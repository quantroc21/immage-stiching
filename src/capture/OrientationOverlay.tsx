import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import type { SphereDot } from './sphereDots'
import type { FovDeg } from './cameraFov'

const SPHERE_RADIUS = 5
const DOT_RADIUS = 0.12
const MATCHED_FADE_MS = 350
// Shrink captured patches slightly so adjacent tiles don't z-fight at the seams.
const PATCH_SCALE = 0.96

export interface OrientationOverlayHandle {
  /** Places the captured photo as a textured patch at that dot's direction in 3D space. */
  placeCapturedPhoto: (dotId: string, imageUrl: string) => void
}

interface OrientationOverlayProps {
  className?: string
  dots: SphereDot[]
  /** One shot's angular field of view — used to size each captured photo patch. */
  fov: FovDeg
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

function directionFor(yawDeg: number, pitchDeg: number): THREE.Vector3 {
  const yawRad = (yawDeg * Math.PI) / 180
  const pitchRad = (pitchDeg * Math.PI) / 180
  return new THREE.Vector3(
    Math.sin(yawRad) * Math.cos(pitchRad),
    Math.sin(pitchRad),
    -Math.cos(yawRad) * Math.cos(pitchRad),
  )
}

const OrientationOverlay = forwardRef<OrientationOverlayHandle, OrientationOverlayProps>(function OrientationOverlay(
  { className, dots, fov, matchThresholdDeg, onDotMatched, onLookDirectionChange, onOrientationSourceChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const dotsGroupRef = useRef<THREE.Group | null>(null)
  const patchesGroupRef = useRef<THREE.Group | null>(null)
  const dotMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map())
  const dotDirectionsRef = useRef<Map<string, THREE.Vector3>>(new Map())
  const matchedIdsRef = useRef<Set<string>>(new Set())
  const matchedMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const textureLoaderRef = useRef<THREE.TextureLoader | null>(null)
  const fovRef = useRef(fov)
  const onLookDirectionChangeRef = useRef(onLookDirectionChange)
  const onOrientationSourceChangeRef = useRef(onOrientationSourceChange)
  const onDotMatchedRef = useRef(onDotMatched)
  const matchThresholdRadRef = useRef((matchThresholdDeg * Math.PI) / 180)

  useEffect(() => {
    onLookDirectionChangeRef.current = onLookDirectionChange
    onOrientationSourceChangeRef.current = onOrientationSourceChange
    onDotMatchedRef.current = onDotMatched
    matchThresholdRadRef.current = (matchThresholdDeg * Math.PI) / 180
    fovRef.current = fov
  }, [onLookDirectionChange, onOrientationSourceChange, onDotMatched, matchThresholdDeg, fov])

  useImperativeHandle(ref, () => ({
    placeCapturedPhoto(dotId: string, imageUrl: string) {
      const group = patchesGroupRef.current
      const dir = dotDirectionsRef.current.get(dotId)
      const loader = textureLoaderRef.current
      if (!group || !dir || !loader) return

      const { horizontal, vertical } = fovRef.current
      const width = 2 * SPHERE_RADIUS * Math.tan((horizontal * Math.PI) / 360) * PATCH_SCALE
      const height = 2 * SPHERE_RADIUS * Math.tan((vertical * Math.PI) / 360) * PATCH_SCALE

      loader.load(imageUrl, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
        mesh.position.copy(dir).multiplyScalar(SPHERE_RADIUS)
        mesh.lookAt(0, 0, 0)
        group.add(mesh)
      })
    },
  }))

  // Mounts the renderer/camera/scene once and drives the render loop + orientation input.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const el = container

    const scene = new THREE.Scene()
    sceneRef.current = scene
    const dotsGroup = new THREE.Group()
    dotsGroupRef.current = dotsGroup
    scene.add(dotsGroup)
    const patchesGroup = new THREE.Group()
    patchesGroupRef.current = patchesGroup
    scene.add(patchesGroup)
    textureLoaderRef.current = new THREE.TextureLoader()

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
      sceneRef.current = null
      dotsGroupRef.current = null
      patchesGroupRef.current = null
      matchedMaterialRef.current = null
      textureLoaderRef.current = null
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
    const dirMap = new Map<string, THREE.Vector3>()
    matchedIdsRef.current = new Set()

    for (const dot of dots) {
      const dir = directionFor(dot.yaw, dot.pitch)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.copy(dir).multiplyScalar(SPHERE_RADIUS)
      mesh.userData.dotId = dot.id
      group.add(mesh)
      meshMap.set(dot.id, mesh)
      dirMap.set(dot.id, dir)
    }
    dotMeshesRef.current = meshMap
    dotDirectionsRef.current = dirMap

    return () => {
      group.clear()
      geometry.dispose()
      material.dispose()
      dotMeshesRef.current = new Map()
    }
  }, [dots])

  return <div ref={containerRef} className={className ?? 'absolute inset-0'} style={{ touchAction: 'none' }} />
})

export default OrientationOverlay
