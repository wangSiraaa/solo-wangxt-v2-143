import type { ProjectData } from '../types';

const DB_NAME = 'navmesh-editor';
const DB_VERSION = 1;
const STORE = 'projects';
const META_KEY = '__meta__';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
  presetId?: string;
}

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const tx = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
};

export const idbSaveProject = async (project: ProjectData, id: string, presetId?: string): Promise<void> => {
  await tx('readwrite', (s) => s.put(project, id));
  const meta: ProjectMeta[] = JSON.parse((await tx<string | undefined>('readonly', (s2) => s2.get(META_KEY))) || '[]');
  const row: ProjectMeta = { id, name: project.name, updatedAt: project.updatedAt, presetId };
  const idx = meta.findIndex((m) => m.id === id);
  if (idx >= 0) meta[idx] = row; else meta.push(row);
  meta.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  await tx('readwrite', (s) => s.put(JSON.stringify(meta), META_KEY));
};

export const idbLoadProject = async (id: string): Promise<ProjectData | undefined> =>
  tx('readonly', (s) => s.get(id) as IDBRequest<ProjectData | undefined>);

export const idbListProjects = async (): Promise<ProjectMeta[]> =>
  JSON.parse((await tx<string | undefined>('readonly', (s) => s.get(META_KEY))) || '[]');

export const idbDeleteProject = async (id: string): Promise<void> => {
  await tx('readwrite', (s) => s.delete(id));
  const meta: ProjectMeta[] = JSON.parse((await tx<string | undefined>('readonly', (s) => s.get(META_KEY))) || '[]');
  await tx('readwrite', (s) => s.put(JSON.stringify(meta.filter((m) => m.id !== id)), META_KEY));
};
