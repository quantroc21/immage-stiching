import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteScene as dbDelete, loadScenes, saveScene } from './storage'
import { newId, type Hotspot, type Scene, type SceneWithUrl, type SourceShot } from './types'

/**
 * Owns the whole tour: the list of rooms, their hotspots, and persistence.
 * Object URLs are minted once per scene and revoked when the scene goes away,
 * so the panorama Blobs don't leak across edits.
 */
export function useTour() {
  const [scenes, setScenes] = useState<SceneWithUrl[]>([])
  const [loading, setLoading] = useState(true)
  const urlsRef = useRef(new Map<string, string>())

  const attachUrl = useCallback((scene: Scene): SceneWithUrl => {
    let url = urlsRef.current.get(scene.id)
    if (!url) {
      url = URL.createObjectURL(scene.image)
      urlsRef.current.set(scene.id, url)
    }
    return { ...scene, url }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadScenes()
      .then((stored) => {
        if (cancelled) return
        setScenes(stored.map(attachUrl))
      })
      .catch((err) => console.error('Không đọc được tour đã lưu:', err))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attachUrl])

  // Revoke every minted URL when the app unmounts.
  const urls = urlsRef.current
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls])

  const persist = useCallback((scene: SceneWithUrl) => {
    const { url: _url, ...record } = scene
    void saveScene(record).catch((err) => console.error('Không lưu được phòng:', err))
  }, [])

  const addScene = useCallback(
    (image: Blob, name: string, sources?: SourceShot[]): SceneWithUrl => {
      const scene: Scene = {
        id: newId(),
        name,
        image,
        sources,
        hotspots: [],
        initialYaw: 0,
        initialPitch: 0,
        createdAt: Date.now(),
      }
      const withUrl = attachUrl(scene)
      setScenes((prev) => [...prev, withUrl])
      persist(withUrl)
      return withUrl
    },
    [attachUrl, persist],
  )

  const updateScene = useCallback(
    (id: string, patch: (scene: SceneWithUrl) => SceneWithUrl) => {
      setScenes((prev) =>
        prev.map((scene) => {
          if (scene.id !== id) return scene
          const next = patch(scene)
          persist(next)
          return next
        }),
      )
    },
    [persist],
  )

  /**
   * Thay ảnh của một phòng sau khi sửa tay.
   *
   * Phải bỏ URL cũ đi chứ không chỉ đổi blob: URL đã cấp trỏ vào blob cũ, giữ
   * lại thì viewer vẫn hiện ảnh chưa sửa dù dữ liệu đã đổi.
   */
  const replaceSceneImage = useCallback(
    (id: string, image: Blob) => {
      const old = urlsRef.current.get(id)
      if (old) URL.revokeObjectURL(old)
      urlsRef.current.delete(id)
      updateScene(id, (scene) => {
        const next = { ...scene, image }
        const url = URL.createObjectURL(image)
        urlsRef.current.set(id, url)
        return { ...next, url }
      })
    },
    [updateScene],
  )

  const renameScene = useCallback(
    (id: string, name: string) => updateScene(id, (scene) => ({ ...scene, name })),
    [updateScene],
  )

  const setSceneStartView = useCallback(
    (id: string, yaw: number, pitch: number) =>
      updateScene(id, (scene) => ({ ...scene, initialYaw: yaw, initialPitch: pitch })),
    [updateScene],
  )

  const addHotspot = useCallback(
    (sceneId: string, hotspot: Omit<Hotspot, 'id'>) =>
      updateScene(sceneId, (scene) => ({
        ...scene,
        hotspots: [...scene.hotspots, { ...hotspot, id: newId() }],
      })),
    [updateScene],
  )

  const removeHotspot = useCallback(
    (sceneId: string, hotspotId: string) =>
      updateScene(sceneId, (scene) => ({
        ...scene,
        hotspots: scene.hotspots.filter((h) => h.id !== hotspotId),
      })),
    [updateScene],
  )

  /** Removing a room also removes every hotspot pointing at it. */
  const removeScene = useCallback(
    (id: string) => {
      setScenes((prev) => {
        const next = prev
          .filter((scene) => scene.id !== id)
          .map((scene) => {
            const hotspots = scene.hotspots.filter((h) => h.targetSceneId !== id)
            if (hotspots.length === scene.hotspots.length) return scene
            const updated = { ...scene, hotspots }
            persist(updated)
            return updated
          })
        return next
      })
      const url = urlsRef.current.get(id)
      if (url) {
        URL.revokeObjectURL(url)
        urlsRef.current.delete(id)
      }
      void dbDelete(id).catch((err) => console.error('Không xoá được phòng:', err))
    },
    [persist],
  )

  return {
    scenes,
    loading,
    addScene,
    removeScene,
    renameScene,
    setSceneStartView,
    addHotspot,
    removeHotspot,
    replaceSceneImage,
  }
}
