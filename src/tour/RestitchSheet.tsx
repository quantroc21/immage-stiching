import { useEffect, useRef, useState } from 'react'
import { ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG, fovFromAspect } from '../capture/cameraFov'
import type { SceneWithUrl } from './types'

/**
 * Ghép lại các phòng cũ bằng bộ ghép hiện tại.
 *
 * Ảnh gốc được giữ lại cùng mỗi phòng chính là để dùng cho lúc này: bộ ghép đã
 * khá lên nhiều lần kể từ khi các phòng đó được chụp, mà chụp lại cả toà nhà
 * thì không đời nào. Chỉ những phòng còn ảnh gốc mới ghép lại được; phòng thêm
 * từ ảnh có sẵn thì không có gì để ghép.
 */

interface Props {
  scenes: SceneWithUrl[]
  onDone: (results: { id: string; image: Blob }[]) => void
  onClose: () => void
}

type Phase = 'ready' | 'running' | 'done' | 'error'

export default function RestitchSheet({ scenes, onDone, onClose }: Props) {
  const eligible = scenes.filter((s) => s.sources && s.sources.length >= 2)
  const [phase, setPhase] = useState<Phase>('ready')
  const [index, setIndex] = useState(0)
  const [percent, setPercent] = useState(0)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState<string[]>([])
  const cancelled = useRef(false)
  const done = useRef<{ id: string; image: Blob }[]>([])

  // Bật lại cờ khi gắn vào, không chỉ tắt khi gỡ ra. React ở chế độ phát triển
  // chạy effect hai lần (gắn, gỡ, gắn lại), nên nếu chỉ đặt cờ huỷ trong phần
  // dọn dẹp thì lần gắn thứ hai đã mang sẵn cờ huỷ bằng true, và vòng ghép
  // thoát ngay dòng đầu -- đúng hiện tượng thanh tiến độ đứng ở 0%.
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const run = async () => {
    setPhase('running')
    const results: { id: string; image: Blob }[] = []
    const bad: string[] = []
    for (let i = 0; i < eligible.length; i++) {
      if (cancelled.current) return
      const scene = eligible[i]
      setIndex(i)
      setPercent(0)
      setMessage(scene.name)
      try {
        const image = await stitchOne(scene, (p, msg) => {
          if (cancelled.current) return
          setPercent(p)
          if (msg) setMessage(`${scene.name} · ${msg}`)
        })
        results.push({ id: scene.id, image })
        done.current = results
      } catch (err) {
        console.error('Ghép lại lỗi:', scene.name, err)
        bad.push(scene.name)
      }
    }
    if (cancelled.current) return
    setFailed(bad)
    setPhase(bad.length === eligible.length ? 'error' : 'done')
    onDone(results)
  }

  const skipped = scenes.length - eligible.length

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 p-4">
      <div className="lg w-full rounded-2xl p-4">
        <p className="font-medium">Ghép lại bằng bản mới</p>

        {phase === 'ready' && (
          <>
            <p className="mt-1 text-sm text-neutral-400">
              {eligible.length} phòng còn ảnh gốc sẽ được ghép lại.
              {skipped > 0 && ` ${skipped} phòng không có ảnh gốc, giữ nguyên.`}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Mỗi phòng mất khoảng nửa phút. Để máy sáng màn hình và đừng rời app.
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={onClose} className="flex-1 rounded-xl bg-neutral-800 px-4 py-3 text-sm font-medium">
                Thôi
              </button>
              <button
                onClick={run}
                disabled={!eligible.length}
                className="flex-1 rounded-xl bg-white px-4 py-3 text-sm font-medium text-neutral-900 disabled:opacity-40"
              >
                Bắt đầu
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <>
            <p className="mt-1 truncate text-sm text-neutral-400">{message}</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              Phòng {index + 1} / {eligible.length}
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-white transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
          </>
        )}

        {(phase === 'done' || phase === 'error') && (
          <>
            <p className="mt-1 text-sm text-neutral-400">
              {phase === 'done'
                ? `Xong ${eligible.length - failed.length} phòng.`
                : 'Không ghép lại được phòng nào.'}
              {failed.length > 0 && ` Lỗi: ${failed.join(', ')}.`}
            </p>
            <button onClick={onClose} className="mt-4 w-full rounded-xl bg-white px-4 py-3 text-sm font-medium text-neutral-900">
              Đóng
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Chạy bộ ghép cho một phòng, trả về ảnh mới. */
function stitchOne(scene: SceneWithUrl, onProgress: (percent: number, message?: string) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const sources = scene.sources
    if (!sources || sources.length < 2) {
      reject(new Error('Phòng này không còn ảnh gốc'))
      return
    }
    const worker = new Worker(new URL('../capture/stitchWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const data = e.data
      if (data.type === 'progress') onProgress(data.percent, data.message)
      else if (data.type === 'result') {
        worker.terminate()
        resolve(data.blob)
      } else if (data.type === 'error') {
        worker.terminate()
        reject(new Error(data.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'Worker lỗi'))
    }
    // Ảnh gốc chụp dọc bằng ống siêu rộng, đúng như lúc chụp lần đầu; bộ ghép
    // vẫn tự đo lại góc nhìn thật từ chính các tấm ảnh.
    worker.postMessage({
      type: 'stitch',
      photos: sources.map((s) => ({ blob: s.blob, yawDeg: s.yawDeg, pitchDeg: s.pitchDeg, vectors: s.vectors })),
      fov: fovFromAspect(ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG, 3 / 4),
    })
  })
}
