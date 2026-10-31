import { AreaChart, BarChart3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  autoGranularity,
  buildSeries,
  METRIC_LABEL,
  type Data,
  type Fact,
  type Granularity,
  type Metric,
  type Range,
  type Split,
} from '../lib/data';
import { compact, usd } from '../lib/format';
import { ChartCard } from './ChartCard';
import { Legend } from './charts/Legend';
import { TimeSeriesChart } from './charts/TimeSeriesChart';
import { Segmented } from './ui';

const SPLIT_LABEL: Record<Split, string> = {
  provider: 'Provider',
  model: 'Model',
  project: 'Project',
  source: 'Source',
  tokenType: 'Token type',
};

export function formatMetric(metric: Metric) {
  return metric === 'cost' ? (v: number) => usd(v, { compact: true }) : (v: number) => compact(v);
}

export function UsageOverTime({
  data,
  facts,
  range,
  title = 'Usage over time',
  subtitle,
  splits = ['provider', 'model', 'project', 'source', 'tokenType'],
  defaultSplit = 'provider',
  refetching,
  height = 280,
}: {
  data: Data;
  facts: Fact[];
  range: Range;
  title?: string;
  subtitle?: string;
  splits?: Split[];
  defaultSplit?: Split;
  refetching?: boolean;
  height?: number;
}) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const [split, setSplit] = useState<Split>(defaultSplit);
  const [gran, setGran] = useState<Granularity>(() => autoGranularity(range));
  const [kind, setKind] = useState<'bar' | 'area'>('bar');
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Re-pick a sensible bucket size when the length of the range changes.
  const days = range.days;
  useEffect(() => setGran(autoGranularity({ from: 0, to: days - 1, days })), [days]);
  useEffect(() => setHidden(new Set()), [split, metric]);
  useEffect(() => {
    if (split === 'tokenType' && metric !== 'tokens') setSplit('provider');
  }, [metric, split]);

  const { series, buckets } = useMemo(
    () => buildSeries(data, facts, range, gran, split, metric),
    [data, facts, range, gran, split, metric],
  );
  const fmt = formatMetric(metric);
  const seriesTotals = series.map((_, i) => buckets.reduce((s, b) => s + b.values[i], 0));
  const tooMany = gran === 'day' && buckets.length > 120;

  return (
    <ChartCard
      title={title}
      subtitle={subtitle ?? `${METRIC_LABEL[metric]} by ${SPLIT_LABEL[split].toLowerCase()}, per ${gran}`}
      refetching={refetching}
      actions={
        <>
          <Segmented
            label="Metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'tokens', label: 'Tokens' },
              { value: 'cost', label: 'Cost' },
              { value: 'requests', label: 'Requests' },
            ]}
          />
          <Segmented
            label="Bucket size"
            value={gran}
            onChange={setGran}
            options={[
              { value: 'day', label: 'Day', disabled: range.days > 400 },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
            ]}
          />
          <button
            type="button"
            onClick={() => setKind((k) => (k === 'bar' ? 'area' : 'bar'))}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
            title={kind === 'bar' ? 'Show as area' : 'Show as bars'}
            aria-label={kind === 'bar' ? 'Show as area chart' : 'Show as bar chart'}
          >
            {kind === 'bar' ? <AreaChart size={15} /> : <BarChart3 size={15} />}
          </button>
        </>
      }
      legend={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Split by"
            value={split}
            onChange={setSplit}
            options={splits.map((s) => ({
              value: s,
              label: SPLIT_LABEL[s],
              disabled: s === 'tokenType' && metric !== 'tokens',
              title: s === 'tokenType' && metric !== 'tokens' ? 'Token types only apply to the token metric' : undefined,
            }))}
          />
          <Legend series={series} hidden={hidden} onChange={setHidden} values={seriesTotals.map(fmt)} />
        </div>
      }
      table={() => (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-muted">
              <th className="sticky top-0 bg-surface px-2 py-1.5 font-medium">Period</th>
              {series.map((s) => (
                <th key={s.key} className="sticky top-0 bg-surface px-2 py-1.5 text-right font-medium">
                  {s.label}
                </th>
              ))}
              <th className="sticky top-0 bg-surface px-2 py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {[...buckets].reverse().map((b) => (
              <tr key={b.start} className="border-t border-line">
                <td className="whitespace-nowrap px-2 py-1.5 text-ink-2">{b.label}</td>
                {b.values.map((v, i) => (
                  <td key={i} className="tnum px-2 py-1.5 text-right">
                    {fmt(v)}
                  </td>
                ))}
                <td className="tnum px-2 py-1.5 text-right font-semibold">{fmt(b.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    >
      <TimeSeriesChart
        buckets={buckets}
        series={series}
        kind={tooMany ? 'area' : kind}
        height={height}
        format={fmt}
        hidden={hidden}
      />
    </ChartCard>
  );
}
