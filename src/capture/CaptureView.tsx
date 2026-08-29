import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedPhoto } from './types'
import { useStitcher } from './useStitcher'
import PanoramaViewer from '../components/PanoramaViewer'
import OrientationOverlay, {
  VIRTUAL_CAMERA_FOV_DEG,
  type OrientationOverlayHandle,
  type OverlayStatus,
} from './OrientationOverlay'
import { DEFAULT_OVERLAP, generateSphereDots } from './sphereDots'
import { ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG, ASSUMED_VERTICAL_FOV_DEG, fovFromAspect } from './cameraFov'
import { requestDeviceOrientationPermission } from './deviceOrientation'
import { tryLockPortrait, usePortraitOrientation } from './usePortraitOrientation'

// Portrait 9:16 default until the live video's real dimensions are known.
const DEFAULT_ASPECT = 9 / 16
/**
 * What share of the grid's overlap budget a single shot's aiming error is allowed to spend.
 * Two neighbouring shots can each miss by the full tolerance in opposite directions, so the
 * pair consumes twice this — a third leaves the planned overlap comfortably intact.
 */
const AIM_TOLERANCE_OF_OVERLAP = 1 / 3
// Hold the crosshair on a point this long before it fires automatically. Fast and responsive (800ms).
const DWELL_MS = 800
// Let people wrap up early once they've covered 40% of the sphere.
const FINISH_AVAILABLE_FRACTION = 0.4

const ARROW_ROTATION = { right: 0, down: 90, left: 180, up: 270 } as const

function exportTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`
}

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
  const [lensLabel, setLensLabel] = useState<'ultra-wide' | 'default' | null>(null)
  const [videoDeviceLabels, setVideoDeviceLabels] = useState<string[]>([])
  const [showDeviceLabels, setShowDeviceLabels] = useState(false)
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

  // When the phone is portrait but camera reports landscape frames, grabFrame rotates
  // the capture 90°. The FOV must match the CAPTURED photo, not the raw video frame.
  const effectiveAspect = useMemo(() => {
    const raw = videoAspect ?? DEFAULT_ASPECT
    return isPortrait && raw > 1 ? 1 / raw : raw
  }, [videoAspect, isPortrait])
  const fov = useMemo(() => {
    const assumedVertical = lensLabel === 'ultra-wide' ? ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG : ASSUMED_VERTICAL_FOV_DEG
    return fovFromAspect(assumedVertical, effectiveAspect)
  }, [effectiveAspect, lensLabel])
  const dots = useMemo(() => generateSphereDots(fov), [fov])
  /**
   * How far off target a shot may be and still count. Derived from the overlap the grid was
   * planned with rather than picked by feel — the previous hand-tuned value accepted shots
   * up to 18.6° off while the grid only carried 9.9° of slack, so two neighbours drifting
   * opposite ways could open a 27° hole. That is where the black patches came from.
   */
  const matchThresholdDeg = Math.min(fov.horizontal, fov.vertical) * DEFAULT_OVERLAP * AIM_TOLERANCE_OF_OVERLAP

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

    // 4:3, not 16:9 — phone sensors are natively 4:3, so a 16:9 video is a *crop* that
    // throws away real field of view. Resolution is deliberately modest: the stitcher
    // downscales every photo to 1280px on its long side anyway (at a 4096px-wide panorama
    // one shot only lands on ~660 output pixels), so 4K only cost RAM and encode time.
    const frameConstraints = {
      aspectRatio: { ideal: 4 / 3 },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    }

    const applyStream = (stream: MediaStream, lens: 'ultra-wide' | 'default') => {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setLensLabel(lens)
    }

    async function start() {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, ...frameConstraints },
          audio: false,
        })
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
          })
        } catch (err) {
          if (!cancelled) setCameraError(err instanceof Error ? err.message : 'Không mở được camera')
          return
        }
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      // Teleport 360 shoots with the phone's ultra-wide lens, not the main one — it sees a
      // visibly wider field of view per shot, which is why 16 shots cover the whole sphere.
      // Device labels are blank until permission is granted at least once, which the
      // request above just did, so this only becomes possible to check afterwards.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const videoInputs = devices.filter((d) => d.kind === 'videoinput')
        // Kept for on-screen diagnosis: there is no reliable, documented way to identify
        // "the ultra-wide one" across devices — deviceId is re-randomised every page load
        // (a deliberate WebKit privacy measure), labels are localised to the phone's system
        // language, and enumeration order isn't guaranteed. Apple's own developer forum has
        // this exact question sitting unanswered. So when the match below fails, the actual
        // labels this phone reported are what's needed to see whether it's a wording miss or
        // the browser genuinely not exposing a second lens at all.
        if (!cancelled) setVideoDeviceLabels(videoInputs.map((d) => d.label || '(không có tên)'))

        // Apple's Vietnamese localization renders "Back Ultra Wide Camera" as "Camera cực
        // rộng mặt sau" — found by inspecting a real device's enumerateDevices() output via
        // the on-screen diagnostic above (a generic "ultra wide" / "siêu rộng" guess missed
        // it entirely). "kép" ("dual") is excluded because that's Apple's virtual
        // multi-lens device that auto-switches by zoom level rather than staying locked to
        // the ultra-wide element — not the same thing as actually requesting that lens.
        const ultraWide = videoInputs.find(
          (d) => /ultra.?wide|siêu rộng|góc rộng|cực rộng/i.test(d.label) && !/kép|dual/i.test(d.label),
        )
        const currentId = stream.getVideoTracks()[0]?.getSettings().deviceId
        if (ultraWide && ultraWide.deviceId !== currentId) {
          const wideStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: ultraWide.deviceId }, ...frameConstraints },
            audio: false,
          })
          stream.getTracks().forEach((t) => t.stop())
          applyStream(wideStream, 'ultra-wide')
          return
        }
      } catch {
        // No separate ultra-wide device exposed (or the switch failed) — the stream already
        // open from the first request is a perfectly good fallback.
      }
      applyStream(stream, 'default')
    }

    start()

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

  /** Grabs the current frame, rotated to match what's on screen. */
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

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
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

  const handleDotMatched = useCallback(
    (
      dotId: string,
      yawDeg: number,
      pitchDeg: number,
      vectors?: {
        right: [number, number, number]
        up: [number, number, number]
        forward: [number, number, number]
      },
    ): boolean => {
      if (processedDotIdsRef.current.has(dotId)) return true
      // Grab the frame first: if the camera isn't ready we must NOT consume the point,
      // otherwise it vanishes from the grid with no photo behind it.
      const canvas = grabFrame()
      if (!canvas) return false

      processedDotIdsRef.current.add(dotId)
      canvas.toBlob(
        (blob) => {
          if (!blob) return
          const photo: CapturedPhoto = {
            id: dotId,
            blob,
            previewUrl: URL.createObjectURL(blob),
            yawDeg,
            pitchDeg,
            vectors,
          }
          setPhotos((prev) => [...prev, photo])
          overlayRef.current?.placeCapturedPhoto(dotId, photo.previewUrl)
        },
        'image/jpeg',
        0.9,
      )
      return true
    },
    // grabFrame reads refs plus the current orientation; nothing else is reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grabFrame],
  )

  const handleStitch = () => {
    stitch(
      photos.map((p) => ({ blob: p.blob, yawDeg: p.yawDeg, pitchDeg: p.pitchDeg, vectors: p.vectors })),
      fov,
    )
  }

  // Auto-stitch once every target point has been captured.
  useEffect(() => {
    if (dots.length > 0 && photos.length === dots.length && stitchStatus === 'idle') {
      handleStitch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length, dots.length, stitchStatus])

  /**
   * Hands the individual shots over to something better at stitching than we are.
   *
   * Desktop tools like PTGui carry things this app does not: proper bundle adjustment,
   * multi-band blending, and — the reason to bother — manual masking, where you paint over
   * the air-conditioner or the TV and force the seam to run somewhere else entirely. That is
   * exactly the fix for a hard edge landing badly, and it is not something any automatic
   * rule here has managed. None of it is reachable from the finished panorama, though: those
   * tools need the source frames, which were being thrown away once stitching completed.
   *
   * Filenames carry the direction each shot was taken in. The stitcher on the other end
   * works it out from the imagery regardless, but it makes a set of sixteen JPEGs readable
   * when something needs checking by hand.
   */
  const handleExportSources = async () => {
    if (photos.length === 0) return
    const stamp = exportTimestamp()
    const files = photos.map((p, i) => {
      const yaw = Math.round(p.yawDeg).toString().padStart(3, '0')
      const pitch = (p.pitchDeg >= 0 ? '+' : '-') + String(Math.abs(Math.round(p.pitchDeg))).padStart(2, '0')
      return new File([p.blob], `pano_${stamp}_${String(i + 1).padStart(2, '0')}_yaw${yaw}_pitch${pitch}.jpg`, {
        type: 'image/jpeg',
      })
    })

    if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: `${files.length} ảnh gốc` })
        return
      } catch {
        // Cancelled or dismissed — fall through to downloading them instead.
      }
    }

    // Some browsers refuse a share of this many files, and some refuse files at all. Saving
    // them one by one is slower but always available.
    for (const file of files) {
      const url = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  const handleExport = async () => {
    if (!result) return
    const filename = `panorama_360_${exportTimestamp()}.jpg`

    if (result.blob && typeof navigator !== 'undefined' && navigator.canShare) {
      const file = new File([result.blob], filename, { type: 'image/jpeg' })
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: 'Ảnh Panorama 360°',
          })
          return
        } catch {
          // User cancelled or share dismissed, proceed to download fallback
        }
      }
    }

    const a = document.createElement('a')
    a.href = result.url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  if (result) {
    return (
      <div className="flex h-full w-full flex-col bg-neutral-950 text-white">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-medium">Xem trước kết quả ghép ({result.width}×{result.height})</h2>
          <div className="flex items-center gap-2">
            <button className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700" onClick={reset}>
              Chụp lại
            </button>
            <button
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-500"
              onClick={handleExport}
              title="Tải ảnh 360 về máy hoặc chia sẻ"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path
                  fillRule="evenodd"
                  d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z"
                  clipRule="evenodd"
                />
              </svg>
              Xuất ảnh 360
            </button>
            <button
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
              onClick={handleExportSources}
              title="Gửi các ảnh gốc sang phần mềm ghép chuyên nghiệp (PTGui, Hugin, Affinity)"
            >
              {photos.length} ảnh gốc
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
        {stitchStatus === 'processing' && <p className="text-xs text-neutral-500">{progressMessage}</p>}
        {stitchStatus === 'error' && error && <p className="max-w-sm text-xs text-red-400">{error.message}</p>}
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

      {lensLabel && (
        <div className="absolute inset-x-0 top-16 z-10 flex flex-col items-center gap-1 text-center">
          <span
            className={
              'pointer-events-none rounded px-2 py-0.5 text-[11px] ' +
              (lensLabel === 'ultra-wide' ? 'bg-emerald-900/80 text-emerald-300' : 'bg-neutral-800/80 text-neutral-400')
            }
          >
            {lensLabel === 'ultra-wide' ? 'Ống kính: siêu rộng ✓' : 'Ống kính: mặc định (không thấy ultra-wide)'}
          </span>
          {lensLabel === 'default' && videoDeviceLabels.length > 0 && (
            <button
              className="pointer-events-auto text-[10px] text-neutral-500 underline"
              onClick={() => setShowDeviceLabels((v) => !v)}
            >
              {showDeviceLabels ? 'Ẩn danh sách camera' : 'Xem camera máy báo cáo'}
            </button>
          )}
          {showDeviceLabels && (
            <div className="pointer-events-auto max-w-[85vw] rounded bg-black/90 p-2 text-left text-[10px] text-neutral-300">
              {videoDeviceLabels.map((label, i) => (
                <div key={i}>
                  {i + 1}. {label}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3.5 text-base font-semibold hover:bg-emerald-400 disabled:opacity-40 shadow-lg"
            onClick={handleStitch}
            disabled={stitchStatus === 'processing'}
          >
            ✓ Hoàn tất ghép ảnh ({photos.length}/{dots.length})
          </button>
        )}
        <div className="flex items-center gap-3">
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-white/30">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          <p className="whitespace-nowrap text-lg font-medium">
            {photos.length} / {dots.length}
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
