import type { SceneWithUrl } from './types'

/**
 * Uploads the tour and returns a link anyone can open.
 *
 * XMLHttpRequest rather than fetch: only XHR reports how much of the body has
 * gone out. A tour is several megabytes of panorama, and without a percentage
 * on screen the wait looks like the app has hung.
 */

export interface SharedTour {
  id: string
  url: string
}

export interface UploadProgress {
  /** 0 to 1, or null while the browser cannot measure it. */
  fraction: number | null
  bytes: number
  totalBytes: number
}

export function tourBytes(scenes: SceneWithUrl[]): number {
  return scenes.reduce((sum, scene) => sum + scene.image.size, 0)
}

export function uploadTour(
  scenes: SceneWithUrl[],
  title: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<SharedTour> {
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
  for (const scene of scenes) {
    form.append(`img_${scene.id}`, scene.image, `${scene.id}.jpg`)
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/tour')

    xhr.upload.onprogress = (event) => {
      onProgress?.({
        fraction: event.lengthComputable ? event.loaded / event.total : null,
        bytes: event.loaded,
        totalBytes: event.total,
      })
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(xhr.responseText || `Tải lên thất bại (${xhr.status})`))
        return
      }
      try {
        const { id } = JSON.parse(xhr.responseText) as { id: string }
        resolve({ id, url: new URL(`/t/${id}`, location.origin).toString() })
      } catch {
        reject(new Error('Máy chủ trả về dữ liệu không đọc được'))
      }
    }
    xhr.onerror = () => reject(new Error('Mất kết nối khi đang tải lên'))
    xhr.ontimeout = () => reject(new Error('Tải lên quá lâu, thử lại khi mạng ổn hơn'))
    xhr.onabort = () => reject(new Error('Đã huỷ tải lên'))

    xhr.send(form)
  })
}
