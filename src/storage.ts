import type { ProjectData } from './types'

/**
 * IndexedDB 工程存储。所有数据（源网格、生成设置、起终点）都在浏览器本地，
 * 不依赖任何后端。
 */

const DB_NAME = 'navmesh-studio'
const DB_VERSION = 1
const STORE = 'projects'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
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
  return dbPromise
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function listProjects(): Promise<ProjectData[]> {
  const all = await tx<ProjectData[]>('readonly', (s) => s.getAll() as IDBRequest<ProjectData[]>)
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadProject(id: string): Promise<ProjectData | undefined> {
  return tx<ProjectData | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<ProjectData | undefined>,
  )
}

export async function saveProject(project: ProjectData): Promise<void> {
  project.updatedAt = Date.now()
  await tx('readwrite', (s) => s.put(project))
}

export async function deleteProject(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}
