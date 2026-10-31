import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { SEQ } from '../../lib/colors';
import { dayLabel, hourLabel, shortMonth } from '../../lib/format';
import { DAY_MS, weekStart, weekdayMon } from '../../lib/time';
import { useWidth } from '../../lib/useSize';
import { leaveIfMouse, useTapAway } from '../../lib/useTouch';
import { ChartTooltip, TooltipRow, TooltipTitle } from './Tooltip';

/** Quantile buckets over non-zero values -> level 1..6; 0 means no activity. */
export function quantileLevels(values: number[], levels = 6): (v: number) => number {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const cuts: number[] = [];
  for (let i = 1; i < levels; i++) cuts.push(nz[Math.floor((i / levels) * (nz.length - 1))]);
  return (v) => (v <= 0 ? 0 : 1 + cuts.filter((c) => v > c).length);
}

export function ScaleLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted" aria-hidden>
      <span>Less</span>
      {SEQ.map((c) => (
        <span key={c} className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />
      ))}
      <span>More</span>
    </div>
  );
}

const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarHeatmap(props: {
  from: number;
  to: number;
  values: Map<number, number>;
  format: (v: number) => string;
  details?: (day: number) => ReactNode;
  onSelectDay?: (day: number) => void;
}) {
  const weeks = Math.floor((weekStart(props.to) - weekStart(props.from)) / 7) + 1;
  return weeks <= 10 ? <MonthGrid {...props} weeks={weeks} /> : <YearStrip {...props} weeks={weeks} />;
}

/** Short ranges read best as a familiar calendar: weekdays across, weeks down. */
function MonthGrid({
  from,
  to,
  values,
  format,
  details,
  onSelectDay,
  weeks,
}: {
  from: number;
  to: number;
  values: Map<number, number>;
  format: (v: number) => string;
  details?: (day: number) => ReactNode;
  onSelectDay?: (day: number) => void;
  weeks: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ day: number; x: number; y: number } | null>(null);
  const clearHover = useCallback(() => setHover(null), []);
  useTapAway(ref, hover !== null, clearHover);
  const first = weekStart(from);
  const gap = 4;
  const top = 20;
  const cellW = Math.max(18, (width - gap * 6) / 7);
  const cellH = Math.max(26, Math.min(40, cellW * 0.5));
  const height = top + weeks * (cellH + gap);
  const level = useMemo(() => quantileLevels([...values.values()]), [values]);
  const cells: { day: number; col: number; row: number }[] = [];
  for (let d = from; d <= to; d++) cells.push({ day: d, col: weekdayMon(d), row: Math.floor((weekStart(d) - first) / 7) });
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Daily activity calendar" className="block">
          {WEEKDAY_SHORT.map((d, i) => (
            <text key={d} x={i * (cellW + gap) + 2} y={12} style={{ fill: 'var(--muted)', fontSize: 12 }}>
              {d}
            </text>
          ))}
          {cells.map((c) => {
            const v = values.get(c.day) ?? 0;
            const lv = level(v);
            const x = c.col * (cellW + gap);
            const y = top + c.row * (cellH + gap);
            const date = new Date(c.day * DAY_MS);
            const dom = date.getUTCDate();
            const isHover = hover?.day === c.day;
            return (
              <g
                key={c.day}
                onPointerEnter={() => setHover({ day: c.day, x: x + cellW / 2, y: y + cellH / 2 })}
                onPointerLeave={leaveIfMouse(clearHover)}
                onClick={() => onSelectDay?.(c.day)}
                style={{ cursor: onSelectDay ? 'pointer' : 'default' }}
              >
                <rect
                  x={x}
                  y={y}
                  width={cellW}
                  height={cellH}
                  rx={6}
                  style={{ fill: SEQ[lv], stroke: isHover ? 'var(--text)' : 'transparent', strokeWidth: 1.5 }}
                />
                <text x={x + 7} y={y + 15} className="tnum" style={{ fill: `var(--seq-ink-${lv})`, fontSize: 11, fontWeight: 500 }}>
                  {dom === 1 || c.day === from ? `${shortMonth(c.day)} ${dom}` : dom}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && (
        <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
          <TooltipTitle>{dayLabel(hover.day, { weekday: true, year: true })}</TooltipTitle>
          <TooltipRow color="var(--seq-4)" label="tokens" value={format(values.get(hover.day) ?? 0)} />
          {details?.(hover.day)}
        </ChartTooltip>
      )}
    </div>
  );
}

/** Long ranges: one column per week, GitHub style. */
function YearStrip({
  from,
  to,
  values,
  format,
  details,
  onSelectDay,
  weeks,
}: {
  from: number;
  to: number;
  values: Map<number, number>;
  format: (v: number) => string;
  details?: (day: number) => ReactNode;
  onSelectDay?: (day: number) => void;
  weeks: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ day: number; x: number; y: number } | null>(null);
  const clearHover = useCallback(() => setHover(null), []);
  useTapAway(ref, hover !== null, clearHover);
  const first = weekStart(from);
  const left = 30;
  const top = 18;
  const gap = 3;
  const cell = Math.max(8, Math.min(18, Math.floor((width - left) / weeks) - gap));
  const step = cell + gap;
  const height = top + 7 * step;
  const level = useMemo(() => quantileLevels([...values.values()]), [values]);

  const cells: { day: number; col: number; row: number }[] = [];
  for (let d = from; d <= to; d++) cells.push({ day: d, col: Math.floor((weekStart(d) - first) / 7), row: weekdayMon(d) });

  const monthMarks: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let c = 0; c < weeks; c++) {
    const day = Math.max(from, first + c * 7);
    const m = new Date(day * DAY_MS).getUTCMonth();
    if (m !== lastMonth) {
      if (!monthMarks.length || c - monthMarks[monthMarks.length - 1].col >= 3) monthMarks.push({ col: c, label: shortMonth(day) });
      lastMonth = m;
    }
  }

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Daily activity calendar" className="block">
          {monthMarks.map((m) => (
            <text key={m.col} x={left + m.col * step} y={11} style={{ fill: 'var(--muted)', fontSize: 12 }}>
              {m.label}
            </text>
          ))}
          {[0, 2, 4].map((r) => (
            <text key={r} x={0} y={top + r * step + cell / 2} dy="0.32em" style={{ fill: 'var(--muted)', fontSize: 12 }}>
              {WEEKDAY_SHORT[r]}
            </text>
          ))}
          {cells.map((c) => {
            const v = values.get(c.day) ?? 0;
            const x = left + c.col * step;
            const y = top + c.row * step;
            const isHover = hover?.day === c.day;
            return (
              <rect
                key={c.day}
                x={x}
                y={y}
                width={cell}
                height={cell}
                rx={Math.min(4, cell / 4)}
                tabIndex={-1}
                style={{
                  fill: SEQ[level(v)],
                  stroke: isHover ? 'var(--text)' : 'transparent',
                  strokeWidth: 1.5,
                  cursor: onSelectDay ? 'pointer' : 'default',
                }}
                onPointerEnter={() => setHover({ day: c.day, x: x + cell / 2, y: y + cell / 2 })}
                onPointerLeave={leaveIfMouse(clearHover)}
                onClick={() => onSelectDay?.(c.day)}
              />
            );
          })}
        </svg>
      )}
      {hover && (
        <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
          <TooltipTitle>{dayLabel(hover.day, { weekday: true, year: true })}</TooltipTitle>
          <TooltipRow color="var(--seq-4)" label="tokens" value={format(values.get(hover.day) ?? 0)} />
          {details?.(hover.day)}
        </ChartTooltip>
      )}
    </div>
  );
}

const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21];

export function HourHeatmap({ matrix, format }: { matrix: number[][]; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const clearHover = useCallback(() => setHover(null), []);
  useTapAway(ref, hover !== null, clearHover);
  const left = 34;
  const gap = 3;
  const cellW = Math.max(6, (width - left) / 24 - gap);
  const cellH = Math.max(14, Math.min(22, cellW));
  const height = 7 * (cellH + gap) + 18;
  const level = useMemo(() => quantileLevels(matrix.flat()), [matrix]);
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Activity by weekday and hour" className="block">
          {WEEKDAY_SHORT.map((d, r) => (
            <text key={d} x={0} y={r * (cellH + gap) + cellH / 2} dy="0.32em" style={{ fill: 'var(--muted)', fontSize: 12 }}>
              {d}
            </text>
          ))}
          {matrix.map((row, r) =>
            row.map((v, c) => {
              const x = left + c * (cellW + gap);
              const y = r * (cellH + gap);
              const isHover = hover?.r === r && hover?.c === c;
              return (
                <rect
                  key={`${r}-${c}`}
                  x={x}
                  y={y}
                  width={cellW}
                  height={cellH}
                  rx={3}
                  style={{ fill: SEQ[level(v)], stroke: isHover ? 'var(--text)' : 'transparent', strokeWidth: 1.5 }}
                  onPointerEnter={() => setHover({ r, c, x: x + cellW / 2, y: y + cellH / 2 })}
                  onPointerLeave={leaveIfMouse(clearHover)}
                />
              );
            }),
          )}
          {HOUR_TICKS.map((h) => (
            <text
              key={h}
              x={left + h * (cellW + gap)}
              y={7 * (cellH + gap) + 12}
              style={{ fill: 'var(--muted)', fontSize: 12 }}
            >
              {hourLabel(h)}
            </text>
          ))}
        </svg>
      )}
      {hover && (
        <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
          <TooltipTitle>
            {WEEKDAY_SHORT[hover.r]}s, {hourLabel(hover.c)}–{hourLabel((hover.c + 1) % 24)}
          </TooltipTitle>
          <TooltipRow color="var(--seq-4)" label="tokens" value={format(matrix[hover.r][hover.c])} />
        </ChartTooltip>
      )}
    </div>
  );
}
