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

export interface Scene {
  id: string
  name: string
  /** Equirectangular panorama, kept as a Blob so it survives a reload. */
  image: Blob
  hotspots: Hotspot[]
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
