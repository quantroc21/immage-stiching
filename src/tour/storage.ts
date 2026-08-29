import type { Scene } from './types'

const DB_NAME = 'virtual-tour-360'
const DB_VERSION = 1
const STORE = 'scenes'

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
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const req = run(transaction.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        transaction.oncomplete = () => db.close()
      }),
  )
}

export async function loadScenes(): Promise<Scene[]> {
  const all = await tx<Scene[]>('readonly', (store) => store.getAll() as IDBRequest<Scene[]>)
  return all.sort((a, b) => a.createdAt - b.createdAt)
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
