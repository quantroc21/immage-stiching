/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import { FURNITURE_CLASS_IDS, MODEL_INPUT_SIZE, type Detection, type ScanWorkerRequest, type ScanWorkerResponse } from './objectScanTypes'

declare const self: DedicatedWorkerGlobalScope

/** Below this the detection is too uncertain to be worth spending an extra capture on. */
const SCORE_THRESHOLD = 0.4
/** Boxes overlapping more than this are treated as the same object. */
const NMS_IOU = 0.45
/** YOLOv8 emits 8400 candidate boxes for a 640px input. */
const ANCHOR_COUNT = 8400
const CLASS_COUNT = 80

let sessionPromise: Promise<ort.InferenceSession> | null = null

function loadSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    // Both the runtime and the model are served from our own origin so the scan keeps
    // working offline, like the rest of the installed app. Single-threaded on purpose:
    // multi-threaded WASM needs cross-origin isolation headers, which would have to be
    // applied to the whole site for this one feature.
    ort.env.wasm.wasmPaths = '/ort/'
    ort.env.wasm.numThreads = 1
    sessionPromise = ort.InferenceSession.create('/models/yolov8n.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  }
  return sessionPromise
}

/** Letterboxes into the model's fixed 640x640 input, preserving aspect ratio. */
function preprocess(image: ImageData): { tensor: ort.Tensor; scale: number; padX: number; padY: number } {
  const size = MODEL_INPUT_SIZE
  const scale = Math.min(size / image.width, size / image.height)
  const drawW = Math.round(image.width * scale)
  const drawH = Math.round(image.height * scale)
  const padX = Math.floor((size - drawW) / 2)
  const padY = Math.floor((size - drawH) / 2)

  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không tạo được canvas context trong worker')
  // Grey rather than black: a black border reads as real image content the model may try
  // to explain, whereas mid-grey is closer to "nothing here".
  ctx.fillStyle = 'rgb(114,114,114)'
  ctx.fillRect(0, 0, size, size)

  const source = new OffscreenCanvas(image.width, image.height)
  const sctx = source.getContext('2d')
  if (!sctx) throw new Error('Không tạo được canvas context trong worker')
  sctx.putImageData(image, 0, 0)
  ctx.drawImage(source, padX, padY, drawW, drawH)

  const { data } = ctx.getImageData(0, 0, size, size)
  const plane = size * size
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    input[i] = data[i * 4] / 255
    input[plane + i] = data[i * 4 + 1] / 255
    input[2 * plane + i] = data[i * 4 + 2] / 255
  }
  return { tensor: new ort.Tensor('float32', input, [1, 3, size, size]), scale, padX, padY }
}

function intersectionOverUnion(a: Detection, b: Detection): number {
  const ax1 = a.cx - a.w / 2
  const ay1 = a.cy - a.h / 2
  const ax2 = a.cx + a.w / 2
  const ay2 = a.cy + a.h / 2
  const bx1 = b.cx - b.w / 2
  const by1 = b.cy - b.h / 2
  const bx2 = b.cx + b.w / 2
  const by2 = b.cy + b.h / 2
  const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1))
  const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1))
  const intersection = overlapX * overlapY
  const union = a.w * a.h + b.w * b.h - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * YOLOv8's output is [1, 84, 8400] laid out channel-first: rows 0-3 are the box centre and
 * size, rows 4-83 are the per-class scores. There is no separate objectness score — the
 * class score is the confidence.
 */
function parseDetections(
  output: Float32Array,
  scale: number,
  padX: number,
  padY: number,
  frameWidth: number,
  frameHeight: number,
): Detection[] {
  const candidates: Detection[] = []
  for (let i = 0; i < ANCHOR_COUNT; i++) {
    let bestScore = 0
    let bestClass = -1
    for (let c = 0; c < CLASS_COUNT; c++) {
      const score = output[(4 + c) * ANCHOR_COUNT + i]
      if (score > bestScore) {
        bestScore = score
        bestClass = c
      }
    }
    if (bestScore < SCORE_THRESHOLD || !FURNITURE_CLASS_IDS.has(bestClass)) continue

    // Undo the letterbox so coordinates refer to the original frame again.
    const cx = (output[i] - padX) / scale
    const cy = (output[ANCHOR_COUNT + i] - padY) / scale
    const w = output[2 * ANCHOR_COUNT + i] / scale
    const h = output[3 * ANCHOR_COUNT + i] / scale
    if (cx < 0 || cy < 0 || cx > frameWidth || cy > frameHeight) continue

    candidates.push({ cx, cy, w, h, score: bestScore, classId: bestClass })
  }

  candidates.sort((a, b) => b.score - a.score)
  const kept: Detection[] = []
  for (const candidate of candidates) {
    if (!kept.some((k) => intersectionOverUnion(k, candidate) > NMS_IOU)) kept.push(candidate)
  }
  return kept
}

self.onmessage = async (event: MessageEvent<ScanWorkerRequest>) => {
  const message = event.data
  try {
    if (message.type === 'warmup') {
      await loadSession()
      const reply: ScanWorkerResponse = { type: 'ready' }
      self.postMessage(reply)
      return
    }

    if (message.type === 'detect') {
      const session = await loadSession()
      const { tensor, scale, padX, padY } = preprocess(message.frame)
      const output = await session.run({ images: tensor })
      const raw = output[session.outputNames[0]].data as Float32Array
      const detections = parseDetections(raw, scale, padX, padY, message.frame.width, message.frame.height)
      const reply: ScanWorkerResponse = {
        type: 'detections',
        detections,
        frameWidth: message.frame.width,
        frameHeight: message.frame.height,
        basis: message.basis,
      }
      self.postMessage(reply)
    }
  } catch (err) {
    const reply: ScanWorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : 'Lỗi không xác định khi quét vật thể',
    }
    self.postMessage(reply)
  }
}
