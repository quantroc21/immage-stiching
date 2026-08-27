import { useCallback, useEffect, useRef, useState } from 'react'
import type { StitchWorkerRequest, StitchWorkerResponse } from './types'

export type StitchStatus = 'idle' | 'processing' | 'done' | 'error'

export interface StitchResult {
  url: string
  width: number
  height: number
}

export function useStitcher() {
  const workerRef = useRef<Worker | null>(null)
  const [status, setStatus] = useState<StitchStatus>('idle')
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [result, setResult] = useState<StitchResult | null>(null)
  const [error, setError] = useState<{ message: string; photoIndex?: number } | null>(null)

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const stitch = useCallback((photos: StitchWorkerRequest['photos'], fov: StitchWorkerRequest['fov']) => {
    workerRef.current?.terminate()
    const worker = new Worker(new URL('./stitchWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    setStatus('processing')
    setProgressPercent(0)
    setProgressMessage('Đang khởi động...')
    setResult(null)
    setError(null)

    worker.onmessage = (event: MessageEvent<StitchWorkerResponse>) => {
      const data = event.data
      if (data.type === 'progress') {
        setProgressPercent(data.percent)
        setProgressMessage(data.message)
      } else if (data.type === 'result') {
        setResult({ url: URL.createObjectURL(data.blob), width: data.width, height: data.height })
        setStatus('done')
        worker.terminate()
        workerRef.current = null
      } else if (data.type === 'error') {
        setError({ message: data.message, photoIndex: data.photoIndex })
        setStatus('error')
        worker.terminate()
        workerRef.current = null
      }
    }

    worker.onerror = (event) => {
      setError({ message: event.message || 'Worker gặp lỗi không xác định' })
      setStatus('error')
      worker.terminate()
      workerRef.current = null
    }

    const request: StitchWorkerRequest = { type: 'stitch', photos, fov }
    worker.postMessage(request)
  }, [])

  const reset = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    setStatus('idle')
    setProgressPercent(0)
    setProgressMessage('')
    setResult(null)
    setError(null)
  }, [])

  return { status, progressPercent, progressMessage, result, error, stitch, reset }
}
