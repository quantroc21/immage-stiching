import { makeThumbnail } from './thumbnail'
import type { SceneWithUrl } from './types'

/**
 * Uploads the tour and returns a link anyone can open.
 *
 * The panoramas go up as separate parts rather than inside the JSON: base64
 * would inflate them by a third, and keeping them as files lets the Worker
 * hand each one straight to R2 and serve it back with its own cache headers.
 */

export interface SharedTour {
  id: string
  url: string
}

export async function uploadTour(scenes: SceneWithUrl[], title: string): Promise<SharedTour> {
  const form = new FormData()
  form.append(
    'manifest',
    JSON.stringify({
      title,
      scenes: scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        initialYaw: scene.initialYaw,
        initialPitch: scene.initialPitch,
        hotspots: scene.hotspots.map((h) => ({
          id: h.id,
          yaw: h.yaw,
          pitch: h.pitch,
          targetSceneId: h.targetSceneId,
        })),
      })),
    }),
  )
  const thumbnails = await Promise.all(scenes.map((scene) => makeThumbnail(scene.image)))
  scenes.forEach((scene, i) => {
    form.append(`img_${scene.id}`, scene.image, `${scene.id}.jpg`)
    form.append(`thumb_${scene.id}`, thumbnails[i], `${scene.id}.thumb.jpg`)
  })

  const res = await fetch('/api/tour', { method: 'POST', body: form })
  if (!res.ok) {
    throw new Error((await res.text().catch(() => '')) || `Tải lên thất bại (${res.status})`)
  }
  const { id } = (await res.json()) as { id: string }
  return { id, url: new URL(`/t/${id}`, location.origin).toString() }
}
