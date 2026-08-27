export interface CapturedPhoto {
  id: string
  blob: Blob
  previewUrl: string
}

export type StitchWorkerRequest = {
  type: 'stitch'
  photos: Blob[]
}

export type StitchWorkerResponse =
  | { type: 'progress'; percent: number; message: string }
  | { type: 'result'; blob: Blob; width: number; height: number }
  | { type: 'error'; message: string; photoIndex?: number }
