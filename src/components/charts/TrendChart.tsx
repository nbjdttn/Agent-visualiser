import { scaleLinear } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { useCallback, useId, useState, type PointerEvent } from 'react';
import { useWidth } from '../../lib/useSize';
import { leaveIfMouse, useTapAway } from '../../lib/useTouch';
import { ChartTooltip, TooltipRow, TooltipTitle } from './Tooltip';

export interface TrendLine {
  label: string;
  values: number[];
  color: string;
  /** Fill under the line with a soft fade (default true for the first line only). */
  wash?: boolean;
}

/**
 * Lines over time, drawn from one baseline (not stacked): 2px lines, each
 * with a soft fading wash, an end dot on the latest value, and a crosshair
 * with every value on hover or tap.
 */
export function TrendChart({
  labels,
  lines,
  height = 120,
  format,
  axis = false,
  ariaLabel,
}: {
  labels: string[];
  lines: TrendLine[];
  height?: number;
  format: (v: number) => string;
  /** Draw y gridlines with values and the first/last x label. */
  axis?: boolean;
  ariaLabel: string;
}) {
  const uid = useId().replace(/:/g, '');
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const clear = useCallback(() => setActive(null), []);
  useTapAway(ref, active !== null, clear);

  const n = labels.length;
  const M = axis ? { top: 10, right: 8, bottom: 20, left: 44 } : { top: 8, right: 8, bottom: 4, left: 8 };
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = Math.max(0, height - M.top - M.bottom);
  const max = Math.max(0, ...lines.flatMap((l) => l.values));
  const y = scaleLinear().domain([0, max || 1]).nice(3).range([plotH, 0]);
  const x = (i: number) => (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const shapes = lines.map((l, k) => {
    const pts = l.values.map((v, i) => [x(i), y(v)] as [number, number]);
    return {
      l,
      pts,
      path: line().curve(curveMonotoneX)(pts) ?? '',
      wash: (l.wash ?? k === 0) ? (area().curve(curveMonotoneX).y0(plotH)(pts) ?? '') : '',
    };
  });

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    if (n < 1 || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - M.left) / plotW) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  };
  const topAt = (i: number) => Math.min(...shapes.map((s) => s.pts[i]?.[1] ?? plotH));

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && n > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          <defs>
            {shapes.map((s, k) => (
              <linearGradient key={k} id={`${uid}w${k}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.l.color} stopOpacity={0.28} />
                <stop offset="1" stopColor={s.l.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            {axis &&
              y.ticks(3).map((t) => (
                <g key={t} transform={`translate(0,${y(t)})`}>
                  <line x1={0} x2={plotW} style={{ stroke: 'var(--grid)' }} strokeWidth={1} />
                  <text x={-8} dy="0.32em" textAnchor="end" className="tnum" style={{ fill: 'var(--muted)', fontSize: 12 }}>
                    {format(t)}
                  </text>
                </g>
              ))}
            {axis && n > 1 && (
              <>
                <text x={0} y={plotH + 15} style={{ fill: 'var(--muted)', fontSize: 12 }}>
                  {labels[0]}
                </text>
                <text x={plotW} y={plotH + 15} textAnchor="end" style={{ fill: 'var(--muted)', fontSize: 12 }}>
                  {labels[n - 1]}
                </text>
              </>
            )}
            {shapes.map((s, k) => s.wash && <path key={`w${k}`} d={s.wash} fill={`url(#${uid}w${k})`} />)}
            {[...shapes].reverse().map((s, k) => (
              <path key={`l${k}`} d={s.path} fill="none" style={{ stroke: s.l.color }} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {active === null &&
              shapes.map((s, k) => {
                const last = s.pts[s.pts.length - 1];
                return last ? <circle key={`e${k}`} cx={last[0]} cy={last[1]} r={4} style={{ fill: s.l.color, stroke: 'var(--surface)' }} strokeWidth={2} /> : null;
              })}
            {active !== null && (
              <g pointerEvents="none">
                <line x1={x(active)} x2={x(active)} y1={0} y2={plotH} style={{ stroke: 'var(--border-strong)' }} strokeWidth={1} />
                {shapes.map((s, k) =>
                  s.pts[active] ? (
                    <circle key={`a${k}`} cx={s.pts[active][0]} cy={s.pts[active][1]} r={4.5} style={{ fill: s.l.color, stroke: 'var(--surface)' }} strokeWidth={2} />
                  ) : null,
                )}
              </g>
            )}
            <rect
              x={-M.left}
              y={-M.top}
              width={plotW + M.left + M.right}
              height={height}
              fill="transparent"
              style={{ touchAction: 'pan-y' }}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={leaveIfMouse(clear)}
            />
          </g>
        </svg>
      )}
      {active !== null && width > 0 && (
        <ChartTooltip x={M.left + x(active)} y={M.top + topAt(active)} containerWidth={width}>
          <TooltipTitle>{labels[active]}</TooltipTitle>
          {shapes.map((s, k) => (
            <TooltipRow key={k} color={s.l.color} label={s.l.label} value={format(s.l.values[active] ?? 0)} strong={k === 0} />
          ))}
        </ChartTooltip>
      )}
    </div>
  );
}
