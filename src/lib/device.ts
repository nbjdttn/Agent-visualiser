import { SOURCE_IDS, SOURCE_META, type ImportInfo, type SessionDetail } from '../../shared/types';
import { buildDataset, type Built } from '../../core/aggregate';
import { DemoSource } from '../../core/demo';
import { importedSourceStatus } from '../../core/imports';
import { deserializeSnapshot, type StoredSnapshot } from '../../core/model';
import { Pricing } from '../../core/pricing';
import { persistStorage, tx } from './idb';
import type { SyncedData } from './sync';

/**
 * On-device mode: when there is no server (the phone app), imports are kept
 * in IndexedDB on this device and the dataset is built in the browser.
 */

export interface DeviceImport {
  info: ImportInfo;
  snapshot: StoredSnapshot;
}

const STORE = 'imports';

export async function listImports(): Promise<DeviceImport[]> {
  try {
    return ((await tx<DeviceImport[]>(STORE, 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.info.importedAt - a.info.importedAt);
  } catch {
    return [];
  }
}

/** Save new imports, replacing older ones from the same source (exports always contain the full history). */
export async function saveImports(items: DeviceImport[]): Promise<void> {
  const existing = await listImports();
  const replaced = new Set(items.map((i) => i.info.source));
  await tx(STORE, 'readwrite', (s) => {
    for (const old of existing) if (replaced.has(old.info.source)) s.delete(old.info.id);
    for (const item of items) s.put(item);
  });
  persistStorage();
}

export async function deleteImport(id: string): Promise<void> {
  await tx(STORE, 'readwrite', (s) => {
    s.delete(id);
  });
}

export async function deleteAllImports(): Promise<void> {
  await tx(STORE, 'readwrite', (s) => {
    s.clear();
  });
}

/** Build the dashboard dataset from what is stored on this device (or demo data when empty). */
export function buildDeviceDataset(imports: DeviceImport[], version: number, synced?: SyncedData): Built {
  const pricing = new Pricing();
  const syncedSnapshots = synced?.snapshots ?? [];
  if (!imports.length && !syncedSnapshots.length) {
    // What a phone user will see after importing: chats only.
    const demo = new DemoSource(Date.now(), 20261031, { agents: false, apis: false, live: false });
    return buildDataset({ snapshots: [demo.snapshot()], pricing, statuses: demo.status(), demo: true, version });
  }
  // Automatic updates carry the complete logs, so agent logs imported by hand would count twice.
  const kept = imports.filter((i) => !synced?.covers.has(i.info.source));
  const latest = (source: string) => kept.find((i) => i.info.source === source)?.info;
  const statuses = SOURCE_IDS.filter((id) => SOURCE_META[id].kind !== 'api').map((id) => synced?.statuses[id] ?? importedSourceStatus(id, latest(id)));
  return buildDataset({
    snapshots: [...kept.map((i) => deserializeSnapshot(i.snapshot)), ...syncedSnapshots],
    pricing,
    statuses,
    demo: false,
    version,
  });
}

export function deviceSessionDetail(built: Built, key: string): SessionDetail | undefined {
  const list = built.eventsBySession.get(key);
  if (!list) return undefined;
  const events: SessionDetail['events'] = list.map((e) => ({
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
  }));
  const hourly = list.some((e) => e.rollup);
  if (!hourly) return { key, events };
  // Automatic updates arrive as hourly totals (one per model and sub-agent flag): show one bar per hour.
  const byHour = new Map<number, SessionDetail['events'][number]>();
  for (const e of events) {
    const h = byHour.get(e.ts);
    if (!h) {
      byHour.set(e.ts, { ...e, tools: [...e.tools] });
      continue;
    }
    const mainModel = e.input + e.output + e.cacheRead + e.cacheWrite > h.input + h.output + h.cacheRead + h.cacheWrite ? e.model : h.model;
    h.input += e.input;
    h.output += e.output;
    h.cacheRead += e.cacheRead;
    h.cacheWrite += e.cacheWrite;
    h.reasoning += e.reasoning;
    h.cost += e.cost;
    h.sidechain = h.sidechain && e.sidechain;
    h.tools.push(...e.tools);
    h.model = mainModel;
  }
  return { key, hourly, events: [...byHour.values()].sort((a, b) => a.ts - b.ts) };
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
