import type { SceneWithUrl } from './types'

/**
 * Uploads the tour and returns a link anyone can open.
 *
 * Panoramas are content addressed: each one is stored under the hash of its
 * bytes, so re-sharing after renaming a room or moving a hotspot uploads
 * nothing at all. The client asks which hashes the server is missing and sends
 * only those.
 *
 * XMLHttpRequest rather than fetch, because only XHR reports how much of the
 * body has gone out. Several megabytes behind a label that never changes reads
 * as a hang.
 */

export interface SharedTour {
  id: string
  url: string
}

export interface UploadProgress {
  /** 0 to 1, or null while the browser cannot measure it. */
  fraction: number | null
  /** Bytes that actually need sending, after skipping what the server has. */
  totalBytes: number
  /** Rooms whose panorama was already stored. */
  skipped: number
}

async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function post(url: string, body: FormData | string, onProgress?: (sent: number, total: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    if (typeof body === 'string') xhr.setRequestHeader('content-type', 'application/json')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.responseText)
        : reject(new Error(xhr.responseText || `Tải lên thất bại (${xhr.status})`))
    xhr.onerror = () => reject(new Error('Mất kết nối khi đang tải lên'))
    xhr.ontimeout = () => reject(new Error('Tải lên quá lâu, thử lại khi mạng ổn hơn'))
    xhr.onabort = () => reject(new Error('Đã huỷ tải lên'))
    xhr.send(body)
  })
}

export async function uploadTour(
  scenes: SceneWithUrl[],
  title: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<SharedTour> {
  const hashes = await Promise.all(scenes.map((scene) => hashBlob(scene.image)))

  const known = new Set(
    (JSON.parse(await post('/api/tour/check', JSON.stringify({ hashes }))) as { missing: string[] })
      .missing,
  )
  const needed = scenes.filter((_, i) => known.has(hashes[i]))
  const totalBytes = needed.reduce((sum, scene) => sum + scene.image.size, 0)
  const skipped = scenes.length - needed.length
  onProgress?.({ fraction: totalBytes === 0 ? 1 : 0, totalBytes, skipped })

  const form = new FormData()
  form.append(
    'manifest',
    JSON.stringify({
      title,
      scenes: scenes.map((scene, i) => ({
        id: scene.id,
        name: scene.name,
        imageHash: hashes[i],
        initialYaw: scene.initialYaw,
        initialPitch: scene.initialPitch,
        hotspots: scene.hotspots.map((h) => ({
          id: h.id,
          yaw: h.yaw,
          pitch: h.pitch,
          targetSceneId: h.targetSceneId,
        })),
      })),
    }),
  )
  // Only the panoramas the server has never seen ride along.
  for (const scene of needed) {
    const hash = hashes[scenes.indexOf(scene)]
    form.append(`img_${hash}`, scene.image, `${hash}.jpg`)
  }

  const body = await post('/api/tour', form, (sent, total) => {
    onProgress?.({ fraction: total ? sent / total : null, totalBytes, skipped })
  })
  const { id } = JSON.parse(body) as { id: string }
  return { id, url: new URL(`/t/${id}`, location.origin).toString() }
}
