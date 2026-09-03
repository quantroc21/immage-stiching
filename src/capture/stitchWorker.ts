/// <reference lib="webworker" />
import type { StitchWorkerRequest, StitchWorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

const OUTPUT_WIDTH = 4096
const OUTPUT_HEIGHT = 2048

/** Degrees of pitch at the centre of a given output row. */
function rowPitchDeg(row: number): number {
  return (0.5 - row / OUTPUT_HEIGHT) * 180
}

/**
 * The equirectangular canvas is composited a horizontal band at a time. Holding only one
 * band of float accumulators (instead of five full-canvas ones) is what keeps this inside
 * a phone's worker memory budget, the previous full-canvas version allocated ~240MB of
 * Float32 buffers and stalled mid-stitch.
 */
const STRIP_ROWS = 256

/**
 * Source photos are downscaled the moment they're decoded. A 4K capture decodes to ~33MB
 * of RGBA, and 18 of those is ~600MB, but at a 4096px-wide output, one shot spanning ~58°
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
 * high-frequency detail must stay winner-takes-all sharp, the wide, invisible part of the
 * transition is handled by the low-frequency band instead.
 */
const SEAM_BLEND_MARGIN = 0.1

const BBOX_MARGIN_DEG = 3
const VIGNETTE_BINS = 12
/**
 * Grid coarseness used while measuring the lens' true field of view. Finer than the colour
 * grid, because a degree of mis-scaling only shifts content by a few pixels and the search
 * has to be able to see that shift.
 */
const CALIBRATION_DIV = 4
/** Fraction of the worst-disagreeing overlap samples ignored when measuring lens geometry. */
const DISAGREEMENT_TRIM = 0.35

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
    // Vignette only ever darkens, so the correction only ever brightens, and it's capped
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
  /** Per-channel exposure gain, see solveGains for why it is not one number. */
  gainRGB: [number, number, number]
  /**
   * This shot alone, averaged onto the coarse low-frequency grid (RGB interleaved), with
   * `lowMask` marking the cells it actually reaches. Subtracting it from the shot's own
   * pixels leaves pure detail with no brightness or colour of its own, which is what lets
   * the sharp band be composited winner-takes-all without carrying each shot's exposure
   * into the result as a hard-edged patch.
   */
  low: Float32Array
  lowMask: Uint8Array
  image: RgbaImage
  /**
   * How far past its own pitch this shot may claim ownership, upward and
   * downward, before fading out. Infinity toward the pole/nadir side of the
   * outermost ring, where nothing else is aimed and full native reach is what
   * clears the pole; finite toward a neighbouring ring, at half the measured
   * spacing to that ring, so a wide lens's own far edge cannot outcompete a
   * shot aimed directly at the same content from the ring next door.
   */
  reachUpDeg: number
  reachDownDeg: number
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
 * largest margin puts every seam down the middle of an overlap and, unlike ranking shots
 * by distance-to-centre, can never hand a pixel to a shot whose rectangle doesn't
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
  gainRGB: readonly [number, number, number],
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

  // Vignette is a property of the lens, not the scene, so it is achromatic and multiplies
  // all three channels alike; the exposure gain is per channel because the mismatch it
  // corrects is not (see solveGains).
  const vg = vignetteGainAt(vignette, Math.sqrt(nx * nx + ny * ny) / Math.SQRT2)
  out[0] = (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * gainRGB[0] * vg
  out[1] = (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * gainRGB[1] * vg
  out[2] = (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * gainRGB[2] * vg
}


// ── Multi-band blend of the low-frequency grid ─────────────────────────────
//
// Burt & Adelson's Laplacian-pyramid blend, run on the coarse colour grid rather than on
// the full canvas (where it would cost tens of MB per shot). Each pyramid level is blended
// with its own, progressively blurrier, weights: fine levels hand over across the feather,
// the coarsest level hands over across several hundred pixels either side of the seam,
// well past the overlap itself. A shot whose colour never quite matched its neighbours
// (auto white balance answers differently for every frame) is then not a patch with a
// border but a drift nobody can locate. Where only one shot reaches, the reconstruction
// returns that shot's own low band exactly, so the sharp band above it stays untouched.

const PYRAMID_LEVELS = 5
const REDUCE_KERNEL = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]

interface Level {
  w: number
  h: number
  rgb: Float32Array // w*h*3
  weight: Float32Array // w*h, blend weight
  valid: Float32Array // w*h, how much of the reduce footprint held real content
}

function levelDims(level: number): { w: number; h: number } {
  return { w: LOW_WIDTH >> level, h: LOW_HEIGHT >> level }
}

/** Masked 5-tap reduce, wrapping in x, clamping in y. Content spreads a little past the
 *  mask at every level, which is what lets coarse levels blend beyond a shot's edge. */
function reduceMasked(src: Level): Level {
  const w = src.w >> 1
  const h = src.h >> 1
  const rgb = new Float32Array(w * h * 3)
  const weight = new Float32Array(w * h)
  const valid = new Float32Array(w * h)
  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      let r = 0
      let g = 0
      let b = 0
      let m = 0
      let wt = 0
      for (let dy = -2; dy <= 2; dy++) {
        const y = Math.min(src.h - 1, Math.max(0, 2 * Y + dy))
        const ky = REDUCE_KERNEL[dy + 2]
        for (let dx = -2; dx <= 2; dx++) {
          const x = (((2 * X + dx) % src.w) + src.w) % src.w
          const k = ky * REDUCE_KERNEL[dx + 2]
          const i = y * src.w + x
          const v = src.valid[i]
          if (v > 0) {
            r += src.rgb[i * 3] * k * v
            g += src.rgb[i * 3 + 1] * k * v
            b += src.rgb[i * 3 + 2] * k * v
            m += k * v
          }
          wt += src.weight[i] * k
        }
      }
      const o = Y * w + X
      if (m > 0) {
        rgb[o * 3] = r / m
        rgb[o * 3 + 1] = g / m
        rgb[o * 3 + 2] = b / m
        valid[o] = 1
      }
      weight[o] = wt
    }
  }
  return { w, h, rgb, weight, valid }
}

/** Bilinear ×2 expand of an RGB grid, wrapping in x, clamping in y. */
function expandRgb(src: Float32Array, sw: number, sh: number, dw: number, dh: number, out: Float32Array): void {
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) / 2 - 0.5
    const y0 = Math.floor(fy)
    const ty = fy - y0
    const ya = Math.min(sh - 1, Math.max(0, y0))
    const yb = Math.min(sh - 1, Math.max(0, y0 + 1))
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) / 2 - 0.5
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const xa = ((x0 % sw) + sw) % sw
      const xb = (xa + 1) % sw
      const i00 = (ya * sw + xa) * 3
      const i10 = (ya * sw + xb) * 3
      const i01 = (yb * sw + xa) * 3
      const i11 = (yb * sw + xb) * 3
      const w00 = (1 - tx) * (1 - ty)
      const w10 = tx * (1 - ty)
      const w01 = (1 - tx) * ty
      const w11 = tx * ty
      const o = (y * dw + x) * 3
      out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11
      out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11
      out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11
    }
  }
}

/** Accumulators for the blended pyramid, one numerator/denominator pair per level. */
interface BlendPyramid {
  num: Float32Array[]
  den: Float32Array[]
}

function newBlendPyramid(): BlendPyramid {
  const num: Float32Array[] = []
  const den: Float32Array[] = []
  for (let k = 0; k < PYRAMID_LEVELS; k++) {
    const { w, h } = levelDims(k)
    num.push(new Float32Array(w * h * 3))
    den.push(new Float32Array(w * h))
  }
  return { num, den }
}

/** Splits one shot's low grid into a Laplacian pyramid and folds it into the blend. */
function accumulateShot(blend: BlendPyramid, rgb: Float32Array, valid: Float32Array, weight: Float32Array): void {
  const levels: Level[] = [{ w: LOW_WIDTH, h: LOW_HEIGHT, rgb, weight, valid }]
  for (let k = 1; k < PYRAMID_LEVELS; k++) levels.push(reduceMasked(levels[k - 1]))

  for (let k = 0; k < PYRAMID_LEVELS; k++) {
    const lv = levels[k]
    const n = lv.w * lv.h
    let up: Float32Array | null = null
    if (k + 1 < PYRAMID_LEVELS) {
      up = new Float32Array(n * 3)
      expandRgb(levels[k + 1].rgb, levels[k + 1].w, levels[k + 1].h, lv.w, lv.h, up)
    }
    const num = blend.num[k]
    const den = blend.den[k]
    for (let i = 0; i < n; i++) {
      const wt = lv.weight[i]
      if (wt <= 0 || lv.valid[i] <= 0) continue
      const lapR = lv.rgb[i * 3] - (up ? up[i * 3] : 0)
      const lapG = lv.rgb[i * 3 + 1] - (up ? up[i * 3 + 1] : 0)
      const lapB = lv.rgb[i * 3 + 2] - (up ? up[i * 3 + 2] : 0)
      num[i * 3] += lapR * wt
      num[i * 3 + 1] += lapG * wt
      num[i * 3 + 2] += lapB * wt
      den[i] += wt
    }
  }
}

/** Normalises each blended level and collapses the pyramid back to a full low grid. */
function collapseBlend(blend: BlendPyramid): Float32Array {
  let acc: Float32Array | null = null
  for (let k = PYRAMID_LEVELS - 1; k >= 0; k--) {
    const { w, h } = levelDims(k)
    const n = w * h
    const level = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const d = blend.den[k][i]
      if (d <= 0) continue
      level[i * 3] = blend.num[k][i * 3] / d
      level[i * 3 + 1] = blend.num[k][i * 3 + 1] / d
      level[i * 3 + 2] = blend.num[k][i * 3 + 2] / d
    }
    if (acc) {
      const { w: cw, h: ch } = levelDims(k + 1)
      const up = new Float32Array(n * 3)
      expandRgb(acc, cw, ch, w, h, up)
      for (let i = 0; i < n * 3; i++) level[i] += up[i]
    }
    acc = level
  }
  return acc as Float32Array
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

  // Mutable because the assumed field of view is only a starting guess, it gets measured
  // from the photos themselves a few lines below.
  let halfTanH = Math.tan((fov.horizontal * Math.PI) / 360)
  let halfTanV = Math.tan((fov.vertical * Math.PI) / 360)
  let halfDiagDeg = 0.5 * Math.hypot(fov.horizontal, fov.vertical) + BBOX_MARGIN_DEG

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
      gainRGB: [1, 1, 1],
      low: new Float32Array(0),
      lowMask: new Uint8Array(0),
      image: p.image,
      rowStart,
      rowEnd,
      centerCol: Math.round(OUTPUT_WIDTH * (p.yawDeg / 360 + 0.5)),
      // Filled in below, once every pose's pitch is known.
      reachUpDeg: Infinity,
      reachDownDeg: Infinity,
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

  // ── Measuring the lens, then matching exposure ─────────────────────────────
  // Both steps lean on the same observation: wherever two shots overlap, they are looking
  // at the same piece of the world, so they ought to agree there.
  const MAX_OVERLAP = 4
  const UNIT_GAIN: readonly [number, number, number] = [1, 1, 1]

  interface OverlapSamples {
    ids: Int16Array
    lums: Float32Array
    counts: Uint8Array
    cells: number
  }

  /**
   * Projects every shot onto a coarse grid and records who covers each cell, and how bright.
   * `step` skips cells and `fast` drops to nearest-neighbour sampling, both only used by the
   * field-of-view search, which runs this ~18 times and cares about the overall shape of the
   * disagreement curve rather than any single cell.
   */
  const collectOverlaps = (
    div: number,
    htH: number,
    htV: number,
    step = 1,
    fast = false,
    channel: 0 | 1 | 2 | 3 = 3,
  ): OverlapSamples => {
    const gw = OUTPUT_WIDTH / div
    const gh = OUTPUT_HEIGHT / div
    const cells = gw * gh
    const ids = new Int16Array(cells * MAX_OVERLAP).fill(-1)
    const lums = new Float32Array(cells * MAX_OVERLAP)
    const counts = new Uint8Array(cells)
    const probe = new Float32Array(3)

    const hFovDeg = (2 * Math.atan(htH) * 180) / Math.PI
    const vFovDeg = (2 * Math.atan(htV) * 180) / Math.PI
    const diag = 0.5 * Math.hypot(hFovDeg, vFovDeg) + BBOX_MARGIN_DEG

    for (let i = 0; i < poses.length; i++) {
      const pose = poses[i]
      const pitchLo = Math.max(-90, pose.pitchDeg - diag)
      const pitchHi = Math.min(90, pose.pitchDeg + diag)
      const gyStart = Math.max(0, Math.floor((OUTPUT_HEIGHT * (0.5 - pitchHi / 180)) / div))
      const gyEnd = Math.min(gh - 1, Math.ceil((OUTPUT_HEIGHT * (0.5 - pitchLo / 180)) / div))
      const centerGx = Math.round((OUTPUT_WIDTH * (pose.yawDeg / 360 + 0.5)) / div)

      const img = pose.image
      for (let gy = gyStart; gy <= gyEnd; gy += step) {
        const row = Math.min(OUTPUT_HEIGHT - 1, Math.round((gy + 0.5) * div))
        const sp = sinPitch[row]
        const cp = cosPitch[row]
        const yawSpan = diag / Math.max(0.01, cp)
        const span =
          yawSpan >= 180 ? Math.floor(gw / 2) : Math.min(Math.floor(gw / 2), Math.ceil((gw * yawSpan) / 360) + 2)
        for (let c = -span; c <= span; c += step) {
          const gx = ((centerGx + c) % gw + gw) % gw
          const col = Math.min(OUTPUT_WIDTH - 1, Math.round((gx + 0.5) * div))
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, htH, htV)
          if (!hit) continue
          const idx = gy * gw + gx
          const k = counts[idx]
          if (k >= MAX_OVERLAP) continue

          let lum: number
          if (fast) {
            const px = Math.min(img.width - 1, Math.max(0, ((0.5 + hit.nx * 0.5) * img.width) | 0))
            const py = Math.min(img.height - 1, Math.max(0, ((0.5 - hit.ny * 0.5) * img.height) | 0))
            const o = (py * img.width + px) * 4
            const vg = vignetteGainAt(vignette, Math.sqrt(hit.nx * hit.nx + hit.ny * hit.ny) / Math.SQRT2)
            lum =
              channel === 3
                ? ((0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) * vg) / 255
                : (img.data[o + channel] * vg) / 255
          } else {
            sampleColour(pose, hit.nx, hit.ny, vignette, UNIT_GAIN, probe)
            lum = channel === 3 ? (0.299 * probe[0] + 0.587 * probe[1] + 0.114 * probe[2]) / 255 : probe[channel] / 255
          }

          ids[idx * MAX_OVERLAP + k] = i
          lums[idx * MAX_OVERLAP + k] = lum
          counts[idx] = k + 1
        }
      }
    }
    return { ids, lums, counts, cells }
  }

  /**
   * Per-shot gains solved so shots agree *where they overlap*, not by dragging every shot to
   * one global average brightness. That distinction is the point: a frame pointed at a
   * window is genuinely brighter than one pointed at the floor, and equalising their means
   * bends the panorama's luminance toward the horizon, measured as the eye-level band
   * reading ~11 levels too bright and the poles ~8 too dark. (Brown & Lowe.)
   */
  const solveGains = (s: OverlapSamples): Float64Array => {
    const n = poses.length
    const pairCount = new Float64Array(n * n)
    const pairSum = new Float64Array(n * n)
    for (let p = 0; p < s.cells; p++) {
      const k = s.counts[p]
      if (k < 2) continue
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          if (a === b) continue
          const i = s.ids[p * MAX_OVERLAP + a]
          const j = s.ids[p * MAX_OVERLAP + b]
          pairCount[i * n + j]++
          pairSum[i * n + j] += s.lums[p * MAX_OVERLAP + a]
        }
      }
    }

    const SIGMA_N2 = 0.04 * 0.04
    // Brown & Lowe's 0.1 assumes a camera whose exposure barely moves between frames. A
    // phone re-meters every shot: measured on a real room, the frame aimed at a glossy
    // white wardrobe came out 35% darker in red than its neighbour (26% in green, 16% in
    // blue), and pairs elsewhere in the same capture differ by up to 2x. With the prior at
    // 0.1 the solver stopped at 1.17 for that frame and left a visible patch; at 0.3 the
    // overlap evidence wins and the prior only still guards against a lone bad pair.
    const SIGMA_G2 = 0.3 * 0.3
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

    // Keep the exposure the camera actually chose, and stop one bad frame dragging the rest.
    let mean = 0
    for (let i = 0; i < n; i++) mean += g[i]
    mean = mean / n || 1
    for (let i = 0; i < n; i++) g[i] = Math.max(0.4, Math.min(2.5, g[i] / mean))
    return g
  }

  /**
   * How much overlapping shots still disagree once their exposure difference is removed.
   *
   * Deliberately a *trimmed* mean rather than a plain one. Rotating around your body means
   * near objects genuinely sit in different places in different shots, so a minority of
   * samples disagree wildly no matter how well the lens is modelled. Averaging those in lets
   * parallax outvote geometry, measured on a scene with furniture 1.2m away, it dragged the
   * field-of-view estimate 9% below the true answer. Throwing away the worst DISAGREEMENT_TRIM
   * of samples leaves the far-field majority, which is what actually pins the geometry down.
   */
  const overlapDisagreement = (s: OverlapSamples, g: Float64Array): number => {
    const BINS = 512
    const histogram = new Float64Array(BINS)
    let count = 0
    for (let p = 0; p < s.cells; p++) {
      const k = s.counts[p]
      if (k < 2) continue
      for (let a = 0; a < k; a++) {
        for (let b = a + 1; b < k; b++) {
          const i = s.ids[p * MAX_OVERLAP + a]
          const j = s.ids[p * MAX_OVERLAP + b]
          const diff = Math.abs(g[i] * s.lums[p * MAX_OVERLAP + a] - g[j] * s.lums[p * MAX_OVERLAP + b])
          let bin = (diff * BINS) | 0
          if (bin >= BINS) bin = BINS - 1
          histogram[bin]++
          count++
        }
      }
    }
    if (count === 0) return Infinity

    const keep = count * (1 - DISAGREEMENT_TRIM)
    let seen = 0
    let sum = 0
    for (let bin = 0; bin < BINS && seen < keep; bin++) {
      const take = Math.min(histogram[bin], keep - seen)
      sum += take * ((bin + 0.5) / BINS)
      seen += take
    }
    return seen > 0 ? sum / seen : Infinity
  }

  /**
   * The declared field of view is a calibrated guess, and everything downstream is built on
   * it: get it wrong and every shot is painted across the wrong angular width, so features
   * land in the wrong place and the overlaps disagree, which is what doubled objects at the
   * seams. But the photos themselves say what the right answer is. Sweep a range of scale
   * factors and keep whichever one makes the overlaps agree best; that is a measurement, not
   * an assumption.
   */
  progress(15, 'Hiệu chỉnh góc nhìn ống kính...')
  const baseHalfTanH = halfTanH
  const baseHalfTanV = halfTanV
  const scoreScale = (scale: number): number => {
    const samples = collectOverlaps(CALIBRATION_DIV, baseHalfTanH * scale, baseHalfTanV * scale, 2, true)
    return overlapDisagreement(samples, solveGains(samples))
  }

  let bestScale = 1
  let bestDisagreement = Infinity
  const sweep = (from: number, to: number, stepSize: number) => {
    for (let scale = from; scale <= to + 1e-9; scale += stepSize) {
      if (scale <= 0.6 || scale >= 1.45) continue
      const disagreement = scoreScale(scale)
      if (disagreement < bestDisagreement) {
        bestDisagreement = disagreement
        bestScale = scale
      }
    }
  }
  // Coarse, then two refinements around the winner. A single fine sweep of the whole range
  // would cost several times as much to land in the same place.
  sweep(0.76, 1.2, 0.08)
  sweep(bestScale - 0.07, bestScale + 0.07, 0.02)
  sweep(bestScale - 0.015, bestScale + 0.015, 0.005)
  halfTanH = baseHalfTanH * bestScale
  halfTanV = baseHalfTanV * bestScale
  const calibratedHFov = (2 * Math.atan(halfTanH) * 180) / Math.PI
  const calibratedVFov = (2 * Math.atan(halfTanV) * 180) / Math.PI
  halfDiagDeg = 0.5 * Math.hypot(calibratedHFov, calibratedVFov) + BBOX_MARGIN_DEG

  // The calibrated field of view changes how far each shot reaches, so its row bounds move.
  for (const pose of poses) {
    const pitchLo = Math.max(-90, pose.pitchDeg - halfDiagDeg)
    const pitchHi = Math.min(90, pose.pitchDeg + halfDiagDeg)
    pose.rowStart = Math.max(0, Math.floor(OUTPUT_HEIGHT * (0.5 - pitchHi / 180)))
    pose.rowEnd = Math.min(OUTPUT_HEIGHT - 1, Math.ceil(OUTPUT_HEIGHT * (0.5 - pitchLo / 180)))
  }

  progress(20, 'Cân bằng phơi sáng giữa các ảnh...')
  // One gain per channel, not one per shot. A phone re-runs auto white balance on every
  // frame, and a frame full of a glossy white surface or a warm lamp gets a different
  // answer from its neighbour, so the two disagree by a different factor in each channel.
  // Matching brightness alone (a single luma gain) leaves that colour cast in place: on a
  // real capture the wardrobe frame still sat 9 levels bluer than the wall around it after
  // the luma solve. Solving R, G and B independently, with the same overlap evidence, is
  // exactly a white-balance correction.
  const gainR = solveGains(collectOverlaps(LOW_DIV, halfTanH, halfTanV, 1, false, 0))
  const gainG = solveGains(collectOverlaps(LOW_DIV, halfTanH, halfTanV, 1, false, 1))
  const gainB = solveGains(collectOverlaps(LOW_DIV, halfTanH, halfTanV, 1, false, 2))
  poses.forEach((pose, i) => {
    pose.gainRGB = [gainR[i], gainG[i], gainB[i]]
  })

  /**
   * Ring reach, measured from this capture's own poses rather than assumed
   * from the capture grid, so it holds for any set of shots. A wide lens's
   * outer ring naturally reaches deep into its neighbour's territory (100deg
   * vertical FOV from a ring 44deg off centre reaches 6deg past the equator's
   * own centre on a real capture); capping that reach at half the measured
   * ring spacing keeps each ring's own well-aimed, non-distorted centre in
   * charge of its own territory, and the SEAM_BLEND_MARGIN feathering already
   * in place still handles the actual join at the boundary.
   */
  const ringMeans: number[] = []
  for (const pitch of [...poses.map((p) => p.pitchDeg)].sort((a, b) => a - b)) {
    const last = ringMeans[ringMeans.length - 1]
    if (last === undefined || pitch - last > 15) ringMeans.push(pitch)
    else ringMeans[ringMeans.length - 1] = (last + pitch) / 2
  }
  const RING_REACH_SLACK_DEG = 6
  /**
   * A capped shot keeps this fraction of its margin rather than dropping to zero. Between
   * two shots of the outer ring, the ring's own coverage thins to the extreme corners of
   * both frames, and at half the ring spacing plus slack it can run out altogether; on a
   * real capture that left a wedge below the equator ring where the equator shot, still
   * well inside its own frame, had been excluded outright. At 0.3 it loses to any
   * neighbour-ring shot with real margin and still takes over where that ring only has
   * its frame corners to offer.
   */
  const RING_REACH_FLOOR = 0.3
  for (const pose of poses) {
    let ringIdx = 0
    let bestDist = Infinity
    ringMeans.forEach((m, i) => {
      const d = Math.abs(m - pose.pitchDeg)
      if (d < bestDist) {
        bestDist = d
        ringIdx = i
      }
    })
    const own = ringMeans[ringIdx]
    let up = Infinity
    let down = Infinity
    ringMeans.forEach((m) => {
      if (m > own + 1) up = Math.min(up, (m - own) / 2)
      else if (m < own - 1) down = Math.min(down, (own - m) / 2)
    })
    pose.reachUpDeg = up
    pose.reachDownDeg = down
  }

  function ringFalloff(pose: PhotoPose, pitchDeg: number, slackDeg = RING_REACH_SLACK_DEG): number {
    const offset = pitchDeg - pose.pitchDeg
    const reach = offset >= 0 ? pose.reachUpDeg : pose.reachDownDeg
    if (!Number.isFinite(reach)) return 1
    const a = Math.abs(offset)
    if (a <= reach) return 1
    if (a >= reach + slackDeg) return RING_REACH_FLOOR
    const t = (a - reach) / slackDeg
    return RING_REACH_FLOOR + (1 - RING_REACH_FLOOR) * (1 - t * t * (3 - 2 * t))
  }
  /** The low band wants a wide, gentle hand-over between rings, not the sharp band's. */
  const RING_REACH_SLACK_LOW_DEG = 14

  // ── Dời đường ghép ra khỏi vật thể ────────────────────────────────────────
  //
  // Vết ghép khó chịu nhất không phải do màu hay do mờ, mà do đường cắt đi
  // XUYÊN QUA một vật: nửa trên cái đồng hồ lấy từ khung này, nửa dưới lấy từ
  // khung kia, lệch nhau khoảng 20px vì parallax, nên nhìn thành hai cái đồng hồ.
  // Ngay cạnh nó là mảng tường trơn, cắt qua đó thì không ai nhận ra.
  //
  // Cách làm: ở chỗ các khung ĐỒNG Ý với nhau (tường trơn), không phạt ai cả, để
  // biên độ khung hình tự quyết định như cũ, nên đường ghép tự do nằm ở đó. Ở chỗ
  // các khung BẤT ĐỒNG (vật thể bị lệch), khung nào lệch xa ý kiến chung thì bị
  // phạt, nên khung đang chiếm ưu thế giữ luôn trọn vật thể và đường cắt bị đẩy ra
  // vùng đồng thuận. Không pixel nào bị dịch chuyển, nên không có nguy cơ bẻ cong
  // đường thẳng như hướng uốn ảnh đã thử và bỏ (nhánh stitcher-warp-experiment).
  const SEAM_DIV = 8
  const SEAM_W = OUTPUT_WIDTH / SEAM_DIV
  const SEAM_H = OUTPUT_HEIGHT / SEAM_DIV
  /** Bao nhiêu biên độ khung hình mà một khung phải trả cho việc bất đồng. */
  const SEAM_AVOID = 0.30
  /** Biên độ tối thiểu còn lại sau khi phạt, để không bao giờ tạo lỗ trống. */
  const SEAM_FLOOR = 0.02
  /**
   * Dải hoà chéo hẹp lại theo mức bất đồng. Hoà chéo chỉ có ích khi hai khung
   * nhìn giống nhau: lúc đó nó giấu đường nối. Khi hai khung nhìn KHÁC nhau vì
   * vật thể lệch chỗ do parallax, hoà chéo chính là thứ tạo ra bản mờ chồng lên
   * mà người dùng thấy là "dư ra một cái đồng hồ nữa". Ở đó cắt dứt khoát, lấy
   * trọn một khung, thì hết chồng.
   */
  const SEAM_BLEND_MIN = 0.012
  const seamPenalty = poses.map(() => new Float32Array(SEAM_W * SEAM_H))

  if (SEAM_AVOID > 0) {
    progress(21, 'Chọn đường ghép né vật thể...')
    const probe = new Float32Array(3)
    const cols = new Float32Array(poses.length * 3)
    const marg = new Float32Array(poses.length)
    const consensus = new Float32Array(3)
    for (let gy = 0; gy < SEAM_H; gy++) {
      const row = Math.min(OUTPUT_HEIGHT - 1, gy * SEAM_DIV + (SEAM_DIV >> 1))
      const sp = sinPitch[row]
      const cp = cosPitch[row]
      for (let gx = 0; gx < SEAM_W; gx++) {
        const col = Math.min(OUTPUT_WIDTH - 1, gx * SEAM_DIV + (SEAM_DIV >> 1))
        let n = 0
        let wsum = 0
        consensus[0] = 0; consensus[1] = 0; consensus[2] = 0
        for (let i = 0; i < poses.length; i++) {
          const pose = poses[i]
          marg[i] = -1
          if (row < pose.rowStart || row > pose.rowEnd) continue
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
          if (!hit) continue
          sampleColour(pose, hit.nx, hit.ny, vignette, pose.gainRGB, probe)
          cols[i * 3] = probe[0]; cols[i * 3 + 1] = probe[1]; cols[i * 3 + 2] = probe[2]
          const w = hit.margin * ringFalloff(pose, rowPitchDeg(row))
          if (w <= 0) continue
          marg[i] = w
          consensus[0] += probe[0] * w; consensus[1] += probe[1] * w; consensus[2] += probe[2] * w
          wsum += w
          n++
        }
        if (n < 2 || wsum <= 0) continue
        // Ý kiến chung nghiêng về khung đang ở sâu trong khung hình của nó, nên
        // khung đó bất đồng ít hơn và giữ được vật thể, thay vì hai khung cùng bị
        // phạt ngang nhau và đường ghép vẫn nằm nguyên chỗ cũ.
        consensus[0] /= wsum; consensus[1] /= wsum; consensus[2] /= wsum
        const g = gy * SEAM_W + gx
        for (let i = 0; i < poses.length; i++) {
          if (marg[i] < 0) continue
          const d =
            (Math.abs(cols[i * 3] - consensus[0]) +
              Math.abs(cols[i * 3 + 1] - consensus[1]) +
              Math.abs(cols[i * 3 + 2] - consensus[2])) /
            (3 * 255)
          seamPenalty[i][g] = Math.min(1, d * 6)
        }
      }
    }

    // Làm mượt để quyền sở hữu thành từng mảng liền lạc, không vụn thành đốm.
    const tmp = new Float32Array(SEAM_W * SEAM_H)
    for (const pen of seamPenalty) {
      for (let pass = 0; pass < 3; pass++) {
        for (let gy = 0; gy < SEAM_H; gy++) for (let gx = 0; gx < SEAM_W; gx++) {
          let a = 0
          let k = 0
          for (let oy = -1; oy <= 1; oy++) {
            const yy = gy + oy
            if (yy < 0 || yy >= SEAM_H) continue
            for (let ox = -1; ox <= 1; ox++) { a += pen[yy * SEAM_W + ((gx + ox + SEAM_W) % SEAM_W)]; k++ }
          }
          tmp[gy * SEAM_W + gx] = a / k
        }
        pen.set(tmp)
      }
    }
  }

  /** Đọc mức phạt của một khung, nội suy song tuyến tính. */
  const seamPenaltyAt = (idx: number, row: number, col: number): number => {
    const fx = col / SEAM_DIV - 0.5
    const fy = row / SEAM_DIV - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const xa = ((x0 % SEAM_W) + SEAM_W) % SEAM_W
    const xb = (xa + 1) % SEAM_W
    const ya = Math.max(0, Math.min(SEAM_H - 1, y0))
    const yb = Math.max(0, Math.min(SEAM_H - 1, y0 + 1))
    const pen = seamPenalty[idx]
    return (
      pen[ya * SEAM_W + xa] * (1 - tx) * (1 - ty) +
      pen[ya * SEAM_W + xb] * tx * (1 - ty) +
      pen[yb * SEAM_W + xa] * (1 - tx) * ty +
      pen[yb * SEAM_W + xb] * tx * ty
    )
  }

  // ── Low-frequency band: wide feathered blend on a coarse grid ───────────────
  progress(22, 'Dựng dải màu nền...')
  const LOW_CELLS = LOW_WIDTH * LOW_HEIGHT
  const lowW = new Float32Array(LOW_CELLS)
  const rgb = new Float32Array(3)
  const blend = newBlendPyramid()

  /**
   * Nearest-valid fill, a few cells at a time. Bilinear reads near the edge of a shot's
   * coverage (or of the whole capture's, at the poles) touch cells no shot reached; those
   * borrow from their nearest reached neighbour rather than reading as black.
   */
  const dilateGrid = (grid: Float32Array, mask: Uint8Array, passes: number) => {
    const next = new Uint8Array(LOW_CELLS)
    for (let pass = 0; pass < passes; pass++) {
      let changed = false
      next.set(mask)
      for (let y = 0; y < LOW_HEIGHT; y++) {
        for (let x = 0; x < LOW_WIDTH; x++) {
          const i = y * LOW_WIDTH + x
          if (mask[i]) continue
          let r = 0
          let g = 0
          let b = 0
          let n = 0
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy
            if (yy < 0 || yy >= LOW_HEIGHT) continue
            for (let dx = -1; dx <= 1; dx++) {
              const j = yy * LOW_WIDTH + ((x + dx + LOW_WIDTH) % LOW_WIDTH)
              if (!mask[j]) continue
              r += grid[j * 3]
              g += grid[j * 3 + 1]
              b += grid[j * 3 + 2]
              n++
            }
          }
          if (n === 0) continue
          grid[i * 3] = r / n
          grid[i * 3 + 1] = g / n
          grid[i * 3 + 2] = b / n
          next[i] = 1
          changed = true
        }
      }
      mask.set(next)
      if (!changed) break
    }
  }

  // Each cell is the mean of a 3x3 spread of samples across it, not the single pixel at its
  // centre. The low band is subtracted from the sharp band later, and a point-sampled grid
  // would leave 16px-scale texture noise in that difference wherever two shots hand over.
  const SUB = 3
  const subOffsets = [2, 8, 13] // output pixels into a 16px cell, evenly spread

  for (const pose of poses) {
    pose.low = new Float32Array(LOW_CELLS * 3)
    pose.lowMask = new Uint8Array(LOW_CELLS)
    const poseWeight = new Float32Array(LOW_CELLS)
    const lowRowStart = Math.max(0, Math.floor(pose.rowStart / LOW_DIV))
    const lowRowEnd = Math.min(LOW_HEIGHT - 1, Math.ceil(pose.rowEnd / LOW_DIV))
    for (let ly = lowRowStart; ly <= lowRowEnd; ly++) {
      const rowC = Math.min(OUTPUT_HEIGHT - 1, ly * LOW_DIV + 8)
      const span = Math.ceil(colSpanForRow(rowC) / LOW_DIV)
      const centerLowCol = Math.round(pose.centerCol / LOW_DIV)
      const wRing = ringFalloff(pose, rowPitchDeg(rowC), RING_REACH_SLACK_LOW_DEG)
      for (let c = -span; c <= span; c++) {
        const lx = ((centerLowCol + c) % LOW_WIDTH + LOW_WIDTH) % LOW_WIDTH
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        let centreW = 0
        for (let sy = 0; sy < SUB; sy++) {
          const row = Math.min(OUTPUT_HEIGHT - 1, ly * LOW_DIV + subOffsets[sy])
          const sp = sinPitch[row]
          const cp = cosPitch[row]
          for (let sx = 0; sx < SUB; sx++) {
            const col = Math.min(OUTPUT_WIDTH - 1, lx * LOW_DIV + subOffsets[sx])
            const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
            if (!hit) continue
            sampleColour(pose, hit.nx, hit.ny, vignette, pose.gainRGB, rgb)
            r += rgb[0]
            g += rgb[1]
            b += rgb[2]
            n++
            // Broad pyramid feather from the centre sample, deliberately gentle, since only
            // this band's low frequencies survive into the result.
            if (sy === 1 && sx === 1) centreW = (1 - Math.abs(hit.nx)) * (1 - Math.abs(hit.ny))
          }
        }
        if (n === 0) continue
        const idx = ly * LOW_WIDTH + lx
        pose.low[idx * 3] = r / n
        pose.low[idx * 3 + 1] = g / n
        pose.low[idx * 3 + 2] = b / n
        pose.lowMask[idx] = 1
        // A cell only partly inside the frame still gets this shot's own low band (above),
        // but weighs into the shared one by how much of it the frame actually covers.
        const w = (centreW > 0 ? centreW : 0.02) * wRing * (n / (SUB * SUB))
        poseWeight[idx] = w
        lowW[idx] += w
      }
    }
    dilateGrid(pose.low, pose.lowMask, 2)
    const valid = new Float32Array(LOW_CELLS)
    for (let i = 0; i < LOW_CELLS; i++) valid[i] = pose.lowMask[i]
    accumulateShot(blend, pose.low, valid, poseWeight)
  }

  const lowRGB = collapseBlend(blend)
  const lowMask = new Uint8Array(LOW_CELLS)
  for (let i = 0; i < LOW_CELLS; i++) if (lowW[i] > 0) lowMask[i] = 1
  dilateGrid(lowRGB, lowMask, LOW_HEIGHT)

  /**
   * Wherever a shot has no low band of its own, it borrows the shared one. The sharp band
   * subtracts a shot's own low band from its pixels, so a cell left at zero would subtract
   * nothing and the shot's full brightness would be added on top of the shared low band --
   * measured near the zenith, where a shot's coverage of the coarse grid runs out a few
   * rows before its coverage of the output does, that blew a pixel from 147 to 297 and
   * clipped it to white, drawing a bright cap over the ceiling. Falling back to the shared
   * band makes the subtraction and the addition cancel exactly, so the worst case is simply
   * the winning shot's own pixel, uncorrected, instead of a blow-out.
   */
  for (const pose of poses) {
    for (let i = 0; i < LOW_CELLS; i++) {
      if (pose.lowMask[i]) continue
      pose.low[i * 3] = lowRGB[i * 3]
      pose.low[i * 3 + 1] = lowRGB[i * 3 + 1]
      pose.low[i * 3 + 2] = lowRGB[i * 3 + 2]
    }
  }

  /** Bilinear read of an RGB low grid at output-pixel position, wrapping in x, clamping in y. */
  const sampleLowRGB = (grid: Float32Array, col: number, row: number, out: Float32Array) => {
    const lx = col / LOW_DIV - 0.5
    const ly = row / LOW_DIV - 0.5
    const x0 = Math.floor(lx)
    const y0 = Math.floor(ly)
    const fx = lx - x0
    const fy = ly - y0
    const xa = ((x0 % LOW_WIDTH) + LOW_WIDTH) % LOW_WIDTH
    const xb = (xa + 1) % LOW_WIDTH
    const ya = Math.min(LOW_HEIGHT - 1, Math.max(0, y0))
    const yb = Math.min(LOW_HEIGHT - 1, Math.max(0, y0 + 1))
    const i00 = (ya * LOW_WIDTH + xa) * 3
    const i10 = (ya * LOW_WIDTH + xb) * 3
    const i01 = (yb * LOW_WIDTH + xa) * 3
    const i11 = (yb * LOW_WIDTH + xb) * 3
    const w00 = (1 - fx) * (1 - fy)
    const w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy
    const w11 = fx * fy
    out[0] = grid[i00] * w00 + grid[i10] * w10 + grid[i01] * w01 + grid[i11] * w11
    out[1] = grid[i00 + 1] * w00 + grid[i10 + 1] * w10 + grid[i01 + 1] * w01 + grid[i11 + 1] * w11
    out[2] = grid[i00 + 2] * w00 + grid[i10 + 2] * w10 + grid[i01 + 2] * w01 + grid[i11 + 2] * w11
  }

  // ── High-frequency band: sharp composite, one strip at a time ───────────────
  //
  // What each shot contributes here is its pixel minus its own low band, i.e. detail only.
  // The earlier version composited full colours and then tried to subtract the seams back
  // out by blurring the difference between the two bands, but that blur was ~20px wide, so
  // any exposure or colour step surviving the gain solve was not dissolved, it was turned
  // into a crisp outline running the length of the seam. Measured on a real capture, a
  // 46-level step at the wardrobe frame's border drew the whole frame as a shield-shaped
  // patch. Detail-only contributions have no step to leave behind: wherever one shot is
  // alone, the result is its own pixel exactly, and across an overlap the only thing that
  // changes is the shared low band, which hands over across the full overlap width.
  const out = new Uint8ClampedArray(OUTPUT_WIDTH * OUTPUT_HEIGHT * 4)
  const covered = new Uint8Array(OUTPUT_WIDTH * OUTPUT_HEIGHT)

  const stripPixels = OUTPUT_WIDTH * STRIP_ROWS
  const bestMargin = new Float32Array(stripPixels)
  const accR = new Float32Array(stripPixels)
  const accG = new Float32Array(stripPixels)
  const accB = new Float32Array(stripPixels)
  const accW = new Float32Array(stripPixels)
  const lowProbe = new Float32Array(3)

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

    // Pass 1, how deep inside its own frame is the best-placed shot for each pixel.
    for (const pose of active) {
      const poseIdx = poses.indexOf(pose)
      const from = Math.max(pose.rowStart, stripStart)
      const to = Math.min(pose.rowEnd, stripEnd - 1)
      for (let row = from; row <= to; row++) {
        const sp = sinPitch[row]
        const cp = cosPitch[row]
        const span = colSpanForRow(row)
        const rowBase = (row - stripStart) * OUTPUT_WIDTH
        // Ring reach is the same for every column in this row, so it is worth
        // computing once per row rather than once per pixel.
        const rowFalloff = ringFalloff(pose, rowPitchDeg(row))
        for (let c = -span; c <= span; c++) {
          const col = ((pose.centerCol + c) % OUTPUT_WIDTH + OUTPUT_WIDTH) % OUTPUT_WIDTH
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
          if (!hit) continue
          const idx = rowBase + col
          const margin = Math.max(
            SEAM_FLOOR,
            hit.margin * rowFalloff - SEAM_AVOID * seamPenaltyAt(poseIdx, row, col),
          )
          if (margin > bestMargin[idx]) bestMargin[idx] = margin
        }
      }
    }

    // Pass 2, every shot within a hair of the best margin contributes; everything else is
    // skipped outright, so detail comes from a single frame almost everywhere.
    for (const pose of active) {
      const poseIdx = poses.indexOf(pose)
      const from = Math.max(pose.rowStart, stripStart)
      const to = Math.min(pose.rowEnd, stripEnd - 1)
      for (let row = from; row <= to; row++) {
        const sp = sinPitch[row]
        const cp = cosPitch[row]
        const span = colSpanForRow(row)
        const rowBase = (row - stripStart) * OUTPUT_WIDTH
        const rowFalloff = ringFalloff(pose, rowPitchDeg(row))
        for (let c = -span; c <= span; c++) {
          const col = ((pose.centerCol + c) % OUTPUT_WIDTH + OUTPUT_WIDTH) % OUTPUT_WIDTH
          const hit = projectPixel(pose, sinYaw[col] * cp, sp, -cosYaw[col] * cp, halfTanH, halfTanV)
          if (!hit) continue
          const idx = rowBase + col
          const margin = Math.max(
            SEAM_FLOOR,
            hit.margin * rowFalloff - SEAM_AVOID * seamPenaltyAt(poseIdx, row, col),
          )
          const gap = bestMargin[idx] - margin
          const blendWidth = Math.max(
            SEAM_BLEND_MIN,
            SEAM_BLEND_MARGIN * (1 - seamPenaltyAt(poseIdx, row, col)),
          )
          if (gap >= blendWidth) continue
          const weight = 1 - smoothstep(gap / blendWidth)
          if (weight <= 1e-4) continue
          sampleColour(pose, hit.nx, hit.ny, vignette, pose.gainRGB, rgb)
          sampleLowRGB(pose.low, col, row, lowProbe)
          accR[idx] += (rgb[0] - lowProbe[0]) * weight
          accG[idx] += (rgb[1] - lowProbe[1]) * weight
          accB[idx] += (rgb[2] - lowProbe[2]) * weight
          accW[idx] += weight
        }
      }
    }

    // Merge the bands: shared low frequencies plus the winner's detail.
    for (let i = 0; i < used; i++) {
      const w = accW[i]
      if (w <= 0) continue
      const row = stripStart + ((i / OUTPUT_WIDTH) | 0)
      const col = i % OUTPUT_WIDTH
      sampleLowRGB(lowRGB, col, row, lowProbe)
      const p = (row * OUTPUT_WIDTH + col) * 4
      out[p] = accR[i] / w + lowProbe[0]
      out[p + 1] = accG[i] / w + lowProbe[1]
      out[p + 2] = accB[i] / w + lowProbe[2]
      covered[row * OUTPUT_WIDTH + col] = 1
    }

    progress(
      25 + Math.round(((stripEnd / OUTPUT_HEIGHT) * 65)),
      `Đang ghép toàn cảnh ${Math.round((stripEnd / OUTPUT_HEIGHT) * 100)}%`,
    )
  }

  for (let p = 0; p < OUTPUT_WIDTH * OUTPUT_HEIGHT; p++) out[p * 4 + 3] = 255

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
