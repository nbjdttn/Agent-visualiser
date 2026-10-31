import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy';
import { useCallback, useMemo, useState } from 'react';
import { PROVIDER_LABEL, type Provider } from '../../../shared/types';
import { PROVIDER_COLOR } from '../../lib/colors';
import { pct } from '../../lib/format';
import { useWidth } from '../../lib/useSize';
import { leaveIfMouse, useTapAway } from '../../lib/useTouch';
import { ChartTooltip, TooltipRow, TooltipTitle } from './Tooltip';

export interface TreemapProject {
  key: string;
  name: string;
  path?: string;
  parts: { provider: Provider; value: number }[];
}

interface Node {
  name: string;
  key: string;
  path?: string;
  provider?: Provider;
  value?: number;
  children?: Node[];
}

/**
 * Where the tokens went: one block per project, split into its providers.
 * Blocks are a tint of the provider colour with a solid edge, so large areas
 * stay quiet and labels stay in text colour.
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
  const [hover, setHover] = useState<{ leaf: HierarchyRectangularNode<Node>; x: number; y: number } | null>(null);
  const clearHover = useCallback(() => setHover(null), []);
  useTapAway(ref, hover !== null, clearHover);

  const root = useMemo(() => {
    if (!width) return undefined;
    const data: Node = {
      name: 'root',
      key: 'root',
      children: projects
        .filter((p) => p.parts.some((x) => x.value > 0))
        .map((p) => ({
          name: p.name,
          key: p.key,
          path: p.path,
          children: p.parts.filter((x) => x.value > 0).map((x) => ({ name: p.name, key: p.key, path: p.path, provider: x.provider, value: x.value })),
        })),
    };
    const h = hierarchy(data)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<Node>()
      .tile(treemapSquarify.ratio(1.3))
      .size([width, height])
      .paddingInner((n) => (n.depth === 0 ? 4 : 2))
      .round(true)(h);
  }, [projects, width, height]);

  const total = root?.value ?? 0;
  const groups = root?.children ?? [];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {root && (
        <svg width={width} height={height} role="img" aria-label="Tokens by project and provider" className="block">
          {groups.map((g) => {
            const leaves = g.leaves();
            const biggest = leaves.reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a));
            const bw = biggest.x1 - biggest.x0;
            const bh = biggest.y1 - biggest.y0;
            return (
              <g key={g.data.key} style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={() => onSelect?.(g.data.key)}>
                {leaves.map((leaf) => {
                  const w = leaf.x1 - leaf.x0;
                  const h = leaf.y1 - leaf.y0;
                  const color = PROVIDER_COLOR[leaf.data.provider!];
                  const isHover = hover?.leaf === leaf;
                  return (
                    <g
                      key={leaf.data.provider}
                      onPointerEnter={() => setHover({ leaf, x: leaf.x0 + w / 2, y: leaf.y0 + Math.min(h / 2, 40) })}
                      onPointerLeave={leaveIfMouse(clearHover)}
                    >
                      <rect
                        x={leaf.x0}
                        y={leaf.y0}
                        width={w}
                        height={h}
                        rx={6}
                        style={{
                          fill: `color-mix(in srgb, ${color} ${isHover ? 36 : 24}%, var(--surface))`,
                          transition: 'fill 120ms ease',
                        }}
                      />
                      <rect x={leaf.x0} y={leaf.y0} width={Math.min(3, w)} height={h} rx={1.5} style={{ fill: color }} />
                    </g>
                  );
                })}
                {bw > 64 && bh > 36 && (
                  <g pointerEvents="none">
                    <text x={biggest.x0 + 12} y={biggest.y0 + 20} style={{ fill: 'var(--text)', fontSize: 12.5, fontWeight: 600 }}>
                      {truncate(g.data.name, Math.floor((bw - 20) / 7))}
                    </text>
                    {bh > 52 && (
                      <text x={biggest.x0 + 12} y={biggest.y0 + 37} className="tnum" style={{ fill: 'var(--text-2)', fontSize: 11.5 }}>
                        {fitLine([`${format(g.value ?? 0)} · ${pct((g.value ?? 0) / (total || 1))}`, format(g.value ?? 0)], bw - 20)}
                      </text>
                    )}
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover && (
        <ChartTooltip x={hover.x} y={hover.y} containerWidth={width}>
          <TooltipTitle>
            {hover.leaf.data.name}
            {hover.leaf.data.path ? <span className="block font-normal">{hover.leaf.data.path}</span> : null}
          </TooltipTitle>
          {(hover.leaf.parent?.children ?? []).map((c) => (
            <TooltipRow
              key={c.data.provider}
              color={PROVIDER_COLOR[c.data.provider!]}
              label={PROVIDER_LABEL[c.data.provider!]}
              value={format(c.value ?? 0)}
            />
          ))}
          <div className="mt-1 text-[11px] text-muted">{pct((hover.leaf.parent?.value ?? 0) / (total || 1), 1)} of all tokens</div>
        </ChartTooltip>
      )}
    </div>
  );
}

/** The longest candidate that fits the width (about 6.6px per character), or nothing. */
function fitLine(candidates: string[], width: number): string {
  return candidates.find((c) => c.length * 6.6 <= width) ?? '';
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}
