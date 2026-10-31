import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { PROVIDER_LABEL, SOURCE_META, type Provider, type SourceId } from '../../shared/types';
import { PROVIDER_COLOR } from '../lib/colors';
import { signedPct } from '../lib/format';

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('card', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink lg:text-[15px]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[14px] text-muted lg:text-[13px]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx('inline-flex items-center rounded-[13px] border border-line bg-surface-2 p-[3px] lg:rounded-[10px]', size === 'md' && 'h-11 lg:h-auto')}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={clsx(
              'whitespace-nowrap rounded-[7px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'flex h-full items-center rounded-[10px] px-2.5 text-[15px] font-semibold leading-5 max-[389px]:px-2 max-[389px]:text-[14px] lg:h-auto lg:rounded-[7px] lg:px-3 lg:py-1 lg:text-[13px] lg:font-medium',
              active ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-line' : 'text-ink-2 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Button({
  className,
  variant = 'ghost',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'ghost' | 'outline' | 'solid' }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'outline' && 'border border-line bg-surface text-ink hover:bg-surface-2',
        variant === 'solid' && 'bg-ink text-page hover:opacity-90',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ProviderDot({ provider, size = 8 }: { provider: Provider; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: PROVIDER_COLOR[provider] }}
    />
  );
}

export function Swatch({ color, shape = 'rect' }: { color: string; shape?: 'rect' | 'line' | 'dot' }) {
  if (shape === 'line') return <span aria-hidden className="inline-block h-[2px] w-3 shrink-0 rounded" style={{ background: color }} />;
  if (shape === 'dot') return <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />;
}

export function ProviderBadge({ provider, className }: { provider: Provider; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2',
        className,
      )}
    >
      <ProviderDot provider={provider} size={6} />
      {PROVIDER_LABEL[provider]}
    </span>
  );
}

export function SourceBadge({ source, className }: { source: SourceId; className?: string }) {
  const meta = SOURCE_META[source];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2',
        className,
      )}
    >
      <ProviderDot provider={meta.provider} size={6} />
      {meta.short}
    </span>
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Change against the previous period. Usage going up is neither good nor bad,
 * so it stays neutral unless `good` says which direction is an improvement.
 */
export function Delta({ value, good = 'none', label }: { value: number; good?: 'up' | 'down' | 'none'; label?: string }) {
  if (!Number.isFinite(value) && value > 0) {
    return <span className="text-[12px] font-medium text-muted">New{label ? ` ${label}` : ''}</span>;
  }
  const flat = Math.abs(value) < 0.005;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const improving = good !== 'none' && !flat && (good === 'up' ? value > 0 : value < 0);
  const worsening = good !== 'none' && !flat && !improving;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-0.5 text-[12px] font-medium',
        improving ? 'text-good-text' : worsening ? 'text-critical' : 'text-ink-2',
      )}
    >
      <Icon size={13} strokeWidth={2.4} aria-hidden />
      {flat ? '0%' : signedPct(value)}
      {label && <span className="ml-1 font-normal text-muted">{label}</span>}
    </span>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{children}</h3>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="whitespace-nowrap rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}
