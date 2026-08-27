import { useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedPhoto } from './types'
import { useStitcher } from './useStitcher'
import PanoramaViewer from '../components/PanoramaViewer'
import OrientationOverlay from './OrientationOverlay'
import { generateSphereDots } from './sphereDots'
import { ASSUMED_VERTICAL_FOV_DEG, fovFromAspect } from './cameraFov'
import { requestDeviceOrientationPermission } from './deviceOrientation'
import { tryLockPortrait, usePortraitOrientation } from './usePortraitOrientation'

const CAPTURE_WIDTH = 1600
// Portrait 9:16 default until the live video's real dimensions are known.
const DEFAULT_ASPECT = 9 / 16
// How forgiving the crosshair-on-dot hit test is, as a fraction of the smaller FOV axis.
const MATCH_THRESHOLD_FRACTION = 0.35

interface CaptureViewProps {
  onAccept: (imageUrl: string) => void
  onCancel: () => void
}

export default function CaptureView({ onAccept, onCancel }: CaptureViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processedDotIdsRef = useRef<Set<string>>(new Set())
  const [started, setStarted] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const [usingSensors, setUsingSensors] = useState(false)
  const [videoAspect, setVideoAspect] = useState<number | null>(null)
  const isPortrait = usePortraitOrientation()
  const { status, progressPercent, progressMessage, result, error, stitch, reset } = useStitcher()

  const fov = useMemo(() => fovFromAspect(ASSUMED_VERTICAL_FOV_DEG, videoAspect ?? DEFAULT_ASPECT), [videoAspect])
  const dots = useMemo(() => generateSphereDots(fov, 0.25), [fov])
  const matchThresholdDeg = Math.min(fov.horizontal, fov.vertical) * MATCH_THRESHOLD_FRACTION

  useEffect(() => {
    if (!started) return
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Ask for a portrait-shaped frame — on some Android browsers the camera
          // otherwise reports its native (landscape) sensor resolution regardless of
          // how the phone is being held, which is what made captured photos come out
          // sideways. capturePhotoBlob() below also corrects for this defensively.
          width: { ideal: 1080 },
          height: { ideal: 1920 },
        },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      })
      .catch((err) => {
        setCameraError(err instanceof Error ? err.message : 'Không mở được camera')
      })

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [started])

  const handleVideoMetadata = () => {
    const video = videoRef.current
    if (video && video.videoWidth > 0) {
      setVideoAspect(video.videoWidth / video.videoHeight)
    }
  }

  const handleStart = async () => {
    // Must fire from this click/tap handler — iOS Safari only grants motion-sensor
    // access when requestPermission() is called directly inside a user gesture.
    await requestDeviceOrientationPermission()
    void tryLockPortrait()
    setStarted(true)
  }

  const capturePhotoBlob = (): Promise<Blob | null> => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return Promise.resolve(null)

    const rawW = video.videoWidth
    const rawH = video.videoHeight
    // Defensive fix: if the raw camera frame is landscape-shaped while the phone is
    // held portrait, rotate it 90° so the saved photo matches what's actually on
    // screen instead of coming out sideways.
    const needsRotation = isPortrait && rawW > rawH
    const outW = needsRotation ? rawH : rawW
    const outH = needsRotation ? rawW : rawH

    const scale = CAPTURE_WIDTH / outW
    const canvas = document.createElement('canvas')
    canvas.width = CAPTURE_WIDTH
    canvas.height = Math.round(outH * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return Promise.resolve(null)

    if (needsRotation) {
      ctx.translate(canvas.width, 0)
      ctx.rotate(Math.PI / 2)
      ctx.drawImage(video, 0, 0, canvas.height, canvas.width)
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    }

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9))
  }

  const handleDotMatched = (dotId: string) => {
    if (processedDotIdsRef.current.has(dotId)) return
    processedDotIdsRef.current.add(dotId)
    capturePhotoBlob().then((blob) => {
      if (!blob) return
      const photo: CapturedPhoto = {
        id: dotId,
        blob,
        previewUrl: URL.createObjectURL(blob),
      }
      setPhotos((prev) => [...prev, photo])
    })
  }

  const handleStitch = () => {
    stitch(photos.map((p) => p.blob))
  }

  // Auto-stitch once every grid point has been captured.
  useEffect(() => {
    if (dots.length > 0 && photos.length === dots.length && status === 'idle') {
      handleStitch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length, dots.length, status])

  if (result) {
    return (
      <div className="flex h-full w-full flex-col bg-neutral-950 text-white">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-medium">Xem trước kết quả ghép ({result.width}×{result.height})</h2>
          <div className="flex gap-2">
            <button className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700" onClick={reset}>
              Chụp lại
            </button>
            <button
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
              onClick={() => onAccept(result.url)}
            >
              Dùng ảnh này
            </button>
          </div>
        </div>
        <div className="relative flex-1">
          <PanoramaViewer imageUrl={result.url} className="h-full w-full" />
        </div>
      </div>
    )
  }

  if (!started) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-neutral-950 px-6 text-center text-white">
        <h2 className="text-xl font-semibold">Chụp 360° tại chỗ đứng</h2>
        <p className="max-w-sm text-sm text-neutral-400">
          Cầm điện thoại dọc, ngang tầm mắt, đứng yên một chỗ và xoay vòng quanh người. Chấm xanh sẽ dẫn hướng —
          máy tự chụp khi bạn xoay tới đúng điểm, không cần bấm nút.
        </p>
        <button
          className="rounded-full bg-indigo-600 px-8 py-3 text-sm font-semibold hover:bg-indigo-500"
          onClick={handleStart}
        >
          Bắt đầu chụp
        </button>
        <button className="text-sm text-neutral-500 underline" onClick={onCancel}>
          Hủy
        </button>
      </div>
    )
  }

  if (!isPortrait) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-white">
        <div className="text-4xl">📱↻</div>
        <p className="max-w-xs text-sm text-neutral-300">
          Xoay điện thoại về chiều dọc (portrait) để tiếp tục chụp — chụp dọc giúp phủ đủ góc trên/dưới trong ít
          tấm hơn.
        </p>
        <button className="text-sm text-neutral-500 underline" onClick={onCancel}>
          Hủy
        </button>
      </div>
    )
  }

  const progressPct = dots.length > 0 ? (photos.length / dots.length) * 100 : 0

  return (
    <div className="relative h-full w-full overflow-hidden bg-black text-white">
      {cameraError ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-red-400">
          Không mở được camera: {cameraError}
        </div>
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={handleVideoMetadata}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      <OrientationOverlay
        className="absolute inset-0"
        dots={dots}
        matchThresholdDeg={matchThresholdDeg}
        onDotMatched={handleDotMatched}
        onOrientationSourceChange={setUsingSensors}
      />

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-lg"
          onClick={onCancel}
          aria-label="Quay lại"
        >
          ←
        </button>
        <h1 className="text-center text-sm font-medium drop-shadow">Capture 360° degree panoramic photos</h1>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-lg font-bold"
          onClick={onCancel}
          aria-label="Đóng"
        >
          ×
        </button>
      </div>

      {/* crop frame + crosshair, dead center of the screen */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="aspect-[4/3] w-[70%] max-w-sm rounded-lg border-2 border-white/90" />
        <div className="absolute flex h-9 w-9 items-center justify-center rounded-full border-2 border-white">
          <div className="h-3 w-3 rounded-full bg-emerald-500" />
        </div>
      </div>

      {/* bottom progress */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-6">
        <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-white/20">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progressPct}%` }} />
        </div>
        <p className="text-center text-xs text-white/80">
          {photos.length} of {dots.length}
        </p>
        {!usingSensors && (
          <p className="mt-1 text-center text-[11px] text-amber-300">
            Chưa nhận được cảm biến xoay — kéo bằng ngón tay để xoay thử (chế độ dự phòng cho máy tính).
          </p>
        )}
        {photos.length >= 2 && photos.length < dots.length && (
          <button
            className="pointer-events-auto mx-auto mt-3 block rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium hover:bg-indigo-500 disabled:opacity-40"
            onClick={handleStitch}
            disabled={status === 'processing'}
          >
            Ghép sớm với {photos.length} tấm đã chụp
          </button>
        )}
      </div>

      {status === 'processing' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
          <div className="h-2 w-64 overflow-hidden rounded-full bg-neutral-700">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
          <p className="text-sm text-neutral-300">{progressMessage}</p>
        </div>
      )}

      {status === 'error' && error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 px-6 text-center">
          <p className="max-w-md text-sm text-red-400">
            Ghép ảnh thất bại{error.photoIndex !== undefined ? ` (liên quan tấm số ${error.photoIndex + 1})` : ''}:{' '}
            {error.message}
          </p>
          <button className="rounded-md bg-neutral-800 px-4 py-2 text-sm hover:bg-neutral-700" onClick={reset}>
            Đóng và thử lại
          </button>
        </div>
      )}
    </div>
  )
}
