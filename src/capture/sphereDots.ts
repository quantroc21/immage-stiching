import type { FovDeg } from './cameraFov'

export interface SphereDot {
  id: string
  /** degrees, 0 = straight ahead, positive = turn right */
  yaw: number
  /** degrees, 0 = eye level, positive = look up, negative = look down */
  pitch: number
}

/**
 * Overlap between neighbouring shots. Seams are chosen by which shot a pixel sits deepest
 * inside, so coverage never gaps, but the assumed field of view is a *calibrated guess*,
 * and a thin overlap leaves no slack when that guess is off. At 10% the top ring's frames
 * met with barely 5° to spare; a few degrees of FOV error there opened real holes.
 */
/**
 * Fraction of a shot its neighbour is asked to cover.
 *
 * This is a design input, not the overlap that comes out. Ring and column counts
 * are whole numbers, so the grid only moves when the request crosses a step. On
 * the ultra-wide it stays at 3/6/3 for every value from 0.17 to 0.25, and the
 * overlap actually achieved is 28% across and 56% up, already past what raising
 * this asks for. On the main lens 0.22 is where the grid jumps from 16 shots to
 * 32, doubling the capture with nothing gained on the lens this app prefers.
 *
 * Measure the realised spacing before changing it; the number here does not tell
 * you what you get.
 */
export const DEFAULT_OVERLAP = 0.17
/**
 * How far past the pole the outer rings should reach. Aiming a few degrees beyond means the
 * zenith and nadir land in the *interior* of those frames rather than on their top edge -
 * where lens distortion is worst and the blend weight is lowest. Rings that merely touched
 * the pole were why the sky came out as a smeared black cap.
 */
const POLE_MARGIN_DEG = 4
/** Rings never crowd closer to the horizon than this, or the capture stops being 3 rows. */
const MIN_RING_PITCH_DEG = 25

/**
 * Builds a grid of capture directions covering the full sphere for the given per-shot
 * field of view, spaced so adjacent shots overlap by `overlapFraction`. The point count is
 * derived from the FOV rather than fixed, a wider frame needs fewer shots, a narrower one
 * more, so switching the camera to a wider aspect ratio automatically shortens the
 * capture instead of silently under-covering the sphere.
 */
export function generateSphereDots(fov: FovDeg, overlapFraction = DEFAULT_OVERLAP): SphereDot[] {
  const usableV = fov.vertical * (1 - overlapFraction)
  const usableH = fov.horizontal * (1 - overlapFraction)

  // Push the outer rings out until their frames clear the poles, but never further apart
  // than the vertical overlap allows, or the rings would stop meeting each other.
  const reachForPole = 90 - fov.vertical / 2 + POLE_MARGIN_DEG
  const ringPitch = Math.max(MIN_RING_PITCH_DEG, Math.min(reachForPole, usableV))
  // A tall frame clears the pole in one ring; a narrow one needs stepping stones.
  const ringsPerSide = Math.max(1, Math.ceil(reachForPole / usableV))

  const pitches: number[] = [0]
  for (let r = 1; r <= ringsPerSide; r++) {
    const pitch = (ringPitch * r) / ringsPerSide
    pitches.push(pitch, -pitch)
  }
  pitches.sort((a, b) => a - b)

  // Rounded up to an even number so the sparser polar rings can be an exact fraction of it,
  // which is what lets every ring line up into columns.
  const rawCols = Math.max(4, Math.ceil(360 / usableH))
  const colsAtEquator = rawCols % 2 === 0 ? rawCols : rawCols + 1

  const dots: SphereDot[] = []
  pitches.forEach((pitch, r) => {
    // Rings nearer a pole are shorter circles, so one frame's width covers more of them and
    // fewer shots are needed, but the count is snapped to a divisor of the equator's, so
    // each polar shot still sits directly above an equator shot instead of between two.
    const ideal = colsAtEquator * Math.cos((pitch * Math.PI) / 180)
    let cols = colsAtEquator
    let closest = Infinity
    for (let candidate = 2; candidate <= colsAtEquator; candidate++) {
      if (colsAtEquator % candidate !== 0) continue
      const distance = Math.abs(candidate - ideal)
      if (distance < closest) {
        closest = distance
        cols = candidate
      }
    }
    const step = 360 / cols
    // No half-step stagger between rings. Staggering is the right way to pack *circles*, but
    // a camera frame is a rectangle, and rectangles tile flush. Offsetting them drives each
    // frame's vertical edge into the middle of the frame above, creating three-way T-joints
    // exactly where the overlap is thinnest, the worst place to put a seam. Aligned rings
    // also give the on-screen guidance a clean up/down/left/right lattice to point along,
    // which is the "+" of dots the reference app shows around your current heading.
    for (let i = 0; i < cols; i++) {
      dots.push({ id: `${r}-${i}`, yaw: (i * step) % 360, pitch })
    }
  })
  return dots
}

/** Smallest signed angular difference between two angles in degrees, result in [-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let diff = (a - b) % 360
  if (diff > 180) diff -= 360
  if (diff < -180) diff += 360
  return diff
}

/** Great-circle-ish angular distance (degrees) between two yaw/pitch directions, treated as small-angle. */
export function angularDistanceDeg(yaw1: number, pitch1: number, yaw2: number, pitch2: number): number {
  const dYaw = angleDiffDeg(yaw1, yaw2) * Math.cos((((pitch1 + pitch2) / 2) * Math.PI) / 180)
  const dPitch = pitch1 - pitch2
  return Math.sqrt(dYaw * dYaw + dPitch * dPitch)
}
