import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A small click-to-open panel that closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = 'left',
  width = 260,
  label,
}: {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="block"
      >
        {trigger(open)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={clsx(
            'fade-in absolute top-[calc(100%+6px)] z-50 rounded-xl border border-line-strong bg-surface p-1.5 shadow-[var(--shadow-pop)]',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          style={{ width, maxWidth: 'calc(100vw - 24px)' }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function TriggerButton({ open, children, active }: { open: boolean; children: ReactNode; active?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-2.5 text-[13px] font-medium transition-colors',
        active ? 'border-line-strong bg-surface text-ink' : 'border-line bg-surface text-ink-2 hover:text-ink',
        open && 'ring-2 ring-focus/30',
      )}
    >
      {children}
    </span>
  );
}

export function MenuItem({
  selected,
  onClick,
  children,
  right,
}: {
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-surface-2"
    >
      <span className="flex w-4 shrink-0 justify-center">
        {selected && (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right && <span className="shrink-0 text-[12px] text-muted">{right}</span>}
    </button>
  );
}
