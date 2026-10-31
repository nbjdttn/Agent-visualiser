import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { useCallback, useMemo, useState } from 'react';
import { PROVIDER_LABEL, type Provider } from '../../../shared/types';
import { inkOn, PROVIDER_COLOR } from '../../lib/colors';
import { pct } from '../../lib/format';
import { useWidth } from '../../lib/useSize';
import { leaveIfMouse, useTapAway } from '../../lib/useTouch';
import { ChartTooltip, TooltipRow, TooltipTitle } from './Tooltip';

export interface TreemapProject {
  key: string;
  name: string;
  path?: string;
  /** The project's own colour (it follows the project across charts). */
  color: string;
  parts: { provider: Provider; value: number }[];
  /** The small projects grouped together: a quiet outlined band along the bottom. */
  rest?: boolean;
}

interface Tile extends TreemapProject {
  value: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Node {
  key: string;
  item?: TreemapProject & { value: number };
  value?: number;
  children?: Node[];
}

const GAP = 3;

/**
 * Where the tokens went: one solid block per project in its own colour,
 * name and amount printed inside when they fit. The small projects share one
 * quiet outlined band along the bottom, sized to their share. Tap a block for
 * its Claude / OpenAI split.
 */
export function Treemap({
  projects,
  height = 340,
  format,
  onSelect,
}: {
  projects: TreemapProject[];
  height?: number;
  format: (v: number) => string;
  onSelect?: (key: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ tile: Tile; x: number; y: number } | null>(null);
  const clearHover = useCallback(() => setHover(null), []);
  useTapAway(ref, hover !== null, clearHover);

  const { tiles, total } = useMemo(() => layout(projects, width, height), [projects, width, height]);

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Tokens by project" className="block">
          {tiles.map((t) => {
            const w = t.x1 - t.x0;
            const h = t.y1 - t.y0;
            const isHover = hover?.tile.key === t.key;
            const rx = Math.min(12, w / 4, h / 4);
            const amount = `${format(t.value)} · ${pct(t.value / (total || 1))}`;
            return (
              <g
                key={t.key}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
                onClick={() => onSelect?.(t.key)}
                onPointerEnter={() => setHover({ tile: t, x: t.x0 + w / 2, y: t.y0 + Math.min(h / 2, 44) })}
                onPointerLeave={leaveIfMouse(clearHover)}
              >
                {t.rest ? (
                  <>
                    <rect
                      x={t.x0 + 0.75}
                      y={t.y0 + 0.75}
                      width={Math.max(0, w - 1.5)}
                      height={Math.max(0, h - 1.5)}
                      rx={rx}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                      style={{ fill: isHover ? 'var(--surface-3)' : 'var(--surface-2)', stroke: 'var(--border-strong)', transition: 'fill 120ms ease' }}
                    />
                    <RestLabel tile={t} amount={amount} format={format} />
                  </>
                ) : (
                  <>
                    <rect x={t.x0} y={t.y0} width={w} height={h} rx={rx} style={{ fill: t.color, opacity: isHover ? 0.86 : 1, transition: 'opacity 120ms ease' }} />
                    <BlockLabel tile={t} amount={amount} format={format} />
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover && (
        <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
          <TooltipTitle>
            {hover.tile.name}
            {hover.tile.path ? <span className="block font-normal">{hover.tile.path}</span> : null}
          </TooltipTitle>
          {hover.tile.parts
            .filter((p) => p.value > 0)
            .map((p) => (
              <TooltipRow key={p.provider} color={PROVIDER_COLOR[p.provider]} label={PROVIDER_LABEL[p.provider]} value={format(p.value)} />
            ))}
          <div className="mt-1 text-[11px] text-muted">{pct(hover.tile.value / (total || 1), 1)} of all tokens</div>
        </ChartTooltip>
      )}
    </div>
  );
}

/** Named projects squarified above; the grouped small ones as a full-width band below. */
function layout(projects: TreemapProject[], width: number, height: number): { tiles: Tile[]; total: number } {
  if (!width) return { tiles: [], total: 0 };
  const items = projects.map((p) => ({ ...p, value: p.parts.reduce((a, x) => a + x.value, 0) })).filter((p) => p.value > 0);
  const total = items.reduce((a, p) => a + p.value, 0);
  const rest = items.find((p) => p.rest);
  const named = items.filter((p) => !p.rest);

  let bandH = rest && total ? Math.max(6, Math.round((height * rest.value) / total)) : 0;
  if (!named.length) bandH = height;
  const topH = named.length ? Math.max(0, height - bandH - (bandH ? GAP : 0)) : 0;

  const tiles: Tile[] = [];
  if (named.length && topH > 0) {
    const root = hierarchy<Node>({ key: 'root', children: named.map((p) => ({ key: p.key, item: p, value: p.value })) })
      .sum((d) => (d.children ? 0 : (d.value ?? 0)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laid = treemap<Node>().tile(treemapSquarify.ratio(1.2)).size([width, topH]).paddingInner(GAP).round(true)(root);
    for (const leaf of laid.leaves()) {
      if (leaf.data.item) tiles.push({ ...leaf.data.item, x0: leaf.x0, y0: leaf.y0, x1: leaf.x1, y1: leaf.y1 });
    }
  }
  if (rest && bandH) tiles.push({ ...rest, x0: 0, y0: height - bandH, x1: width, y1: height });
  return { tiles, total };
}

function BlockLabel({ tile: t, amount, format }: { tile: Tile; amount: string; format: (v: number) => string }) {
  const w = t.x1 - t.x0;
  const h = t.y1 - t.y0;
  const nameChars = Math.floor((w - 22) / 8);
  if (!(w > 58 && h > 38 && nameChars >= 3)) return null;
  const ink = inkOn(t.color);
  return (
    <g pointerEvents="none">
      <text x={t.x0 + 11} y={t.y0 + 23} style={{ fill: ink, fontSize: 14.5, fontWeight: 650 }}>
        {truncate(t.name, nameChars)}
      </text>
      {h > 58 && (
        <text x={t.x0 + 11} y={t.y0 + 42} className="tnum" style={{ fill: ink, opacity: 0.85, fontSize: 13 }}>
          {fitLine([amount, format(t.value)], w - 22)}
        </text>
      )}
    </g>
  );
}

/** The grouped band: name and amount on two lines when it's tall, on one when it's short, with a chevron to the full list. */
function RestLabel({ tile: t, amount, format }: { tile: Tile; amount: string; format: (v: number) => string }) {
  const w = t.x1 - t.x0;
  const h = t.y1 - t.y0;
  if (h < 26 || w < 80) return null;
  const chevron = w > 140;
  const room = w - 22 - (chevron ? 18 : 0);
  if (h > 58) {
    return (
      <g pointerEvents="none">
        <text x={t.x0 + 11} y={t.y0 + 23} style={{ fill: 'var(--text-2)', fontSize: 14.5, fontWeight: 650 }}>
          {truncate(t.name, Math.floor(room / 8))}
        </text>
        <text x={t.x0 + 11} y={t.y0 + 42} className="tnum" style={{ fill: 'var(--muted)', fontSize: 13 }}>
          {fitLine([amount, format(t.value)], room)}
        </text>
        {chevron && <Chevron x={t.x1 - 12} y={t.y0 + 23} />}
      </g>
    );
  }
  const mid = t.y0 + h / 2 + 5;
  return (
    <g pointerEvents="none">
      <text x={t.x0 + 11} y={mid} className="tnum" style={{ fill: 'var(--text-2)', fontSize: 14, fontWeight: 600 }}>
        {fitLine([`${t.name} · ${amount}`, `${t.name} · ${format(t.value)}`, t.name], room)}
      </text>
      {chevron && <Chevron x={t.x1 - 12} y={mid} />}
    </g>
  );
}

function Chevron({ x, y }: { x: number; y: number }) {
  return (
    <text x={x} y={y} textAnchor="end" style={{ fill: 'var(--muted)', fontSize: 18, fontWeight: 500 }}>
      ›
    </text>
  );
}

/** The longest candidate that fits the width (about 7.4px per character at 13px), or nothing. */
function fitLine(candidates: string[], width: number): string {
  return candidates.find((c) => c.length * 7.4 <= width) ?? '';
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}
