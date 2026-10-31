import type { ReactNode } from 'react';
import { useWidth } from '../lib/useSize';
import { Sparkline } from './charts/Sparkline';
import { Delta } from './ui';

/** A sparkline as wide as its container. */
function FluidSparkline({ values, height = 30 }: { values: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && <Sparkline values={values} width={width} height={height} />}
    </div>
  );
}

/** label · value · change vs the previous period · trend. */
export function StatTile({
  label,
  value,
  delta,
  good,
  spark,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  delta?: number;
  good?: 'up' | 'down' | 'none';
  spark?: number[];
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="card flex min-w-0 flex-col justify-between gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium leading-tight text-ink-2">
          {icon}
          {label}
        </span>
        {delta !== undefined && (
          <span className="shrink-0">
            <Delta value={delta} good={good} />
          </span>
        )}
      </div>
      <div className="whitespace-nowrap text-[24px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
      {spark && spark.length > 1 && <FluidSparkline values={spark} />}
      {hint && <div className="truncate text-[12px] text-muted">{hint}</div>}
    </div>
  );
}
