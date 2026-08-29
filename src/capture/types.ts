export interface CameraVectors {
  right: [number, number, number]
  up: [number, number, number]
  forward: [number, number, number]
}

export interface CapturedPhoto {
  id: string
  blob: Blob
  previewUrl: string
  /** Camera orientation at the moment of capture, degrees, same convention as sphereDots. */
  yawDeg: number
  pitchDeg: number
  /** True 3D camera unit vectors at capture time (accounts for roll and sensor orientation). */
  vectors?: CameraVectors
}

export interface PhotoOrientation {
  yawDeg: number
  pitchDeg: number
  vectors?: CameraVectors
}

export type StitchWorkerRequest = {
  type: 'stitch'
  photos: {
    blob: Blob
    yawDeg: number
    pitchDeg: number
    vectors?: CameraVectors
  }[]
  fov: { horizontal: number; vertical: number }
}

export type StitchWorkerResponse =
  | { type: 'progress'; percent: number; message: string }
  | { type: 'result'; blob: Blob; width: number; height: number }
  | { type: 'error'; message: string; photoIndex?: number }
