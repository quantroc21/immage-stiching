import { useEffect, useState } from 'react'

export function usePortraitOrientation(): boolean {
  const [isPortrait, setIsPortrait] = useState(() => window.matchMedia('(orientation: portrait)').matches)

  useEffect(() => {
    const mql = window.matchMedia('(orientation: portrait)')
    const handler = () => setIsPortrait(mql.matches)
    handler()
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isPortrait
}

/**
 * Best-effort only: the Screen Orientation Lock API needs fullscreen on most browsers
 * that support it at all, and iOS Safari doesn't implement it. Callers should still show
 * a "please rotate your phone" prompt as the real fallback, this just saves a rotation
 * on browsers where it happens to work.
 */
export async function tryLockPortrait(): Promise<void> {
  try {
    await screen.orientation?.lock?.('portrait')
  } catch {
    // ignored, see doc comment above
  }
}
