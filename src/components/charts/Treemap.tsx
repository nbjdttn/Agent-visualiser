import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy';
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
}

interface Node {
  name: string;
  key: string;
  path?: string;
  color?: string;
  parts?: TreemapProject['parts'];
  value?: number;
  children?: Node[];
}

/**
 * Where the tokens went: one solid block per project in its own colour,
 * name and amount printed inside when they fit. Tap a block for its
 * Claude / OpenAI split.
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
        .map((p) => ({ name: p.name, key: p.key, path: p.path, color: p.color, parts: p.parts, value: p.parts.reduce((a, x) => a + x.value, 0) }))
        .filter((p) => p.value > 0),
    };
    const h = hierarchy(data)
      .sum((d) => (d.children ? 0 : (d.value ?? 0)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<Node>().tile(treemapSquarify.ratio(1.2)).size([width, height]).paddingInner(3).round(true)(h);
  }, [projects, width, height]);

  const total = root?.value ?? 0;
  const leaves = root?.leaves() ?? [];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {root && (
        <svg width={width} height={height} role="img" aria-label="Tokens by project" className="block">
          {leaves.map((leaf) => {
            const w = leaf.x1 - leaf.x0;
            const h = leaf.y1 - leaf.y0;
            const color = leaf.data.color ?? 'var(--other)';
            const ink = inkOn(color);
            const isHover = hover?.leaf === leaf;
            const nameChars = Math.floor((w - 22) / 8);
            return (
              <g
                key={leaf.data.key}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
                onClick={() => onSelect?.(leaf.data.key)}
                onPointerEnter={() => setHover({ leaf, x: leaf.x0 + w / 2, y: leaf.y0 + Math.min(h / 2, 44) })}
                onPointerLeave={leaveIfMouse(clearHover)}
              >
                <rect x={leaf.x0} y={leaf.y0} width={w} height={h} rx={Math.min(12, w / 4, h / 4)} style={{ fill: color, opacity: isHover ? 0.86 : 1, transition: 'opacity 120ms ease' }} />
                {w > 58 && h > 38 && nameChars >= 3 && (
                  <g pointerEvents="none">
                    <text x={leaf.x0 + 11} y={leaf.y0 + 23} style={{ fill: ink, fontSize: 14.5, fontWeight: 650 }}>
                      {truncate(leaf.data.name, nameChars)}
                    </text>
                    {h > 58 && (
                      <text x={leaf.x0 + 11} y={leaf.y0 + 42} className="tnum" style={{ fill: ink, opacity: 0.85, fontSize: 13 }}>
                        {fitLine([`${format(leaf.value ?? 0)} · ${pct((leaf.value ?? 0) / (total || 1))}`, format(leaf.value ?? 0)], w - 22)}
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
          {(hover.leaf.data.parts ?? [])
            .filter((p) => p.value > 0)
            .map((p) => (
              <TooltipRow key={p.provider} color={PROVIDER_COLOR[p.provider]} label={PROVIDER_LABEL[p.provider]} value={format(p.value)} />
            ))}
          <div className="mt-1 text-[11px] text-muted">{pct((hover.leaf.value ?? 0) / (total || 1), 1)} of all tokens</div>
        </ChartTooltip>
      )}
    </div>
  );
}

/** The longest candidate that fits the width (about 7.4px per character at 13px), or nothing. */
function fitLine(candidates: string[], width: number): string {
  return candidates.find((c) => c.length * 7.4 <= width) ?? '';
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}
