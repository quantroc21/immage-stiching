/**
 * Browsers don't expose a camera's real optical field of view, MediaTrackSettings /
 * MediaTrackCapabilities has no FOV field, on any platform. So instead of guessing the
 * physical lens FOV, we treat the *displayed* video frame itself as the source of truth:
 * whatever angular slice of the world the live preview shows IS the FOV of one captured
 * photo, and we derive it from the video's own aspect ratio once its metadata loads.
 *
 * `assumedVerticalFovDeg` is the one number that can't be measured from the browser and
 * has to be calibrated, typical rear cameras on modern phones sit around 60-75° vertical
 * FOV in portrait. Adjust this constant if real-device testing shows the grid is too
 * sparse (dots overlap less than expected) or too dense (more shots than needed).
 */
export const ASSUMED_VERTICAL_FOV_DEG = 73
/**
 * Starting guess when the ultra-wide lens is in use instead of the main one, it sees
 * noticeably more of the scene (~120° diagonal is a commonly cited spec across phones with
 * one), so keeping the main-lens guess here would give the stitcher's own FOV calibration
 * (see stitchWorker.ts) a much bigger error to correct than it needs to. That calibration -
 * sweeping a scale factor and keeping whichever makes overlapping shots agree best, is what
 * actually pins the number down; this constant only has to be in the right neighbourhood.
 */
export const ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG = 100

export interface FovDeg {
  horizontal: number
  vertical: number
}

/** Derives horizontal FOV from a known vertical FOV and the frame's width/height ratio. */
export function fovFromAspect(verticalFovDeg: number, widthOverHeight: number): FovDeg {
  const vFovRad = (verticalFovDeg * Math.PI) / 180
  const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * widthOverHeight)
  return { horizontal: (hFovRad * 180) / Math.PI, vertical: verticalFovDeg }
}
