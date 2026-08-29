import { useEffect, useRef, useState } from 'react'
import type { PannellumViewerInstance } from '../types/pannellum'
import TourViewer, { DEFAULT_HFOV } from './TourViewer'
import type { Hotspot, SceneWithUrl } from './types'

/** Turning toward the doorway and pushing in. */
const APPROACH_MS = 420
/** The old room dissolving as the new one takes over. */
const CROSS_MS = 520
/** The new room easing back out to a resting field of view. */
const SETTLE_MS = 900
/** Narrowed field of view at the moment of travel — reads as moving forward. */
const TRAVEL_HFOV = 58
/** How long to hold the approach waiting for the next panorama to decode. */
const LOAD_GRACE_MS = 1600

interface Slot {
  scene: SceneWithUrl
  entry?: { yaw: number; pitch: number; hfov: number }
}

interface TourStageProps {
  scene: SceneWithUrl
  sceneNames: Map<string, string>
  placing: boolean
  onPlace: (yaw: number, pitch: number) => void
  onHotspotClick: (hotspot: Hotspot) => void
  /**
   * Direction the visitor is walking, taken from the hotspot they clicked.
   * Present means "walk through the door"; absent means a plain dissolve,
   * which is what jumping from the room strip should feel like.
   */
  travel: { yaw: number; pitch: number } | null
  className?: string
}

/**
 * Moves between rooms the way Street View does: turn toward the doorway, push
 * in, then dissolve the old room away while the new one is already on screen
 * underneath. That needs both panoramas alive at once, so the stage keeps two
 * viewer slots and alternates between them.
 */
export default function TourStage({
  scene,
  sceneNames,
  placing,
  onPlace,
  onHotspotClick,
  travel,
  className,
}: TourStageProps) {
  const [slots, setSlots] = useState<[Slot | null, Slot | null]>([{ scene }, null])
  const [front, setFront] = useState(0)
  const [leaving, setLeaving] = useState<number | null>(null)
  const [flying, setFlying] = useState(false)

  const apis = useRef<[PannellumViewerInstance | null, PannellumViewerInstance | null]>([null, null])
  const loadWaiters = useRef<Array<(() => void) | null>>([null, null])
  const runId = useRef(0)
  const travelRef = useRef(travel)
  travelRef.current = travel

  useEffect(() => {
    const current = slots[front]

    // Same room: refresh the slot so hotspot edits reach the viewer.
    if (current && current.scene.id === scene.id) {
      if (current.scene !== scene) {
        setSlots((prev) => {
          const next = [...prev] as [Slot | null, Slot | null]
          next[front] = { ...prev[front]!, scene }
          return next
        })
      }
      return
    }

    const run = ++runId.current
    const alive = () => runId.current === run
    const heading = travelRef.current
    const incoming = front === 0 ? 1 : 0
    const departing = apis.current[front]

    // Mount the next room underneath, already facing the way we're walking.
    setSlots((prev) => {
      const next = [...prev] as [Slot | null, Slot | null]
      next[incoming] = {
        scene,
        entry: heading
          ? { yaw: heading.yaw, pitch: scene.initialPitch, hfov: TRAVEL_HFOV }
          : undefined,
      }
      return next
    })
    setFlying(true)

    const waitForLoad = new Promise<void>((resolve) => {
      loadWaiters.current[incoming] = resolve
    })

    if (heading && departing) {
      // Turn toward the doorway and push in. Pitch is damped so the camera
      // doesn't dive at the floor on a low hotspot.
      departing.lookAt(heading.pitch * 0.5, heading.yaw, TRAVEL_HFOV, APPROACH_MS)
    }

    const approach = new Promise<void>((r) => setTimeout(r, heading ? APPROACH_MS : 0))
    const grace = new Promise<void>((r) => setTimeout(r, LOAD_GRACE_MS))

    // Hold the approach until the next panorama is actually on screen, or the
    // grace period runs out — a dissolve into a blank canvas is worse than a wait.
    void Promise.all([approach, Promise.race([waitForLoad, grace])]).then(() => {
      if (!alive()) return
      loadWaiters.current[incoming] = null
      setFront(incoming)
      setLeaving(front)

      apis.current[incoming]?.lookAt(
        scene.initialPitch,
        heading ? heading.yaw : scene.initialYaw,
        DEFAULT_HFOV,
        heading ? SETTLE_MS : 0,
      )

      setTimeout(() => {
        if (!alive()) return
        setSlots((prev) => {
          const next = [...prev] as [Slot | null, Slot | null]
          next[front] = null
          return next
        })
        setLeaving(null)
        setFlying(false)
      }, CROSS_MS)
    })
    // `travel` is read through a ref: it changes with the click that caused the
    // move, and re-running on it alone would restart a flight already in motion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, front])

  return (
    <div className={`relative overflow-hidden ${className ?? 'h-full w-full'}`}>
      {slots.map((slot, index) => {
        if (!slot) return null
        const isLeaving = leaving === index
        const isFront = front === index && !isLeaving
        return (
          <div
            key={index}
            className={`absolute inset-0 ${isLeaving ? 'vt-slot--leaving' : ''}`}
            style={{
              // The room being left must stay on top through the dissolve, and
              // the one being preloaded must stay under the room still in use.
              zIndex: isLeaving ? 20 : index === front ? 10 : 5,
              // A leaving slot keeps drifting forward, so the dissolve reads as
              // motion rather than a fade. A plain jump just dissolves.
              transitionDuration: `${CROSS_MS}ms`,
              ...(isLeaving && travelRef.current ? { transform: 'scale(1.6)' } : null),
              ...(isLeaving ? { opacity: 0 } : null),
              pointerEvents: isFront && !flying ? 'auto' : 'none',
            }}
          >
            <TourViewer
              scene={slot.scene}
              sceneNames={sceneNames}
              placing={isFront && placing}
              onPlace={onPlace}
              onHotspotClick={onHotspotClick}
              entry={slot.entry}
              apiRef={{
                get current() {
                  return apis.current[index]
                },
                set current(value) {
                  apis.current[index] = value
                },
              }}
              onLoad={() => loadWaiters.current[index]?.()}
              className="h-full w-full"
            />
          </div>
        )
      })}
    </div>
  )
}
