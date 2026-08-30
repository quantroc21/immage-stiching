/**
 * Measures, per shot, how usable each part of the frame is.
 *
 * The stitcher picks which shot owns an output pixel purely by geometry: the
 * frame that has the pixel furthest from its own edge wins. That keeps seams
 * down the middle of overlaps, but it is blind to whether the winning frame is
 * actually any good there. A pixel is usually covered by two or three shots, so
 * when one of them is motion blurred or has blown the window out, a better
 * sample is already sitting in another frame and gets thrown away.
 *
 * These maps are coarse on purpose. They are read once per output pixel per
 * candidate shot, so they have to be an array lookup, and the defects being
 * measured are much larger than a cell anyway.
 */

export interface RgbaLike {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface FrameQuality {
  cols: number
  rows: number
  /** Mean luma gradient in the cell. Comparable between shots of the same spot. */
  sharpness: Float32Array
  /** Fraction of the cell pinned at the top of the range, so detail is gone. */
  clipped: Float32Array
}

/** Source pixels per quality cell. */
export const QUALITY_CELL = 16
/** Luma at or above this has lost its detail to clipping. */
const CLIP_LUMA = 248
/**
 * How much of the score a fully blown cell gives up. High enough that a
 * correctly exposed shot wins even from well outside the overlap's middle.
 */
const CLIP_PENALTY = 0.75
/** Sharpness below this is texture-free, where the measurement is just noise. */
const SHARPNESS_FLOOR = 0.6

export function measureFrameQuality(image: RgbaLike): FrameQuality {
  const { width, height, data } = image
  const cols = Math.max(1, Math.ceil(width / QUALITY_CELL))
  const rows = Math.max(1, Math.ceil(height / QUALITY_CELL))
  const sharpness = new Float32Array(cols * rows)
  const clipped = new Float32Array(cols * rows)
  const counts = new Float32Array(cols * rows)

  const luma = new Float32Array(width * height)
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }

  for (let y = 1; y < height - 1; y++) {
    const cy = (y / QUALITY_CELL) | 0
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx = luma[i + 1] - luma[i - 1]
      const gy = luma[i + width] - luma[i - width]
      const cell = cy * cols + ((x / QUALITY_CELL) | 0)
      sharpness[cell] += Math.abs(gx) + Math.abs(gy)
      if (luma[i] >= CLIP_LUMA) clipped[cell]++
      counts[cell]++
    }
  }

  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) {
      sharpness[i] /= counts[i]
      clipped[i] /= counts[i]
    }
  }

  // Soften both maps before anyone reads them. A cell boundary is an arbitrary
  // grid line, and letting the score step across it lets ownership flip along
  // it too, which paints rectangular patches into the panorama.
  smooth(sharpness, cols, rows)
  smooth(clipped, cols, rows)
  return { cols, rows, sharpness, clipped }
}

/** Separable 3-tap blur, run once in each direction. */
function smooth(values: Float32Array, cols: number, rows: number): void {
  const tmp = new Float32Array(values.length)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const l = values[y * cols + Math.max(0, x - 1)]
      const r = values[y * cols + Math.min(cols - 1, x + 1)]
      tmp[i] = 0.25 * l + 0.5 * values[i] + 0.25 * r
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const u = tmp[Math.max(0, y - 1) * cols + x]
      const d = tmp[Math.min(rows - 1, y + 1) * cols + x]
      values[i] = 0.25 * u + 0.5 * tmp[i] + 0.25 * d
    }
  }
}

/**
 * A scale for sharpness that suits this particular set of shots, so the
 * comparison does not depend on how textured the room happens to be.
 */
export function sharpnessReference(maps: FrameQuality[]): number {
  const all: number[] = []
  for (const map of maps) for (const v of map.sharpness) if (v > 0) all.push(v)
  if (all.length === 0) return 1
  all.sort((a, b) => a - b)
  return Math.max(SHARPNESS_FLOOR, all[(all.length * 0.6) | 0])
}

/**
 * How much this shot's claim on a pixel is worth, as a multiplier on its
 * geometric margin. Around 1 for an ordinary sample.
 *
 * Two shots are only ever compared at the same output pixel, where they see the
 * same thing, so raw gradient is a fair comparison between them. On a blank
 * wall both read near zero and the term cancels, which is the right answer:
 * there is nothing there to be sharp about.
 */
export function qualityMultiplier(
  quality: FrameQuality,
  nx: number,
  ny: number,
  reference: number,
): number {
  // Bilinear, not nearest: reading one cell makes the multiplier a staircase,
  // and a staircase in the score is a staircase in the seam.
  const fx = Math.min(quality.cols - 1, Math.max(0, (0.5 + nx * 0.5) * quality.cols - 0.5))
  const fy = Math.min(quality.rows - 1, Math.max(0, (0.5 - ny * 0.5) * quality.rows - 0.5))
  const x0 = fx | 0
  const y0 = fy | 0
  const x1 = Math.min(quality.cols - 1, x0 + 1)
  const y1 = Math.min(quality.rows - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const bilinear = (map: Float32Array): number =>
    (map[y0 * quality.cols + x0] * (1 - tx) + map[y0 * quality.cols + x1] * tx) * (1 - ty) +
    (map[y1 * quality.cols + x0] * (1 - tx) + map[y1 * quality.cols + x1] * tx) * ty

  // Cubed rather than linear: a plain soft threshold saturates, and two shots
  // of the same spot then score within a few percent of each other even when
  // one is visibly blurred. Cubing steepens the curve around the reference so a
  // real difference in focus actually moves the seam.
  const sharp = bilinear(quality.sharpness)
  const s3 = sharp * sharp * sharp
  const r3 = reference * reference * reference
  const detail = s3 / (s3 + r3)
  return (0.5 + 0.9 * detail) * (1 - CLIP_PENALTY * bilinear(quality.clipped))
}
