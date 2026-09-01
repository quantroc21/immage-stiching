import type { SourceShot } from './types'

/**
 * Hands the frames a room was stitched from back to the person who shot it.
 *
 * The angle each shot was taken at goes in its filename, so a set stays
 * self-describing once it leaves the phone and lands in a chat or a desktop
 * stitcher.
 */

function signed(value: number, width: number): string {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : '+'
  return sign + String(Math.abs(rounded)).padStart(width, '0')
}

export function sourceFiles(sources: SourceShot[], roomName: string): File[] {
  // Colons are not allowed in filenames on most systems.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const slug =
    roomName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'phong'

  return sources.map((shot, i) => {
    const index = String(i + 1).padStart(2, '0')
    // Signed rather than zero-padded: a yaw of -1 used to come out as "yaw0-1".
    const name = `${slug}_${stamp}_${index}_yaw${signed(shot.yawDeg, 3)}_pitch${signed(shot.pitchDeg, 2)}.jpg`
    return new File([shot.blob], name, { type: 'image/jpeg' })
  })
}

export async function shareSources(sources: SourceShot[], roomName: string): Promise<void> {
  const files = sourceFiles(sources, roomName)

  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title: `${files.length} ảnh gốc - ${roomName}` })
      return
    } catch {
      // Cancelled, or the OS refused this many files. Saving them one by one
      // is slower but always works.
    }
  }

  for (const file of files) {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    await new Promise((r) => setTimeout(r, 120))
  }
}
