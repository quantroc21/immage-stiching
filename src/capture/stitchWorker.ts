/// <reference lib="webworker" />
import type { StitchWorkerRequest, StitchWorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

const OUTPUT_WIDTH = 6144
const OUTPUT_HEIGHT = 3072
// Extra angular padding around each shot's FOV when deciding which output pixels it
// could possibly cover — cheap safety margin, not a precision knob.
const BBOX_MARGIN_DEG = 3
// Narrow seam blend width in degrees. Only pixels within this angular distance of
// the ownership boundary between two photos will be blended. Everything else comes
// from a single photo — no ghosting, no plastic averaging.
const SEAM_BLEND_DEG = 3.0

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
  const x1 = Math.min(x0 + 1, img.width - 1)
  const y1 = Math.min(y0 + 1, img.height - 1)
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

/** Great-circle angular distance in degrees between two directions given as yaw/pitch. */
function angularDistDeg(yaw1: number, pitch1: number, yaw2: number, pitch2: number): number {
  const d1 = dirFromYawPitch(yaw1, pitch1)
  const d2 = dirFromYawPitch(yaw2, pitch2)
  const cosAngle = Math.min(1, Math.max(-1, dot3(d1, d2)))
  return (Math.acos(cosAngle) * 180) / Math.PI
}

/** Compute average brightness of an image (fast — samples every 8th pixel). */
function averageBrightness(img: RgbaImage): number {
  let sum = 0
  let count = 0
  const step = 8
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const idx = (y * img.width + x) * 4
      // Luminance approximation: 0.299R + 0.587G + 0.114B
      sum += 0.299 * img.data[idx] + 0.587 * img.data[idx + 1] + 0.114 * img.data[idx + 2]
      count++
    }
  }
  return count > 0 ? sum / count : 128
}

/**
 * Professional-grade 360° stitcher using Winner-Takes-All ownership with narrow
 * seam blending and per-photo exposure compensation.
 *
 * Key differences from weighted-average approach:
 * 1. Each output pixel is "owned" by the photo whose center is angularly closest.
 *    This means each area gets its texture from ONE photo only — no ghosting.
 * 2. Only at the narrow seam boundary between two photos' territories do we blend,
 *    over a configurable angular width (SEAM_BLEND_DEG, default 3°).
 * 3. Before rendering, all photos are exposure-compensated to a common median
 *    brightness, eliminating the visible "brightness bands" between shots.
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
  // ────────────────────────────────────────────────────────────────────────────
  // Step 1: Exposure compensation — normalize all photos to a common brightness
  // ────────────────────────────────────────────────────────────────────────────
  progress(12, 'Cân bằng phơi sáng...')
  const brightnesses = photos.map((p) => averageBrightness(p.image))
  // Use the median brightness as the target — more robust than mean against outliers
  const sortedBright = [...brightnesses].sort((a, b) => a - b)
  const medianBright = sortedBright[Math.floor(sortedBright.length / 2)]

  const gains = brightnesses.map((b) => {
    if (b < 1) return 1
    const raw = medianBright / b
    // Clamp gain to avoid extreme corrections that amplify noise
    return Math.max(0.5, Math.min(2.0, raw))
  })

  // ────────────────────────────────────────────────────────────────────────────
  // Step 2: Build per-photo projection helpers (camera axes, bounding boxes)
  // ────────────────────────────────────────────────────────────────────────────
  const halfTanH = Math.tan((fov.horizontal * Math.PI) / 360)
  const halfTanV = Math.tan((fov.vertical * Math.PI) / 360)
  const halfDiagDeg = 0.5 * Math.hypot(fov.horizontal, fov.vertical) + BBOX_MARGIN_DEG

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

  const poses: PhotoPose[] = photos.map((p, i) => {
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
      up = cross(right, forward) as [number, number, number]
    }

    const pitchLo = Math.max(-90, p.pitchDeg - halfDiagDeg)
    const pitchHi = Math.min(90, p.pitchDeg + halfDiagDeg)
    let rowStart = Math.floor(OUTPUT_HEIGHT * (0.5 - pitchHi / 180))
    let rowEnd = Math.ceil(OUTPUT_HEIGHT * (0.5 - pitchLo / 180))
    rowStart = Math.max(0, rowStart)
    rowEnd = Math.min(OUTPUT_HEIGHT - 1, rowEnd)

    return {
      forward, right, up,
      yawDeg: p.yawDeg,
      pitchDeg: p.pitchDeg,
      gain: gains[i],
      image: p.image,
      rowStart, rowEnd,
      centerCol: Math.round(OUTPUT_WIDTH * (p.yawDeg / 360 + 0.5)),
    }
  })

  // ────────────────────────────────────────────────────────────────────────────
  // Step 3: Winner-Takes-All ownership map
  //
  // For each output pixel, determine which photo's center is angularly closest.
  // Store the winning photo index and the angular distance to the second-closest
  // photo (needed later to compute the seam blend zone).
  // ────────────────────────────────────────────────────────────────────────────
  progress(18, 'Tính vùng sở hữu pixel...')

  // ownerMap[pixel] = index of winning photo, -1 if uncovered
  const ownerMap = new Int16Array(OUTPUT_WIDTH * OUTPUT_HEIGHT).fill(-1)
  // distToOwner[pixel] = angular distance to owner's center
  const distToOwner = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT).fill(999)
  // distToSecond[pixel] = angular distance to second-closest photo center
  const distToSecond = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT).fill(999)

  // For each pixel, find the two closest photo centers
  for (let row = 0; row < OUTPUT_HEIGHT; row++) {
    const pitchOut = (0.5 - row / OUTPUT_HEIGHT) * 180
    for (let col = 0; col < OUTPUT_WIDTH; col++) {
      const yawOut = (col / OUTPUT_WIDTH - 0.5) * 360
      const pIdx = row * OUTPUT_WIDTH + col

      let best = -1
      let bestDist = 999
      let secondDist = 999

      for (let i = 0; i < poses.length; i++) {
        const dist = angularDistDeg(yawOut, pitchOut, poses[i].yawDeg, poses[i].pitchDeg)
        if (dist < bestDist) {
          secondDist = bestDist
          bestDist = dist
          best = i
        } else if (dist < secondDist) {
          secondDist = dist
        }
      }

      ownerMap[pIdx] = best
      distToOwner[pIdx] = bestDist
      distToSecond[pIdx] = secondDist
    }
    // Progress every 64 rows
    if (row % 64 === 0) {
      progress(18 + Math.round((row / OUTPUT_HEIGHT) * 15), 'Tính vùng sở hữu pixel...')
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Step 4: Render with narrow seam blending
  //
  // For each photo, project its pixels onto the equirectangular canvas. But each
  // pixel is only written if:
  //   (a) This photo owns the pixel (winner-takes-all), OR
  //   (b) The pixel is within SEAM_BLEND_DEG of the ownership boundary and this
  //       photo is the second-closest — in which case it contributes to a narrow
  //       crossfade blend.
  //
  // The blend weight at the seam is:
  //   ownerWeight = smoothstep(marginFromBorder / SEAM_BLEND_DEG)
  //   neighborWeight = 1 - ownerWeight
  // where marginFromBorder = (distToSecond - distToOwner) / 2
  // ────────────────────────────────────────────────────────────────────────────
  const colorR = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)
  const colorG = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)
  const colorB = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)
  const totalWeight = new Float32Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)

  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i]
    const { image, forward, right, up, gain, rowStart, rowEnd, centerCol } = pose

    for (let row = rowStart; row <= rowEnd; row++) {
      const pitchOut = (0.5 - row / OUTPUT_HEIGHT) * 180
      const cosPitch = Math.max(0.01, Math.cos((pitchOut * Math.PI) / 180))
      const yawSpanDeg = halfDiagDeg / cosPitch
      const colSpan =
        yawSpanDeg >= 180
          ? Math.floor(OUTPUT_WIDTH / 2)
          : Math.min(OUTPUT_WIDTH / 2, Math.ceil((OUTPUT_WIDTH * yawSpanDeg) / 360) + 2)

      for (let c = -colSpan; c <= colSpan; c++) {
        const col = ((centerCol + c) % OUTPUT_WIDTH + OUTPUT_WIDTH) % OUTPUT_WIDTH
        const pIdx = row * OUTPUT_WIDTH + col

        // Skip if this pixel is not owned by us and we're not a seam neighbor
        const owner = ownerMap[pIdx]
        if (owner !== i) {
          // Check if we're the second-closest and within seam zone
          const margin = (distToSecond[pIdx] - distToOwner[pIdx]) * 0.5
          if (margin > SEAM_BLEND_DEG) continue
          // We need to be a plausible contributor — check we're close enough
          const yawOut = (col / OUTPUT_WIDTH - 0.5) * 360
          const pitchOutHere = pitchOut
          const myDist = angularDistDeg(yawOut, pitchOutHere, pose.yawDeg, pose.pitchDeg)
          if (myDist > distToSecond[pIdx] + 1) continue
        }

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

        // Compute blend weight
        let weight: number
        if (owner === i) {
          // We own this pixel — compute how far we are from the seam border
          const margin = (distToSecond[pIdx] - distToOwner[pIdx]) * 0.5
          if (margin >= SEAM_BLEND_DEG) {
            // Far from any seam — full weight, no blending needed
            weight = 1.0
          } else {
            // Near seam — smoothstep fade
            const t = Math.max(0, margin / SEAM_BLEND_DEG)
            weight = t * t * (3 - 2 * t) // smoothstep
          }
        } else {
          // We're a neighbor contributing to the seam blend
          const margin = (distToSecond[pIdx] - distToOwner[pIdx]) * 0.5
          const t = Math.max(0, margin / SEAM_BLEND_DEG)
          weight = 1.0 - t * t * (3 - 2 * t) // inverse smoothstep
        }

        // Apply edge rolloff so we never sample from the very edge of a photo
        const edgeFade = Math.min(
          Math.max(0, 1 - Math.abs(nx)) * 5, 1,
          Math.max(0, 1 - Math.abs(ny)) * 5, 1,
        )
        weight *= edgeFade
        if (weight <= 1e-6) continue

        // Apply exposure gain
        const rr = Math.min(255, r * gain)
        const gg = Math.min(255, g * gain)
        const bb = Math.min(255, b * gain)

        colorR[pIdx] += rr * weight
        colorG[pIdx] += gg * weight
        colorB[pIdx] += bb * weight
        totalWeight[pIdx] += weight
      }
    }

    progress(
      35 + Math.round(((i + 1) / poses.length) * 50),
      `Đang ghép ảnh ${i + 1}/${poses.length}`,
    )
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Step 5: Finalize pixels & inpaint gaps
  // ────────────────────────────────────────────────────────────────────────────
  progress(88, 'Đang xuất ảnh kết quả...')
  const out = new Uint8ClampedArray(OUTPUT_WIDTH * OUTPUT_HEIGHT * 4)
  const covered = new Uint8Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)

  for (let p = 0; p < OUTPUT_WIDTH * OUTPUT_HEIGHT; p++) {
    const w = totalWeight[p]
    if (w > 0) {
      out[p * 4] = Math.round(colorR[p] / w)
      out[p * 4 + 1] = Math.round(colorG[p] / w)
      out[p * 4 + 2] = Math.round(colorB[p] / w)
      covered[p] = 1
    }
    out[p * 4 + 3] = 255
  }

  // Horizontal neighbor fill for tiny seam gaps
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

  // Vertical pole diffusion
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
