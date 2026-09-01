export interface Hotspot {
  id: string
  /** Horizontal angle in degrees, -180..180, as reported by Pannellum. */
  yaw: number
  /** Vertical angle in degrees, -90..90. */
  pitch: number
  /** Scene this hotspot walks the visitor into. */
  targetSceneId: string
  /** Optional label shown on hover; falls back to the target scene name. */
  label?: string
}

/**
 * One frame as it came off the camera, kept so a room can be stitched again.
 *
 * Without these a capture is a one-shot deal: no re-stitching with different
 * settings, and no way to compare two stitchers on the same input, which means
 * every experiment costs a fresh shooting session in a room that has changed.
 * They are ~500KB each at the 1920x1440 the camera is asked for, so a room
 * carries roughly 6MB of them.
 */
export interface SourceShot {
  blob: Blob
  yawDeg: number
  pitchDeg: number
  /** True camera axes at the shutter, which the stitcher prefers over the angles. */
  vectors?: {
    right: [number, number, number]
    up: [number, number, number]
    forward: [number, number, number]
  }
}

export interface Scene {
  id: string
  name: string
  /** Equirectangular panorama, kept as a Blob so it survives a reload. */
  image: Blob
  hotspots: Hotspot[]
  /** The frames this panorama was built from. Absent on rooms captured before
   *  they were kept, and on rooms added from an existing image. */
  sources?: SourceShot[]
  /** Where the camera looks when this scene opens. */
  initialYaw: number
  initialPitch: number
  createdAt: number
}

/** A scene with a live object URL for the current page session. */
export interface SceneWithUrl extends Scene {
  url: string
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
