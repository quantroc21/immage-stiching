import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import type { SphereDot } from './sphereDots'
import type { FovDeg } from './cameraFov'

const SPHERE_RADIUS = 5
const MATCHED_FADE_MS = 300
// Shrink captured patches slightly so adjacent tiles don't z-fight at the seams.
const PATCH_SCALE = 0.98
// The live quad sits a touch closer to the eye than the captured patches so it always
// draws in front of them.
const LIVE_RADIUS_SCALE = 0.97
/**
 * The virtual camera is deliberately WIDER than the phone's real camera, so the live
 * frame occupies only the middle of the screen and you can see the black void plus your
 * already-captured tiles around it — that's what gives the reference app its look.
 */
export const VIRTUAL_CAMERA_FOV_DEG = 100
/** Beyond this much roll the shot would come out crooked, so capture is blocked. Forgiving enough for handheld pitch. */
const ROLL_TOLERANCE_DEG = 18
/**
 * Above this much swing the phone is still moving, so autofocus hasn't settled and the
 * frame would come out smeared. The dwell timer pauses until you hold steady.
 */
const STEADY_MAX_DEG_PER_SEC = 28

const GREEN = 0x22c55e
const RED = 0xdc2626

export type TiltHint = 'ok' | 'left' | 'right'
export type ArrowHint = 'up' | 'down' | 'left' | 'right' | null

export interface OverlayStatus {
  tilt: TiltHint
  /** Which way to turn to reach the nearest not-yet-captured point. */
  arrow: ArrowHint
  /** 0..1 — how long the crosshair has been held on a point, drives the crosshair pie. */
  dwell: number
  /** False while the phone is still swinging — the countdown is paused waiting for focus. */
  steady: boolean
  /** True while the crosshair is sitting on a point (i.e. the countdown is relevant). */
  onTarget: boolean
  usingSensors: boolean
}

export interface OrientationOverlayHandle {
  /** Places the captured photo as a textured patch at that dot's direction in 3D space. */
  placeCapturedPhoto: (dotId: string, imageUrl: string) => void
  /** Manually triggers capturing the nearest pending dot immediately. */
  triggerManualCapture: () => boolean
  /**
   * The camera's current 3D orientation. Needed to turn a point in a video frame back into
   * a direction in the world — the scan step uses it to work out where a detected object
   * actually is, rather than just where it sat on screen.
   */
  getCameraBasis: () => { right: [number, number, number]; up: [number, number, number]; forward: [number, number, number] } | null
}

interface OrientationOverlayProps {
  className?: string
  dots: SphereDot[]
  /** One shot's angular field of view — sizes the live frame and each captured patch. */
  fov: FovDeg
  /** The live camera element, drawn into the 3D scene as a floating frame. */
  video: HTMLVideoElement | null
  /** Angular distance (degrees) within which the crosshair counts as "on" a point. */
  matchThresholdDeg: number
  /** How long the crosshair must stay on a point before it fires. */
  dwellMs: number
  /**
   * Return false to reject the shot (e.g. the camera had no frame ready) — the point then
   * stays pending instead of silently disappearing with nothing captured for it.
   */
  onDotMatched?: (
    dotId: string,
    yawDeg: number,
    pitchDeg: number,
    vectors?: {
      right: [number, number, number]
      up: [number, number, number]
      forward: [number, number, number]
    },
  ) => boolean
  onStatusChange?: (status: OverlayStatus) => void
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

/** Angular half-extents of one shot, as world-space sizes on a sphere of the given radius. */
function quadSize(fov: FovDeg, radius: number) {
  return {
    width: 2 * radius * Math.tan((fov.horizontal * Math.PI) / 360),
    height: 2 * radius * Math.tan((fov.vertical * Math.PI) / 360),
  }
}

/** Orients a quad so it faces the origin with its top edge as close to world-up as possible. */
function faceOrigin(mesh: THREE.Mesh, dir: THREE.Vector3) {
  // Straight up/down would make the world-up reference degenerate, so lean on Z there.
  mesh.up.set(0, 1, 0)
  if (Math.abs(dir.y) > 0.99) mesh.up.set(0, 0, -Math.sign(dir.y))
  mesh.lookAt(0, 0, 0)
}

const OrientationOverlay = forwardRef<OrientationOverlayHandle, OrientationOverlayProps>(function OrientationOverlay(
  { className, dots, fov, video, matchThresholdDeg, dwellMs, onDotMatched, onStatusChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dotsGroupRef = useRef<THREE.Group | null>(null)
  const patchesGroupRef = useRef<THREE.Group | null>(null)
  const dotMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map())
  const dotDirectionsRef = useRef<Map<string, THREE.Vector3>>(new Map())
  const matchedIdsRef = useRef<Set<string>>(new Set())
  const greenMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const redMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const matchedMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null)
  const liveMeshRef = useRef<THREE.Mesh | null>(null)
  const manualCaptureRef = useRef<() => boolean>(() => false)
  const cameraBasisRef = useRef<{
    right: [number, number, number]
    up: [number, number, number]
    forward: [number, number, number]
  } | null>(null)
  const fovRef = useRef(fov)
  const videoRef = useRef(video)
  const dwellMsRef = useRef(dwellMs)
  const matchThresholdRadRef = useRef((matchThresholdDeg * Math.PI) / 180)
  const onDotMatchedRef = useRef(onDotMatched)
  const onStatusChangeRef = useRef(onStatusChange)

  useEffect(() => {
    fovRef.current = fov
    dwellMsRef.current = dwellMs
    matchThresholdRadRef.current = (matchThresholdDeg * Math.PI) / 180
    onDotMatchedRef.current = onDotMatched
    onStatusChangeRef.current = onStatusChange
  }, [fov, dwellMs, matchThresholdDeg, onDotMatched, onStatusChange])

  useImperativeHandle(ref, () => ({
    placeCapturedPhoto(dotId: string, imageUrl: string) {
      const group = patchesGroupRef.current
      const dir = dotDirectionsRef.current.get(dotId)
      if (!group || !dir) return

      const { width, height } = quadSize(fovRef.current, SPHERE_RADIUS)
      const img = new Image()
      img.onload = () => {
        // Downscale to 512px max for the 3D sphere preview patch to avoid WebGL memory bloat/crash
        const scale = Math.min(1, 512 / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          const texture = new THREE.CanvasTexture(canvas)
          texture.colorSpace = THREE.SRGBColorSpace
          const material = new THREE.MeshBasicMaterial({ map: texture })
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * PATCH_SCALE, height * PATCH_SCALE), material)
          mesh.position.copy(dir).multiplyScalar(SPHERE_RADIUS)
          faceOrigin(mesh, dir)
          group.add(mesh)
        }
      }
      img.src = imageUrl
    },
    triggerManualCapture() {
      return manualCaptureRef.current()
    },
    getCameraBasis() {
      return cameraBasisRef.current
    },
  }))

  // Sets up the renderer/camera/scene once, and drives the render loop + orientation input.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const el = container

    const scene = new THREE.Scene()
    const dotsGroup = new THREE.Group()
    dotsGroupRef.current = dotsGroup
    scene.add(dotsGroup)
    const patchesGroup = new THREE.Group()
    patchesGroupRef.current = patchesGroup
    scene.add(patchesGroup)

    greenMaterialRef.current = new THREE.MeshBasicMaterial({ color: GREEN })
    redMaterialRef.current = new THREE.MeshBasicMaterial({ color: RED })
    matchedMaterialRef.current = new THREE.MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.45 })

    const camera = new THREE.PerspectiveCamera(
      VIRTUAL_CAMERA_FOV_DEG,
      el.clientWidth / el.clientHeight,
      0.1,
      20,
    )
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)

    // --- Live camera frame, floating in the scene at wherever you're aiming ---
    let liveTexture: THREE.VideoTexture | null = null
    let liveMaterial: THREE.MeshBasicMaterial | null = null
    let liveGeometry: THREE.PlaneGeometry | null = null

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
      manualYawDeg -= (e.clientX - lastX) * 0.2
      manualPitchDeg = Math.max(-89, Math.min(89, manualPitchDeg + (e.clientY - lastY) * 0.2))
      lastX = e.clientX
      lastY = e.clientY
    }
    function onPointerUp() {
      dragging = false
    }
    container.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    let rafId = 0
    let hoverDotId: string | null = null
    let hoverSince = 0
    let lastTilt: TiltHint | null = null
    let lastArrow: ArrowHint | 'unset' = 'unset'
    let lastDwellBucket = -1
    let lastSensors: boolean | null = null
    let lastSteady: boolean | null = null
    let lastOnTarget: boolean | null = null
    let lastFrameAt = performance.now()
    let angularSpeedDegPerSec = 0

    const previousForward = new THREE.Vector3(0, 0, -1)
    const forward = new THREE.Vector3()
    const camRight = new THREE.Vector3()
    const camUp = new THREE.Vector3()
    const dotDir = new THREE.Vector3()
    const localDir = new THREE.Vector3()
    const inverseQuat = new THREE.Quaternion()

    function ensureLiveMesh() {
      const videoEl = videoRef.current
      if (!videoEl || videoEl.videoWidth === 0) return null
      if (!liveTexture) {
        liveTexture = new THREE.VideoTexture(videoEl)
        liveTexture.colorSpace = THREE.SRGBColorSpace
        liveMaterial = new THREE.MeshBasicMaterial({ map: liveTexture })
      }
      const { width, height } = quadSize(fovRef.current, SPHERE_RADIUS * LIVE_RADIUS_SCALE)
      const mesh = liveMeshRef.current
      if (!mesh) {
        liveGeometry = new THREE.PlaneGeometry(width, height)
        const created = new THREE.Mesh(liveGeometry, liveMaterial!)
        created.renderOrder = 1
        liveMeshRef.current = created
        scene.add(created)
        return created
      }
      return mesh
    }

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

      forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
      camRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
      camUp.set(0, 1, 0).applyQuaternion(camera.quaternion)

      // How fast the aim is swinging, smoothed so a single jittery frame doesn't stall
      // or falsely unblock the countdown.
      const frameNow = performance.now()
      const dt = Math.max(1, frameNow - lastFrameAt) / 1000
      lastFrameAt = frameNow
      const sweptDeg = (previousForward.angleTo(forward) * 180) / Math.PI
      previousForward.copy(forward)
      angularSpeedDegPerSec = angularSpeedDegPerSec * 0.7 + (sweptDeg / dt) * 0.3
      const steady = angularSpeedDegPerSec <= STEADY_MAX_DEG_PER_SEC

      // Keep the live frame pinned to wherever the phone is aiming, but oriented to world
      // up — so holding the phone crooked visibly skews it, exactly the cue the tilt
      // warning is about.
      const liveMesh = ensureLiveMesh()
      if (liveMesh) {
        liveMesh.position.copy(forward).multiplyScalar(SPHERE_RADIUS * LIVE_RADIUS_SCALE)
        faceOrigin(liveMesh, forward)
      }

      // Roll check: how far the screen's right edge is from level.
      const rollRad = Math.atan2(camRight.y, camUp.y)
      const rollDeg = (rollRad * 180) / Math.PI
      let tilt: TiltHint = 'ok'
      if (rollDeg > ROLL_TOLERANCE_DEG) tilt = 'right'
      else if (rollDeg < -ROLL_TOLERANCE_DEG) tilt = 'left'

      // Repaint pending dots to reflect whether a shot is currently allowed.
      const pendingMaterial = tilt === 'ok' ? greenMaterialRef.current : redMaterialRef.current
      if (pendingMaterial && tilt !== lastTilt) {
        for (const [id, mesh] of dotMeshesRef.current) {
          if (!matchedIdsRef.current.has(id)) mesh.material = pendingMaterial
        }
      }

      // Nearest still-pending point: drives both the guidance arrow and the dwell timer.
      const threshold = matchThresholdRadRef.current
      let nearestId: string | null = null
      let nearestAngle = Infinity
      let nearestDir: THREE.Vector3 | null = null
      for (const [id, mesh] of dotMeshesRef.current) {
        if (matchedIdsRef.current.has(id)) continue
        dotDir.copy(mesh.position).normalize()
        const angle = forward.angleTo(dotDir)
        if (angle < nearestAngle) {
          nearestAngle = angle
          nearestId = id
          nearestDir = dotDir.clone()
        }
      }

      let arrow: ArrowHint = null
      if (nearestDir && nearestAngle > threshold) {
        inverseQuat.copy(camera.quaternion).invert()
        localDir.copy(nearestDir).applyQuaternion(inverseQuat)
        // Behind you? Then the only useful advice is which way to spin around.
        if (localDir.z > 0 || Math.abs(localDir.x) > Math.abs(localDir.y)) {
          arrow = localDir.x >= 0 ? 'right' : 'left'
        } else {
          arrow = localDir.y >= 0 ? 'up' : 'down'
        }
      }

      cameraBasisRef.current = {
        right: [camRight.x, camRight.y, camRight.z],
        up: [camUp.x, camUp.y, camUp.z],
        forward: [forward.x, forward.y, forward.z],
      }

      // Connect manual capture action
      manualCaptureRef.current = () => {
        if (!nearestId) return false
        const mesh = dotMeshesRef.current.get(nearestId)
        const pitchDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)))
        const yawDeg = THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z))
        const accepted =
          onDotMatchedRef.current?.(nearestId, yawDeg, pitchDeg, {
            right: [camRight.x, camRight.y, camRight.z],
            up: [camUp.x, camUp.y, camUp.z],
            forward: [forward.x, forward.y, forward.z],
          }) ?? true
        if (accepted) {
          matchedIdsRef.current.add(nearestId)
          if (mesh && matchedMaterialRef.current) mesh.material = matchedMaterialRef.current
          if (mesh) setTimeout(() => dotsGroupRef.current?.remove(mesh), MATCHED_FADE_MS)
          hoverDotId = null
          return true
        }
        return false
      }

      // Dwell: hold the crosshair on a point, level and still, to shoot it. The countdown
      // is what gives the camera time to lock focus — firing the instant the crosshair
      // arrives is what produced blurry frames.
      const now = frameNow
      const onTarget = !!nearestId && nearestAngle < threshold
      let dwell = 0
      if (tilt === 'ok' && onTarget && nearestId) {
        if (hoverDotId !== nearestId) {
          hoverDotId = nearestId
          hoverSince = now
        }
        // Still swinging? Hold the countdown where it is rather than letting it run.
        if (!steady) hoverSince += dt * 1000
        dwell = Math.min(1, Math.max(0, (now - hoverSince) / dwellMsRef.current))
        if (dwell >= 1) {
          const mesh = dotMeshesRef.current.get(nearestId)
          // Use the actual look direction at the moment of capture (not the idealized
          // dot position) so the reprojection in the stitcher lines up with reality.
          const pitchDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)))
          const yawDeg = THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z))
          const accepted =
            onDotMatchedRef.current?.(nearestId, yawDeg, pitchDeg, {
              right: [camRight.x, camRight.y, camRight.z],
              up: [camUp.x, camUp.y, camUp.z],
              forward: [forward.x, forward.y, forward.z],
            }) ?? true
          if (accepted) {
            matchedIdsRef.current.add(nearestId)
            if (mesh && matchedMaterialRef.current) mesh.material = matchedMaterialRef.current
            if (mesh) setTimeout(() => dotsGroupRef.current?.remove(mesh), MATCHED_FADE_MS)
            hoverDotId = null
          } else {
            // Shot rejected — restart the dwell so the point can be tried again.
            hoverSince = now
          }
          dwell = 0
        }
      } else {
        hoverDotId = null
      }

      const dwellBucket = Math.round(dwell * 20)
      if (
        tilt !== lastTilt ||
        arrow !== lastArrow ||
        dwellBucket !== lastDwellBucket ||
        steady !== lastSteady ||
        onTarget !== lastOnTarget ||
        haveDeviceData !== lastSensors
      ) {
        lastTilt = tilt
        lastArrow = arrow
        lastDwellBucket = dwellBucket
        lastSteady = steady
        lastOnTarget = onTarget
        lastSensors = haveDeviceData
        onStatusChangeRef.current?.({ tilt, arrow, dwell, steady, onTarget, usingSensors: haveDeviceData })
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
      liveTexture?.dispose()
      liveMaterial?.dispose()
      liveGeometry?.dispose()
      greenMaterialRef.current?.dispose()
      redMaterialRef.current?.dispose()
      matchedMaterialRef.current?.dispose()
      renderer.dispose()
      container.removeChild(renderer.domElement)
      liveMeshRef.current = null
      dotsGroupRef.current = null
      patchesGroupRef.current = null
    }
  }, [])

  // Rebuilds the target points whenever the (FOV-derived) grid changes, without tearing
  // down the renderer/camera/orientation listeners set up above.
  useEffect(() => {
    const group = dotsGroupRef.current
    const material = greenMaterialRef.current
    if (!group || !material) return

    // The dot is drawn at exactly the angle within which a shot is accepted, so what you see
    // is the tolerance. It used to be a fixed size roughly a tenth of the real threshold,
    // which meant the shutter fired while the dot was still visibly short of the crosshair —
    // the interface was describing a precision the mechanic did not require, and hiding how
    // far off target an accepted shot could actually be.
    const dotRadius = SPHERE_RADIUS * Math.tan((matchThresholdDeg * Math.PI) / 180)
    const geometry = new THREE.SphereGeometry(dotRadius, 16, 16)
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
      dotMeshesRef.current = new Map()
    }
  }, [dots, matchThresholdDeg])

  return <div ref={containerRef} className={className ?? 'absolute inset-0'} style={{ touchAction: 'none' }} />
})

export default OrientationOverlay
