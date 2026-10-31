import clsx from 'clsx';
import { useState, type ReactNode } from 'react';

export interface BarItem {
  key: string;
  label: ReactNode;
  title?: string;
  sublabel?: ReactNode;
  value: number;
  display: string;
  secondary?: string;
  color: string;
  /** Optional split of the bar (e.g. by provider), drawn inside its length. */
  segments?: { value: number; color: string; label: string }[];
  icon?: ReactNode;
  active?: boolean;
}

/**
 * Ranked horizontal bars: one baseline, largest first, value at the tip.
 * Rows are buttons when `onSelect` is given (used for cross-filtering).
 */
export function BarList({
  items,
  onSelect,
  limit = 8,
  emptyLabel = 'Nothing to show',
}: {
  items: BarItem[];
  onSelect?: (key: string) => void;
  limit?: number;
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return <p className="py-6 text-center text-[13px] text-muted">{emptyLabel}</p>;
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  const shown = expanded ? items : items.slice(0, limit);
  return (
    <div>
      <ul className="flex flex-col gap-0.5">
        {shown.map((item) => {
          const inner = (
            <>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  {item.icon}
                  <span className="truncate text-[15px] font-medium text-ink lg:text-[13px]" title={item.title}>
                    {item.label}
                  </span>
                  {item.sublabel && <span className="hidden truncate text-[12px] text-muted sm:inline">{item.sublabel}</span>}
                </div>
                <div className="flex shrink-0 items-baseline gap-2">
                  {item.secondary && <span className="tnum text-[13px] text-muted lg:text-[12px]">{item.secondary}</span>}
                  <span className="tnum text-[15px] font-semibold text-ink lg:text-[13px]">{item.display}</span>
                </div>
              </div>
              <div className="mt-2 h-[8px] w-full rounded-full bg-surface-2 lg:mt-1.5 lg:h-[6px]">
                {item.segments && item.segments.filter((s) => s.value > 0).length > 1 ? (
                  <div
                    className="flex h-full gap-[2px] transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.max(0.6, (item.value / max) * 100)}%` }}
                    title={item.segments.map((s) => `${s.label}: ${Math.round((s.value / (item.value || 1)) * 100)}%`).join(' · ')}
                  >
                    {item.segments
                      .filter((s) => s.value > 0)
                      .map((s) => (
                        <div
                          key={s.label}
                          className="h-full rounded-full"
                          style={{ flexGrow: s.value, flexBasis: 0, minWidth: 3, background: s.color }}
                        />
                      ))}
                  </div>
                ) : (
                  <div
                    className="h-full rounded-full transition-[width] duration-500 ease-out"
                    style={{
                      width: `${Math.max(0.6, (item.value / max) * 100)}%`,
                      background: item.segments?.find((s) => s.value > 0)?.color ?? item.color,
                    }}
                  />
                )}
              </div>
            </>
          );
          return (
            <li key={item.key}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(item.key)}
                  aria-pressed={item.active}
                  className={clsx(
                    'w-full rounded-[12px] px-2.5 py-2.5 text-left transition-colors hover:bg-surface-2 lg:py-2',
                    item.active && 'bg-surface-2 ring-1 ring-line-strong',
                  )}
                >
                  {inner}
                </button>
              ) : (
                <div className="px-2.5 py-2">{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 px-2.5 py-2 text-[14px] font-medium text-ink-2 hover:text-ink lg:py-0 lg:text-[12px]"
        >
          {expanded ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
