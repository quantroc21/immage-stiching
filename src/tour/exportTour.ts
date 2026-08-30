import { makeThumbnail } from './thumbnail'
import { renderTourPage, type TourPageScene } from './tourPage'
import type { SceneWithUrl } from './types'

/**
 * Packs the whole tour into one self-contained HTML file: Pannellum inlined,
 * every panorama embedded as a data URI. No server and no asset folder, so it
 * opens straight from disk.
 *
 * This is the offline copy. Sharing a tour with someone should go through
 * shareTour instead: a link opens on any device, and streams the rooms in
 * rather than making the visitor pull the whole thing down first.
 */

async function toDataUri(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function toPageScenes(
  scenes: SceneWithUrl[],
  panoramas: string[],
  thumbnails?: string[],
): TourPageScene[] {
  return scenes.map((scene, i) => ({
    id: scene.id,
    name: scene.name,
    panorama: panoramas[i],
    thumbnail: thumbnails?.[i],
    initialYaw: scene.initialYaw,
    initialPitch: scene.initialPitch,
    hotspots: scene.hotspots.map((h) => ({
      id: h.id,
      yaw: h.yaw,
      pitch: h.pitch,
      targetSceneId: h.targetSceneId,
    })),
  }))
}

export interface TourExport {
  blob: Blob
  filename: string
  bytes: number
}

export function tourSlug(title: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'tour-360'
  )
}

export async function buildTourHtml(scenes: SceneWithUrl[], title: string): Promise<TourExport> {
  const [pannellumJs, pannellumCss, panoramas, thumbnails] = await Promise.all([
    fetch('/pannellum/pannellum.js').then((r) => r.text()),
    fetch('/pannellum/pannellum.css').then((r) => r.text()),
    Promise.all(scenes.map((scene) => toDataUri(scene.image))),
    Promise.all(scenes.map(async (scene) => toDataUri(await makeThumbnail(scene.image)))),
  ])

  const html = renderTourPage({
    title,
    scenes: toPageScenes(scenes, panoramas, thumbnails),
    css: { inline: pannellumCss },
    js: { inline: pannellumJs },
  })

  const blob = new Blob([html], { type: 'text/html' })
  return { blob, filename: `${tourSlug(title)}.html`, bytes: blob.size }
}
