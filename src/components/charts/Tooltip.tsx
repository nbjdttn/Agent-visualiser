import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A tooltip positioned inside a relatively-positioned chart container. It sits
 * beside the pointer and flips to the other side near the right edge.
 */
export function ChartTooltip({
  x,
  y,
  containerWidth,
  children,
}: {
  x: number;
  y: number;
  containerWidth: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 180, h: 60 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  });
  const gap = 14;
  const left = x + gap + size.w > containerWidth ? Math.max(4, x - gap - size.w) : x + gap;
  return (
    <div
      ref={ref}
      role="status"
      className="pointer-events-none absolute z-30 min-w-[150px] rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-[12px] shadow-[var(--shadow-pop)]"
      style={{ left, top: Math.max(4, y - size.h / 2) }}
    >
      {children}
    </div>
  );
}

export function TooltipTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium text-muted">{children}</div>;
}

/** Values lead, labels follow; a short line key carries the series colour. */
export function TooltipRow({
  color,
  label,
  value,
  muted,
  strong,
}: {
  color?: string;
  label: ReactNode;
  value: ReactNode;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-[1px]">
      {color ? (
        <span aria-hidden className="inline-block h-[2px] w-2.5 shrink-0 rounded" style={{ background: color }} />
      ) : (
        <span className="inline-block w-2.5 shrink-0" />
      )}
      <span className={`tnum font-semibold ${muted ? 'text-ink-2' : 'text-ink'} ${strong ? 'text-[13px]' : ''}`}>{value}</span>
      <span className="truncate text-ink-2">{label}</span>
    </div>
  );
}
