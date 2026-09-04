import type { Project, Scene } from './types'

const DB_NAME = 'virtual-tour-360'
const DB_VERSION = 2
const STORE = 'scenes'
const PROJECTS = 'projects'

// Panoramas are 3-4 MB each, so localStorage is out. IndexedDB stores the Blob
// directly, no base64 round-trip, and has a quota measured in hundreds of MB.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const req = run(transaction.objectStore(storeName))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        transaction.oncomplete = () => db.close()
      }),
  )
}

export async function loadProjects(): Promise<Project[]> {
  const all = await tx<Project[]>('readonly', (s) => s.getAll() as IDBRequest<Project[]>, PROJECTS)
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveProject(project: Project): Promise<void> {
  await tx('readwrite', (s) => s.put(project), PROJECTS)
}

/** Xoá dự án cùng mọi phòng của nó. Ảnh nằm trong phòng nên đi theo luôn. */
export async function deleteProject(id: string): Promise<void> {
  const scenes = await tx<Scene[]>('readonly', (s) => s.getAll() as IDBRequest<Scene[]>)
  for (const scene of scenes) if (scene.projectId === id) await deleteScene(scene.id)
  await tx('readwrite', (s) => s.delete(id), PROJECTS)
}

/**
 * Đưa dữ liệu cũ về dạng có dự án.
 *
 * Bản trước chỉ có một tour duy nhất, phòng không mang projectId. Gom hết vào
 * một dự án tên "Tour của tôi" để người đang dùng không thấy mất gì.
 */
export async function migrateLooseScenes(): Promise<void> {
  const scenes = await tx<Scene[]>('readonly', (s) => s.getAll() as IDBRequest<Scene[]>)
  const loose = scenes.filter((s) => !s.projectId)
  if (!loose.length) return
  const id = `p-${Date.now().toString(36)}`
  await saveProject({ id, name: 'Tour của tôi', createdAt: Date.now() })
  for (const scene of loose) await saveScene({ ...scene, projectId: id })
}

export async function loadScenes(projectId: string): Promise<Scene[]> {
  const all = await tx<Scene[]>('readonly', (store) => store.getAll() as IDBRequest<Scene[]>)
  return all.filter((s) => s.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveScene(scene: Scene): Promise<void> {
  await tx('readwrite', (store) => store.put(scene))
}

export async function deleteScene(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id))
}

export async function clearScenes(): Promise<void> {
  await tx('readwrite', (store) => store.clear())
}
