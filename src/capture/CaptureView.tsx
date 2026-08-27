import { useEffect, useRef, useState } from 'react'
import type { CapturedPhoto } from './types'
import { useStitcher } from './useStitcher'
import PanoramaViewer from '../components/PanoramaViewer'

const CAPTURE_WIDTH = 1600

interface CaptureViewProps {
  onAccept: (imageUrl: string) => void
  onCancel: () => void
}

export default function CaptureView({ onAccept, onCancel }: CaptureViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const { status, progressPercent, progressMessage, result, error, stitch, reset } = useStitcher()

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
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
  }, [])

  const capturePhoto = () => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return
    const scale = CAPTURE_WIDTH / video.videoWidth
    const canvas = document.createElement('canvas')
    canvas.width = CAPTURE_WIDTH
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const photo: CapturedPhoto = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          blob,
          previewUrl: URL.createObjectURL(blob),
        }
        setPhotos((prev) => [...prev, photo])
      },
      'image/jpeg',
      0.9,
    )
  }

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const photo = prev.find((p) => p.id === id)
      if (photo) URL.revokeObjectURL(photo.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  const handleStitch = () => {
    stitch(photos.map((p) => p.blob))
  }

  if (result) {
    return (
      <div className="flex h-full w-full flex-col bg-neutral-950 text-white">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-medium">Xem trước kết quả ghép ({result.width}×{result.height})</h2>
          <div className="flex gap-2">
            <button
              className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
              onClick={reset}
            >
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

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950 text-white">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm font-medium">Chụp mới (thử nghiệm) — {photos.length} tấm</h2>
        <button className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700" onClick={onCancel}>
          Hủy
        </button>
      </div>

      <div className="relative flex-1 bg-black">
        {cameraError ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-red-400">
            Không mở được camera: {cameraError}
          </div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
        )}

        {status === 'processing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center">
            <div className="h-2 w-64 overflow-hidden rounded-full bg-neutral-700">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="text-sm text-neutral-300">{progressMessage}</p>
          </div>
        )}

        {status === 'error' && error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 px-6 text-center">
            <p className="max-w-md text-sm text-red-400">
              Ghép ảnh thất bại{error.photoIndex !== undefined ? ` (liên quan tấm số ${error.photoIndex + 1})` : ''}: {error.message}
            </p>
            <button
              className="rounded-md bg-neutral-800 px-4 py-2 text-sm hover:bg-neutral-700"
              onClick={reset}
            >
              Đóng và thử lại
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3">
        {photos.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {photos.map((photo, idx) => (
              <div key={photo.id} className="relative flex-shrink-0">
                <img src={photo.previewUrl} alt={`Ảnh ${idx + 1}`} className="h-16 w-24 rounded object-cover" />
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-xs">{idx + 1}</span>
                <button
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs"
                  onClick={() => removePhoto(photo.id)}
                  aria-label={`Xóa ảnh ${idx + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <button
            className="flex-1 rounded-md bg-white py-3 text-sm font-semibold text-black disabled:opacity-40"
            onClick={capturePhoto}
            disabled={!!cameraError}
          >
            Chụp tấm {photos.length + 1}
          </button>
          <button
            className="rounded-md bg-indigo-600 px-4 py-3 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            onClick={handleStitch}
            disabled={photos.length < 2 || status === 'processing'}
          >
            Ghép ảnh ({photos.length})
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Đứng yên tại chỗ, xoay dần quanh trục người, chụp mỗi ~22–30° cho tới khi đủ 360° (khoảng 12–16 tấm). Đây là bước thử nghiệm thủ công — chưa tự động theo cảm biến xoay.
        </p>
      </div>
    </div>
  )
}
