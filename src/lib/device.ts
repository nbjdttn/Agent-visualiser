import { SOURCE_IDS, SOURCE_META, type ImportInfo, type SessionDetail } from '../../shared/types';
import { buildDataset, type Built } from '../../core/aggregate';
import { DemoSource } from '../../core/demo';
import { importedSourceStatus } from '../../core/imports';
import { deserializeSnapshot, type StoredSnapshot } from '../../core/model';
import { Pricing } from '../../core/pricing';

/**
 * On-device mode: when there is no server (the phone app), imports are kept
 * in IndexedDB on this device and the dataset is built in the browser.
 */

export interface DeviceImport {
  info: ImportInfo;
  snapshot: StoredSnapshot;
}

const DB_NAME = 'agent-visualiser';
const STORE = 'imports';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'info.id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open on-device storage'));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error ?? new Error('Storage error'));
      t.onabort = () => reject(t.error ?? new Error('Storage was full or unavailable'));
    });
  } finally {
    db.close();
  }
}

export async function listImports(): Promise<DeviceImport[]> {
  try {
    return ((await tx<DeviceImport[]>('readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.info.importedAt - a.info.importedAt);
  } catch {
    return [];
  }
}

/** Save new imports, replacing older ones from the same source (exports always contain the full history). */
export async function saveImports(items: DeviceImport[]): Promise<void> {
  const existing = await listImports();
  const replaced = new Set(items.map((i) => i.info.source));
  await tx('readwrite', (s) => {
    for (const old of existing) if (replaced.has(old.info.source)) s.delete(old.info.id);
    for (const item of items) s.put(item);
  });
  // Ask the browser not to clear this data under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
}

export async function deleteImport(id: string): Promise<void> {
  await tx('readwrite', (s) => {
    s.delete(id);
  });
}

export async function deleteAllImports(): Promise<void> {
  await tx('readwrite', (s) => {
    s.clear();
  });
}

/** Build the dashboard dataset from what is stored on this device (or demo data when empty). */
export function buildDeviceDataset(imports: DeviceImport[], version: number): Built {
  const pricing = new Pricing();
  if (!imports.length) {
    // What a phone user will see after importing: chats only.
    const demo = new DemoSource(Date.now(), 20261031, { agents: false, apis: false, live: false });
    return buildDataset({ snapshots: [demo.snapshot()], pricing, statuses: demo.status(), demo: true, version });
  }
  const latest = (source: string) => imports.find((i) => i.info.source === source)?.info;
  const statuses = SOURCE_IDS.filter((id) => SOURCE_META[id].kind !== 'api').map((id) => importedSourceStatus(id, latest(id)));
  return buildDataset({
    snapshots: imports.map((i) => deserializeSnapshot(i.snapshot)),
    pricing,
    statuses,
    demo: false,
    version,
  });
}

export function deviceSessionDetail(built: Built, key: string): SessionDetail | undefined {
  const list = built.eventsBySession.get(key);
  if (!list) return undefined;
  return {
    key,
    events: list.map((e) => ({
      ts: e.ts,
      model: e.model,
      input: e.input,
      output: e.output,
      cacheRead: e.cacheRead,
      cacheWrite: e.cacheWrite,
      reasoning: e.reasoning,
      cost: e.cost ?? 0,
      sidechain: Boolean(e.sidechain),
      tools: e.tools ?? [],
    })),
  };
}

export interface WorkerMessage {
  type: 'progress' | 'done' | 'error';
  stage?: string;
  imports?: DeviceImport[];
  message?: string;
}

/** Parse a picked file in a Web Worker so the screen stays responsive. */
export function parseInWorker(file: File, onProgress: (stage: string) => void): Promise<DeviceImport[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'progress' && m.stage) onProgress(m.stage);
      else if (m.type === 'done') {
        worker.terminate();
        resolve(m.imports ?? []);
      } else if (m.type === 'error') {
        worker.terminate();
        reject(new Error(m.message ?? 'Import failed'));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Import failed'));
    };
    worker.postMessage({ file });
  });
}
