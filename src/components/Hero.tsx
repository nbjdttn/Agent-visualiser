import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { PROVIDER_LABEL, type Provider } from '../../shared/types';
import type { ClaudeWindow } from '../../core/sync/payload';
import { PROVIDER_COLOR } from '../lib/colors';
import { compact, pct, usd } from '../lib/format';
import { TrendChart } from './charts/TrendChart';

const LIGHT: Record<Provider, string> = {
  anthropic: 'color-mix(in srgb, var(--anthropic) 55%, #fff)',
  openai: 'color-mix(in srgb, var(--openai) 55%, #fff)',
};

export interface Ring {
  key: Provider;
  ratio: number;
}

/**
 * Concentric ring meters (Claude outside, OpenAI inside, like the app icon).
 * Each ring fills to its share; a value over 1 wraps into a second lap.
 */
export function UsageRings({ rings, size = 160, children }: { rings: Ring[]; size?: number; children?: ReactNode }) {
  const uid = useId().replace(/:/g, '');
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(t);
  }, []);
  const stroke = Math.round(size * 0.1);
  const gap = 4;
  const c = size / 2;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="block">
        <defs>
          {rings.map((r) => (
            <linearGradient key={r.key} id={`${uid}${r.key}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" style={{ stopColor: LIGHT[r.key] }} />
              <stop offset="1" style={{ stopColor: PROVIDER_COLOR[r.key] }} />
            </linearGradient>
          ))}
        </defs>
        {rings.map((r, i) => {
          const radius = c - stroke / 2 - i * (stroke + gap);
          const circ = 2 * Math.PI * radius;
          const first = Math.min(1, Math.max(0, r.ratio));
          const over = Math.min(1, Math.max(0, r.ratio - 1));
          const arc = (p: number) => (drawn ? `${circ * p} ${circ}` : `0 ${circ}`);
          return (
            <g key={r.key} transform={`rotate(-90 ${c} ${c})`}>
              <circle cx={c} cy={c} r={radius} fill="none" style={{ stroke: PROVIDER_COLOR[r.key] }} strokeOpacity={0.18} strokeWidth={stroke} />
              {first > 0.002 && (
                <circle
                  className="ring-arc"
                  cx={c}
                  cy={c}
                  r={radius}
                  fill="none"
                  stroke={`url(#${uid}${r.key})`}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={arc(first)}
                />
              )}
              {over > 0.002 && (
                <circle
                  className="ring-arc"
                  cx={c}
                  cy={c}
                  r={radius}
                  fill="none"
                  style={{ stroke: PROVIDER_COLOR[r.key], filter: 'drop-shadow(0 0 3px rgba(0,0,0,.45))' }}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={arc(over)}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

const WINDOW_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };

function LimitPill({ w }: { w: ClaudeWindow }) {
  const ok = w.status === 'allowed';
  const close = w.status === 'allowed_warning';
  const Icon = ok ? CheckCircle2 : close ? AlertTriangle : XCircle;
  const when =
    w.resetsAt && w.resetsAt > Date.now()
      ? new Date(w.resetsAt).toLocaleString(undefined, {
          weekday: w.resetsAt - Date.now() > 20 * 3600_000 ? 'short' : undefined,
          hour: 'numeric',
          minute: '2-digit',
        })
      : undefined;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2">
      <Icon size={13} className={ok ? 'text-good' : close ? 'text-warning' : 'text-critical'} aria-hidden />
      <span className="font-semibold text-ink">{WINDOW_LABEL[w.type] ?? w.type.replace(/_/g, ' ')}</span>
      {ok ? 'OK' : close ? 'close' : 'reached'}
      {when && <span className="text-muted">· resets {when}</span>}
    </span>
  );
}

/**
 * The headline card, styled like the app icon: total tokens for the period,
 * the Claude / OpenAI share as two rings, and the daily trend.
 */
export function HeroCard({
  label,
  tokens,
  cost,
  change,
  byProvider,
  trend,
  limits,
}: {
  label: string;
  tokens: number;
  cost: number;
  change: ReactNode;
  byProvider: { p: Provider; tokens: number; daily: number[] }[];
  trend: string[];
  limits?: ClaudeWindow[];
}) {
  const total = byProvider.reduce((s, r) => s + r.tokens, 0);
  const recent = (limits ?? []).filter((w) => Date.now() - w.seenAt < 8 * 86_400_000);
  return (
    <div className="hero-card relative overflow-hidden rounded-[22px] p-5 text-ink">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium text-ink-2">{label}</h2>
        {change}
      </div>
      <div className="mt-3 flex items-center gap-5">
        <UsageRings rings={byProvider.map((r) => ({ key: r.p, ratio: total ? r.tokens / total : 0 }))}>
          <div className="text-[25px] font-semibold leading-none tracking-[-0.03em]">{compact(tokens)}</div>
          <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">tokens</div>
        </UsageRings>
        <ul className="flex min-w-0 flex-1 flex-col gap-3">
          {byProvider.map((r) => (
            <li key={r.p} className="min-w-0">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PROVIDER_COLOR[r.p] }} aria-hidden />
                {PROVIDER_LABEL[r.p]}
                <span className="text-muted">{total ? pct(r.tokens / total) : ''}</span>
              </div>
              <div className="mt-0.5 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{compact(r.tokens)}</div>
            </li>
          ))}
          <li className="text-[12.5px] text-ink-2">
            ≈ <b className="font-semibold text-ink">{usd(cost)}</b>
          </li>
        </ul>
      </div>
      <div className="mt-4">
        <TrendChart
          labels={trend}
          lines={byProvider.map((r) => ({ label: PROVIDER_LABEL[r.p], values: r.daily, color: PROVIDER_COLOR[r.p], wash: true }))}
          height={96}
          format={(v) => compact(v)}
          ariaLabel="Tokens per day"
        />
      </div>
      {recent.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3.5">
          {recent.map((w) => (
            <LimitPill key={w.type} w={w} />
          ))}
        </div>
      )}
    </div>
  );
}
