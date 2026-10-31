import { ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PROVIDER_LABEL, SOURCE_META, type Provider } from '../../shared/types';
import { PROVIDER_COLOR } from '../lib/colors';
import { autoGranularity, bucketStarts, filterSessions, type Bucket, type Data, type SeriesDef } from '../lib/data';
import { compact, dayLabel, full, monthLabel, usd } from '../lib/format';
import { useData, useDrawer, useFilters } from '../lib/store';
import { dayIndex } from '../lib/time';
import { SimpleTable, sessionColumns } from '../components/cards';
import { ChartCard } from '../components/ChartCard';
import { BarList, type BarItem } from '../components/charts/BarList';
import { Legend } from '../components/charts/Legend';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { DataTable } from '../components/DataTable';
import { BiggestSessionsCard } from '../components/overviewCards';
import { Card, CardHeader } from '../components/ui';

const SIZES: [number, number, string][] = [
  [0, 1e4, 'Under 10K'],
  [1e4, 1e5, '10K – 100K'],
  [1e5, 1e6, '100K – 1M'],
  [1e6, 1e7, '1M – 10M'],
  [1e7, Infinity, 'Over 10M'],
];

const tokensOf = (s: { input: number; output: number; cacheRead: number; cacheWrite: number }) => s.input + s.output + s.cacheRead + s.cacheWrite;

export function SessionsPage({ data }: { data: Data }) {
  const { refetching } = useData();
  const { filters, range } = useFilters();
  const { openSession } = useDrawer();
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const sessions = useMemo(() => filterSessions(data, filters, range), [data, filters, range]);
  const cols = useMemo(() => sessionColumns(data), [data]);

  const perDay = useMemo(() => {
    const providers = (['anthropic', 'openai'] as Provider[]).filter((p) => filters.provider === 'all' || filters.provider === p);
    const series: SeriesDef[] = providers.map((p) => ({ key: p, label: PROVIDER_LABEL[p], color: PROVIDER_COLOR[p], provider: p }));
    const gran = autoGranularity(range);
    const buckets: Bucket[] = bucketStarts(range, gran).map(({ start, end }) => ({
      start,
      end,
      label: gran === 'day' ? dayLabel(start, { weekday: true, year: true }) : gran === 'week' ? `Week of ${dayLabel(start)}` : monthLabel(start),
      short: gran === 'month' ? monthLabel(start, false) : dayLabel(start),
      values: series.map(() => 0),
      total: 0,
    }));
    for (const s of sessions) {
      const day = dayIndex(s.start);
      const b = buckets.find((x) => day >= x.start && day <= x.end);
      const i = series.findIndex((x) => x.key === SOURCE_META[data.sourceIds[s.src]].provider);
      if (!b || i < 0) continue;
      b.values[i] += 1;
      b.total += 1;
    }
    return { series, buckets };
  }, [data, sessions, range, filters.provider]);

  const sizes: BarItem[] = useMemo(
    () =>
      SIZES.map(([lo, hi, label]) => {
        const n = sessions.filter((s) => tokensOf(s) >= lo && tokensOf(s) < hi).length;
        return { key: label, label, value: n, display: full(n), color: 'var(--seq-5)' };
      }),
    [sessions],
  );

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? sessions.filter((s) =>
        [s.title, data.projects[s.proj]?.name, data.projects[s.proj]?.path, s.branch, ...s.models.map((m) => data.models[m].label)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : sessions;
  const tokens = sessions.reduce((sum, s) => sum + tokensOf(s), 0);

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      <ChartCard
        title="Sessions per day"
        subtitle={`${full(sessions.length)} sessions · ${compact(tokens)} tokens · ≈ ${usd(sessions.reduce((sum, s) => sum + s.cost, 0))}`}
        refetching={refetching}
        legend={perDay.series.length > 1 ? <Legend series={perDay.series} hidden={hidden} onChange={setHidden} /> : undefined}
        table={() => <SimpleTable headers={['When', ...perDay.series.map((s) => s.label)]} rows={perDay.buckets.map((b) => [b.label, ...b.values.map(String)])} />}
      >
        <TimeSeriesChart buckets={perDay.buckets} series={perDay.series} kind="bar" height={190} format={(v) => full(Math.round(v))} hidden={hidden} />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <BiggestSessionsCard data={data} sessions={sessions} refetching={refetching} />
        <ChartCard title="Session sizes" subtitle="Tokens per session" refetching={refetching}>
          <BarList items={sizes} limit={SIZES.length} />
        </ChartCard>
      </div>

      <Card className={`p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
        <button type="button" onClick={() => setShowAll((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={showAll}>
          <CardHeader title="All sessions" subtitle={`${full(sessions.length)} in this period`} />
          <ChevronDown size={20} className={`shrink-0 text-ink-2 transition-transform ${showAll ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {showAll && (
          <>
            <label className="relative mt-3 block">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search"
                className="h-10 w-full rounded-xl border border-line bg-surface-2 pl-9 pr-3 text-[16px] text-ink placeholder:text-muted lg:h-8 lg:w-[280px] lg:text-[13px]"
              />
            </label>
            <div className="-mx-3 mt-3">
              <DataTable
                columns={cols}
                rows={shown}
                rowKey={(s) => s.key}
                onRowClick={(s) => openSession(s.key)}
                initialSort={{ key: 'start', dir: 'desc' }}
                pageSize={40}
                emptyLabel="Nothing matches"
              />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
