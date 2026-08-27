export interface CapturedPhoto {
  id: string
  blob: Blob
  previewUrl: string
  /** Camera orientation at the moment of capture — degrees, same convention as sphereDots. */
  yawDeg: number
  pitchDeg: number
}

export interface PhotoOrientation {
  yawDeg: number
  pitchDeg: number
}

export type StitchWorkerRequest = {
  type: 'stitch'
  photos: { blob: Blob; yawDeg: number; pitchDeg: number }[]
  fov: { horizontal: number; vertical: number }
}

export type StitchWorkerResponse =
  | { type: 'progress'; percent: number; message: string }
  | { type: 'result'; blob: Blob; width: number; height: number }
  | { type: 'error'; message: string; photoIndex?: number }
