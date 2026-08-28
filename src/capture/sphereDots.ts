import type { FovDeg } from './cameraFov'

export interface SphereDot {
  id: string
  /** degrees, 0 = straight ahead, positive = turn right */
  yaw: number
  /** degrees, 0 = eye level, positive = look up, negative = look down */
  pitch: number
}

/**
 * Pitch of the top and bottom rings. At ±55° with a ~73° vertical FOV each ring reaches
 * past ±91°, so the zenith and nadir are genuinely covered — at the old ±42° the rings
 * stopped at ±78° and left polar caps that had to be faked by smearing the last row of
 * pixels. Pushing the rings out also *reduces* the shot count, because a ring nearer the
 * pole is a shorter circle and needs fewer shots to go all the way round.
 */
const PITCH_RANGE_DEG = 55
const MIN_ROWS = 3
/**
 * Overlap between neighbouring shots. The stitcher decides seams by which shot a pixel
 * sits deepest inside, so it stays gap-free even at modest overlap; 10% is enough to give
 * the seam cross-fade room to work while keeping the capture short.
 */
const DEFAULT_OVERLAP = 0.1

/**
 * Builds a grid of capture directions covering the full sphere for the given per-shot
 * field of view, spaced so adjacent shots overlap by `overlapFraction`. The point count is
 * derived from the FOV rather than fixed — a wider frame needs fewer shots, a narrower one
 * more — so switching the camera to a wider aspect ratio automatically shortens the
 * capture instead of silently under-covering the sphere.
 */
export function generateSphereDots(fov: FovDeg, overlapFraction = DEFAULT_OVERLAP): SphereDot[] {
  const usableV = fov.vertical * (1 - overlapFraction)
  const usableH = fov.horizontal * (1 - overlapFraction)

  // PITCH_RANGE_DEG is a half-range, so the span actually needing rows is twice it.
  const rowCount = Math.max(MIN_ROWS, Math.ceil((2 * PITCH_RANGE_DEG) / usableV) + 1)
  const colsAtEquator = Math.max(3, Math.ceil(360 / usableH))

  const dots: SphereDot[] = []
  for (let r = 0; r < rowCount; r++) {
    const pitch = rowCount === 1 ? 0 : -PITCH_RANGE_DEG + (2 * PITCH_RANGE_DEG * r) / (rowCount - 1)
    // Fewer shots are needed per row near the poles: a fixed angular horizontal FOV
    // sweeps a larger azimuthal range as pitch increases, since the "ring" you're
    // shooting around gets effectively foreshortened.
    const cols = Math.max(3, Math.round(colsAtEquator * Math.cos((pitch * Math.PI) / 180)))
    const step = 360 / cols
    const offset = r % 2 === 0 ? 0 : step / 2
    for (let i = 0; i < cols; i++) {
      dots.push({ id: `${r}-${i}`, yaw: (i * step + offset) % 360, pitch })
    }
  }
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
