export const MODEL_INPUT_SIZE = 640

/**
 * How much of a frame an object may fill and still be worth a dedicated shot, measured on
 * its larger side.
 *
 * The point of aiming at an object is to put all of it comfortably inside one frame, so the
 * seam — which runs near frame edges — never crosses it. Past roughly this fraction the
 * object's own edges sit where the seam does even when centred, so the extra shot buys
 * nothing. Below the lower bound it is either genuinely small or far away; either way it
 * shifts too little between shots to be visible.
 */
export const MAX_APPARENT_SIZE = 0.6
export const MIN_APPARENT_SIZE = 0.12

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
 *
 * Beds are excluded outright. A dedicated shot only helps when the whole object fits inside
 * one frame — that is what stops any seam crossing it. A bed close enough to ghost is always
 * wider than a frame, so aiming at it cannot remove the seam, and it would spend one of the
 * limited extra-shot slots that a chair or table could actually be fixed by.
 */
export const FURNITURE_CLASS_IDS = new Set([
  56, // chair
  57, // couch
  58, // potted plant
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
  60: 'bàn ăn',
  61: 'bồn cầu',
  62: 'TV',
  68: 'lò vi sóng',
  69: 'lò nướng',
  71: 'bồn rửa',
  72: 'tủ lạnh',
  75: 'bình hoa',
}
