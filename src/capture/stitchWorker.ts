/// <reference lib="webworker" />
import type { StitchWorkerRequest, StitchWorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

const OUTPUT_WIDTH = 4096
const OUTPUT_HEIGHT = 2048
// Extra angular padding around each shot's FOV when deciding which output pixels it
// could possibly cover — cheap safety margin, not a precision knob.
const BBOX_MARGIN_DEG = 3

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
  const width = bitmap.width
  const height = bitmap.height
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Không tạo được canvas context trong worker')
  }
  ctx.drawImage(bitmap, 0, 0)
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

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function bilinearSample(img: RgbaImage, px: number, py: number): [number, number, number] {
  const x = Math.min(Math.max(px, 0), img.width - 1.001)
  const y = Math.min(Math.max(py, 0), img.height - 1.001)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const fx = x - x0
  const fy = y - y0
  const at = (xx: number, yy: number) => (yy * img.width + xx) * 4
  const corners: [number, number, number][] = [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ]
  let rr = 0
  let gg = 0
  let bb = 0
  for (const [cx, cy, w] of corners) {
    const idx = at(cx, cy)
    rr += img.data[idx] * w
    gg += img.data[idx + 1] * w
    bb += img.data[idx + 2] * w
  }
  return [rr, gg, bb]
}

class StitchError extends Error {
  photoIndex?: number
  constructor(message: string, photoIndex?: number) {
    super(message)
    this.photoIndex = photoIndex
  }
}

/**
 * Projects every captured photo onto an equirectangular canvas using the phone's own
 * device-orientation reading at the moment each shot was taken — no feature matching, no
 * homography estimation. This can't "fail to find enough matches" the way the old
 * OpenCV.js pipeline could, because it never needs to find anything: we already know
 * exactly where each photo points.
 */
/**
 * Projects every captured photo onto an equirectangular canvas using the phone's true
 * 3D camera pose (including roll and exact orientation vectors).
 *
 * Uses non-linear super-elliptical power weighting: the photo closest to the center of
 * any view direction dominates with razor-sharp detail, while transitions at seams are
 * smoothly feathered over a narrow band, eliminating the "watery ghosting / melted 2D"
 * artifacts of wide linear averaging.
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
  const colorSum = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT * 3)
  const weightSum = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)

  const halfTanH = Math.tan((fov.horizontal * Math.PI) / 360)
  const halfTanV = Math.tan((fov.vertical * Math.PI) / 360)
  // Angular radius of a safe bounding circle around each shot's frustum, in output pixels.
  const halfDiagDeg = 0.5 * Math.hypot(fov.horizontal, fov.vertical) + BBOX_MARGIN_DEG

  for (let i = 0; i < photos.length; i++) {
    const { image, yawDeg, pitchDeg, vectors } = photos[i]

    let forward: [number, number, number]
    let right: [number, number, number]
    let up: [number, number, number]

    if (vectors) {
      right = vectors.right
      up = vectors.up
      forward = vectors.forward
    } else {
      forward = dirFromYawPitch(yawDeg, pitchDeg)
      const rightCross = cross(forward, [0, 1, 0])
      const rightLen = Math.hypot(rightCross[0], rightCross[1], rightCross[2])
      right =
        rightLen < 1e-4 ? [1, 0, 0] : [rightCross[0] / rightLen, rightCross[1] / rightLen, rightCross[2] / rightLen]
      up = cross(right, forward) as [number, number, number]
    }

    const pitchLo = Math.max(-90, pitchDeg - halfDiagDeg)
    const pitchHi = Math.min(90, pitchDeg + halfDiagDeg)
    // pixel row increases as pitch decreases (row 0 = +90 at the top)
    let rowStart = Math.floor(OUTPUT_HEIGHT * (0.5 - pitchHi / 180))
    let rowEnd = Math.ceil(OUTPUT_HEIGHT * (0.5 - pitchLo / 180))
    rowStart = Math.max(0, rowStart)
    rowEnd = Math.min(OUTPUT_HEIGHT - 1, rowEnd)

    const centerCol = Math.round(OUTPUT_WIDTH * (yawDeg / 360 + 0.5))

    for (let row = rowStart; row <= rowEnd; row++) {
      const pitchOut = (0.5 - row / OUTPUT_HEIGHT) * 180
      const cosPitch = Math.max(0.01, Math.cos((pitchOut * Math.PI) / 180))
      // Scale longitude span near poles so equirectangular distortion never clips the photo edges.
      const yawSpanDeg = halfDiagDeg / cosPitch
      const colSpan =
        yawSpanDeg >= 180
          ? Math.floor(OUTPUT_WIDTH / 2)
          : Math.min(OUTPUT_WIDTH / 2, Math.ceil((OUTPUT_WIDTH * yawSpanDeg) / 360) + 2)

      for (let c = -colSpan; c <= colSpan; c++) {
        const col = ((centerCol + c) % OUTPUT_WIDTH + OUTPUT_WIDTH) % OUTPUT_WIDTH
        const yawOut = (col / OUTPUT_WIDTH - 0.5) * 360

        const d = dirFromYawPitch(yawOut, pitchOut)
        const zLocal = dot3(d, forward)
        if (zLocal <= 0.05) continue
        const xLocal = dot3(d, right) / zLocal
        const yLocal = dot3(d, up) / zLocal

        const nx = xLocal / halfTanH
        const ny = yLocal / halfTanV
        if (Math.abs(nx) >= 1.0 || Math.abs(ny) >= 1.0) continue

        const u = 0.5 + nx * 0.5
        const v = 0.5 - ny * 0.5
        const [r, g, b] = bilinearSample(image, u * image.width, v * image.height)

        // Smooth falloff to 0 at edges. Power of 4 gives dominant center weight (crisp sharpness,
        // eliminates watery ghosting) while smoothly feathering across the narrow overlap seams.
        const edgeX = 1 - nx * nx
        const edgeY = 1 - ny * ny
        const baseWeight = edgeX * edgeY
        const weight = baseWeight * baseWeight * baseWeight * baseWeight
        if (weight <= 1e-6) continue

        const outIdx = row * OUTPUT_WIDTH + col
        colorSum[outIdx * 3] += r * weight
        colorSum[outIdx * 3 + 1] += g * weight
        colorSum[outIdx * 3 + 2] += b * weight
        weightSum[outIdx] += weight
      }
    }

    progress(
      10 + Math.round(((i + 1) / photos.length) * 75),
      `Đang ghép ảnh ${i + 1}/${photos.length}`,
    )
  }

  progress(88, 'Đang xuất ảnh kết quả...')
  const out = new Uint8ClampedArray(OUTPUT_WIDTH * OUTPUT_HEIGHT * 4)
  const covered = new Uint8Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)

  for (let p = 0; p < OUTPUT_WIDTH * OUTPUT_HEIGHT; p++) {
    const w = weightSum[p]
    if (w > 0) {
      out[p * 4] = Math.round(colorSum[p * 3] / w)
      out[p * 4 + 1] = Math.round(colorSum[p * 3 + 1] / w)
      out[p * 4 + 2] = Math.round(colorSum[p * 3 + 2] / w)
      covered[p] = 1
    }
    out[p * 4 + 3] = 255
  }

  // 1. Horizontal neighbor fill for any tiny seam gaps between adjacent shots
  for (let row = 0; row < OUTPUT_HEIGHT; row++) {
    for (let col = 0; col < OUTPUT_WIDTH; col++) {
      const idx = row * OUTPUT_WIDTH + col
      if (!covered[idx]) {
        const leftIdx = row * OUTPUT_WIDTH + ((col - 1 + OUTPUT_WIDTH) % OUTPUT_WIDTH)
        if (covered[leftIdx]) {
          out[idx * 4] = out[leftIdx * 4]
          out[idx * 4 + 1] = out[leftIdx * 4 + 1]
          out[idx * 4 + 2] = out[leftIdx * 4 + 2]
          covered[idx] = 1
        }
      }
    }
  }
  for (let row = 0; row < OUTPUT_HEIGHT; row++) {
    for (let col = OUTPUT_WIDTH - 1; col >= 0; col--) {
      const idx = row * OUTPUT_WIDTH + col
      if (!covered[idx]) {
        const rightIdx = row * OUTPUT_WIDTH + ((col + 1) % OUTPUT_WIDTH)
        if (covered[rightIdx]) {
          out[idx * 4] = out[rightIdx * 4]
          out[idx * 4 + 1] = out[rightIdx * 4 + 1]
          out[idx * 4 + 2] = out[rightIdx * 4 + 2]
          covered[idx] = 1
        }
      }
    }
  }

  // 2. Smoothly propagate colors to the unreached tips of the zenith and nadir poles
  for (let row = 1; row < OUTPUT_HEIGHT; row++) {
    for (let col = 0; col < OUTPUT_WIDTH; col++) {
      const idx = row * OUTPUT_WIDTH + col
      if (!covered[idx]) {
        const prevIdx = (row - 1) * OUTPUT_WIDTH + col
        if (covered[prevIdx]) {
          out[idx * 4] = out[prevIdx * 4]
          out[idx * 4 + 1] = out[prevIdx * 4 + 1]
          out[idx * 4 + 2] = out[prevIdx * 4 + 2]
          covered[idx] = 1
        }
      }
    }
  }
  for (let row = OUTPUT_HEIGHT - 2; row >= 0; row--) {
    for (let col = 0; col < OUTPUT_WIDTH; col++) {
      const idx = row * OUTPUT_WIDTH + col
      if (!covered[idx]) {
        const nextIdx = (row + 1) * OUTPUT_WIDTH + col
        if (covered[nextIdx]) {
          out[idx * 4] = out[nextIdx * 4]
          out[idx * 4 + 1] = out[nextIdx * 4 + 1]
          out[idx * 4 + 2] = out[nextIdx * 4 + 2]
          covered[idx] = 1
        }
      }
    }
  }

  const canvas = new OffscreenCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không tạo được canvas context trong worker')
  const imgData = new ImageData(out, OUTPUT_WIDTH, OUTPUT_HEIGHT)
  ctx.putImageData(imgData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })

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
