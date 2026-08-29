import { useEffect, useRef, type MutableRefObject } from 'react'
import type { PannellumHotSpot, PannellumViewerInstance } from '../types/pannellum'
import type { Hotspot, SceneWithUrl } from './types'

interface TourViewerProps {
  scene: SceneWithUrl
  /** Used to label hotspots with the room they lead to. */
  sceneNames: Map<string, string>
  /** In 'place' mode a tap on the panorama reports its yaw/pitch instead of panning. */
  placing: boolean
  onPlace: (yaw: number, pitch: number) => void
  onHotspotClick: (hotspot: Hotspot, event?: MouseEvent) => void
  /** Reports the current camera angles so the caller can save a start view. */
  onViewChange?: (yaw: number, pitch: number) => void
  /** Overrides the scene's own start view, used to arrive mid-flight. */
  entry?: { yaw: number; pitch: number; hfov: number }
  /** Exposes the Pannellum instance so the stage can drive the camera. */
  apiRef?: MutableRefObject<PannellumViewerInstance | null>
  /** Fires once the panorama texture is on screen. */
  onLoad?: () => void
  className?: string
}

/** A tap that moves less than this is a click, not a drag of the panorama. */
const CLICK_SLOP_PX = 8

/**
 * Resting field of view, in degrees, with the limits it must stay inside.
 *
 * Do not widen these. Past ~85 deg the rectilinear projection funnels badly on
 * a portrait phone screen when you pan up or down, the "flowing water" stretch
 * that f9f8e2f fixed. The pitch clamp keeps the poles, where equirectangular
 * stretching is worst, out of frame.
 */
export const DEFAULT_HFOV = 70
export const MIN_HFOV = 45
export const MAX_HFOV = 85
export const MIN_PITCH = -80
export const MAX_PITCH = 80

export default function TourViewer({
  scene,
  sceneNames,
  placing,
  onPlace,
  onHotspotClick,
  onViewChange,
  entry,
  apiRef,
  onLoad,
  className,
}: TourViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PannellumViewerInstance | null>(null)
  const renderedRef = useRef<Map<string, Hotspot>>(new Map())

  // Handlers are called from hotspots created imperatively, so read them
  // through refs to avoid rebuilding the viewer on every render.
  const handlersRef = useRef({ placing, onPlace, onHotspotClick, onViewChange, onLoad, sceneNames })
  handlersRef.current = { placing, onPlace, onHotspotClick, onViewChange, onLoad, sceneNames }
  // Captured once per viewer build: changing it later must not rebuild.
  const entryRef = useRef(entry)

  const toPannellum = (hotspot: Hotspot): PannellumHotSpot => {
    const label =
      hotspot.label ?? handlersRef.current.sceneNames.get(hotspot.targetSceneId) ?? 'Phòng đã xoá'
    return {
      id: hotspot.id,
      yaw: hotspot.yaw,
      pitch: hotspot.pitch,
      type: 'info',
      cssClass: 'vt-hotspot',
      // Build the marker by hand rather than relying on Pannellum's sprite
      // sheet, so the room name rides along with the arrow.
      createTooltipFunc: (div) => {
        const ring = document.createElement('span')
        ring.className = 'vt-hotspot__ring'
        const caption = document.createElement('span')
        caption.className = 'vt-hotspot__label'
        caption.textContent = label
        div.appendChild(ring)
        div.appendChild(caption)
      },
      clickHandlerFunc: (event) => handlersRef.current.onHotspotClick(hotspot, event),
    }
  }

  // Build the viewer once per scene image.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const viewer = window.pannellum.viewer(container, {
      type: 'equirectangular',
      panorama: scene.url,
      autoLoad: true,
      showControls: false,
      compass: false,
      yaw: entryRef.current?.yaw ?? scene.initialYaw,
      pitch: entryRef.current?.pitch ?? scene.initialPitch,
      hfov: entryRef.current?.hfov ?? DEFAULT_HFOV,
      minHfov: MIN_HFOV,
      maxHfov: MAX_HFOV,
      minPitch: MIN_PITCH,
      maxPitch: MAX_PITCH,
      friction: 0.12,
      touchPanSpeedCoeffFactor: 1,
      hotSpots: scene.hotspots.map(toPannellum),
    })
    viewerRef.current = viewer
    if (apiRef) apiRef.current = viewer
    renderedRef.current = new Map(scene.hotspots.map((h) => [h.id, h]))

    const announceLoad = () => handlersRef.current.onLoad?.()
    viewer.on('load', announceLoad)

    return () => {
      viewer.off('load', announceLoad)
      viewer.destroy()
      viewerRef.current = null
      if (apiRef) apiRef.current = null
      renderedRef.current = new Map()
    }
    // Rebuilding on hotspot changes would reset the camera mid-edit, so the
    // hotspot list is synced incrementally in the effect below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id, scene.url])

  // Sync hotspots without tearing down the viewer.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const rendered = renderedRef.current
    const next = new Map(scene.hotspots.map((h) => [h.id, h]))

    for (const [id] of rendered) {
      if (!next.has(id)) {
        viewer.removeHotSpot(id)
        rendered.delete(id)
      }
    }
    for (const [id, hotspot] of next) {
      const current = rendered.get(id)
      const changed =
        current &&
        (current.yaw !== hotspot.yaw ||
          current.pitch !== hotspot.pitch ||
          current.targetSceneId !== hotspot.targetSceneId ||
          current.label !== hotspot.label)
      if (changed) {
        viewer.removeHotSpot(id)
        rendered.delete(id)
      }
      if (!rendered.has(id)) {
        viewer.addHotSpot(toPannellum(hotspot))
        rendered.set(id, hotspot)
      }
    }
    // toPannellum reads live values through handlersRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.hotspots, sceneNames])

  // Tap-to-place. Pannellum swallows its own drags, so measure the pointer
  // travel and only treat a near-stationary tap as a placement.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let start: { x: number; y: number } | null = null

    const onPointerDown = (e: PointerEvent) => {
      start = { x: e.clientX, y: e.clientY }
    }
    const onPointerUp = (e: PointerEvent) => {
      const from = start
      start = null
      if (!from || !handlersRef.current.placing) return
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP_PX) return
      // Don't place a hotspot on top of an existing one.
      if ((e.target as HTMLElement).closest('.pnlm-hotspot-base')) return
      const viewer = viewerRef.current
      if (!viewer) return
      const [pitch, yaw] = viewer.mouseEventToCoords(e as unknown as MouseEvent)
      handlersRef.current.onPlace(yaw, pitch)
    }

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointerup', onPointerUp)
    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  // Report camera angles so the caller can persist a start view.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !onViewChange) return
    const handler = () => {
      const v = viewerRef.current as unknown as { getYaw?: () => number; getPitch?: () => number }
      if (v.getYaw && v.getPitch) handlersRef.current.onViewChange?.(v.getYaw(), v.getPitch())
    }
    viewer.on('animatefinished', handler)
    return () => {
      viewer.off('animatefinished', handler)
    }
  }, [scene.id, onViewChange])

  return (
    <div
      ref={containerRef}
      className={`${className ?? 'h-full w-full'} ${placing ? 'cursor-crosshair' : ''}`}
    />
  )
}
