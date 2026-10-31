import {
  SOURCE_META,
  type Dataset,
  type ModelInfo,
  type ProjectInfo,
  type Provider,
  type SessionInfo,
  type SourceId,
} from '../../shared/types';
import { OTHER_COLOR, PROVIDER_COLOR, SOURCE_COLOR, TOKEN_TYPES, slotColor } from './colors';
import { dayLabel, monthLabel } from './format';
import { DAY_MS, addMonths, dayIndex, monthStart, weekStart, weekdayMon, yearStart } from './time';

export interface Fact {
  day: number;
  hour: number;
  src: number;
  model: number;
  proj: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  cost: number;
  tokens: number;
  provider: Provider;
  source: SourceId;
}

export interface Data {
  raw: Dataset;
  facts: Fact[];
  models: ModelInfo[];
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  sourceIds: SourceId[];
  minDay: number;
  maxDay: number;
  modelById: Map<string, number>;
  projectByKey: Map<string, number>;
  sessionByKey: Map<string, SessionInfo>;
}

/** Turn the compact dataset into objects. `names` holds project names the user chose. */
export function decode(ds: Dataset, names: Record<string, string> = {}): Data {
  const projects = ds.projects.map((p) => (names[p.key] ? { ...p, name: names[p.key] } : p));
  let minDay = Infinity;
  let maxDay = -Infinity;
  const facts: Fact[] = ds.facts.map((t) => {
    if (t[0] < minDay) minDay = t[0];
    if (t[0] > maxDay) maxDay = t[0];
    return {
      day: t[0],
      hour: t[1],
      src: t[2],
      model: t[3],
      proj: t[4],
      input: t[5],
      output: t[6],
      cacheRead: t[7],
      cacheWrite: t[8],
      reasoning: t[9],
      requests: t[10],
      cost: t[11],
      tokens: t[5] + t[6] + t[7] + t[8],
      provider: ds.models[t[3]]?.provider ?? 'anthropic',
      source: ds.sourceIds[t[2]],
    };
  });
  return {
    raw: ds,
    facts,
    models: ds.models,
    projects,
    sessions: ds.sessions,
    sourceIds: ds.sourceIds,
    minDay: Number.isFinite(minDay) ? minDay : 0,
    maxDay: Number.isFinite(maxDay) ? maxDay : 0,
    modelById: new Map(ds.models.map((m, i) => [m.id, i])),
    projectByKey: new Map(ds.projects.map((p, i) => [p.key, i])),
    sessionByKey: new Map(ds.sessions.map((s) => [s.key, s])),
  };
}

// ---------------------------------------------------------------------------
// Filters and ranges
// ---------------------------------------------------------------------------

export type Preset = 'today' | '7d' | '30d' | '90d' | 'mtd' | 'ytd' | '1y' | 'all' | 'custom';

export interface Filters {
  preset: Preset;
  from?: number;
  to?: number;
  provider: 'all' | Provider;
  sources: SourceId[];
  project: string | null;
  model: string | null;
}

export const DEFAULT_FILTERS: Filters = { preset: '30d', provider: 'all', sources: [], project: null, model: null };

export interface Range {
  from: number;
  to: number;
  days: number;
}

export const PRESETS: { id: Preset; label: string; short: string }[] = [
  { id: 'today', label: 'Today', short: 'Today' },
  { id: '7d', label: 'Last 7 days', short: '7D' },
  { id: '30d', label: 'Last 30 days', short: '30D' },
  { id: '90d', label: 'Last 90 days', short: '90D' },
  { id: 'mtd', label: 'Month to date', short: 'MTD' },
  { id: 'ytd', label: 'Year to date', short: 'YTD' },
  { id: '1y', label: 'Last 12 months', short: '1Y' },
  { id: 'all', label: 'All time', short: 'All' },
];

export function resolveRange(f: Filters, data: Data | undefined, today: number): Range {
  let from = today - 29;
  let to = today;
  switch (f.preset) {
    case 'today':
      from = today;
      break;
    case '7d':
      from = today - 6;
      break;
    case '30d':
      from = today - 29;
      break;
    case '90d':
      from = today - 89;
      break;
    case 'mtd':
      from = monthStart(today);
      break;
    case 'ytd':
      from = yearStart(today);
      break;
    case '1y':
      from = today - 364;
      break;
    case 'all':
      from = data && data.facts.length ? Math.min(data.minDay, today) : today - 29;
      to = Math.max(today, data?.maxDay ?? today);
      break;
    case 'custom':
      from = f.from ?? today - 29;
      to = f.to ?? today;
      if (from > to) [from, to] = [to, from];
      break;
  }
  return { from, to, days: to - from + 1 };
}

export function previousRange(r: Range): Range {
  return { from: r.from - r.days, to: r.from - 1, days: r.days };
}

export function presetLabel(f: Filters): string {
  return PRESETS.find((p) => p.id === f.preset)?.label ?? 'Custom range';
}

export interface FilterOptions {
  range?: boolean;
  project?: boolean;
  model?: boolean;
}

export function applyFilters(data: Data, f: Filters, range: Range, opts: FilterOptions = {}): Fact[] {
  const srcSet = f.sources.length ? new Set(f.sources.map((s) => data.sourceIds.indexOf(s))) : null;
  const proj = opts.project !== false && f.project ? data.projectByKey.get(f.project) : undefined;
  const model = opts.model !== false && f.model ? data.modelById.get(f.model) : undefined;
  const useRange = opts.range !== false;
  const out: Fact[] = [];
  for (const x of data.facts) {
    if (useRange && (x.day < range.from || x.day > range.to)) continue;
    if (f.provider !== 'all' && x.provider !== f.provider) continue;
    if (srcSet && !srcSet.has(x.src)) continue;
    if (proj !== undefined && x.proj !== proj) continue;
    if (model !== undefined && x.model !== model) continue;
    out.push(x);
  }
  return out;
}

/** Local-midnight timestamp of a calendar day index. */
export function dayStartTs(day: number): number {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

export function filterSessions(data: Data, f: Filters, range: Range | null): SessionInfo[] {
  const from = range ? dayStartTs(range.from) : -Infinity;
  const to = range ? dayStartTs(range.to + 1) : Infinity;
  const proj = f.project ? data.projectByKey.get(f.project) : undefined;
  const model = f.model ? data.modelById.get(f.model) : undefined;
  return data.sessions.filter((s) => {
    if (s.end < from || s.start >= to) return false;
    const source = data.sourceIds[s.src];
    if (f.sources.length && !f.sources.includes(source)) return false;
    if (f.provider !== 'all') {
      const providers = s.models.map((m) => data.models[m]?.provider);
      if (!providers.includes(f.provider)) return false;
    }
    if (proj !== undefined && s.proj !== proj) return false;
    if (model !== undefined && !s.models.includes(model)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Totals {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  cost: number;
}

export const emptyTotals = (): Totals => ({
  tokens: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  requests: 0,
  cost: 0,
});

export function addInto(t: Totals, f: Totals) {
  t.tokens += f.tokens;
  t.input += f.input;
  t.output += f.output;
  t.cacheRead += f.cacheRead;
  t.cacheWrite += f.cacheWrite;
  t.reasoning += f.reasoning;
  t.requests += f.requests;
  t.cost += f.cost;
}

export function sum(facts: Fact[]): Totals {
  const t = emptyTotals();
  for (const f of facts) addInto(t, f);
  return t;
}

export function groupBy<K>(facts: Fact[], key: (f: Fact) => K): Map<K, Totals> {
  const out = new Map<K, Totals>();
  for (const f of facts) {
    const k = key(f);
    let t = out.get(k);
    if (!t) out.set(k, (t = emptyTotals()));
    addInto(t, f);
  }
  return out;
}

/** Share of prompt tokens served from cache. */
export function cacheHitRate(t: Totals): number {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt ? t.cacheRead / prompt : 0;
}

export type Granularity = 'day' | 'week' | 'month';
export type Metric = 'tokens' | 'cost' | 'requests';
export type Split = 'provider' | 'model' | 'project' | 'source' | 'tokenType';

export const METRIC_LABEL: Record<Metric, string> = { tokens: 'Tokens', cost: 'Est. cost', requests: 'Requests' };

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  provider?: Provider;
}

export interface Bucket {
  start: number;
  end: number;
  label: string;
  short: string;
  values: number[];
  total: number;
}

export function bucketStarts(range: Range, gran: Granularity): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (gran === 'day') {
    for (let d = range.from; d <= range.to; d++) out.push({ start: d, end: d });
  } else if (gran === 'week') {
    for (let d = weekStart(range.from); d <= range.to; d += 7) out.push({ start: d, end: d + 6 });
  } else {
    for (let d = monthStart(range.from); d <= range.to; d = addMonths(d, 1)) out.push({ start: d, end: addMonths(d, 1) - 1 });
  }
  return out;
}

export function autoGranularity(range: Range): Granularity {
  if (range.days <= 62) return 'day';
  if (range.days <= 270) return 'week';
  return 'month';
}

const metricOf = (m: Metric) => (t: Totals | Fact) => (m === 'tokens' ? t.tokens : m === 'cost' ? t.cost : t.requests);

export interface SplitResult {
  series: SeriesDef[];
  index: (f: Fact) => number;
  /** For token-type splits a fact contributes to several series at once. */
  multi?: (f: Fact) => number[];
}

const rankCache = new WeakMap<Data, Map<string, Map<number, number>>>();

/**
 * Rank models or projects by tokens within the date range, ignoring the other
 * filters. Colours follow this rank, so narrowing by provider, source or
 * project never repaints the series that remain.
 */
export function rangeRanks(data: Data, range: Range, key: 'model' | 'proj'): Map<number, number> {
  let byData = rankCache.get(data);
  if (!byData) rankCache.set(data, (byData = new Map()));
  const cacheKey = `${key}:${range.from}:${range.to}`;
  const hit = byData.get(cacheKey);
  if (hit) return hit;
  const totals = new Map<number, number>();
  for (const f of data.facts) {
    if (f.day < range.from || f.day > range.to) continue;
    const k = key === 'model' ? f.model : f.proj;
    totals.set(k, (totals.get(k) ?? 0) + f.tokens);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const ranks = new Map(sorted.map(([k], i) => [k, i]));
  byData.set(cacheKey, ranks);
  return ranks;
}

/** Models and folders the logs didn't name: kept in totals, left out of lists (they fold into "Other"). */
export const isUnknownModel = (m?: ModelInfo) => !m || m.id === 'unknown' || m.id === '<synthetic>';
export const isUnknownProject = (p?: ProjectInfo) => !p || p.key === 'dir:unknown';

export function splitSeries(data: Data, facts: Fact[], split: Split, range?: Range): SplitResult {
  if (split === 'provider') {
    const present = new Set(facts.map((f) => f.provider));
    const order: Provider[] = (['anthropic', 'openai'] as Provider[]).filter((p) => present.has(p));
    const series = order.map((p) => ({
      key: p,
      label: p === 'anthropic' ? 'Claude' : 'OpenAI',
      color: PROVIDER_COLOR[p],
      provider: p,
    }));
    return { series, index: (f) => order.indexOf(f.provider) };
  }
  if (split === 'source') {
    const present = new Set(facts.map((f) => f.source));
    const order = data.sourceIds.filter((s) => present.has(s));
    const series = order.map((s) => ({
      key: s,
      label: SOURCE_META[s].label,
      color: SOURCE_COLOR[s],
      provider: SOURCE_META[s].provider,
    }));
    return { series, index: (f) => order.indexOf(f.source) };
  }
  if (split === 'tokenType') {
    const series = TOKEN_TYPES.map((t) => ({ key: t.key, label: t.label, color: t.color }));
    return {
      series,
      index: () => -1,
      multi: (f) => [f.cacheRead, f.cacheWrite, f.input, f.output],
    };
  }
  // model or project: colour by rank within the date range so entities keep
  // their colour when other filters change.
  const isModel = split === 'model';
  const ranks = range
    ? rangeRanks(data, range, isModel ? 'model' : 'proj')
    : new Map((isModel ? data.models : data.projects).map((_, i) => [i, i]));
  const rankOf = (i: number) => ranks.get(i) ?? Infinity;
  const present = new Set(facts.map((f) => (isModel ? f.model : f.proj)));
  const ranked = [...present].sort((a, b) => rankOf(a) - rankOf(b));
  const unknown = (i: number) => (isModel ? isUnknownModel(data.models[i]) : isUnknownProject(data.projects[i]));
  const named = ranked.filter((i) => rankOf(i) < 6 && !unknown(i));
  const hasOther = ranked.some((i) => rankOf(i) >= 6 || unknown(i));
  const series: SeriesDef[] = named.map((i) => {
    if (isModel) {
      const m = data.models[i];
      return { key: m.id, label: m.label, color: slotColor(rankOf(i)), provider: m.provider };
    }
    const p = data.projects[i];
    return { key: p.key, label: p.name, color: slotColor(rankOf(i)), provider: p.provider };
  });
  if (hasOther) series.push({ key: '__other', label: 'Other', color: OTHER_COLOR });
  const pos = new Map(named.map((i, k) => [i, k]));
  const otherIdx = named.length;
  return { series, index: (f) => pos.get(isModel ? f.model : f.proj) ?? otherIdx };
}

export function buildSeries(
  data: Data,
  facts: Fact[],
  range: Range,
  gran: Granularity,
  split: Split,
  metric: Metric,
): { series: SeriesDef[]; buckets: Bucket[] } {
  const effectiveSplit = split === 'tokenType' && metric !== 'tokens' ? 'provider' : split;
  const { series, index, multi } = splitSeries(data, facts, effectiveSplit, range);
  const starts = bucketStarts(range, gran);
  const buckets: Bucket[] = starts.map(({ start, end }) => ({
    start,
    end,
    label:
      gran === 'day'
        ? dayLabel(start, { weekday: true, year: true })
        : gran === 'week'
          ? `Week of ${dayLabel(start, { year: true })}`
          : monthLabel(start),
    short: gran === 'month' ? monthLabel(start, false) : dayLabel(start),
    values: new Array(series.length).fill(0),
    total: 0,
  }));
  const pick = metricOf(metric);
  const bucketIndex = (day: number) => {
    if (gran === 'day') return day - range.from;
    let lo = 0;
    let hi = buckets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (day < buckets[mid].start) hi = mid - 1;
      else if (day > buckets[mid].end) lo = mid + 1;
      else return mid;
    }
    return -1;
  };
  for (const f of facts) {
    const b = buckets[bucketIndex(f.day)];
    if (!b) continue;
    if (multi) {
      const parts = multi(f);
      parts.forEach((v, i) => {
        b.values[i] += v;
        b.total += v;
      });
    } else {
      const i = index(f);
      if (i < 0) continue;
      const v = pick(f);
      b.values[i] += v;
      b.total += v;
    }
  }
  return { series, buckets };
}

/** Daily (or weekly/monthly) values for a sparkline. */
export function sparkValues(facts: Fact[], range: Range, metric: Metric, maxPoints = 30): number[] {
  const gran: Granularity = range.days <= maxPoints ? 'day' : range.days <= maxPoints * 7 ? 'week' : 'month';
  const starts = bucketStarts(range, gran);
  const values = new Array(starts.length).fill(0);
  const pick = metricOf(metric);
  for (const f of facts) {
    let i: number;
    if (gran === 'day') i = f.day - range.from;
    else i = starts.findIndex((s) => f.day >= s.start && f.day <= s.end);
    if (i >= 0 && i < values.length) values[i] += pick(f);
  }
  return values;
}

/** Totals per day (per week or month on long ranges), with labels: the data behind trend lines. */
export function trendBuckets(facts: Fact[], range: Range, maxPoints = 62): { labels: string[]; totals: Totals[]; starts: number[] } {
  const gran: Granularity = range.days <= maxPoints ? 'day' : range.days <= maxPoints * 7 ? 'week' : 'month';
  const starts = bucketStarts(range, gran);
  const totals = starts.map(() => emptyTotals());
  const indexOf = (day: number) => (gran === 'day' ? day - range.from : starts.findIndex((b) => day >= b.start && day <= b.end));
  for (const f of facts) {
    const i = indexOf(f.day);
    if (i >= 0 && i < totals.length) addInto(totals[i], f);
  }
  const labels = starts.map(({ start }) =>
    gran === 'day' ? dayLabel(start) : gran === 'week' ? `Week of ${dayLabel(start)}` : monthLabel(start),
  );
  return { labels, totals, starts: starts.map((b) => b.start) };
}

/** Sessions started per bucket of trendBuckets(). */
export function sessionCounts(sessions: SessionInfo[], range: Range, maxPoints = 62): number[] {
  const gran: Granularity = range.days <= maxPoints ? 'day' : range.days <= maxPoints * 7 ? 'week' : 'month';
  const starts = bucketStarts(range, gran);
  const out = new Array<number>(starts.length).fill(0);
  for (const s of sessions) {
    const day = dayIndex(s.start);
    const i = gran === 'day' ? day - range.from : starts.findIndex((b) => day >= b.start && day <= b.end);
    if (i >= 0 && i < out.length) out[i] += 1;
  }
  return out;
}

/** Running total. */
export function cumulative(values: number[]): number[] {
  let acc = 0;
  return values.map((v) => (acc += v));
}

export function dailyTotals(facts: Fact[]): Map<number, Totals> {
  return groupBy(facts, (f) => f.day);
}

export function hourMatrix(facts: Fact[], metric: Metric): number[][] {
  const m = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const pick = metricOf(metric);
  for (const f of facts) {
    if (f.hour < 0) continue;
    m[weekdayMon(f.day)][f.hour] += pick(f);
  }
  return m;
}

export function metricValue(t: Totals, m: Metric): number {
  return metricOf(m)(t);
}

/** Change against the previous period as a ratio (0.12 = +12%). */
export function delta(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : Infinity;
  return (current - previous) / previous;
}

export function sourceProvider(s: SourceId): Provider {
  return SOURCE_META[s].provider;
}
