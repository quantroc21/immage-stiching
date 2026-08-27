import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { SphereDot } from './sphereDots'

const SPHERE_RADIUS = 5
const DOT_RADIUS = 0.12
const MATCHED_FADE_MS = 350

interface OrientationOverlayProps {
  className?: string
  dots: SphereDot[]
  /** Angular distance (degrees) within which the crosshair is considered "on" a dot. */
  matchThresholdDeg: number
  /** Fired once, the first time the crosshair lines up with a given (still-unmatched) dot. */
  onDotMatched?: (dotId: string) => void
  /** yaw/pitch in degrees of where the camera is currently looking */
  onLookDirectionChange?: (yawDeg: number, pitchDeg: number) => void
  /** true once real deviceorientation events start arriving, false while using the drag fallback */
  onOrientationSourceChange?: (usingSensors: boolean) => void
}

function getScreenOrientationRad(): number {
  const angle =
    screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0
  return (angle * Math.PI) / 180
}

export default function OrientationOverlay({
  className,
  dots,
  matchThresholdDeg,
  onDotMatched,
  onLookDirectionChange,
  onOrientationSourceChange,
}: OrientationOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dotsGroupRef = useRef<THREE.Group | null>(null)
  const dotMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map())
  const matchedIdsRef = useRef<Set<string>>(new Set())
  const matchedMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const onLookDirectionChangeRef = useRef(onLookDirectionChange)
  const onOrientationSourceChangeRef = useRef(onOrientationSourceChange)
  const onDotMatchedRef = useRef(onDotMatched)
  const matchThresholdRadRef = useRef((matchThresholdDeg * Math.PI) / 180)

  useEffect(() => {
    onLookDirectionChangeRef.current = onLookDirectionChange
    onOrientationSourceChangeRef.current = onOrientationSourceChange
    onDotMatchedRef.current = onDotMatched
    matchThresholdRadRef.current = (matchThresholdDeg * Math.PI) / 180
  }, [onLookDirectionChange, onOrientationSourceChange, onDotMatched, matchThresholdDeg])

  // Mounts the renderer/camera/scene once and drives the render loop + orientation input.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const el = container

    const scene = new THREE.Scene()
    const dotsGroup = new THREE.Group()
    dotsGroupRef.current = dotsGroup
    scene.add(dotsGroup)

    const matchedMaterial = new THREE.MeshBasicMaterial({ color: 0x6b7280, transparent: true, opacity: 0.5 })
    matchedMaterialRef.current = matchedMaterial

    const camera = new THREE.PerspectiveCamera(70, el.clientWidth / el.clientHeight, 0.1, 20)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)

    // --- Real sensor input (mobile) ---
    let alpha = 0
    let beta = 0
    let gamma = 0
    let haveDeviceData = false
    const zAxis = new THREE.Vector3(0, 0, 1)
    const euler = new THREE.Euler()
    const screenAdjustQuat = new THREE.Quaternion()
    // Rotates device "top pointing at sky" frame to camera "looking out the back" frame.
    const deviceToCameraQuat = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5))

    function handleDeviceOrientation(e: DeviceOrientationEvent) {
      if (e.alpha === null) return
      haveDeviceData = true
      alpha = THREE.MathUtils.degToRad(e.alpha)
      beta = THREE.MathUtils.degToRad(e.beta ?? 0)
      gamma = THREE.MathUtils.degToRad(e.gamma ?? 0)
    }
    window.addEventListener('deviceorientation', handleDeviceOrientation)

    // --- Drag-to-look fallback (desktop / no sensor permission) ---
    let manualYawDeg = 0
    let manualPitchDeg = 0
    let dragging = false
    let lastX = 0
    let lastY = 0
    function onPointerDown(e: PointerEvent) {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      manualYawDeg -= dx * 0.2
      manualPitchDeg = Math.max(-89, Math.min(89, manualPitchDeg + dy * 0.2))
    }
    function onPointerUp() {
      dragging = false
    }
    container.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    let rafId = 0
    let lastReportedSource: boolean | null = null
    const forward = new THREE.Vector3()
    const dotDir = new THREE.Vector3()

    function animate() {
      rafId = requestAnimationFrame(animate)

      if (haveDeviceData) {
        euler.set(beta, alpha, -gamma, 'YXZ')
        camera.quaternion.setFromEuler(euler)
        camera.quaternion.multiply(deviceToCameraQuat)
        camera.quaternion.multiply(screenAdjustQuat.setFromAxisAngle(zAxis, -getScreenOrientationRad()))
      } else {
        euler.set(
          THREE.MathUtils.degToRad(manualPitchDeg),
          THREE.MathUtils.degToRad(manualYawDeg),
          0,
          'YXZ',
        )
        camera.quaternion.setFromEuler(euler)
      }

      if (lastReportedSource !== haveDeviceData) {
        lastReportedSource = haveDeviceData
        onOrientationSourceChangeRef.current?.(haveDeviceData)
      }

      forward.set(0, 0, -1).applyQuaternion(camera.quaternion)

      if (onLookDirectionChangeRef.current) {
        const pitchOut = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)))
        const yawOut = THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z))
        onLookDirectionChangeRef.current(((yawOut % 360) + 360) % 360, pitchOut)
      }

      // Crosshair-vs-dot hit test: is the camera looking straight enough at any
      // still-unmatched dot to count as "captured"?
      const threshold = matchThresholdRadRef.current
      for (const [id, mesh] of dotMeshesRef.current) {
        if (matchedIdsRef.current.has(id)) continue
        dotDir.copy(mesh.position).normalize()
        if (forward.angleTo(dotDir) < threshold) {
          matchedIdsRef.current.add(id)
          const material = matchedMaterialRef.current
          if (material) mesh.material = material
          onDotMatchedRef.current?.(id)
          setTimeout(() => {
            dotsGroupRef.current?.remove(mesh)
          }, MATCHED_FADE_MS)
        }
      }

      renderer.render(scene, camera)
    }
    animate()

    function handleResize() {
      camera.aspect = el.clientWidth / el.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(el.clientWidth, el.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('deviceorientation', handleDeviceOrientation)
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('resize', handleResize)
      matchedMaterial.dispose()
      renderer.dispose()
      container.removeChild(renderer.domElement)
      dotsGroupRef.current = null
      matchedMaterialRef.current = null
    }
  }, [])

  // Rebuilds the dot meshes whenever the (FOV-derived) grid changes, without tearing down
  // the renderer/camera/orientation listeners set up above.
  useEffect(() => {
    const group = dotsGroupRef.current
    if (!group) return

    const geometry = new THREE.SphereGeometry(DOT_RADIUS, 12, 12)
    const material = new THREE.MeshBasicMaterial({ color: 0x22c55e })
    const meshMap = new Map<string, THREE.Mesh>()
    matchedIdsRef.current = new Set()

    for (const dot of dots) {
      const yawRad = (dot.yaw * Math.PI) / 180
      const pitchRad = (dot.pitch * Math.PI) / 180
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(
        SPHERE_RADIUS * Math.sin(yawRad) * Math.cos(pitchRad),
        SPHERE_RADIUS * Math.sin(pitchRad),
        -SPHERE_RADIUS * Math.cos(yawRad) * Math.cos(pitchRad),
      )
      mesh.userData.dotId = dot.id
      group.add(mesh)
      meshMap.set(dot.id, mesh)
    }
    dotMeshesRef.current = meshMap

    return () => {
      group.clear()
      geometry.dispose()
      material.dispose()
      dotMeshesRef.current = new Map()
    }
  }, [dots])

  return <div ref={containerRef} className={className ?? 'absolute inset-0'} style={{ touchAction: 'none' }} />
}
