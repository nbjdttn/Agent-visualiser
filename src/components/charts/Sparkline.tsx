import { area, curveMonotoneX, line } from 'd3-shape';

/** A compact trend line: muted ink for the run, an accent dot on the latest value. */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  color = 'var(--muted)',
  accent = 'var(--focus)',
  fill = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  accent?: string;
  fill?: boolean;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const max = Math.max(...values, 0) || 1;
  const pad = 4;
  const xs = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const ys = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const pts = values.map((v, i) => [xs(i), ys(v)] as [number, number]);
  const path = line().curve(curveMonotoneX)(pts) ?? '';
  const wash = area().curve(curveMonotoneX).y0(height - pad)(pts) ?? '';
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden className="block overflow-visible">
      {fill && <path d={wash} style={{ fill: accent, opacity: 0.08 }} />}
      <path d={path} fill="none" style={{ stroke: color }} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3.5} style={{ fill: accent, stroke: 'var(--surface)' }} strokeWidth={2} />
    </svg>
  );
}
