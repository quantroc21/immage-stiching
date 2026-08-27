/// <reference lib="webworker" />
import type { StitchWorkerRequest, StitchWorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cv?: Promise<any> | any
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cvPromise: Promise<any> | null = null
async function loadCv() {
  if (!cvPromise) {
    cvPromise = fetch('/opencv/opencv.js')
      .then((res) => res.text())
      .then((code) => {
        // opencv.js is a legacy UMD bundle (not an ES module), so it can't go through
        // Vite's `import()` analysis for a public/ asset. Executing it in the global
        // worker scope is the standard way to load it into a module worker.
        // eslint-disable-next-line no-new-func
        new Function(code)()
        if (!self.cv) throw new Error('opencv.js không khởi tạo được biến toàn cục "cv"')
        // opencv.js's UMD wrapper already invokes its module factory, so `cv` here
        // is the pending-init Promise itself, not a callable — just await it.
        return self.cv
      })
  }
  return cvPromise
}

function post(message: StitchWorkerResponse) {
  self.postMessage(message)
}

function progress(percent: number, message: string) {
  post({ type: 'progress', percent, message })
}

class StitchError extends Error {
  photoIndex?: number
  constructor(message: string, photoIndex?: number) {
    super(message)
    this.photoIndex = photoIndex
  }
}

async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không tạo được canvas context trong worker')
  ctx.drawImage(bitmap, 0, 0)
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  bitmap.close()
  return data
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function matToBlob(cvNS: any, mat: any): Promise<{ blob: Blob; width: number; height: number }> {
  const rgba = new cvNS.Mat()
  cvNS.cvtColor(mat, rgba, cvNS.COLOR_BGR2RGBA)
  const imageData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows)
  rgba.delete()
  const canvas = new OffscreenCanvas(imageData.width, imageData.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không tạo được canvas context trong worker')
  ctx.putImageData(imageData, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return { blob, width: imageData.width, height: imageData.height }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stitch(cvNS: any, photos: Blob[]) {
  if (photos.length < 2) throw new StitchError('Cần ít nhất 2 tấm ảnh để ghép')

  progress(5, 'Đang giải mã ảnh...')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mats: any[] = []
  for (let i = 0; i < photos.length; i++) {
    const imageData = await blobToImageData(photos[i])
    mats.push(cvNS.matFromImageData(imageData))
    progress(5 + Math.round(((i + 1) / photos.length) * 15), `Đọc ảnh ${i + 1}/${photos.length}`)
  }

  progress(20, 'Đang tìm đặc trưng ảnh...')
  const orb = new cvNS.ORB(2500)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keypoints: any[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const descriptors: any[] = []
  for (let i = 0; i < mats.length; i++) {
    const gray = new cvNS.Mat()
    cvNS.cvtColor(mats[i], gray, cvNS.COLOR_RGBA2GRAY)
    const kp = new cvNS.KeyPointVector()
    const desc = new cvNS.Mat()
    orb.detectAndCompute(gray, new cvNS.Mat(), kp, desc)
    keypoints.push(kp)
    descriptors.push(desc)
    gray.delete()
    if (desc.rows < 8) {
      throw new StitchError(`Ảnh ${i + 1} không đủ chi tiết để nhận diện (quá mờ hoặc quá trơn)`, i)
    }
    progress(20 + Math.round(((i + 1) / mats.length) * 20), `Tìm đặc trưng ${i + 1}/${mats.length}`)
  }

  progress(40, 'Đang khớp và ước lượng góc ghép...')
  const matcher = new cvNS.BFMatcher(cvNS.NORM_HAMMING, false)
  // Homography chaining: homographies[i] maps image i's pixel coords -> image 0's coord space
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const homographies: any[] = [cvNS.Mat.eye(3, 3, cvNS.CV_64F)]

  for (let i = 1; i < mats.length; i++) {
    const knnMatches = new cvNS.DMatchVectorVector()
    matcher.knnMatch(descriptors[i], descriptors[i - 1], knnMatches, 2)

    const srcPts: number[] = []
    const dstPts: number[] = []
    for (let j = 0; j < knnMatches.size(); j++) {
      const pair = knnMatches.get(j)
      if (pair.size() < 2) continue
      const m0 = pair.get(0)
      const m1 = pair.get(1)
      if (m0.distance < 0.75 * m1.distance) {
        const p1 = keypoints[i].get(m0.queryIdx).pt
        const p2 = keypoints[i - 1].get(m0.trainIdx).pt
        srcPts.push(p1.x, p1.y)
        dstPts.push(p2.x, p2.y)
      }
    }
    knnMatches.delete()

    const pairCount = srcPts.length / 2
    if (pairCount < 8) {
      throw new StitchError(
        `Không đủ điểm chung giữa ảnh ${i} và ảnh ${i + 1}. Có thể 2 ảnh này bị xoay lệch quá nhiều hoặc thiếu vùng chồng lấn — hãy chụp lại 1 trong 2 tấm.`,
        i,
      )
    }

    const srcMat = cvNS.matFromArray(pairCount, 1, cvNS.CV_32FC2, srcPts)
    const dstMat = cvNS.matFromArray(pairCount, 1, cvNS.CV_32FC2, dstPts)
    const mask = new cvNS.Mat()
    const relativeH = cvNS.findHomography(srcMat, dstMat, cvNS.RANSAC, 4, mask)
    srcMat.delete()
    dstMat.delete()
    mask.delete()

    if (relativeH.empty()) {
      relativeH.delete()
      throw new StitchError(`Không ước lượng được phép biến đổi giữa ảnh ${i} và ảnh ${i + 1}. Hãy chụp lại.`, i)
    }

    const chained = new cvNS.Mat()
    cvNS.gemm(homographies[i - 1], relativeH, 1, new cvNS.Mat(), 0, chained)
    relativeH.delete()
    homographies.push(chained)

    progress(40 + Math.round((i / (mats.length - 1)) * 20), `Ghép ảnh ${i + 1}/${mats.length}`)
  }

  progress(60, 'Đang tính khung ảnh toàn cảnh...')
  // Project each image's 4 corners through its homography to find the overall bounding box
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < mats.length; i++) {
    const w = mats[i].cols
    const h = mats[i].rows
    const corners = cvNS.matFromArray(4, 1, cvNS.CV_32FC2, [0, 0, w, 0, w, h, 0, h])
    const projected = new cvNS.Mat()
    cvNS.perspectiveTransform(corners, projected, homographies[i])
    for (let c = 0; c < 4; c++) {
      const x = projected.data32F[c * 2]
      const y = projected.data32F[c * 2 + 1]
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    corners.delete()
    projected.delete()
  }

  const MAX_CANVAS_WIDTH = 6000
  let canvasWidth = Math.ceil(maxX - minX)
  let canvasHeight = Math.ceil(maxY - minY)
  let scale = 1
  if (canvasWidth > MAX_CANVAS_WIDTH) {
    scale = MAX_CANVAS_WIDTH / canvasWidth
    canvasWidth = Math.round(canvasWidth * scale)
    canvasHeight = Math.round(canvasHeight * scale)
  }

  const translate = cvNS.matFromArray(3, 3, cvNS.CV_64F, [scale, 0, -minX * scale, 0, scale, -minY * scale, 0, 0, 1])

  progress(70, 'Đang phối ảnh lên khung toàn cảnh...')
  const canvas = new cvNS.Mat(canvasHeight, canvasWidth, cvNS.CV_8UC4, new cvNS.Scalar(0, 0, 0, 0))
  const size = new cvNS.Size(canvasWidth, canvasHeight)

  for (let i = 0; i < mats.length; i++) {
    const finalH = new cvNS.Mat()
    cvNS.gemm(translate, homographies[i], 1, new cvNS.Mat(), 0, finalH)

    const warped = new cvNS.Mat()
    cvNS.warpPerspective(mats[i], warped, finalH, size, cvNS.INTER_LINEAR, cvNS.BORDER_CONSTANT, new cvNS.Scalar(0, 0, 0, 0))

    const srcMask = new cvNS.Mat(mats[i].rows, mats[i].cols, cvNS.CV_8UC1, new cvNS.Scalar(255))
    const warpedMask = new cvNS.Mat()
    cvNS.warpPerspective(srcMask, warpedMask, finalH, size, cvNS.INTER_NEAREST, cvNS.BORDER_CONSTANT, new cvNS.Scalar(0))

    warped.copyTo(canvas, warpedMask)

    finalH.delete()
    warped.delete()
    srcMask.delete()
    warpedMask.delete()

    progress(70 + Math.round(((i + 1) / mats.length) * 20), `Phối ảnh ${i + 1}/${mats.length}`)
  }

  progress(95, 'Đang xuất ảnh kết quả...')
  const bgr = new cvNS.Mat()
  cvNS.cvtColor(canvas, bgr, cvNS.COLOR_RGBA2BGR)
  const output = await matToBlob(cvNS, bgr)
  bgr.delete()

  // cleanup
  mats.forEach((m) => m.delete())
  keypoints.forEach((k) => k.delete())
  descriptors.forEach((d) => d.delete())
  homographies.forEach((h) => h.delete())
  translate.delete()
  canvas.delete()

  progress(100, 'Hoàn tất')
  return output
}

self.onmessage = async (event: MessageEvent<StitchWorkerRequest>) => {
  if (event.data.type !== 'stitch') return
  try {
    const cvNS = await loadCv()
    const result = await stitch(cvNS, event.data.photos)
    post({ type: 'result', blob: result.blob, width: result.width, height: result.height })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Lỗi không xác định khi ghép ảnh'
    const photoIndex = err instanceof StitchError ? err.photoIndex : undefined
    post({ type: 'error', message, photoIndex })
  }
}
