import type { SourceId, SourceStatus } from '../../shared/types';
import type { SourceSnapshot } from '../../core/model';
import { deviceCode, generateDeviceKey, NotForThisDevice, openJson, type Envelope } from '../../core/sync/envelope';
import {
  DEVICES_DIR,
  INDEX_FILE,
  SYNC_BRANCH,
  cloudSnapshot,
  expandRollup,
  mergeCloudPayload,
  type ClaudeWindow,
  type CloudHistory,
  type ComputerPayload,
  type SyncIndex,
  type SyncKind,
  type SyncPayload,
} from '../../core/sync/payload';
import { persistStorage, tx } from './idb';

/**
 * Automatic updates on the phone. The phone holds a key pair; computers and
 * the cloud collector publish usage encrypted for it to the repository's
 * usage-data branch; the phone downloads, decrypts and keeps it here.
 */

const STORE = 'sync';

interface DeviceRecord {
  id: 'device';
  kid: string;
  publicKey: string;
  /** Non-extractable key (preferred), or a JWK where CryptoKeys can't be stored. */
  privateKey?: CryptoKey;
  jwk?: JsonWebKey;
  name: string;
  createdAt: number;
}

interface FileRecord {
  id: string;
  name: string;
  kind: SyncKind;
  updatedAt: number;
  receivedAt: number;
  label: string;
  sessions: number;
  payload?: ComputerPayload;
}

interface CloudRecord {
  id: 'cloud';
  history: CloudHistory;
  limits: ClaudeWindow[];
  generatedAt: number;
}

interface MetaRecord {
  id: 'meta';
  lastCheck?: number;
  error?: string;
  /** Files that exist but aren't encrypted for this phone yet. */
  waiting: string[];
  /** Whether the usage-data branch exists at all. */
  branch: boolean;
  /** Whether this phone's key is in the branch's devices folder. */
  registered?: boolean;
}

type SyncRecord = DeviceRecord | FileRecord | CloudRecord | MetaRecord;

const isFile = (r: SyncRecord): r is FileRecord => r.id.startsWith('file:');

const all = async () => (await tx<SyncRecord[]>(STORE, 'readonly', (s) => s.getAll())) ?? [];
const get = async <T extends SyncRecord>(id: T['id']) => (await tx<T>(STORE, 'readonly', (s) => s.get(id) as IDBRequest<T>)) ?? undefined;
const put = async (r: SyncRecord) => {
  await tx(STORE, 'readwrite', (s) => {
    s.put(r);
  });
};

export interface SyncTarget {
  repo: string;
  branch: string;
  base: string;
}

/** Where updates are published: this app's own repository, from the build or the github.io address. */
export function syncTarget(): SyncTarget | undefined {
  let override: string | null = null;
  try {
    override = new URLSearchParams(location.search).get('syncBase') ?? localStorage.getItem('av.sync.base');
  } catch {
    // storage blocked
  }
  const built = String(import.meta.env.VITE_SYNC_REPO ?? '').trim();
  const page = location.pathname.split('/').filter(Boolean)[0];
  const fromHost = location.hostname.endsWith('.github.io') && page ? `${location.hostname.split('.')[0]}/${page}` : undefined;
  const repo = built || fromHost;
  if (override) return { repo: repo ?? 'local/test', branch: SYNC_BRANCH, base: override.endsWith('/') ? override : `${override}/` };
  if (!repo) return undefined;
  return { repo, branch: SYNC_BRANCH, base: `https://raw.githubusercontent.com/${repo}/${SYNC_BRANCH}/` };
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Browser';
}

async function privateKeyOf(d: DeviceRecord): Promise<CryptoKey> {
  if (d.privateKey) return d.privateKey;
  if (!d.jwk) throw new Error('This device has no key; turn automatic updates off and on again');
  return crypto.subtle.importKey('jwk', d.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export async function enableSync(): Promise<void> {
  if (await get<DeviceRecord>('device')) return;
  const base = { id: 'device' as const, name: deviceName(), createdAt: Date.now() };
  const key = await generateDeviceKey(false);
  try {
    await put({ ...base, kid: key.kid, publicKey: key.publicKey, privateKey: key.privateKey });
  } catch {
    // Some browsers can't keep CryptoKey objects in IndexedDB: store an exportable key instead.
    const k = await generateDeviceKey(true);
    await put({ ...base, kid: k.kid, publicKey: k.publicKey, jwk: await crypto.subtle.exportKey('jwk', k.privateKey) });
  }
  await put({ id: 'meta', waiting: [], branch: false });
  persistStorage();
}

/** Forget the key and everything received. */
export async function disableSync(): Promise<void> {
  await tx(STORE, 'readwrite', (s) => {
    s.clear();
  });
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error(navigator.onLine === false ? "You're offline" : "Couldn't reach GitHub");
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as T;
}

let running: Promise<boolean> | undefined;

/** Download whatever changed since the last check. Resolves to true when there is new data. */
export function checkForUpdates(): Promise<boolean> {
  running ??= check().finally(() => {
    running = undefined;
  });
  return running;
}

async function check(): Promise<boolean> {
  const device = await get<DeviceRecord>('device');
  if (!device) return false;
  const meta: MetaRecord = (await get<MetaRecord>('meta')) ?? { id: 'meta', waiting: [], branch: false };
  const target = syncTarget();
  try {
    if (!target) throw new Error('Automatic updates work in the published app');
    const index = await fetchJson<SyncIndex>(`${target.base}${INDEX_FILE}?t=${Date.now()}`);
    meta.branch = Boolean(index);
    meta.registered = Boolean(await fetchJson(`${target.base}${DEVICES_DIR}/${encodeURIComponent(device.kid)}.json?t=${Date.now()}`).catch(() => undefined));
    const waiting: string[] = [];
    let changed = false;
    if (index?.files) {
      const privateKey = await privateKeyOf(device);
      const files = new Map((await all()).filter(isFile).map((f) => [f.name, f]));
      let cloud = await get<CloudRecord>('cloud');
      for (const [name, entry] of Object.entries(index.files)) {
        if (!/^[\w.-]+\.json$/.test(name)) continue;
        if (!entry.recipients?.includes(device.kid)) {
          waiting.push(name);
          continue;
        }
        const have = files.get(name);
        if (have && have.updatedAt >= entry.updatedAt) continue;
        const envelope = await fetchJson<Envelope>(`${target.base}${encodeURIComponent(name)}?v=${entry.updatedAt}`);
        if (!envelope) continue;
        let payload: SyncPayload;
        try {
          payload = await openJson<SyncPayload>(envelope, { kid: device.kid, privateKey });
        } catch (err) {
          if (err instanceof NotForThisDevice) {
            waiting.push(name);
            continue;
          }
          throw new Error(`Couldn't decrypt ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // A CDN can briefly serve the previous version; record the payload's own time so it's fetched again next check.
        const common = { id: `file:${name}`, name, updatedAt: Math.min(entry.updatedAt, payload.generatedAt), receivedAt: Date.now(), label: payload.name };
        if (payload.kind === 'computer') {
          await put({ ...common, kind: 'computer', sessions: payload.rollup.sessions.length, payload });
        } else if (payload.kind === 'cloud') {
          cloud = {
            id: 'cloud',
            history: mergeCloudPayload(cloud?.history ?? {}, payload),
            limits: payload.limits.length ? payload.limits : (cloud?.limits ?? []),
            generatedAt: payload.generatedAt,
          };
          await put(cloud);
          await put({ ...common, kind: 'cloud', sessions: Object.keys(cloud.history).length });
        } else continue;
        changed = true;
      }
    }
    meta.waiting = waiting;
    meta.error = undefined;
    return changed;
  } catch (err) {
    meta.error = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    meta.lastCheck = Date.now();
    await put(meta).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// What the rest of the app sees
// ---------------------------------------------------------------------------

export interface SyncSourceView {
  name: string;
  kind: SyncKind;
  label: string;
  updatedAt: number;
  receivedAt: number;
  sessions: number;
}

export interface SyncView {
  available: boolean;
  enabled: boolean;
  repo?: string;
  kid?: string;
  code?: string;
  /** Opens GitHub's "new file" page with this phone's key filled in. */
  registerUrl?: string;
  deviceName?: string;
  lastCheck?: number;
  error?: string;
  waiting: string[];
  branch: boolean;
  registered?: boolean;
  sources: SyncSourceView[];
  limits: ClaudeWindow[];
}

export interface SyncedData {
  snapshots: SourceSnapshot[];
  statuses: Partial<Record<SourceId, SourceStatus>>;
  /** Sources the updates provide; hand-imported logs of these are left out to avoid counting twice. */
  covers: Set<SourceId>;
  view: SyncView;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export async function loadSynced(): Promise<SyncedData> {
  const target = syncTarget();
  let records: SyncRecord[] = [];
  try {
    records = await all();
  } catch {
    // storage unavailable: behave as if nothing was received
  }
  const device = records.find((r): r is DeviceRecord => r.id === 'device');
  const meta = records.find((r): r is MetaRecord => r.id === 'meta');
  const cloud = records.find((r): r is CloudRecord => r.id === 'cloud');
  const files = records.filter(isFile).sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'computer' ? -1 : 1));

  const snapshots: SourceSnapshot[] = [];
  const covers = new Set<SourceId>();
  const parts: Record<'claude-code' | 'codex', string[]> = { 'claude-code': [], codex: [] };
  const latest: Record<'claude-code' | 'codex', { event?: number; updated?: number }> = { 'claude-code': {}, codex: {} };
  const bump = (id: 'claude-code' | 'codex', event?: number, updated?: number) => {
    const l = latest[id];
    if (event && (!l.event || event > l.event)) l.event = event;
    if (updated && (!l.updated || updated > l.updated)) l.updated = updated;
  };

  if (device) {
    for (const f of files) {
      if (f.kind !== 'computer' || !f.payload) continue;
      const snap = expandRollup(f.payload.rollup);
      snapshots.push(snap);
      for (const id of ['claude-code', 'codex'] as const) {
        const n = f.payload.rollup.sessions.filter((s) => s.source === id).length;
        if (!n) continue;
        covers.add(id);
        parts[id].push(`${f.label}: ${plural(n, 'session')}`);
        bump(id, f.payload.statuses.find((s) => s.id === id)?.lastEventAt, f.payload.generatedAt);
      }
    }
    const cloudSessions = cloud ? Object.values(cloud.history) : [];
    if (cloudSessions.length) {
      snapshots.push(cloudSnapshot(cloud!.history));
      covers.add('claude-code');
      parts['claude-code'].push(`cloud: ${plural(cloudSessions.length, 'session')}`);
      bump('claude-code', Math.max(...cloudSessions.map((s) => s.record.updated)), cloud!.generatedAt);
    }
  }

  const statuses: Partial<Record<SourceId, SourceStatus>> = {};
  for (const id of ['claude-code', 'codex'] as const) {
    if (!parts[id].length) continue;
    statuses[id] = {
      id,
      label: id === 'codex' ? 'Codex CLI' : 'Claude Code',
      provider: id === 'codex' ? 'openai' : 'anthropic',
      kind: 'agent',
      connected: true,
      summary: `Automatic updates · ${parts[id].join(' · ')}`,
      lastEventAt: latest[id].event,
      updatedAt: latest[id].updated,
    };
  }

  const view: SyncView = {
    available: Boolean(target),
    enabled: Boolean(device),
    repo: target?.repo,
    deviceName: device?.name ?? deviceName(),
    waiting: meta?.waiting ?? [],
    branch: meta?.branch ?? false,
    registered: meta?.registered,
    lastCheck: meta?.lastCheck,
    error: meta?.error,
    sources: files.map(({ name, kind, label, updatedAt, receivedAt, sessions }) => ({ name, kind, label, updatedAt, receivedAt, sessions })),
    limits: cloud?.limits ?? [],
  };
  if (device) {
    view.kid = device.kid;
    view.code = deviceCode(device.publicKey);
    if (target) {
      const file = { kid: device.kid, name: device.name, publicKey: device.publicKey, added: new Date(device.createdAt).toISOString().slice(0, 10) };
      view.registerUrl =
        `https://github.com/${target.repo}/new/${target.branch}?filename=${encodeURIComponent(`${DEVICES_DIR}/${device.kid}.json`)}` +
        `&value=${encodeURIComponent(JSON.stringify(file, null, 2) + '\n')}`;
    }
  }
  return { snapshots, statuses, covers, view };
}
