import { useCallback, useEffect, useRef, useState } from 'react'
import type { CameraBasis, Detection, ScanWorkerRequest, ScanWorkerResponse } from './objectScanTypes'
import type { FovDeg } from './cameraFov'
import { angularDistanceDeg } from './sphereDots'

export interface SpottedObject {
  yaw: number
  pitch: number
  classId: number
  score: number
}

export type ScanStatus = 'idle' | 'loading' | 'scanning' | 'error'

/**
 * Turns a detection's position in the frame back into a direction in the world.
 *
 * This is the exact inverse of what the stitcher does when it paints a photo onto the
 * panorama: there, a world direction is projected into the frame; here, a point in the
 * frame is projected back out into the world using the camera orientation recorded when
 * that frame was grabbed.
 */
function detectionToDirection(
  detection: Detection,
  frameWidth: number,
  frameHeight: number,
  basis: CameraBasis,
  fov: FovDeg,
): { yaw: number; pitch: number } {
  const halfTanH = Math.tan((fov.horizontal * Math.PI) / 360)
  const halfTanV = Math.tan((fov.vertical * Math.PI) / 360)
  const nx = (detection.cx / frameWidth) * 2 - 1
  const ny = 1 - (detection.cy / frameHeight) * 2

  const { right, up, forward } = basis
  const x = nx * halfTanH * right[0] + ny * halfTanV * up[0] + forward[0]
  const y = nx * halfTanH * right[1] + ny * halfTanV * up[1] + forward[1]
  const z = nx * halfTanH * right[2] + ny * halfTanV * up[2] + forward[2]
  const length = Math.hypot(x, y, z) || 1

  const dx = x / length
  const dy = y / length
  const dz = z / length
  const pitch = (Math.asin(Math.max(-1, Math.min(1, dy))) * 180) / Math.PI
  const yaw = (Math.atan2(dx, -dz) * 180) / Math.PI
  return { yaw: ((yaw % 360) + 360) % 360, pitch }
}

/** Two sightings closer together than this are treated as the same piece of furniture. */
const MERGE_ANGLE_DEG = 14

export function useObjectScan(fov: FovDeg) {
  const workerRef = useRef<Worker | null>(null)
  const busyRef = useRef(false)
  const fovRef = useRef(fov)

  useEffect(() => {
    fovRef.current = fov
  }, [fov])

  const [status, setStatus] = useState<ScanStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [objects, setObjects] = useState<SpottedObject[]>([])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current
    const worker = new Worker(new URL('./objectScanWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ScanWorkerResponse>) => {
      const data = event.data
      if (data.type === 'ready') {
        setStatus('scanning')
        return
      }
      if (data.type === 'error') {
        setError(data.message)
        setStatus('error')
        busyRef.current = false
        return
      }
      if (data.type === 'detections') {
        busyRef.current = false
        if (data.detections.length === 0) return
        setObjects((previous) => {
          const merged = [...previous]
          for (const detection of data.detections) {
            const { yaw, pitch } = detectionToDirection(
              detection,
              data.frameWidth,
              data.frameHeight,
              data.basis,
              fovRef.current,
            )
            // The same chair is seen in many frames as you sweep past it; keep the
            // sighting the model was most confident about rather than piling up duplicates.
            const existing = merged.findIndex(
              (o) => angularDistanceDeg(o.yaw, o.pitch, yaw, pitch) < MERGE_ANGLE_DEG,
            )
            if (existing >= 0) {
              if (detection.score > merged[existing].score) {
                merged[existing] = { yaw, pitch, classId: detection.classId, score: detection.score }
              }
            } else {
              merged.push({ yaw, pitch, classId: detection.classId, score: detection.score })
            }
          }
          return merged
        })
      }
    }
    worker.onerror = (event) => {
      setError(event.message || 'Worker quét vật thể gặp lỗi')
      setStatus('error')
    }
    workerRef.current = worker
    return worker
  }, [])

  const start = useCallback(() => {
    setObjects([])
    setError(null)
    setStatus('loading')
    const worker = ensureWorker()
    const request: ScanWorkerRequest = { type: 'warmup' }
    worker.postMessage(request)
  }, [ensureWorker])

  /**
   * Submits a frame if the previous one has finished. Inference takes far longer than a
   * frame interval on a phone, so queueing every frame would build an unbounded backlog and
   * report objects long after you had swept past them.
   */
  const submitFrame = useCallback((frame: ImageData, basis: CameraBasis) => {
    if (busyRef.current || !workerRef.current) return
    busyRef.current = true
    const request: ScanWorkerRequest = { type: 'detect', frame, basis }
    workerRef.current.postMessage(request)
  }, [])

  const stop = useCallback(() => {
    setStatus('idle')
    busyRef.current = false
  }, [])

  return { status, error, objects, start, submitFrame, stop }
}
