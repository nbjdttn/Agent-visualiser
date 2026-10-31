import { scaleBand, scaleLinear } from 'd3-scale';
import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape';
import { useCallback, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Bucket, SeriesDef } from '../../lib/data';
import { useWidth } from '../../lib/useSize';
import { leaveIfMouse, useTapAway } from '../../lib/useTouch';
import { ChartTooltip, TooltipRow, TooltipTitle } from './Tooltip';

interface Props {
  buckets: Bucket[];
  series: SeriesDef[];
  kind: 'bar' | 'area';
  height?: number;
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  /** Series keys hidden by the legend. */
  hidden?: Set<string>;
  emptyLabel?: string;
}

const M = { top: 18, right: 8, bottom: 26, left: 48 };

/** Rounded top corners, square base: the 4px data-end spec for bars. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function TimeSeriesChart({ buckets, series, kind, height = 260, format, axisFormat, hidden, emptyLabel }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [pointerY, setPointerY] = useState(0);
  const clearActive = useCallback(() => setActive(null), []);
  useTapAway(ref, active !== null, clearActive);

  const visible = useMemo(() => series.map((s) => !hidden?.has(s.key)), [series, hidden]);
  const totals = useMemo(
    () => buckets.map((b) => b.values.reduce((sum, v, i) => sum + (visible[i] ? v : 0), 0)),
    [buckets, visible],
  );
  const max = Math.max(0, ...totals);
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;

  const x = useMemo(
    () =>
      scaleBand<number>()
        .domain(buckets.map((_, i) => i))
        .range([0, plotW])
        .paddingInner(kind === 'bar' ? 0.28 : 0)
        .paddingOuter(kind === 'bar' ? 0.14 : 0),
    [buckets, plotW, kind],
  );
  const y = useMemo(() => scaleLinear().domain([0, max || 1]).nice(4).range([plotH, 0]), [max, plotH]);
  const ticks = y.ticks(4);
  const tickFmt = axisFormat ?? format;

  // Cumulative stack per bucket, bottom (series 0) to top.
  const stacks = useMemo(
    () =>
      buckets.map((b) => {
        let acc = 0;
        return b.values.map((v, i) => {
          const lo = acc;
          if (visible[i]) acc += v;
          return [lo, acc] as [number, number];
        });
      }),
    [buckets, visible],
  );

  const center = (i: number) => (x(i) ?? 0) + x.bandwidth() / 2;
  const barW = Math.max(2, Math.min(24, x.bandwidth()));

  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 66))));
  const peak = totals.indexOf(max);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < buckets.length; i++) {
      const d = Math.abs(center(i) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setActive(best);
    setPointerY(e.clientY - rect.top + M.top);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!buckets.length) return;
    if (e.key === 'ArrowRight') setActive((a) => Math.min(buckets.length - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? buckets.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
    setPointerY(M.top + plotH / 3);
  };

  const areaPaths = useMemo(() => {
    if (kind !== 'area' || buckets.length === 0) return [];
    return series.map((_, si) => {
      if (!visible[si]) return null;
      const pts = buckets.map((_, bi) => ({ x: center(bi), lo: stacks[bi][si][0], hi: stacks[bi][si][1] }));
      const fill = d3area<(typeof pts)[number]>()
        .x((p) => p.x)
        .y0((p) => y(p.lo))
        .y1((p) => y(p.hi))
        .curve(curveMonotoneX)(pts);
      const edge = d3line<(typeof pts)[number]>()
        .x((p) => p.x)
        .y((p) => y(p.hi))
        .curve(curveMonotoneX)(pts);
      return { fill: fill ?? '', edge: edge ?? '' };
    });
  }, [kind, buckets, series, visible, stacks, y, x]);

  const empty = max === 0;

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height, touchAction: 'pan-y' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Usage over time chart" className="block overflow-visible">
          <g transform={`translate(${M.left},${M.top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line x1={0} x2={plotW} style={{ stroke: t === 0 ? 'var(--baseline)' : 'var(--grid)' }} strokeWidth={1} />
                <text x={-10} dy="0.32em" textAnchor="end" className="tnum" style={{ fill: 'var(--muted)', fontSize: 11 }}>
                  {tickFmt(t)}
                </text>
              </g>
            ))}

            {active !== null && kind === 'bar' && (
              <rect
                x={(x(active) ?? 0) - x.step() * x.paddingInner() / 2}
                y={0}
                width={x.step()}
                height={plotH}
                rx={6}
                style={{ fill: 'var(--surface-3)', opacity: 0.6 }}
              />
            )}

            {kind === 'bar' &&
              buckets.map((b, bi) => {
                const segs = b.values
                  .map((v, si) => ({ v, si }))
                  .filter(({ v, si }) => v > 0 && visible[si]);
                const cx = center(bi) - barW / 2;
                return (
                  <g key={b.start}>
                    {segs.map(({ si }, k) => {
                      const [lo, hi] = stacks[bi][si];
                      const top = y(hi);
                      const h = y(lo) - top;
                      const isTop = k === segs.length - 1;
                      const gap = !isTop && h > 3 ? 2 : 0;
                      const hh = Math.max(0.5, h - gap);
                      const yy = top + gap;
                      return isTop ? (
                        <path key={si} d={topRoundedRect(cx, yy, barW, hh, 4)} style={{ fill: series[si].color }} />
                      ) : (
                        <rect key={si} x={cx} y={yy} width={barW} height={hh} style={{ fill: series[si].color }} />
                      );
                    })}
                  </g>
                );
              })}

            {kind === 'area' &&
              areaPaths.map((p, si) =>
                p ? (
                  <g key={series[si].key}>
                    <path d={p.fill} style={{ fill: series[si].color, opacity: 0.14 }} />
                    <path
                      d={p.edge}
                      fill="none"
                      style={{ stroke: series[si].color }}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </g>
                ) : null,
              )}

            {kind === 'area' && active !== null && (
              <g>
                <line x1={center(active)} x2={center(active)} y1={0} y2={plotH} style={{ stroke: 'var(--baseline)' }} />
                {series.map((s, si) =>
                  visible[si] && buckets[active].values[si] > 0 ? (
                    <circle
                      key={s.key}
                      cx={center(active)}
                      cy={y(stacks[active][si][1])}
                      r={4}
                      style={{ fill: s.color, stroke: 'var(--surface)' }}
                      strokeWidth={2}
                    />
                  ) : null,
                )}
              </g>
            )}

            {!empty && peak >= 0 && active === null && buckets.length > 1 && (
              <text
                x={center(peak)}
                y={y(max) - 6}
                textAnchor={center(peak) > plotW - 30 ? 'end' : center(peak) < 30 ? 'start' : 'middle'}
                className="tnum"
                style={{ fill: 'var(--text-2)', fontSize: 11, fontWeight: 600 }}
              >
                {format(max)}
              </text>
            )}

            {buckets.map((b, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={b.start}
                  x={center(i)}
                  y={plotH + 17}
                  textAnchor={i === 0 && kind === 'area' ? 'start' : 'middle'}
                  style={{ fill: 'var(--muted)', fontSize: 11 }}
                >
                  {b.short}
                </text>
              ) : null,
            )}

            <rect
              x={0}
              y={0}
              width={plotW}
              height={plotH}
              fill="transparent"
              tabIndex={0}
              role="application"
              aria-label="Chart. Use left and right arrow keys to read values."
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={leaveIfMouse(clearActive)}
              onKeyDown={onKey}
              onBlur={() => setActive(null)}
              style={{ outline: 'none', cursor: 'crosshair' }}
            />
          </g>
        </svg>
      )}
      {empty && width > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-muted">
          {emptyLabel ?? 'No usage in this period'}
        </div>
      )}
      {active !== null && buckets[active] && (
        <ChartTooltip x={M.left + center(active)} y={pointerY} containerWidth={width}>
          <TooltipTitle>{buckets[active].label}</TooltipTitle>
          {series
            .map((s, si) => ({ s, si }))
            .filter(({ si }) => visible[si])
            .reverse()
            .map(({ s, si }) => (
              <TooltipRow key={s.key} color={s.color} label={s.label} value={format(buckets[active].values[si])} />
            ))}
          {series.filter((_, si) => visible[si]).length > 1 && (
            <div className="mt-1.5 border-t border-line pt-1.5">
              <TooltipRow label="Total" value={format(totals[active])} />
            </div>
          )}
        </ChartTooltip>
      )}
    </div>
  );
}
