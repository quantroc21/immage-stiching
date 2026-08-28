/// <reference lib="webworker" />
import type { StitchWorkerRequest, StitchWorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

const OUTPUT_WIDTH = 4096
const OUTPUT_HEIGHT = 2048

/**
 * The equirectangular canvas is composited a horizontal band at a time. Holding only one
 * band of float accumulators (instead of five full-canvas ones) is what keeps this inside
 * a phone's worker memory budget — the previous full-canvas version allocated ~240MB of
 * Float32 buffers and stalled mid-stitch.
 */
const STRIP_ROWS = 256

/**
 * Source photos are downscaled the moment they're decoded. A 4K capture decodes to ~33MB
 * of RGBA, and 18 of those is ~600MB — but at a 4096px-wide output, one shot spanning ~58°
 * only ever lands on ~660 output pixels, so anything past ~1280px on the long side is
 * resolution we pay for in RAM and never see.
 */
const MAX_PHOTO_LONG_SIDE = 1280

/** Grid used for the low-frequency (colour/exposure) band. 4096/16 = 256 × 128. */
const LOW_DIV = 16
const LOW_WIDTH = OUTPUT_WIDTH / LOW_DIV
const LOW_HEIGHT = OUTPUT_HEIGHT / LOW_DIV

/**
 * How close two shots' "distance to their own frame edge" must be before we cross-fade
 * them, in normalised frustum units (0 = frame edge, 1 = frame centre). Small, because
 * high-frequency detail must stay winner-takes-all sharp — the wide, invisible part of the
 * transition is handled by the low-frequency band instead.
 */
const SEAM_BLEND_MARGIN = 0.1

const BBOX_MARGIN_DEG = 3
const VIGNETTE_BINS = 12

function post(message: StitchWorkerResponse) {
  self.postMessage(message)
}

function progress(percent: number, message: string) {
  post({ type: 'progress', percent, message })
}

interface RgbaImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

async function decodeToRgba(blob: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_PHOTO_LONG_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Không tạo được canvas context trong worker')
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  bitmap.close()
  return { data, width, height }
}

/** Same yaw/pitch -> unit-vector convention used by sphereDots.ts / OrientationOverlay. */
function dirFromYawPitch(yawDeg: number, pitchDeg: number): [number, number, number] {
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

class StitchError extends Error {
  photoIndex?: number
  constructor(message: string, photoIndex?: number) {
    super(message)
    this.photoIndex = photoIndex
  }
}

/**
 * Estimates the lens' radial falloff by averaging brightness-vs-radius across every shot.
 * Scene content is uncorrelated with sensor radius once you average over shots pointing in
 * a dozen different directions, so what survives the average is the lens vignette itself.
 * Left uncorrected this is a major cause of the "tiled" look: every frame is darker at its
 * corners, so each frame's border reads as an edge.
 */
function estimateVignetteGains(images: RgbaImage[]): Float64Array {
  const sum = new Float64Array(VIGNETTE_BINS)
  const count = new Float64Array(VIGNETTE_BINS)
  const invSqrt2 = 1 / Math.SQRT2

  for (const img of images) {
    const step = Math.max(1, Math.floor(Math.max(img.width, img.height) / 200))
    for (let y = 0; y < img.height; y += step) {
      const v = img.height > 1 ? (y / (img.height - 1)) * 2 - 1 : 0
      for (let x = 0; x < img.width; x += step) {
        const u = img.width > 1 ? (x / (img.width - 1)) * 2 - 1 : 0
        const r = Math.sqrt(u * u + v * v) * invSqrt2
        let bin = Math.floor(r * VIGNETTE_BINS)
        if (bin >= VIGNETTE_BINS) bin = VIGNETTE_BINS - 1
        const idx = (y * img.width + x) * 4
        sum[bin] += 0.299 * img.data[idx] + 0.587 * img.data[idx + 1] + 0.114 * img.data[idx + 2]
        count[bin]++
      }
    }
  }

  const gains = new Float64Array(VIGNETTE_BINS).fill(1)
  const centre = count[0] > 0 ? sum[0] / count[0] : 0
  if (centre <= 1) return gains
  for (let b = 0; b < VIGNETTE_BINS; b++) {
    const mean = count[b] > 0 ? sum[b] / count[b] : centre
    // Vignette only ever darkens, so the correction only ever brightens — and it's capped
    // so a dark scene edge can't be mistaken for extreme falloff and blown out.
    gains[b] = mean > 1 ? Math.min(1.6, Math.max(1, centre / mean)) : 1
  }

  const smoothed = new Float64Array(VIGNETTE_BINS)
  for (let b = 0; b < VIGNETTE_BINS; b++) {
    const prev = gains[Math.max(0, b - 1)]
    const next = gains[Math.min(VIGNETTE_BINS - 1, b + 1)]
    smoothed[b] = (prev + 2 * gains[b] + next) / 4
  }
  return smoothed
}

function vignetteGainAt(gains: Float64Array, r: number): number {
  const f = Math.min(VIGNETTE_BINS - 1, Math.max(0, r * VIGNETTE_BINS - 0.5))
  const b0 = Math.floor(f)
  const b1 = Math.min(VIGNETTE_BINS - 1, b0 + 1)
  const t = f - b0
  return gains[b0] * (1 - t) + gains[b1] * t
}

interface PhotoPose {
  forward: [number, number, number]
  right: [number, number, number]
  up: [number, number, number]
  yawDeg: number
  pitchDeg: number
  gain: number
  image: RgbaImage
  rowStart: number
  rowEnd: number
  centerCol: number
}

/**
 * Samples a photo at an output direction and returns its colour plus how far inside its
 * own frame that direction landed.
 *
 * The margin is the whole trick behind the seam placement: it is the distance to the
 * *nearest frame edge* in normalised coordinates, so it is 0 along a photo's rectangular
 * border and ~1 at its centre. Assigning each output pixel to whichever shot has the
 * largest margin puts every seam down the middle of an overlap and — unlike ranking shots
 * by distance-to-centre — can never hand a pixel to a shot whose rectangle doesn't
 * actually reach it. That mismatch was what carved rectangular gaps along frame borders,
 * which the old gap-filler then smeared into visible boxes.
 */
function projectPixel(
  pose: PhotoPose,
  dx: number,
  dy: number,
  dz: number,
  halfTanH: number,
  halfTanV: number,
): { margin: number; nx: number; ny: number } | null {
  const { forward, right, up } = pose
  const zLocal = dx * forward[0] + dy * forward[1] + dz * forward[2]
  if (zLocal <= 0.05) return null
  const nx = (dx * right[0] + dy * right[1] + dz * right[2]) / zLocal / halfTanH
  const ny = (dx * up[0] + dy * up[1] + dz * up[2]) / zLocal / halfTanV
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  if (ax >= 1 || ay >= 1) return null
  const margin = Math.min(1 - ax, 1 - ay)
  return { margin, nx, ny }
}

function sampleColour(
  pose: PhotoPose,
  nx: number,
  ny: number,
  vignette: Float64Array,
  exposureGain: number,
  out: Float32Array,
): void {
  const img = pose.image
  const px = (0.5 + nx * 0.5) * img.width
  const py = (0.5 - ny * 0.5) * img.height
  const x = Math.min(Math.max(px, 0), img.width - 1.001)
  const y = Math.min(Math.max(py, 0), img.height - 1.001)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, img.width - 1)
  const y1 = Math.min(y0 + 1, img.height - 1)
  const fx = x - x0
  const fy = y - y0
  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy
  const d = img.data
  const i00 = (y0 * img.width + x0) * 4
  const i10 = (y0 * img.width + x1) * 4
  const i01 = (y1 * img.width + x0) * 4
  const i11 = (y1 * img.width + x1) * 4

  const gain = exposureGain * vignetteGainAt(vignette, Math.sqrt(nx * nx + ny * ny) / Math.SQRT2)
  out[0] = (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * gain
  out[1] = (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * gain
  out[2] = (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * gain
}

/** Separable 1-2-1 blur, applied in place, wrapping horizontally like the sphere does. */
function blurLowBand(buf: Float32Array, passes: number): void {
  const tmp = new Float32Array(buf.length)
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < LOW_HEIGHT; y++) {
      const row = y * LOW_WIDTH
      for (let x = 0; x < LOW_WIDTH; x++) {
        const l = buf[row + ((x - 1 + LOW_WIDTH) % LOW_WIDTH)]
        const c = buf[row + x]
        const r = buf[row + ((x + 1) % LOW_WIDTH)]
        tmp[row + x] = (l + 2 * c + r) * 0.25
      }
    }
    for (let y = 0; y < LOW_HEIGHT; y++) {
      const yUp = Math.max(0, y - 1) * LOW_WIDTH
      const yDn = Math.min(LOW_HEIGHT - 1, y + 1) * LOW_WIDTH
      const row = y * LOW_WIDTH
      for (let x = 0; x < LOW_WIDTH; x++) {
        buf[row + x] = (tmp[yUp + x] + 2 * tmp[row + x] + tmp[yDn + x]) * 0.25
      }
    }
  }
}

/** Bilinear read from the low-frequency grid, wrapping in x and clamping in y. */
function sampleLow(buf: Float32Array, lx: number, ly: number): number {
  const x0 = Math.floor(lx)
  const y0 = Math.floor(ly)
  const fx = lx - x0
  const fy = ly - y0
  const xa = ((x0 % LOW_WIDTH) + LOW_WIDTH) % LOW_WIDTH
  const xb = (xa + 1) % LOW_WIDTH
  const ya = Math.min(LOW_HEIGHT - 1, Math.max(0, y0))
  const yb = Math.min(LOW_HEIGHT - 1, Math.max(0, y0 + 1))
  const top = buf[ya * LOW_WIDTH + xa] * (1 - fx) + buf[ya * LOW_WIDTH + xb] * fx
  const bottom = buf[yb * LOW_WIDTH + xa] * (1 - fx) + buf[yb * LOW_WIDTH + xb] * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * Two-band 360° compositor.
 *
 * Averaging every overlapping shot gives smooth colour but soft, ghosted, "plastic" detail.
 * Picking a single winner per pixel gives sharp detail but every exposure or white-balance
 * difference lands as a hard visible edge. So each band is treated the way it wants to be:
 *
 *  - High frequencies (detail) come from a near-winner-takes-all composite, cross-faded
 *    only across a hair-thin band where two shots are equally deep inside their frames.
 *    Detail stays as sharp as the source, nothing doubles up.
 *  - Low frequencies (brightness, colour cast) come from a broad, heavily feathered blend
 *    computed on a coarse grid, then added back as a smooth correction. Exposure steps
 *    dissolve into a gradient no one can point at.
 *
 * That split is what separates this from a naive average or a naive winner: sharp where it
 * matters, seamless where it shows.
 */
async function stitch(
  photos: {
    image: RgbaImage
    yawDeg: number
    pitchDeg: number
    vectors?: {
      right: [number, number, number]
      up: [number, number, number]
      forward: [number, number, number]
    }
  }[],
  fov: { horizontal: number; vertical: number },
): Promise<{ blob: Blob; width: number; height: number }> {
  progress(12, 'Phân tích ống kính...')
  const vignette = estimateVignetteGains(photos.map((p) => p.image))

  const halfTanH = Math.tan((fov.horizontal * Math.PI) / 360)
  const halfTanV = Math.tan((fov.vertical * Math.PI) / 360)
  const halfDiagDeg = 0.5 * Math.hypot(fov.horizontal, fov.vertical) + BBOX_MARGIN_DEG

  const poses: PhotoPose[] = photos.map((p) => {
    let forward: [number, number, number]
    let right: [number, number, number]
    let up: [number, number, number]

    if (p.vectors) {
      right = p.vectors.right
      up = p.vectors.up
      forward = p.vectors.forward
    } else {
      forward = dirFromYawPitch(p.yawDeg, p.pitchDeg)
      const rightCross = cross(forward, [0, 1, 0])
      const rightLen = Math.hypot(rightCross[0], rightCross[1], rightCross[2])
      right =
        rightLen < 1e-4 ? [1, 0, 0] : [rightCross[0] / rightLen, rightCross[1] / rightLen, rightCross[2] / rightLen]
      up = cross(right, forward)
    }

    const pitchLo = Math.max(-90, p.pitchDeg - halfDiagDeg)
    const pitchHi = Math.min(90, p.pitchDeg + halfDiagDeg)
    const rowStart = Math.max(0, Math.floor(OUTPUT_HEIGHT * (0.5 - pitchHi / 180)))
    const rowEnd = Math.min(OUTPUT_HEIGHT - 1, Math.ceil(OUTPUT_HEIGHT * (0.5 - pitchLo / 180)))

    return {
      forward,
      right,
      up,
      yawDeg: p.yawDeg,
      pitchDeg: p.pitchDeg,
      gain: 1,
      image: p.image,
      rowStart,
      rowEnd,
      centerCol: Math.round(OUTPUT_WIDTH * (p.yawDeg / 360 + 0.5)),
    }
  })

  // Direction vectors factor into a per-row and a per-column part, so the trig is done
  // once up front instead of millions of times inside the compositing loops.
  const sinYaw = new Float64Array(OUTPUT_WIDTH)
  const cosYaw = new Float64Array(OUTPUT_WIDTH)
  for (let col = 0; col < OUTPUT_WIDTH; col++) {
    const yaw = ((col / OUTPUT_WIDTH - 0.5) * 360 * Math.PI) / 180
    sinYaw[col] = Math.sin(yaw)
    cosYaw[col] = Math.cos(yaw)
  }
  const sinPitch = new Float64Array(OUTPUT_HEIGHT)
  const cosPitch = new Float64Array(OUTPUT_HEIGHT)
  for (let row = 0; row < OUTPUT_HEIGHT; row++) {
    const pitch = ((0.5 - row / OUTPUT_HEIGHT) * 180 * Math.PI) / 180
    sinPitch[row] = Math.sin(pitch)
    cosPitch[row] = Math.cos(pitch)
  }

  const colSpanForRow = (row: number): number => {
    const cp = Math.max(0.01, cosPitch[row])
    const yawSpanDeg = halfDiagDeg / cp
    return yawSpanDeg >= 180
      ? Math.floor(OUTPUT_WIDTH / 2)
      : Math.min(OUTPUT_WIDTH / 2, Math.ceil((OUTPUT_WIDTH * yawSpanDeg) / 360) + 2)
  }

  // ── Exposure matching ──────────────────────────────────────────────────────
  // Gains are solved so neighbouring shots agree *where they overlap*, not by dragging
  // every shot to one global average brightness. That distinction is the whole point: a
  // frame pointed at a window is genuinely brighter than one pointed at the floor, and
  // equalising their means bends the panorama's luminance toward the horizon — measurable
  // as the eye-level band reading ~11 levels too bright and the poles ~8 too dark. Matching
  // only inside overlaps cancels the camera's auto-exposure drift and leaves the scene's
  // real lighting intact. (Brown & Lowe's gain-compensation formulation.)
  progress(18, 'Cân bằng phơi sáng giữa các ảnh...')
  const exposureGains = ((): number[] => {
    const n = poses.length
    const MAX_OVERLAP = 4
    const lowPixels = LOW_WIDTH * LOW_HEIGHT
    const ids = new Int16Array(lowPixels * MAX_OVERLAP).fill(-1)
    const lums = new Float32Array(lowPixels * MAX_OVERLAP)
    const counts = new Uint8Array(lowPixels)
    const probe = new Float32Array(3)

    for (let i = 0; i < n; i++) {
      const pose = poses[i]
      const lowRowStart = Math.max(0, Math.floor(pose.rowStart / LOW_DIV))
      const lowRowEnd = Math.min(LOW_HEIGHT - 1, Math.ceil(pose.rowEnd / LOW_DIV))
      for (let ly = lowRowStart; ly <= lowRowEnd; ly++) {
        const row = Math.min(OUTPUT_HEIGHT - 1, Math.round((ly + 0.5) * LOW_DIV))
        const sp = sinPitch[row]
        const cp = cosPitch[row]
        const span = Math.ceil(colSpanForRow(row) / LOW_DIV)
        const centerLowCol = Math.round(pose.centerCol / LOW_DIV)
        for (let c = -span; c <= span; c++) {
          const lx = ((centerLowCol + c) % LOW_WIDTH + LOW_WIDTH) % LOW_WIDTH
          const col = Math.min(OUTPUT_WIDTH - 1, Math.round((lx + 0.5) * LOW_DIV))
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
          if (!hit) continue
          const idx = ly * LOW_WIDTH + lx
          const k = counts[idx]
          if (k >= MAX_OVERLAP) continue
          sampleColour(pose, hit.nx, hit.ny, vignette, 1, probe)
          ids[idx * MAX_OVERLAP + k] = i
          lums[idx * MAX_OVERLAP + k] = (0.299 * probe[0] + 0.587 * probe[1] + 0.114 * probe[2]) / 255
          counts[idx] = k + 1
        }
      }
    }

    const pairCount = new Float64Array(n * n)
    const pairSum = new Float64Array(n * n)
    for (let p = 0; p < lowPixels; p++) {
      const k = counts[p]
      if (k < 2) continue
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          if (a === b) continue
          const i = ids[p * MAX_OVERLAP + a]
          const j = ids[p * MAX_OVERLAP + b]
          pairCount[i * n + j]++
          pairSum[i * n + j] += lums[p * MAX_OVERLAP + a]
        }
      }
    }

    const SIGMA_N2 = 0.04 * 0.04
    const SIGMA_G2 = 0.1 * 0.1
    const g = new Float64Array(n).fill(1)
    for (let iter = 0; iter < 30; iter++) {
      for (let i = 0; i < n; i++) {
        let num = 0
        let den = 0
        for (let j = 0; j < n; j++) {
          const nij = pairCount[i * n + j]
          if (nij === 0) continue
          const meanI = pairSum[i * n + j] / nij
          const meanJ = pairSum[j * n + i] / nij
          num += nij * ((meanI * meanJ * g[j]) / SIGMA_N2 + 1 / SIGMA_G2)
          den += nij * ((meanI * meanI) / SIGMA_N2 + 1 / SIGMA_G2)
        }
        if (den > 0) g[i] = num / den
      }
    }

    // Renormalise so the panorama keeps the exposure the camera actually chose, and clamp
    // so one bad frame can't drag everything with it.
    let mean = 0
    for (let i = 0; i < n; i++) mean += g[i]
    mean = mean / n || 1
    return Array.from(g, (v) => Math.max(0.5, Math.min(2, v / mean)))
  })()
  poses.forEach((pose, i) => {
    pose.gain = exposureGains[i]
  })

  // ── Low-frequency band: wide feathered blend on a coarse grid ───────────────
  progress(22, 'Dựng dải màu nền...')
  const lowR = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const lowG = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const lowB = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const lowW = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const rgb = new Float32Array(3)

  for (const pose of poses) {
    const lowRowStart = Math.max(0, Math.floor(pose.rowStart / LOW_DIV))
    const lowRowEnd = Math.min(LOW_HEIGHT - 1, Math.ceil(pose.rowEnd / LOW_DIV))
    for (let ly = lowRowStart; ly <= lowRowEnd; ly++) {
      const row = Math.min(OUTPUT_HEIGHT - 1, Math.round((ly + 0.5) * LOW_DIV))
      const sp = sinPitch[row]
      const cp = cosPitch[row]
      const span = Math.ceil(colSpanForRow(row) / LOW_DIV)
      const centerLowCol = Math.round(pose.centerCol / LOW_DIV)
      for (let c = -span; c <= span; c++) {
        const lx = ((centerLowCol + c) % LOW_WIDTH + LOW_WIDTH) % LOW_WIDTH
        const col = Math.min(OUTPUT_WIDTH - 1, Math.round((lx + 0.5) * LOW_DIV))
        const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
        if (!hit) continue
        // Broad pyramid feather — deliberately gentle, since only this band's low
        // frequencies survive into the result.
        const w = (1 - Math.abs(hit.nx)) * (1 - Math.abs(hit.ny))
        if (w <= 0) continue
        sampleColour(pose, hit.nx, hit.ny, vignette, pose.gain, rgb)
        const idx = ly * LOW_WIDTH + lx
        lowR[idx] += rgb[0] * w
        lowG[idx] += rgb[1] * w
        lowB[idx] += rgb[2] * w
        lowW[idx] += w
      }
    }
  }

  const lowValid = new Uint8Array(LOW_WIDTH * LOW_HEIGHT)
  for (let i = 0; i < lowW.length; i++) {
    if (lowW[i] > 0) {
      lowR[i] /= lowW[i]
      lowG[i] /= lowW[i]
      lowB[i] /= lowW[i]
      lowValid[i] = 1
    }
  }

  // ── High-frequency band: sharp composite, one strip at a time ───────────────
  const out = new Uint8ClampedArray(OUTPUT_WIDTH * OUTPUT_HEIGHT * 4)
  const covered = new Uint8Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)

  const stripPixels = OUTPUT_WIDTH * STRIP_ROWS
  const bestMargin = new Float32Array(stripPixels)
  const accR = new Float32Array(stripPixels)
  const accG = new Float32Array(stripPixels)
  const accB = new Float32Array(stripPixels)
  const accW = new Float32Array(stripPixels)

  for (let stripStart = 0; stripStart < OUTPUT_HEIGHT; stripStart += STRIP_ROWS) {
    const stripEnd = Math.min(OUTPUT_HEIGHT, stripStart + STRIP_ROWS)
    const rows = stripEnd - stripStart
    const used = OUTPUT_WIDTH * rows
    bestMargin.fill(0, 0, used)
    accR.fill(0, 0, used)
    accG.fill(0, 0, used)
    accB.fill(0, 0, used)
    accW.fill(0, 0, used)

    const active = poses.filter((p) => p.rowEnd >= stripStart && p.rowStart < stripEnd)

    // Pass 1 — how deep inside its own frame is the best-placed shot for each pixel.
    for (const pose of active) {
      const from = Math.max(pose.rowStart, stripStart)
      const to = Math.min(pose.rowEnd, stripEnd - 1)
      for (let row = from; row <= to; row++) {
        const sp = sinPitch[row]
        const cp = cosPitch[row]
        const span = colSpanForRow(row)
        const rowBase = (row - stripStart) * OUTPUT_WIDTH
        for (let c = -span; c <= span; c++) {
          const col = ((pose.centerCol + c) % OUTPUT_WIDTH + OUTPUT_WIDTH) % OUTPUT_WIDTH
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
          if (!hit) continue
          const idx = rowBase + col
          if (hit.margin > bestMargin[idx]) bestMargin[idx] = hit.margin
        }
      }
    }

    // Pass 2 — every shot within a hair of the best margin contributes; everything else is
    // skipped outright, so detail comes from a single frame almost everywhere.
    for (const pose of active) {
      const from = Math.max(pose.rowStart, stripStart)
      const to = Math.min(pose.rowEnd, stripEnd - 1)
      for (let row = from; row <= to; row++) {
        const sp = sinPitch[row]
        const cp = cosPitch[row]
        const span = colSpanForRow(row)
        const rowBase = (row - stripStart) * OUTPUT_WIDTH
        for (let c = -span; c <= span; c++) {
          const col = ((pose.centerCol + c) % OUTPUT_WIDTH + OUTPUT_WIDTH) % OUTPUT_WIDTH
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
          if (!hit) continue
          const idx = rowBase + col
          const gap = bestMargin[idx] - hit.margin
          if (gap >= SEAM_BLEND_MARGIN) continue
          const weight = 1 - smoothstep(gap / SEAM_BLEND_MARGIN)
          if (weight <= 1e-4) continue
          sampleColour(pose, hit.nx, hit.ny, vignette, pose.gain, rgb)
          accR[idx] += rgb[0] * weight
          accG[idx] += rgb[1] * weight
          accB[idx] += rgb[2] * weight
          accW[idx] += weight
        }
      }
    }

    for (let i = 0; i < used; i++) {
      const w = accW[i]
      if (w <= 0) continue
      const p = (stripStart * OUTPUT_WIDTH + i) * 4
      out[p] = accR[i] / w
      out[p + 1] = accG[i] / w
      out[p + 2] = accB[i] / w
      covered[stripStart * OUTPUT_WIDTH + i] = 1
    }

    progress(
      25 + Math.round(((stripEnd / OUTPUT_HEIGHT) * 55)),
      `Đang ghép toàn cảnh ${Math.round((stripEnd / OUTPUT_HEIGHT) * 100)}%`,
    )
  }

  for (let p = 0; p < OUTPUT_WIDTH * OUTPUT_HEIGHT; p++) out[p * 4 + 3] = 255

  // ── Merge the bands ────────────────────────────────────────────────────────
  progress(84, 'Hòa màu các mối nối...')
  const sharpLowR = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const sharpLowG = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const sharpLowB = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const sharpLowN = new Float32Array(LOW_WIDTH * LOW_HEIGHT)

  for (let row = 0; row < OUTPUT_HEIGHT; row++) {
    const ly = Math.min(LOW_HEIGHT - 1, (row / LOW_DIV) | 0)
    for (let col = 0; col < OUTPUT_WIDTH; col++) {
      const idx = row * OUTPUT_WIDTH + col
      if (!covered[idx]) continue
      const lx = Math.min(LOW_WIDTH - 1, (col / LOW_DIV) | 0)
      const l = ly * LOW_WIDTH + lx
      sharpLowR[l] += out[idx * 4]
      sharpLowG[l] += out[idx * 4 + 1]
      sharpLowB[l] += out[idx * 4 + 2]
      sharpLowN[l]++
    }
  }
  for (let i = 0; i < sharpLowN.length; i++) {
    if (sharpLowN[i] > 0) {
      sharpLowR[i] /= sharpLowN[i]
      sharpLowG[i] /= sharpLowN[i]
      sharpLowB[i] /= sharpLowN[i]
    }
  }

  // The correction is the difference between the two bands' low frequencies. Blurring it
  // is what turns a step at each seam into an imperceptible gradient.
  const deltaR = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const deltaG = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  const deltaB = new Float32Array(LOW_WIDTH * LOW_HEIGHT)
  for (let i = 0; i < deltaR.length; i++) {
    if (!lowValid[i] || sharpLowN[i] === 0) continue
    deltaR[i] = lowR[i] - sharpLowR[i]
    deltaG[i] = lowG[i] - sharpLowG[i]
    deltaB[i] = lowB[i] - sharpLowB[i]
  }
  blurLowBand(deltaR, 3)
  blurLowBand(deltaG, 3)
  blurLowBand(deltaB, 3)

  for (let row = 0; row < OUTPUT_HEIGHT; row++) {
    const ly = row / LOW_DIV - 0.5
    for (let col = 0; col < OUTPUT_WIDTH; col++) {
      const idx = row * OUTPUT_WIDTH + col
      if (!covered[idx]) continue
      const lx = col / LOW_DIV - 0.5
      const p = idx * 4
      out[p] = out[p] + sampleLow(deltaR, lx, ly)
      out[p + 1] = out[p + 1] + sampleLow(deltaG, lx, ly)
      out[p + 2] = out[p + 2] + sampleLow(deltaB, lx, ly)
    }
  }

  // ── Anything the capture grid never reached (tiny polar caps) ──────────────
  progress(93, 'Lấp các vùng chưa phủ...')
  for (let col = 0; col < OUTPUT_WIDTH; col++) {
    for (let row = 1; row < OUTPUT_HEIGHT; row++) {
      const idx = row * OUTPUT_WIDTH + col
      if (covered[idx]) continue
      const prev = (row - 1) * OUTPUT_WIDTH + col
      if (!covered[prev]) continue
      out[idx * 4] = out[prev * 4]
      out[idx * 4 + 1] = out[prev * 4 + 1]
      out[idx * 4 + 2] = out[prev * 4 + 2]
      covered[idx] = 1
    }
    for (let row = OUTPUT_HEIGHT - 2; row >= 0; row--) {
      const idx = row * OUTPUT_WIDTH + col
      if (covered[idx]) continue
      const next = (row + 1) * OUTPUT_WIDTH + col
      if (!covered[next]) continue
      out[idx * 4] = out[next * 4]
      out[idx * 4 + 1] = out[next * 4 + 1]
      out[idx * 4 + 2] = out[next * 4 + 2]
      covered[idx] = 1
    }
  }

  progress(96, 'Đang xuất ảnh kết quả...')
  const canvas = new OffscreenCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không tạo được canvas context trong worker')
  ctx.putImageData(new ImageData(out, OUTPUT_WIDTH, OUTPUT_HEIGHT), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })

  progress(100, 'Hoàn tất')
  return { blob, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT }
}

self.onmessage = async (event: MessageEvent<StitchWorkerRequest>) => {
  if (event.data.type !== 'stitch') return
  try {
    const { photos, fov } = event.data
    if (photos.length < 2) throw new StitchError('Cần ít nhất 2 tấm ảnh để ghép')

    progress(2, 'Đang giải mã ảnh...')
    const decoded: {
      image: RgbaImage
      yawDeg: number
      pitchDeg: number
      vectors?: {
        right: [number, number, number]
        up: [number, number, number]
        forward: [number, number, number]
      }
    }[] = []
    for (let i = 0; i < photos.length; i++) {
      const image = await decodeToRgba(photos[i].blob)
      decoded.push({
        image,
        yawDeg: photos[i].yawDeg,
        pitchDeg: photos[i].pitchDeg,
        vectors: photos[i].vectors,
      })
      progress(2 + Math.round(((i + 1) / photos.length) * 8), `Đọc ảnh ${i + 1}/${photos.length}`)
    }

    const result = await stitch(decoded, fov)
    post({ type: 'result', blob: result.blob, width: result.width, height: result.height })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lỗi không xác định khi ghép ảnh'
    const photoIndex = err instanceof StitchError ? err.photoIndex : undefined
    post({ type: 'error', message, photoIndex })
  }
}
