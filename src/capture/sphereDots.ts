import type { FovDeg } from './cameraFov'

export interface SphereDot {
  id: string
  /** degrees, 0 = straight ahead, positive = turn right */
  yaw: number
  /** degrees, 0 = eye level, positive = look up, negative = look down */
  pitch: number
}

// Pitch coverage: ±70° from eye level — reaches near ceiling and floor to ensure
// full 360° sphere coverage without blind spots.
const PITCH_RANGE_DEG = 70 // covers -70..+70
const MIN_ROWS = 3
/**
 * Overlap between neighbouring shots. 18% overlap provides comfortable margins
 * for both 4:3 and 16:9 phone sensors, yielding a fast, solid ~24-dot sweep.
 */
const DEFAULT_OVERLAP = 0.18

/**
 * Builds a grid of capture directions that fully covers a 360°×140° sweep with the given
 * per-shot field of view, spaced so adjacent shots overlap by `overlapFraction` (extra
 * overlap gives the feature-matching stitcher more shared detail to align on). Point count
 * is derived from the FOV, not fixed — a wider FOV (bigger sensor crop, more zoomed out)
 * needs fewer shots; a narrower one needs more.
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
