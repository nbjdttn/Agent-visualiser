import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Dataset, ImportInfo, LiveStatus, SessionDetail } from '../../shared/types';
import type { Built } from '../../core/aggregate';
import { decode, DEFAULT_FILTERS, resolveRange, type Data, type Filters, type Range } from './data';
import type { SyncView } from './sync';
import { todayIndex } from './time';

// ---------------------------------------------------------------------------
// Dataset + live status
// ---------------------------------------------------------------------------

/**
 * server: a local Agent Visualiser server reads agent logs (desktop).
 * device: no server (the phone app); imports live in this browser.
 */
export type Mode = 'server' | 'device';

interface DataState {
  mode?: Mode;
  data?: Data;
  live?: LiveStatus;
  error?: string;
  loading: boolean;
  refetching: boolean;
  refresh: () => Promise<void>;
  imports: ImportInfo[];
  importing?: string;
  importError?: string;
  /** What the last successful import added, for a confirmation message. */
  lastImported?: ImportInfo[];
  importFile: (file: File) => Promise<ImportInfo[] | undefined>;
  removeImport: (id: string) => Promise<void>;
  clearImports: () => Promise<void>;
  sessionDetail: (key: string) => Promise<SessionDetail | undefined>;
  renameProject: (key: string, name: string | null) => void;
  /** Automatic updates (phone app only). */
  sync?: SyncView;
  syncing: boolean;
  enableSync: () => Promise<void>;
  disableSync: () => Promise<void>;
  checkSync: () => Promise<void>;
}

const DataContext = createContext<DataState | null>(null);
const API = './api';
/** How often the phone looks for automatic updates while the app is open. */
const SYNC_EVERY_MS = 5 * 60_000;
const NAMES_KEY = 'av.projectNames.v1';

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

async function detectMode(): Promise<Mode> {
  // The desktop server marks the page it serves; a static host (GitHub Pages)
  // has no API, so don't even ask unless this is a local address (dev server).
  if (document.querySelector('meta[name="av-server"]')) return 'server';
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  if (!local) return 'device';
  try {
    const res = await fetch(`${API}/health`, { cache: 'no-store' });
    return res.ok && (res.headers.get('content-type') ?? '').includes('json') ? 'server' : 'device';
  } catch {
    return 'device';
  }
}

function loadNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const WRITE_HEADERS = { 'x-agent-visualiser': '1' };

export function DataProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>();
  const [dataset, setDataset] = useState<Dataset>();
  const [live, setLive] = useState<LiveStatus>();
  const [error, setError] = useState<string>();
  const [refetching, setRefetching] = useState(false);
  const [imports, setImports] = useState<ImportInfo[]>([]);
  const [importing, setImporting] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const [lastImported, setLastImported] = useState<ImportInfo[]>();
  const [names, setNames] = useState<Record<string, string>>(loadNames);
  const [sync, setSync] = useState<SyncView>();
  const [syncing, setSyncing] = useState(false);
  const versionRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);
  const builtRef = useRef<Built | undefined>(undefined);

  // --- server mode -----------------------------------------------------------
  const loadServerDataset = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefetching(true);
    try {
      const [ds, list] = await Promise.all([getJson<Dataset>(`${API}/dataset`), getJson<ImportInfo[]>(`${API}/imports`).catch(() => [])]);
      versionRef.current = ds.version;
      setDataset(ds);
      setImports(list);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setRefetching(false);
    }
  }, []);

  const pollLive = useCallback(async () => {
    try {
      const l = await getJson<LiveStatus>(`${API}/live`);
      setLive(l);
      if (versionRef.current !== undefined && l.version !== versionRef.current) void loadServerDataset();
    } catch {
      // the next poll will try again
    }
  }, [loadServerDataset]);

  // --- device mode -----------------------------------------------------------
  const loadDeviceDataset = useCallback(async (): Promise<SyncView | undefined> => {
    setRefetching(true);
    try {
      const [device, syncLib] = await Promise.all([import('./device'), import('./sync')]);
      const [stored, synced] = await Promise.all([device.listImports(), syncLib.loadSynced()]);
      const version = (versionRef.current ?? 0) + 1;
      versionRef.current = version;
      const built = device.buildDeviceDataset(stored, version, synced);
      builtRef.current = built;
      setDataset(built.dataset);
      setImports(stored.map((s) => s.info));
      setSync(synced.view);
      setError(undefined);
      return synced.view;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setRefetching(false);
    }
  }, []);

  // --- automatic updates (device mode) ----------------------------------------
  const lastSyncRef = useRef(0);
  const checkSync = useCallback(async () => {
    lastSyncRef.current = Date.now();
    setSyncing(true);
    try {
      const syncLib = await import('./sync');
      const changed = await syncLib.checkForUpdates();
      if (changed) await loadDeviceDataset();
      else setSync((await syncLib.loadSynced()).view);
    } finally {
      setSyncing(false);
    }
  }, [loadDeviceDataset]);

  const enableSync = useCallback(async () => {
    const syncLib = await import('./sync');
    await syncLib.enableSync();
    await loadDeviceDataset();
    await checkSync();
  }, [loadDeviceDataset, checkSync]);

  const disableSync = useCallback(async () => {
    const syncLib = await import('./sync');
    await syncLib.disableSync();
    await loadDeviceDataset();
  }, [loadDeviceDataset]);

  useEffect(() => {
    if (mode !== 'device' || !sync?.enabled) return;
    const maybeCheck = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastSyncRef.current > 60_000) void checkSync();
    };
    const timer = window.setInterval(maybeCheck, SYNC_EVERY_MS);
    document.addEventListener('visibilitychange', maybeCheck);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', maybeCheck);
    };
  }, [mode, sync?.enabled, checkSync]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const onVisible = () => document.visibilityState === 'visible' && void pollLive();
    void detectMode().then(async (m) => {
      if (cancelled) return;
      setMode(m);
      if (m === 'device') {
        const view = await loadDeviceDataset();
        if (view?.enabled && !cancelled) void checkSync();
        return;
      }
      await loadServerDataset();
      await pollLive();
      const schedule = () => {
        timer = window.setTimeout(async () => {
          if (document.visibilityState === 'visible') await pollLive();
          if (!cancelled) schedule();
        }, 8_000);
      };
      schedule();
      document.addEventListener('visibilitychange', onVisible);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadServerDataset, loadDeviceDataset, pollLive, checkSync]);

  const refresh = useCallback(async () => {
    if (mode === 'device') {
      if (sync?.enabled) await checkSync();
      else await loadDeviceDataset();
      return;
    }
    setRefetching(true);
    try {
      await getJson(`${API}/refresh`, { method: 'POST', headers: WRITE_HEADERS });
    } catch {
      // fall through to a normal reload
    }
    await loadServerDataset();
    await pollLive();
  }, [mode, sync?.enabled, checkSync, loadDeviceDataset, loadServerDataset, pollLive]);

  const importFile = useCallback(
    async (file: File): Promise<ImportInfo[] | undefined> => {
      setImportError(undefined);
      setLastImported(undefined);
      setImporting('Reading the file');
      try {
        let added: ImportInfo[];
        if (mode === 'server') {
          setImporting('Uploading to your computer');
          added = await getJson<ImportInfo[]>(`${API}/import`, {
            method: 'POST',
            headers: { ...WRITE_HEADERS, 'x-file-name': encodeURIComponent(file.name) },
            body: file,
          });
          await loadServerDataset();
        } else {
          const device = await import('./device');
          const parsed = await device.parseInWorker(file, setImporting);
          setImporting('Saving on this device');
          await device.saveImports(parsed);
          added = parsed.map((p) => p.info);
          await loadDeviceDataset();
        }
        setLastImported(added);
        return added;
      } catch (err) {
        setImportError(err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        setImporting(undefined);
      }
    },
    [mode, loadServerDataset, loadDeviceDataset],
  );

  const removeImport = useCallback(
    async (id: string) => {
      if (mode === 'server') {
        await getJson(`${API}/import/${encodeURIComponent(id)}`, { method: 'DELETE', headers: WRITE_HEADERS }).catch(() => undefined);
        await loadServerDataset();
      } else {
        const device = await import('./device');
        await device.deleteImport(id);
        await loadDeviceDataset();
      }
    },
    [mode, loadServerDataset, loadDeviceDataset],
  );

  const clearImports = useCallback(async () => {
    if (mode === 'server') {
      for (const i of imports) await getJson(`${API}/import/${encodeURIComponent(i.id)}`, { method: 'DELETE', headers: WRITE_HEADERS }).catch(() => undefined);
      await loadServerDataset();
    } else {
      const device = await import('./device');
      await device.deleteAllImports();
      await loadDeviceDataset();
    }
  }, [mode, imports, loadServerDataset, loadDeviceDataset]);

  const sessionDetail = useCallback(
    async (key: string): Promise<SessionDetail | undefined> => {
      if (mode === 'device') {
        const device = await import('./device');
        return builtRef.current ? device.deviceSessionDetail(builtRef.current, key) : undefined;
      }
      try {
        return await getJson<SessionDetail>(`${API}/session/${encodeURIComponent(key)}`);
      } catch {
        return undefined;
      }
    },
    [mode],
  );

  const renameProject = useCallback((key: string, name: string | null) => {
    setNames((prev) => {
      const next = { ...prev };
      if (name && name.trim()) next[key] = name.trim();
      else delete next[key];
      try {
        localStorage.setItem(NAMES_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: the name lasts until reload
      }
      return next;
    });
  }, []);

  const data = useMemo(() => (dataset ? decode(dataset, names) : undefined), [dataset, names]);

  const value = useMemo<DataState>(
    () => ({
      mode,
      data,
      live,
      error,
      loading: !data && !error,
      refetching,
      refresh,
      imports,
      importing,
      importError,
      lastImported,
      importFile,
      removeImport,
      clearImports,
      sessionDetail,
      renameProject,
      sync,
      syncing,
      enableSync,
      disableSync,
      checkSync,
    }),
    [
      mode,
      data,
      live,
      error,
      refetching,
      refresh,
      imports,
      importing,
      importError,
      lastImported,
      importFile,
      removeImport,
      clearImports,
      sessionDetail,
      renameProject,
      sync,
      syncing,
      enableSync,
      disableSync,
      checkSync,
    ],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Filters (remembered per browser)
// ---------------------------------------------------------------------------

interface FilterState {
  filters: Filters;
  range: Range;
  today: number;
  setFilters: (patch: Partial<Filters>) => void;
  clearDimension: (key: 'provider' | 'sources' | 'project' | 'model') => void;
  resetFilters: () => void;
}

const FilterContext = createContext<FilterState | null>(null);
const FILTER_KEY = 'av.filters.v1';

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<Filters>) };
  } catch {
    // storage unavailable
  }
  return DEFAULT_FILTERS;
}

export function FilterProvider({ children }: { children: ReactNode }) {
  const { data } = useData();
  const [filters, setState] = useState<Filters>(loadFilters);
  const [today, setToday] = useState(todayIndex);

  useEffect(() => {
    const t = window.setInterval(() => setToday(todayIndex()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      // ignore
    }
  }, [filters]);

  // Drop filters that point at projects or models that no longer exist.
  useEffect(() => {
    if (!data) return;
    setState((f) => {
      const project = f.project && !data.projectByKey.has(f.project) ? null : f.project;
      const model = f.model && !data.modelById.has(f.model) ? null : f.model;
      return project === f.project && model === f.model ? f : { ...f, project, model };
    });
  }, [data]);

  const setFilters = useCallback((patch: Partial<Filters>) => setState((f) => ({ ...f, ...patch })), []);
  const clearDimension = useCallback(
    (key: 'provider' | 'sources' | 'project' | 'model') =>
      setState((f) => ({ ...f, [key]: key === 'provider' ? 'all' : key === 'sources' ? [] : null })),
    [],
  );
  const resetFilters = useCallback(() => setState((f) => ({ ...DEFAULT_FILTERS, preset: f.preset, from: f.from, to: f.to })), []);
  const range = useMemo(() => resolveRange(filters, data, today), [filters, data, today]);

  const value = useMemo(
    () => ({ filters, range, today, setFilters, clearDimension, resetFilters }),
    [filters, range, today, setFilters, clearDimension, resetFilters],
  );
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterState {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useFilters outside FilterProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Session drawer
// ---------------------------------------------------------------------------

interface DrawerState {
  sessionKey: string | null;
  openSession: (key: string | null) => void;
}

const DrawerContext = createContext<DrawerState | null>(null);

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [sessionKey, openSession] = useState<string | null>(null);
  const value = useMemo(() => ({ sessionKey, openSession }), [sessionKey]);
  return <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>;
}

export function useDrawer(): DrawerState {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error('useDrawer outside DrawerProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type ThemePref = 'system' | 'light' | 'dark' | 'midnight' | 'paper';
export const THEMES: { id: ThemePref; label: string; page: string; surface: string; accent: string }[] = [
  { id: 'system', label: 'Match iPhone', page: 'linear-gradient(135deg,#f4f4f1 50%,#0d0d0d 50%)', surface: '#fcfcfb', accent: '#2a78d6' },
  { id: 'light', label: 'Light', page: '#f4f4f1', surface: '#fcfcfb', accent: '#2a78d6' },
  { id: 'dark', label: 'Dark', page: '#0d0d0d', surface: '#1a1a19', accent: '#3987e5' },
  { id: 'midnight', label: 'Midnight', page: '#0b0a10', surface: '#15131c', accent: '#8f7bff' },
  { id: 'paper', label: 'Paper', page: '#f3eee6', surface: '#fbf8f3', accent: '#c4572a' },
];
const THEME_IDS = THEMES.map((t) => t.id);

/** Keep the iPhone status bar in the page colour. */
function applyStatusBar(t: ThemePref) {
  const theme = THEMES.find((x) => x.id === t);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('data-media') ?? m.getAttribute('media');
    if (media) m.setAttribute('data-media', media);
    if (t === 'system' || !theme) {
      if (media) m.setAttribute('media', media);
      m.content = media?.includes('dark') ? '#0d0d0d' : '#f4f4f1';
    } else {
      m.removeAttribute('media');
      m.content = theme.page;
    }
  });
}

export type PaletteId = 'classic' | 'ocean' | 'sunset' | 'bold' | 'berry';
/** Chart colour palettes; the swatch shows Claude, OpenAI and the first two series colours. */
export const PALETTES: { id: PaletteId; label: string; swatch: string[] }[] = [
  { id: 'classic', label: 'Classic', swatch: ['#eb6834', '#1baf7a', '#2a78d6', '#e87ba4'] },
  { id: 'ocean', label: 'Ocean', swatch: ['#2a78d6', '#1baf7a', '#eb6834', '#6250d6'] },
  { id: 'sunset', label: 'Sunset', swatch: ['#eb6834', '#6250d6', '#1baf7a', '#eda100'] },
  { id: 'bold', label: 'Bold', swatch: ['#e34948', '#2a78d6', '#eb6834', '#1baf7a'] },
  { id: 'berry', label: 'Berry', swatch: ['#e87ba4', '#6250d6', '#eb6834', '#2a78d6'] },
];

/** Ready-made themes: each pairs a background with the colours that suit it best. */
export const COMBOS: { id: string; label: string; theme: ThemePref; palette: PaletteId }[] = [
  { id: 'auto', label: 'Match iPhone', theme: 'system', palette: 'classic' },
  { id: 'light', label: 'Light', theme: 'light', palette: 'classic' },
  { id: 'dark', label: 'Dark', theme: 'dark', palette: 'classic' },
  { id: 'midnight', label: 'Midnight', theme: 'midnight', palette: 'berry' },
  { id: 'ocean', label: 'Ocean', theme: 'light', palette: 'ocean' },
  { id: 'sunset', label: 'Sunset', theme: 'paper', palette: 'sunset' },
];

export function usePalette(): [PaletteId, (p: PaletteId) => void] {
  const [palette, setPalette] = useState<PaletteId>(() => {
    try {
      const p = localStorage.getItem('av.palette') as PaletteId | null;
      return p && PALETTES.some((x) => x.id === p) ? p : 'classic';
    } catch {
      return 'classic';
    }
  });
  const set = useCallback((p: PaletteId) => {
    setPalette(p);
    try {
      if (p === 'classic') localStorage.removeItem('av.palette');
      else localStorage.setItem('av.palette', p);
    } catch {
      // ignore
    }
    if (p === 'classic') document.documentElement.removeAttribute('data-palette');
    else document.documentElement.setAttribute('data-palette', p);
  }, []);
  return [palette, set];
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      const t = localStorage.getItem('av.theme') as ThemePref | null;
      return t && THEME_IDS.includes(t) ? t : 'system';
    } catch {
      return 'system';
    }
  });
  const set = useCallback((t: ThemePref) => {
    setPref(t);
    try {
      if (t === 'system') localStorage.removeItem('av.theme');
      else localStorage.setItem('av.theme', t);
    } catch {
      // ignore
    }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    applyStatusBar(t);
  }, []);
  useEffect(() => applyStatusBar(pref), [pref]);
  return [pref, set];
}
