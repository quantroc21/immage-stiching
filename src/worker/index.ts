import { renderTourPage, type TourPageScene } from '../tour/tourPage'

/**
 * Serves the app's static assets, and adds the two routes that make a tour
 * shareable: one to store it, one to show it.
 *
 * A published tour is a manifest at tours/<id>.json plus one JPEG per room.
 * The page links the panoramas rather than embedding them, so a visitor sees
 * the first room while the rest are still arriving.
 */

// Minimal shapes for the runtime bindings, so the app's tsconfig can typecheck
// this file without pulling in a separate Workers type package.
interface R2ObjectBody {
  body: ReadableStream
  httpEtag: string
  size: number
}
interface R2Bucket {
  head(key: string): Promise<{ size: number } | null>
  get(key: string): Promise<R2ObjectBody | null>
  put(key: string, value: ArrayBuffer | string, options?: unknown): Promise<unknown>
  list(options?: unknown): Promise<{ objects: { key: string }[] }>
}
interface Env {
  TOURS: R2Bucket
  ASSETS: { fetch(request: Request): Promise<Response> }
}

/** No vowels and no look-alike characters, so an id is safe to read aloud. */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ID_LENGTH = 8
const MAX_SCENES = 40
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

function newTourId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH))
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
}

interface StoredScene {
  id: string
  name: string
  /** SHA-256 of the panorama. Absent on tours published before dedup. */
  imageHash?: string
  initialYaw: number
  initialPitch: number
  hotspots: { id: string; yaw: number; pitch: number; targetSceneId: string }[]
}
interface StoredTour {
  title: string
  scenes: StoredScene[]
  createdAt: number
}

function bad(message: string, status = 400): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** Scene ids reach R2 as object keys, so they must not carry a path. */
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function parseManifest(raw: unknown): StoredTour | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { title, scenes } = parsed as { title?: unknown; scenes?: unknown }
  if (!Array.isArray(scenes) || scenes.length === 0 || scenes.length > MAX_SCENES) return null

  const known = new Set<string>()
  const cleaned: StoredScene[] = []
  for (const scene of scenes) {
    const s = scene as Record<string, unknown>
    if (!safeId(s.id) || typeof s.name !== 'string') return null
    known.add(s.id)
    cleaned.push({
      id: s.id,
      name: s.name.slice(0, 120),
      imageHash: typeof s.imageHash === 'string' && /^[0-9a-f]{64}$/.test(s.imageHash) ? s.imageHash : undefined,
      initialYaw: Number(s.initialYaw) || 0,
      initialPitch: Number(s.initialPitch) || 0,
      hotspots: Array.isArray(s.hotspots)
        ? (s.hotspots as Record<string, unknown>[])
            .filter((h) => safeId(h.id) && safeId(h.targetSceneId))
            .map((h) => ({
              id: h.id as string,
              yaw: Number(h.yaw) || 0,
              pitch: Number(h.pitch) || 0,
              targetSceneId: h.targetSceneId as string,
            }))
        : [],
    })
  }
  // Drop hotspots aimed at a room that was not uploaded, or the page would
  // offer a doorway into nothing.
  for (const scene of cleaned) {
    scene.hotspots = scene.hotspots.filter((h) => known.has(h.targetSceneId))
  }
  return { title: typeof title === 'string' ? title.slice(0, 120) : 'Virtual Tour 360', scenes: cleaned, createdAt: Date.now() }
}

/** Tells the client which panoramas still need sending. */
async function checkHashes(request: Request, env: Env): Promise<Response> {
  let hashes: unknown
  try {
    hashes = ((await request.json()) as { hashes?: unknown }).hashes
  } catch {
    return bad('Danh sách ảnh không hợp lệ')
  }
  if (!Array.isArray(hashes) || hashes.length > MAX_SCENES) return bad('Danh sách ảnh không hợp lệ')

  const wanted = hashes.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
  const present = await Promise.all(wanted.map((h) => env.TOURS.head(`img/${h}.jpg`)))
  return Response.json({ missing: wanted.filter((_, i) => present[i] === null) })
}

async function createTour(request: Request, env: Env): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return bad('Không đọc được dữ liệu tải lên')
  }

  const tour = parseManifest(form.get('manifest'))
  if (!tour) return bad('Dữ liệu tour không hợp lệ')

  // Panoramas live under their own hash, shared across every tour that uses
  // them, so re-publishing after an edit re-sends nothing.
  const uploads: { key: string; body: ArrayBuffer }[] = []
  for (const scene of tour.scenes) {
    if (!scene.imageHash) return bad(`Thiếu ảnh cho phòng "${scene.name}"`)
    const file = form.get(`img_${scene.imageHash}`)
    if (file instanceof File) {
      if (file.size > MAX_IMAGE_BYTES) return bad(`Ảnh phòng "${scene.name}" vượt quá 16MB`)
      uploads.push({ key: `img/${scene.imageHash}.jpg`, body: await file.arrayBuffer() })
    } else if (!(await env.TOURS.head(`img/${scene.imageHash}.jpg`))) {
      return bad(`Thiếu ảnh cho phòng "${scene.name}"`)
    }
  }

  const id = newTourId()
  await Promise.all(
    uploads.map((image) =>
      env.TOURS.put(image.key, image.body, {
        httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
      }),
    ),
  )
  await env.TOURS.put(`tours/${id}.json`, JSON.stringify(tour), {
    httpMetadata: { contentType: 'application/json' },
  })

  return Response.json({ id })
}

async function servePage(env: Env, id: string): Promise<Response> {
  const object = await env.TOURS.get(`tours/${id}.json`)
  if (!object) return bad('Không tìm thấy tour này. Link có thể đã bị xoá.', 404)
  const tour = JSON.parse(await new Response(object.body).text()) as StoredTour

  const scenes: TourPageScene[] = tour.scenes.map((scene) => ({
    ...scene,
    // Tours published before dedup kept their panoramas under the tour id.
    panorama: scene.imageHash ? `/i/${scene.imageHash}.jpg` : `/api/tour/${id}/img/${scene.id}.jpg`,
  }))

  const html = renderTourPage({
    title: tour.title,
    scenes,
    // Linked, not inlined: both files are already served as static assets on
    // this origin and cached by the browser across every tour.
    css: { href: '/pannellum/pannellum.css' },
    js: { src: '/pannellum/pannellum.js' },
  })

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  })
}

async function serveImage(env: Env, key: string): Promise<Response> {
  const object = await env.TOURS.get(key)
  if (!object) return bad('Không tìm thấy ảnh', 404)
  return new Response(object.body, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: object.httpEtag,
    },
  })
}

/**
 * Diagnostics: a room's shots plus the angle each was taken at, kept together so
 * the angles survive the trip. Filenames do not: every export route off the
 * phone rewrites them, and the JPEGs carry no EXIF.
 */
async function storeDiagnostics(request: Request, env: Env): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return bad('Không đọc được dữ liệu')
  }
  const manifest = form.get('manifest')
  if (typeof manifest !== 'string' || manifest.length > 200_000) return bad('Manifest không hợp lệ')

  const id = newTourId()
  const puts: Promise<unknown>[] = [
    env.TOURS.put(`diag/${id}/manifest.json`, manifest, {
      httpMetadata: { contentType: 'application/json' },
    }),
  ]
  for (const [key, value] of form.entries()) {
    if (key === 'manifest' || !(value instanceof File)) continue
    if (!/^(pano|shot_\d{1,3})$/.test(key)) return bad(`Trường không hợp lệ: ${key}`)
    if (value.size > MAX_IMAGE_BYTES) return bad(`${key} vượt quá 16MB`)
    puts.push(
      env.TOURS.put(`diag/${id}/${key}.jpg`, await value.arrayBuffer(), {
        httpMetadata: { contentType: 'image/jpeg' },
      }),
    )
  }
  await Promise.all(puts)
  return Response.json({ id })
}

async function serveDiagnostic(env: Env, id: string, name: string): Promise<Response> {
  const object = await env.TOURS.get(`diag/${id}/${name}`)
  if (!object) return bad('Không tìm thấy', 404)
  return new Response(object.body, {
    headers: {
      'content-type': name.endsWith('.json') ? 'application/json' : 'image/jpeg',
      'cache-control': 'public, max-age=3600',
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/diag' && request.method === 'POST') {
      return storeDiagnostics(request, env)
    }
    const diag = url.pathname.match(/^\/api\/diag\/([a-z0-9]+)\/([A-Za-z0-9_.-]+)$/)
    if (diag && !diag[2].includes('..')) return serveDiagnostic(env, diag[1], diag[2])

    if (url.pathname === '/api/tour/check' && request.method === 'POST') {
      return checkHashes(request, env)
    }

    if (url.pathname === '/api/tour' && request.method === 'POST') {
      return createTour(request, env)
    }

    const shared = url.pathname.match(/^\/i\/([0-9a-f]{64})\.jpg$/)
    if (shared) return serveImage(env, `img/${shared[1]}.jpg`)

    const legacy = url.pathname.match(/^\/api\/tour\/([a-z0-9]+)\/img\/([A-Za-z0-9_-]+\.jpg)$/)
    if (legacy) return serveImage(env, `tours/${legacy[1]}/${legacy[2]}`)

    const page = url.pathname.match(/^\/t\/([a-z0-9]+)\/?$/)
    if (page) return servePage(env, page[1])

    return env.ASSETS.fetch(request)
  },
}
