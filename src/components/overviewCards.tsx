import { useMemo, useState } from 'react';
import { SOURCE_META, type SessionInfo } from '../../shared/types';
import { PROVIDER_COLOR, TOKEN_TYPES } from '../lib/colors';
import { applyFilters, autoGranularity, buildSeries, cumulative, type Data, type Fact, type Filters, type Range, type SeriesDef, type Totals } from '../lib/data';
import { compact, full, usd } from '../lib/format';
import { useDrawer } from '../lib/store';
import { addMonths, monthStart } from '../lib/time';
import { SimpleTable } from './cards';
import { ChartCard } from './ChartCard';
import { BarList, type BarItem } from './charts/BarList';
import { Legend } from './charts/Legend';
import { SegmentedBar } from './charts/SegmentedBar';
import { TimeSeriesChart } from './charts/TimeSeriesChart';
import { TrendChart } from './charts/TrendChart';
import { ProviderDot } from './ui';

/** Where the tokens went: cache reads, cache writes, new input, output. */
export function TokenTypesCard({ t, refetching }: { t: Totals; refetching?: boolean }) {
  const parts = TOKEN_TYPES.map((k) => ({ key: k.key, label: k.label, value: t[k.key], display: compact(t[k.key]), color: k.color }));
  return (
    <ChartCard
      title="Token types"
      refetching={refetching}
      table={() => <SimpleTable headers={['Type', 'Tokens']} rows={parts.map((p) => [p.label, full(p.value)])} />}
    >
      <SegmentedBar parts={parts} ariaLabel="Tokens by type" />
    </ChartCard>
  );
}

/** Estimated cost per day (or week/month), by provider. */
export function CostCard({ data, facts, range, refetching }: { data: Data; facts: Fact[]; range: Range; refetching?: boolean }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { series, buckets } = useMemo(() => buildSeries(data, facts, range, autoGranularity(range), 'provider', 'cost'), [data, facts, range]);
  const total = facts.reduce((s, f) => s + f.cost, 0);
  return (
    <ChartCard
      title="Cost"
      subtitle={`≈ ${usd(total)} at API prices`}
      refetching={refetching}
      legend={<Legend series={series} hidden={hidden} onChange={setHidden} />}
      table={() => <SimpleTable headers={['When', ...series.map((s) => s.label)]} rows={buckets.map((b) => [b.label, ...b.values.map((v) => usd(v))])} />}
    >
      <TimeSeriesChart buckets={buckets} series={series} kind="bar" height={190} format={(v) => usd(v, { compact: true })} hidden={hidden} />
    </ChartCard>
  );
}

/** Cost so far in this period against the same point in the previous one. */
export function SpendPaceCard({
  labels,
  current,
  previous,
  refetching,
}: {
  labels: string[];
  current: number[];
  previous: number[];
  refetching?: boolean;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const now = cumulative(current);
  const before = cumulative(previous).slice(0, now.length);
  const series: SeriesDef[] = [
    { key: 'now', label: 'This period', color: 'var(--focus)' },
    { key: 'before', label: 'Previous', color: 'var(--muted)' },
  ];
  const fmt = (v: number) => usd(v, { compact: true });
  const showNow = !hidden.has('now');
  return (
    <ChartCard
      title="Spending vs last time"
      refetching={refetching}
      legend={<Legend series={series} hidden={hidden} onChange={setHidden} shape="line" values={[usd(now.at(-1) ?? 0), usd(before.at(-1) ?? 0)]} />}
      table={() => <SimpleTable headers={['Up to', 'This period', 'Previous']} rows={labels.map((l, i) => [l, usd(now[i]), usd(before[i] ?? 0)])} />}
    >
      <TrendChart
        labels={labels}
        lines={[
          ...(showNow ? [{ label: 'This period', values: now, color: 'var(--focus)' }] : []),
          ...(!hidden.has('before') ? [{ label: 'Previous', values: before, color: 'var(--muted)', wash: false }] : []),
        ]}
        height={170}
        axis
        format={fmt}
        ariaLabel="Running total of estimated cost, this period and the previous one"
      />
    </ChartCard>
  );
}

/** The largest sessions and chats as ranked bars; tap one to open it. */
export function BiggestSessionsCard({ data, sessions, refetching }: { data: Data; sessions: SessionInfo[]; refetching?: boolean }) {
  const { openSession } = useDrawer();
  const items: BarItem[] = useMemo(
    () =>
      [...sessions]
        .map((s) => ({ s, tokens: s.input + s.output + s.cacheRead + s.cacheWrite }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 6)
        .map(({ s, tokens }) => {
          const provider = SOURCE_META[data.sourceIds[s.src]].provider;
          return {
            key: s.key,
            label: s.title || 'Untitled',
            sublabel: data.projects[s.proj]?.name,
            value: tokens,
            display: compact(tokens),
            secondary: usd(s.cost),
            color: PROVIDER_COLOR[provider],
            icon: <ProviderDot provider={provider} />,
          };
        }),
    [data, sessions],
  );
  return (
    <ChartCard
      title="Biggest sessions"
      refetching={refetching}
      actions={
        <a href="#/sessions" className="text-[12px] font-medium text-ink-2 hover:text-ink">
          All →
        </a>
      }
    >
      <BarList items={items} onSelect={openSession} limit={6} emptyLabel="No sessions in this period" />
    </ChartCard>
  );
}

/** Tokens per month for the last 12 months, by provider (ignores the date range, keeps the other filters). */
export function MonthsCard({ data, filters, today, refetching }: { data: Data; filters: Filters; today: number; refetching?: boolean }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { series, buckets } = useMemo(() => {
    const from = monthStart(addMonths(today, -11));
    const range = { from, to: today, days: today - from + 1 };
    return buildSeries(data, applyFilters(data, filters, range), range, 'month', 'provider', 'tokens');
  }, [data, filters, today]);
  return (
    <ChartCard
      title="Last 12 months"
      refetching={refetching}
      legend={<Legend series={series} hidden={hidden} onChange={setHidden} />}
      table={() => <SimpleTable headers={['Month', ...series.map((s) => s.label)]} rows={buckets.map((b) => [b.label, ...b.values.map((v) => compact(v))])} />}
    >
      <TimeSeriesChart buckets={buckets} series={series} kind="bar" height={200} format={(v) => compact(v)} hidden={hidden} />
    </ChartCard>
  );
}
