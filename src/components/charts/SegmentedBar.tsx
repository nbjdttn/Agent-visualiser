import { useCallback, useState } from 'react';
import { inkOn } from '../../lib/colors';
import { pct } from '../../lib/format';
import { useWidth } from '../../lib/useSize';
import { leaveIfMouse, useTapAway } from '../../lib/useTouch';
import { ChartTooltip, TooltipRow } from './Tooltip';

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  display?: string;
}

/**
 * One whole split into parts. Tall (28px) prints each share inside its block
 * when it fits; thin (8px) prints nothing and leans on the text beside it.
 */
export function SegmentedBar({
  parts,
  variant = 'tall',
  legend = true,
  ariaLabel,
}: {
  parts: Part[];
  variant?: 'tall' | 'thin';
  legend?: boolean;
  ariaLabel?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const clearHover = useCallback(() => setHover(null), []);
  useTapAway(ref, hover !== null, clearHover);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const visible = parts.filter((p) => p.value > 0);
  const gap = 2;
  const h = variant === 'tall' ? 28 : 8;
  const usable = Math.max(0, width - gap * Math.max(0, visible.length - 1));
  let x = 0;
  const blocks = visible.map((p) => {
    const w = total ? (p.value / total) * usable : 0;
    const b = { ...p, x, w, share: total ? p.value / total : 0 };
    x += w + gap;
    return b;
  });
  const label = ariaLabel ?? parts.map((p) => `${p.label} ${pct(total ? p.value / total : 0)}`).join(', ');

  return (
    <div>
      <div ref={ref} className="relative" style={{ height: h }} role="img" aria-label={label}>
        {total === 0 && <div className="h-full w-full rounded-full bg-surface-2" />}
        {blocks.map((b, i) => {
          const text = pct(b.share);
          const fits = variant === 'tall' && b.w > text.length * 7 + 14;
          return (
            <div
              key={b.key}
              className="absolute top-0 flex items-center overflow-hidden"
              style={{
                left: b.x,
                width: Math.max(b.w, 2),
                height: h,
                background: b.color,
                borderRadius: variant === 'tall' ? 4 : 9999,
                opacity: hover && hover.i !== i ? 0.75 : 1,
              }}
              onPointerEnter={() => setHover({ i, x: b.x + b.w / 2 })}
              onPointerLeave={leaveIfMouse(clearHover)}
            >
              {fits && (
                <span className="tnum pl-2 text-[12px] font-semibold" style={{ color: inkOn(b.color) }}>
                  {text}
                </span>
              )}
            </div>
          );
        })}
        {hover && blocks[hover.i] && (
          <ChartTooltip x={hover.x} y={h / 2} containerWidth={width}>
            <TooltipRow
              color={blocks[hover.i].color}
              label={blocks[hover.i].label}
              value={`${blocks[hover.i].display ?? ''} ${pct(blocks[hover.i].share, 1)}`.trim()}
            />
          </ChartTooltip>
        )}
      </div>
      {legend && visible.length > 1 && (
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
          {visible.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: p.color }} />
              {p.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
