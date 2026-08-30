/**
 * Timings for the warp between rooms, shared with the exported tour so both
 * move identically.
 *
 * The room being left accelerates hard and only begins to dissolve once it is
 * already rushing, fading it from the first frame reads as a cross-fade, not
 * as travel. The arriving room decelerates into place over a longer beat, so
 * the move lands instead of stopping dead.
 */
export const FLIGHT = {
  /** The rush forward. Short and violent, this is the whole effect. */
  warpMs: 300,
  fadeMs: 170,
  fadeDelayMs: 130,
  settleMs: 480,
  /** Longest the flight waits for the next panorama before revealing it. */
  revealGraceMs: 300,
  /** How far past the viewer the room being left flies. */
  outScale: 3.2,
  /** How close the arriving room starts, so it settles outward into place. */
  inScale: 1.35,
  outEase: 'cubic-bezier(0.55, 0, 1, 0.45)',
  inEase: 'cubic-bezier(0.12, 0.9, 0.25, 1)',
} as const
