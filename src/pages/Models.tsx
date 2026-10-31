import { AlertCircle, ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PROVIDER_LABEL } from '../../shared/types';
import { OTHER_COLOR, PROVIDER_COLOR, slotColor } from '../lib/colors';
import { applyFilters, cacheHitRate, filterSessions, groupBy, isUnknownModel, type Data, type Totals } from '../lib/data';
import { compact, pct, usd } from '../lib/format';
import { useData, useFilters } from '../lib/store';
import { CalendarCard } from '../components/cards';
import { ChartCard } from '../components/ChartCard';
import { BarList } from '../components/charts/BarList';
import { SegmentedBar } from '../components/charts/SegmentedBar';
import { DataTable, type Column } from '../components/DataTable';
import { UsageOverTime } from '../components/UsageOverTime';
import { Card, CardHeader, ProviderDot } from '../components/ui';
import type { ModelInfo } from '../../shared/types';

interface Row {
  m: ModelInfo;
  t: Totals;
  share: number;
}

const perM = (n?: number) => (n === undefined ? '–' : `$${n < 1 ? n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(2).replace(/\.00$/, '')}`);

export function ModelsPage({ data }: { data: Data }) {
  const { refetching } = useData();
  const { filters, range, setFilters } = useFilters();
  const [showAll, setShowAll] = useState(false);
  const dayFacts = useMemo(() => applyFilters(data, filters, range), [data, filters, range]);
  const sessions = useMemo(() => filterSessions(data, filters, range), [data, filters, range]);
  const facts = useMemo(() => applyFilters(data, filters, range, { model: false }), [data, filters, range]);
  const rows: Row[] = useMemo(() => {
    const by = groupBy(facts, (f) => f.model);
    const total = [...by.values()].reduce((s, t) => s + t.tokens, 0) || 1;
    return [...by.entries()].filter(([i]) => !isUnknownModel(data.models[i])).map(([i, t]) => ({ m: data.models[i], t, share: t.tokens / total }));
  }, [data, facts]);

  const columns: Column<Row>[] = [
    {
      key: 'model',
      header: 'Model',
      cell: (r) => (
        <div className="flex min-w-[150px] items-center gap-2.5">
          <ProviderDot provider={r.m.provider} />
          <div className="min-w-0">
            <div className="font-medium text-ink">{r.m.label}</div>
            <div className="truncate font-mono text-[11px] text-muted">{r.m.id}</div>
          </div>
        </div>
      ),
      sort: (r) => r.m.label,
    },
    { key: 'provider', header: 'Provider', cell: (r) => <span className="text-ink-2">{PROVIDER_LABEL[r.m.provider]}</span>, hide: 'lg', sort: (r) => r.m.provider },
    { key: 'tokens', header: 'Tokens', cell: (r) => <span className="font-semibold">{compact(r.t.tokens)}</span>, sort: (r) => r.t.tokens, align: 'right' },
    {
      key: 'share',
      header: 'Share',
      cell: (r) => (
        <div className="ml-auto flex w-[110px] items-center gap-2">
          <div className="h-1.5 flex-1 rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${r.share * 100}%`, background: 'var(--s1)' }} />
          </div>
          <span className="tnum w-9 text-right text-[12px] text-ink-2">{pct(r.share)}</span>
        </div>
      ),
      sort: (r) => r.share,
      align: 'right',
      hide: 'md',
    },
    { key: 'requests', header: 'Requests', cell: (r) => compact(r.t.requests), sort: (r) => r.t.requests, align: 'right', hide: 'sm' },
    {
      key: 'avg',
      header: 'Tokens / request',
      cell: (r) => (r.t.requests ? compact(r.t.tokens / r.t.requests) : '–'),
      sort: (r) => (r.t.requests ? r.t.tokens / r.t.requests : 0),
      align: 'right',
      hide: 'lg',
    },
    { key: 'cache', header: 'Cache hit', cell: (r) => pct(cacheHitRate(r.t)), sort: (r) => cacheHitRate(r.t), align: 'right', hide: 'md' },
    { key: 'output', header: 'Output', cell: (r) => compact(r.t.output), sort: (r) => r.t.output, align: 'right', hide: 'lg' },
    {
      key: 'price',
      header: 'Price in / out',
      cell: (r) =>
        r.m.price ? (
          <span className="whitespace-nowrap text-ink-2">
            {perM(r.m.price.input)} / {perM(r.m.price.output)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted" title="No public price found for this model">
            <AlertCircle size={12} /> unpriced
          </span>
        ),
      align: 'right',
      hide: 'lg',
    },
    { key: 'cost', header: 'Est. cost', cell: (r) => <span className="font-medium">{usd(r.t.cost)}</span>, sort: (r) => r.t.cost, align: 'right' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <UsageOverTime
        data={data}
        facts={facts}
        range={range}
        title="Models over time"
        splits={['model', 'provider', 'tokenType']}
        defaultSplit="model"
        refetching={refetching}
      />
      <CalendarCard facts={dayFacts} range={range} sessions={sessions} refetching={refetching} />

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <ChartCard title="Share of tokens" refetching={refetching}>
          <SegmentedBar
            ariaLabel="Share of tokens by model"
            parts={(() => {
              const sorted = [...rows].sort((a, b) => b.t.tokens - a.t.tokens);
              const top = sorted.slice(0, 5).map((r) => ({ key: r.m.id, label: r.m.label, value: r.t.tokens, display: compact(r.t.tokens), color: slotColor(r.m.rank) }));
              const rest = sorted.slice(5).reduce((sum, r) => sum + r.t.tokens, 0);
              return rest > 0 ? [...top, { key: '__other', label: 'Other', value: rest, display: compact(rest), color: OTHER_COLOR }] : top;
            })()}
          />
        </ChartCard>
        <ChartCard title="Cost by model" refetching={refetching}>
          <BarList
            items={[...rows]
              .sort((a, b) => b.t.cost - a.t.cost)
              .map((r) => ({
                key: r.m.id,
                label: r.m.label,
                value: r.t.cost,
                display: usd(r.t.cost),
                color: PROVIDER_COLOR[r.m.provider],
                icon: <ProviderDot provider={r.m.provider} />,
                active: filters.model === r.m.id,
              }))}
            onSelect={(key) => setFilters({ model: filters.model === key ? null : key })}
            limit={6}
            emptyLabel="No model usage in this period"
          />
        </ChartCard>
      </div>

      <Card className={`p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
        <button type="button" onClick={() => setShowAll((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={showAll}>
          <CardHeader title="All models" subtitle={`${rows.length} in this period · prices per million tokens`} />
          <ChevronDown size={20} className={`shrink-0 text-ink-2 transition-transform ${showAll ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {showAll && (
          <div className="-mx-3 mt-3">
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.m.id}
              onRowClick={(r) => setFilters({ model: filters.model === r.m.id ? null : r.m.id })}
              initialSort={{ key: 'tokens', dir: 'desc' }}
              emptyLabel="No model usage in this period"
            />
          </div>
        )}
      </Card>
    </div>
  );
}
