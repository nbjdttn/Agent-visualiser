import { AlertTriangle, CheckCircle2, OctagonAlert } from 'lucide-react';

/**
 * A single ratio against a limit. The fill carries severity and the track is a
 * lighter step of the same hue; past 70% an icon and label join the colour.
 * Use `tone="neutral"` for comparisons that are not real limits.
 */
export function Meter({
  value,
  label,
  sublabel,
  tone = 'severity',
}: {
  value: number;
  label?: string;
  sublabel?: string;
  tone?: 'severity' | 'neutral';
}) {
  const v = Math.max(0, Math.min(1, value));
  const level = tone === 'neutral' ? 'ok' : v >= 0.9 ? 'critical' : v >= 0.7 ? 'warning' : 'ok';
  const color = level === 'critical' ? 'var(--critical)' : level === 'warning' ? 'var(--warning)' : 'var(--focus)';
  const Icon = level === 'critical' ? OctagonAlert : level === 'warning' ? AlertTriangle : CheckCircle2;
  return (
    <div>
      {(label || sublabel) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px]">
          <span className="font-medium text-ink-2">{label}</span>
          <span className="text-muted">{sublabel}</span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 18%, var(--surface-2))` }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-label={label}
      >
        <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${v * 100}%`, background: color }} />
      </div>
      {level !== 'ok' && (
        <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink-2">
          <Icon size={12} style={{ color }} aria-hidden />
          {level === 'critical' ? 'Almost at the limit' : 'Getting close to the limit'}
        </div>
      )}
    </div>
  );
}
