import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Dataset, ImportInfo, LiveStatus, SessionDetail } from '../../shared/types';
import type { Built } from '../../core/aggregate';
import { decode, DEFAULT_FILTERS, resolveRange, type Data, type Filters, type Range } from './data';
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
}

const DataContext = createContext<DataState | null>(null);
const API = './api';
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
  const loadDeviceDataset = useCallback(async () => {
    setRefetching(true);
    try {
      const device = await import('./device');
      const stored = await device.listImports();
      const version = (versionRef.current ?? 0) + 1;
      versionRef.current = version;
      const built = device.buildDeviceDataset(stored, version);
      builtRef.current = built;
      setDataset(built.dataset);
      setImports(stored.map((s) => s.info));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefetching(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const onVisible = () => document.visibilityState === 'visible' && void pollLive();
    void detectMode().then(async (m) => {
      if (cancelled) return;
      setMode(m);
      if (m === 'device') {
        await loadDeviceDataset();
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
  }, [loadServerDataset, loadDeviceDataset, pollLive]);

  const refresh = useCallback(async () => {
    if (mode === 'device') return loadDeviceDataset();
    setRefetching(true);
    try {
      await getJson(`${API}/refresh`, { method: 'POST', headers: WRITE_HEADERS });
    } catch {
      // fall through to a normal reload
    }
    await loadServerDataset();
    await pollLive();
  }, [mode, loadDeviceDataset, loadServerDataset, pollLive]);

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
    }),
    [mode, data, live, error, refetching, refresh, imports, importing, importError, lastImported, importFile, removeImport, clearImports, sessionDetail, renameProject],
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

export type ThemePref = 'system' | 'light' | 'dark';

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      const t = localStorage.getItem('av.theme');
      return t === 'light' || t === 'dark' ? t : 'system';
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
  }, []);
  return [pref, set];
}
