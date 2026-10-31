import clsx from 'clsx';
import type { SeriesDef } from '../../lib/data';

/**
 * Legend for two or more series. Clicking an item isolates that series;
 * clicking it again shows everything.
 */
export function Legend({
  series,
  hidden,
  onChange,
  shape = 'rect',
  values,
}: {
  series: SeriesDef[];
  hidden: Set<string>;
  onChange: (hidden: Set<string>) => void;
  shape?: 'rect' | 'line';
  values?: string[];
}) {
  if (series.length < 2) return null;
  const isolated = series.length - hidden.size === 1 ? series.find((s) => !hidden.has(s.key))?.key : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" role="list" aria-label="Legend">
      {series.map((s, i) => {
        const off = hidden.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            role="listitem"
            aria-pressed={!off}
            title={isolated === s.key ? 'Show all series' : `Show only ${s.label}`}
            onClick={() => {
              if (isolated === s.key) onChange(new Set());
              else onChange(new Set(series.filter((x) => x.key !== s.key).map((x) => x.key)));
            }}
            className={clsx(
              'group inline-flex items-center gap-1.5 rounded-md text-[12px] transition-opacity',
              off ? 'opacity-40 hover:opacity-70' : 'opacity-100',
            )}
          >
            {shape === 'line' ? (
              <span aria-hidden className="inline-block h-[2px] w-3 rounded" style={{ background: s.color }} />
            ) : (
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
            )}
            <span className="max-w-[180px] truncate text-ink-2 group-hover:text-ink">{s.label}</span>
            {values?.[i] && <span className="tnum font-medium text-ink">{values[i]}</span>}
          </button>
        );
      })}
    </div>
  );
}
