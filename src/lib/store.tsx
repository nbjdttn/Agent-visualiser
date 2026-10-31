import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Dataset, LiveStatus } from '../../shared/types';
import { decode, DEFAULT_FILTERS, resolveRange, type Data, type Filters, type Range } from './data';
import { todayIndex } from './time';

// ---------------------------------------------------------------------------
// Dataset + live status
// ---------------------------------------------------------------------------

interface DataState {
  data?: Data;
  live?: LiveStatus;
  error?: string;
  loading: boolean;
  refetching: boolean;
  refresh: () => Promise<void>;
}

const DataContext = createContext<DataState | null>(null);

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>();
  const [live, setLive] = useState<LiveStatus>();
  const [error, setError] = useState<string>();
  const [refetching, setRefetching] = useState(false);
  const versionRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  const loadDataset = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefetching(true);
    try {
      const ds = await getJson<Dataset>('/api/dataset');
      versionRef.current = ds.version;
      setData(decode(ds));
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
      const l = await getJson<LiveStatus>('/api/live');
      setLive(l);
      if (versionRef.current !== undefined && l.version !== versionRef.current) void loadDataset();
    } catch {
      // the next poll will try again
    }
  }, [loadDataset]);

  useEffect(() => {
    void loadDataset().then(pollLive);
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') await pollLive();
        schedule();
      }, 8_000);
    };
    schedule();
    const onVisible = () => document.visibilityState === 'visible' && void pollLive();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadDataset, pollLive]);

  const refresh = useCallback(async () => {
    setRefetching(true);
    try {
      await getJson('/api/refresh', { method: 'POST', headers: { 'x-agent-visualiser': '1' } });
    } catch {
      // fall through to a normal reload
    }
    await loadDataset();
    await pollLive();
  }, [loadDataset, pollLive]);

  const value = useMemo<DataState>(
    () => ({ data, live, error, loading: !data && !error, refetching, refresh }),
    [data, live, error, refetching, refresh],
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
