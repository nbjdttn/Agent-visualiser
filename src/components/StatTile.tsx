import type { ReactNode } from 'react';
import { Sparkline } from './charts/Sparkline';
import { Delta } from './ui';

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
      <div className="flex items-end justify-between gap-3">
        <div className="whitespace-nowrap text-[24px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
        {spark && spark.length > 1 && (
          <div className="hidden shrink-0 sm:block">
            <Sparkline values={spark} width={84} height={28} />
          </div>
        )}
      </div>
      {hint && <div className="truncate text-[12px] text-muted">{hint}</div>}
    </div>
  );
}
