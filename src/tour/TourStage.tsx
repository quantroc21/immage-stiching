import { useEffect, useRef, useState } from 'react'
import type { PannellumViewerInstance } from '../types/pannellum'
import TourViewer, { DEFAULT_HFOV } from './TourViewer'
import type { Hotspot, SceneWithUrl } from './types'

/** The old room dissolving while it keeps rushing forward. */
const FLIGHT_MS = 460
/** The new room easing out of its slight over-scale. */
const SETTLE_MS = 620
/** Longest the flight will wait for the next panorama before revealing it. */
const REVEAL_GRACE_MS = 500
/** How far the room being left rushes past the viewer. */
const OUT_SCALE = 1.45
/** How close the arriving room starts, so it settles outward into place. */
const IN_SCALE = 1.14

export interface Travel {
  yaw: number
  pitch: number
  /** Where the doorway was on screen, 0..1, so the rush aims at it. */
  originX: number
  originY: number
}

interface Slot {
  scene: SceneWithUrl
  entry?: { yaw: number; pitch: number; hfov: number }
  /** Scale this room is held at while it waits underneath, so it can settle
   *  outward the moment it is revealed. 1 for a plain dissolve. */
  entryScale: number
}

interface TourStageProps {
  scene: SceneWithUrl
  sceneNames: Map<string, string>
  placing: boolean
  onPlace: (yaw: number, pitch: number) => void
  onHotspotClick: (hotspot: Hotspot, event?: MouseEvent) => void
  /**
   * Set when the visitor walked through a hotspot. Absent means a plain
   * dissolve, which is what picking a room off the strip should feel like.
   */
  travel: Travel | null
  className?: string
}

/**
 * Moves between rooms the way Street View does: the room you are leaving rushes
 * past and dissolves, uncovering the next one already on screen underneath, and
 * you arrive facing the way you walked.
 *
 * Every bit of that motion is a CSS transform. Animating Pannellum's field of
 * view instead means re-projecting a 4096px sphere on each frame while the next
 * panorama is still decoding, which stutters on a phone; transforms stay on the
 * compositor and the two movements overlap instead of running one after the other.
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
  const [slots, setSlots] = useState<[Slot | null, Slot | null]>([
    { scene, entryScale: 1 },
    null,
  ])
  const [front, setFront] = useState(0)
  const [leaving, setLeaving] = useState<{ index: number; travel: Travel | null } | null>(null)
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
    const departing = front

    setSlots((prev) => {
      const next = [...prev] as [Slot | null, Slot | null]
      next[incoming] = {
        scene,
        entry: heading
          ? { yaw: heading.yaw, pitch: scene.initialPitch, hfov: DEFAULT_HFOV }
          : undefined,
        entryScale: heading ? IN_SCALE : 1,
      }
      return next
    })
    setFlying(true)

    const waitForLoad = new Promise<void>((resolve) => {
      loadWaiters.current[incoming] = resolve
    })
    const grace = new Promise<void>((r) => setTimeout(r, REVEAL_GRACE_MS))

    // Reveal as soon as the next panorama is on screen — dissolving into a
    // blank canvas is worse than a short wait — but never stall on it.
    void Promise.race([waitForLoad, grace]).then(() => {
      if (!alive()) return
      loadWaiters.current[incoming] = null
      // Becoming the front slot is itself what starts the settle: the room has
      // been sitting at its entry scale with no transition while it loaded, so
      // this commit animates it from there down to 1.
      setFront(incoming)
      setLeaving({ index: departing, travel: heading })

      setTimeout(() => {
        if (!alive()) return
        setSlots((prev) => {
          const next = [...prev] as [Slot | null, Slot | null]
          next[departing] = null
          return next
        })
        setLeaving(null)
        setFlying(false)
      }, FLIGHT_MS)
    })
    // `travel` is read through a ref: it arrives with the click that caused the
    // move, and reacting to it alone would restart a flight already under way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, front])

  // `isolate` keeps the slot z-indices below from competing with the controls
  // the caller layers over the stage.
  return (
    <div className={`relative isolate overflow-hidden ${className ?? 'h-full w-full'}`}>
      {slots.map((slot, index) => {
        if (!slot) return null
        const isLeaving = leaving?.index === index
        const isFront = front === index && !isLeaving
        const heading = isLeaving ? leaving.travel : null

        const style: React.CSSProperties = {
          // The room being left stays on top through the dissolve; the one
          // being preloaded stays under the room still in use.
          zIndex: isLeaving ? 20 : index === front ? 10 : 5,
          pointerEvents: isFront && !flying ? 'auto' : 'none',
        }

        if (isLeaving) {
          style.transitionDuration = `${FLIGHT_MS}ms`
          style.opacity = 0
          if (heading) {
            // Rush toward the doorway itself rather than the middle of the screen.
            style.transformOrigin = `${heading.originX * 100}% ${heading.originY * 100}%`
            style.transform = `scale(${OUT_SCALE})`
          }
        } else if (index === front) {
          style.transitionDuration = `${SETTLE_MS}ms`
          style.transform = 'scale(1)'
        } else {
          // Waiting underneath: held at the entry scale, untransitioned, so the
          // reveal animates outward from here instead of snapping into it.
          style.transitionDuration = '0ms'
          style.transform = `scale(${slot.entryScale})`
        }

        return (
          <div
            key={index}
            className={`absolute inset-0 ${isLeaving ? 'vt-slot--leaving' : ''} ${
              isFront ? 'vt-slot--arriving' : ''
            }`}
            style={style}
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
