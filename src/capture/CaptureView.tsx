import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedPhoto } from './types'
import { useStitcher } from './useStitcher'
import PanoramaViewer from '../components/PanoramaViewer'
import OrientationOverlay, {
  VIRTUAL_CAMERA_FOV_DEG,
  type OrientationOverlayHandle,
  type OverlayStatus,
} from './OrientationOverlay'
import { generateSphereDots } from './sphereDots'
import { ASSUMED_VERTICAL_FOV_DEG, fovFromAspect } from './cameraFov'
import { requestDeviceOrientationPermission } from './deviceOrientation'
import { tryLockPortrait, usePortraitOrientation } from './usePortraitOrientation'

const CAPTURE_WIDTH = 1600
// Portrait 9:16 default until the live video's real dimensions are known.
const DEFAULT_ASPECT = 9 / 16
// How forgiving the crosshair-on-point hit test is, as a fraction of the smaller FOV axis.
const MATCH_THRESHOLD_FRACTION = 0.32
// Hold the crosshair on a point this long before it fires. This is the window the camera
// gets to lock focus and exposure — shooting the instant the crosshair lands gave blurry
// frames. The countdown only advances while the phone is actually held still.
const DWELL_MS = 1400
// Let people wrap up early once they've covered most of the sphere.
const FINISH_AVAILABLE_FRACTION = 0.5

const ARROW_ROTATION = { right: 0, down: 90, left: 180, up: 270 } as const

interface CaptureViewProps {
  onAccept: (imageUrl: string) => void
  onCancel: () => void
}

export default function CaptureView({ onAccept, onCancel }: CaptureViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const overlayRef = useRef<OrientationOverlayHandle>(null)
  const processedDotIdsRef = useRef<Set<string>>(new Set())
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [started, setStarted] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const [videoAspect, setVideoAspect] = useState<number | null>(null)
  const [status, setStatus] = useState<OverlayStatus>({
    tilt: 'ok',
    arrow: null,
    dwell: 0,
    steady: true,
    onTarget: false,
    usingSensors: false,
  })
  const isPortrait = usePortraitOrientation()
  const { status: stitchStatus, progressPercent, progressMessage, result, error, stitch, reset } = useStitcher()

  const fov = useMemo(() => fovFromAspect(ASSUMED_VERTICAL_FOV_DEG, videoAspect ?? DEFAULT_ASPECT), [videoAspect])
  const dots = useMemo(() => generateSphereDots(fov), [fov])
  const matchThresholdDeg = Math.min(fov.horizontal, fov.vertical) * MATCH_THRESHOLD_FRACTION

  // What fraction of the screen height one shot covers, given the deliberately wider
  // virtual camera — this is exactly where the white guide frame belongs.
  const frameHeightPct =
    (Math.tan((fov.vertical * Math.PI) / 360) / Math.tan((VIRTUAL_CAMERA_FOV_DEG * Math.PI) / 360)) * 100

  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
    setVideoEl(el)
  }, [])

  useEffect(() => {
    if (!started) return
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({
        // No width/height/zoom constraints — requesting a specific resolution made some
        // phones pick a tighter digital crop from the sensor (visibly zoomed in).
        video: { facingMode: { ideal: 'environment' } },
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

  /** Grabs the current frame synchronously, so callers can tell right away if it worked. */
  const grabFrame = (): HTMLCanvasElement | null => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.readyState < 2) return null

    const rawW = video.videoWidth
    const rawH = video.videoHeight
    // Defensive fix: if the raw camera frame is landscape-shaped while the phone is
    // held portrait, rotate it 90° so the saved photo matches what's on screen.
    const needsRotation = isPortrait && rawW > rawH
    const outW = needsRotation ? rawH : rawW
    const outH = needsRotation ? rawW : rawH

    const scale = CAPTURE_WIDTH / outW
    const canvas = document.createElement('canvas')
    canvas.width = CAPTURE_WIDTH
    canvas.height = Math.round(outH * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    if (needsRotation) {
      ctx.translate(canvas.width, 0)
      ctx.rotate(Math.PI / 2)
      ctx.drawImage(video, 0, 0, canvas.height, canvas.width)
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    }
    return canvas
  }

  const handleDotMatched = useCallback((dotId: string): boolean => {
    if (processedDotIdsRef.current.has(dotId)) return true
    // Grab the frame first: if the camera isn't ready we must NOT consume the point,
    // otherwise it vanishes from the grid with no photo behind it.
    const canvas = grabFrame()
    if (!canvas) return false

    processedDotIdsRef.current.add(dotId)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const photo: CapturedPhoto = { id: dotId, blob, previewUrl: URL.createObjectURL(blob) }
        setPhotos((prev) => [...prev, photo])
        overlayRef.current?.placeCapturedPhoto(dotId, photo.previewUrl)
      },
      'image/jpeg',
      0.9,
    )
    return true
    // grabFrame reads refs plus the current orientation; nothing else is reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPortrait])

  const handleStitch = () => {
    stitch(photos.map((p) => p.blob))
  }

  // Auto-stitch once every target point has been captured.
  useEffect(() => {
    if (dots.length > 0 && photos.length === dots.length && stitchStatus === 'idle') {
      handleStitch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length, dots.length, stitchStatus])

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
          Cầm điện thoại dọc, ngang tầm mắt, đứng yên một chỗ và xoay vòng quanh người. Ngắm vòng tròn vào từng
          chấm xanh và giữ yên — máy tự chụp, không cần bấm nút.
        </p>
        <button
          className="rounded-full bg-emerald-500 px-8 py-3 text-sm font-semibold hover:bg-emerald-400"
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
  const canFinish = photos.length >= Math.max(4, Math.ceil(dots.length * FINISH_AVAILABLE_FRACTION))
  const dwellDegrees = status.dwell * 360
  // Amber while the countdown is stalled waiting for you to stop moving, green once it's
  // actually ticking down toward the shot.
  const holdColor = status.steady ? '#22c55e' : '#f59e0b'
  const showHoldStill = status.onTarget && !status.steady && status.tilt === 'ok'

  return (
    <div className="relative h-full w-full overflow-hidden bg-black text-white">
      {/* The live feed is drawn into the 3D scene as a floating frame, so this element is
          only a texture source — kept rendered (not display:none) because iOS Safari can
          stall a fully hidden video. */}
      <video
        ref={attachVideo}
        autoPlay
        playsInline
        muted
        onLoadedMetadata={handleVideoMetadata}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      />

      <OrientationOverlay
        ref={overlayRef}
        className="absolute inset-0"
        dots={dots}
        fov={fov}
        video={videoEl}
        matchThresholdDeg={matchThresholdDeg}
        dwellMs={DWELL_MS}
        onDotMatched={handleDotMatched}
        onStatusChange={setStatus}
      />

      {cameraError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center px-6 text-center text-red-400">
          Không mở được camera: {cameraError}
        </div>
      )}

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-xl text-black"
          onClick={onCancel}
          aria-label="Quay lại"
        >
          ↺
        </button>
        <button
          className="flex h-11 w-11 items-center justify-center rounded-full bg-red-600 text-xl font-bold"
          onClick={onCancel}
          aria-label="Đóng"
        >
          ×
        </button>
      </div>

      {/* tilt correction banner */}
      {status.tilt !== 'ok' && (
        <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-white/70 text-2xl">
            {status.tilt === 'right' ? '↻' : '↺'}
          </div>
          <p className="text-lg drop-shadow">
            Nghiêng điện thoại sang {status.tilt === 'right' ? 'phải' : 'trái'}
          </p>
        </div>
      )}

      {/* white guide frame — outlines exactly the area one shot covers */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div
          className="border border-white/90"
          style={{ height: `${frameHeightPct}%`, aspectRatio: `${videoAspect ?? DEFAULT_ASPECT}` }}
        />
      </div>

      {/* crosshair — the ring fills green as you hold steady on a point */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="relative flex h-24 w-24 items-center justify-center">
          <div
            className="absolute h-[72px] w-[72px] rounded-full transition-colors"
            style={{
              background: status.onTarget
                ? `conic-gradient(${holdColor} ${dwellDegrees}deg, transparent ${dwellDegrees}deg)`
                : 'transparent',
            }}
          />
          <div className="absolute h-24 w-24 rounded-full border-[5px] border-white" />
        </div>
        {status.arrow && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute h-11 w-11 drop-shadow"
            style={{
              transform:
                (status.arrow === 'right'
                  ? 'translateX(84px)'
                  : status.arrow === 'left'
                    ? 'translateX(-84px)'
                    : status.arrow === 'up'
                      ? 'translateY(-84px)'
                      : 'translateY(84px)') + ` rotate(${ARROW_ROTATION[status.arrow]}deg)`,
            }}
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
        )}
      </div>

      {/* hint under the frame */}
      <div className="pointer-events-none absolute inset-x-0 z-10 px-8" style={{ top: `${50 + frameHeightPct / 2 + 3}%` }}>
        {showHoldStill ? (
          <p className="text-center text-lg font-medium leading-snug text-amber-400 drop-shadow">
            Giữ yên máy để lấy nét…
          </p>
        ) : (
          <p className="text-center text-base leading-snug drop-shadow">
            Chụp tất cả ảnh từ đúng chỗ đứng của ảnh đầu tiên để có kết quả tốt nhất.
          </p>
        )}
      </div>

      {/* bottom progress / finish */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {canFinish && (
          <button
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-4 text-lg font-semibold hover:bg-emerald-400 disabled:opacity-40"
            onClick={handleStitch}
            disabled={stitchStatus === 'processing'}
          >
            ✓ Hoàn tất ({photos.length} ảnh)
          </button>
        )}
        <div className="flex items-center gap-3">
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-white">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          <p className="whitespace-nowrap text-xl font-medium">
            {photos.length} of {dots.length}
          </p>
        </div>
        {!status.usingSensors && (
          <p className="mt-2 text-center text-[11px] text-amber-300">
            Chưa nhận được cảm biến xoay — kéo bằng ngón tay để xoay thử (chế độ dự phòng cho máy tính).
          </p>
        )}
      </div>

      {stitchStatus === 'processing' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
          <div className="h-2 w-64 overflow-hidden rounded-full bg-neutral-700">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progressPercent}%` }} />
          </div>
          <p className="text-sm text-neutral-300">{progressMessage}</p>
        </div>
      )}

      {stitchStatus === 'error' && error && (
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
