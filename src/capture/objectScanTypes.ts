export const MODEL_INPUT_SIZE = 640

export interface CameraBasis {
  right: [number, number, number]
  up: [number, number, number]
  forward: [number, number, number]
}

export interface Detection {
  /** Box centre and size, in pixels of the frame that was submitted. */
  cx: number
  cy: number
  w: number
  h: number
  score: number
  classId: number
}

export type ScanWorkerRequest =
  | { type: 'warmup' }
  | { type: 'detect'; frame: ImageData; basis: CameraBasis }

export type ScanWorkerResponse =
  | { type: 'ready' }
  | {
      type: 'detections'
      detections: Detection[]
      frameWidth: number
      frameHeight: number
      basis: CameraBasis
    }
  | { type: 'error'; message: string }

/**
 * The COCO classes worth spending an extra capture on: furniture and appliances large
 * enough, and close enough to where someone stands, to shift noticeably between two shots.
 * Small objects (remote, book, phone) are excluded — they are usually sitting on a larger
 * piece of furniture that is already in the list, and adding a shot for each would balloon
 * the capture for no benefit. Flat things like walls and doors aren't detected at all, and
 * don't need to be: without a sharp silhouette against a background they don't produce
 * visible ghosting even when close.
 */
export const FURNITURE_CLASS_IDS = new Set([
  56, // chair
  57, // couch
  58, // potted plant
  59, // bed
  60, // dining table
  61, // toilet
  62, // tv
  68, // microwave
  69, // oven
  71, // sink
  72, // refrigerator
  75, // vase
])

export const COCO_LABELS: Record<number, string> = {
  56: 'ghế',
  57: 'ghế sofa',
  58: 'chậu cây',
  59: 'giường',
  60: 'bàn ăn',
  61: 'bồn cầu',
  62: 'TV',
  68: 'lò vi sóng',
  69: 'lò nướng',
  71: 'bồn rửa',
  72: 'tủ lạnh',
  75: 'bình hoa',
}
