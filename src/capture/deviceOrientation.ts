export type OrientationPermissionStatus = 'unsupported' | 'unnecessary' | 'granted' | 'denied'

interface RequestPermissionCapable {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

function getRequestPermissionFn(): (() => Promise<'granted' | 'denied'>) | null {
  if (typeof DeviceOrientationEvent === 'undefined') return null
  const ctor = DeviceOrientationEvent as unknown as RequestPermissionCapable
  return typeof ctor.requestPermission === 'function' ? ctor.requestPermission.bind(ctor) : null
}

/** Must be called synchronously from within a user gesture handler (iOS Safari requirement). */
export async function requestDeviceOrientationPermission(): Promise<OrientationPermissionStatus> {
  if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported'
  const requestPermission = getRequestPermissionFn()
  if (!requestPermission) return 'unnecessary' // Android / desktop: no explicit permission step
  try {
    const result = await requestPermission()
    return result === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}
