import clsx from 'clsx';
import { ArrowRight, Flame, Gauge, Timer } from 'lucide-react';
import type { ActiveSession, BlockStatus, CodexLimits, LiveStatus } from '../../shared/types';
import { SOURCE_COLOR } from '../lib/colors';
import { compact, relative, shortDuration, timeOfDay, until, usd } from '../lib/format';
import { useDrawer } from '../lib/store';
import { Meter } from './charts/Meter';
import { Card, SourceBadge } from './ui';

function MinuteBars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-9 items-end gap-[2px]" aria-label="Tokens per minute, last 30 minutes" role="img">
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-[2px]"
          style={{
            height: v > 0 ? `${Math.max(8, (v / max) * 100)}%` : '3px',
            background: v > 0 ? color : 'var(--surface-3)',
            opacity: v > 0 ? 0.55 + 0.45 * (i / values.length) : 1,
          }}
        />
      ))}
    </div>
  );
}

export function ActiveSessionCard({ s, now }: { s: ActiveSession; now: number }) {
  const { openSession } = useDrawer();
  const working = s.state === 'working';
  return (
    <button
      type="button"
      onClick={() => openSession(s.key)}
      className="card group flex w-full flex-col gap-3 p-4 text-left transition-shadow hover:shadow-[var(--shadow-pop)]"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {working ? (
            <span className="live-dot shrink-0" aria-label="Working" />
          ) : (
            <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--muted)]" aria-label="Idle" />
          )}
          <span className={clsx('text-[12px] font-semibold', working ? 'text-good-text' : 'text-muted')}>
            {working ? 'Working' : 'Idle'}
          </span>
          <span className="text-[12px] text-muted">· {relative(s.lastActivity, now)}</span>
        </div>
        <SourceBadge source={s.source} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">{s.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted">
          <span className="font-medium text-ink-2">{s.project}</span>
          {s.path && <span> · {s.path}</span>}
        </div>
      </div>
      <MinuteBars values={s.perMinute} color={SOURCE_COLOR[s.source]} />
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-ink-2">
          <span className="font-medium text-ink">{s.modelLabel}</span> · since {timeOfDay(s.start)}
        </span>
        <span className="tnum text-ink-2">
          <span className="font-semibold text-ink">{compact(s.tokensLastHour)}</span> tok/h · {usd(s.costLastHour)}
        </span>
      </div>
    </button>
  );
}

export function BlockCard({
  title,
  blocks,
  now,
  note,
}: {
  title: string;
  blocks: BlockStatus;
  now: number;
  note?: string;
}) {
  const cur = blocks.current;
  const share = cur && blocks.maxTokens ? cur.tokens / blocks.maxTokens : cur ? 1 : 0;
  const shareLabel = !blocks.maxTokens
    ? 'first window on record'
    : share > 1
      ? `busiest yet · ${Math.round(share * 100)}% of ${compact(blocks.maxTokens)}`
      : `${Math.round(share * 100)}% of ${compact(blocks.maxTokens)}`;
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">{title}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {cur ? `${timeOfDay(cur.start)} – ${timeOfDay(cur.end)} · resets in ${until(cur.end, now)}` : 'No active 5-hour window'}
          </p>
        </div>
        <Timer size={18} className="text-muted" aria-hidden />
      </div>
      {cur ? (
        <>
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="text-[30px] font-semibold leading-none tracking-[-0.02em]">{compact(cur.tokens)}</div>
              <div className="mt-1 text-[12.5px] text-muted">tokens · {usd(cur.cost)} est. · {cur.requests} requests</div>
            </div>
            <div className="text-right text-[12.5px]">
              <div className="inline-flex items-center gap-1 text-ink-2">
                <Flame size={13} aria-hidden /> {compact(cur.burnTokensPerMin)}/min
              </div>
              <div className="mt-0.5 text-muted">{usd(cur.burnCostPerHour)}/h</div>
            </div>
          </div>
          <Meter value={share} label="vs. your busiest earlier window" sublabel={shareLabel} tone="neutral" />
          {cur.projectedTokens > cur.tokens && (
            <p className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <ArrowRight size={13} className="text-muted" aria-hidden />
              At this pace: <span className="font-semibold text-ink">{compact(cur.projectedTokens)}</span> tokens (
              {usd(cur.projectedCost)}) by reset.
            </p>
          )}
        </>
      ) : (
        <p className="text-[13px] text-ink-2">Nothing has run in the last five hours.</p>
      )}
      {blocks.recent.length > 1 && <RecentBlocks blocks={blocks} />}
      {note && <p className="text-[11.5px] leading-relaxed text-muted">{note}</p>}
    </Card>
  );
}

function RecentBlocks({ blocks }: { blocks: BlockStatus }) {
  const max = Math.max(...blocks.recent.map((b) => b.tokens), 1);
  return (
    <div>
      <div className="mb-1.5 text-[11.5px] font-medium text-muted">Recent 5-hour windows</div>
      <div className="flex h-12 items-end gap-1">
        {blocks.recent.map((b) => (
          <div
            key={b.start}
            className="group relative flex-1 rounded-t-[3px]"
            title={`${new Date(b.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}: ${compact(b.tokens)} tokens, ${usd(b.cost)}`}
            style={{
              height: `${Math.max(6, (b.tokens / max) * 100)}%`,
              background: b.active ? 'var(--focus)' : 'var(--surface-3)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function windowName(minutes?: number): string {
  if (!minutes) return 'Usage limit';
  if (minutes >= 10_000) return 'Weekly limit';
  if (minutes >= 1_440) return 'Daily limit';
  return `${Math.round(minutes / 60)}-hour limit`;
}

export function CodexLimitsCard({ limits, now }: { limits?: CodexLimits; now: number }) {
  const win = (w: CodexLimits['primary']) => {
    if (!w) return null;
    const expired = w.resetsAt !== undefined && w.resetsAt < now;
    const used = expired ? 0 : w.usedPercent / 100;
    return (
      <Meter
        value={used}
        label={windowName(w.windowMinutes)}
        sublabel={`${Math.round(used * 100)}% used${w.resetsAt && !expired ? ` · resets in ${until(w.resetsAt, now)}` : expired ? ' · reset' : ''}`}
      />
    );
  };
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Codex plan limits</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {limits
              ? `Reported by Codex ${relative(limits.updatedAt, now)}${limits.planType ? ` · ${limits.planType} plan` : ''}`
              : 'Codex reports this once you use it with a ChatGPT plan'}
          </p>
        </div>
        <Gauge size={18} className="text-muted" aria-hidden />
      </div>
      {limits ? (
        <div className="flex flex-col gap-4">
          {win(limits.primary)}
          {win(limits.secondary)}
        </div>
      ) : (
        <p className="text-[13px] text-ink-2">No limit snapshot in your Codex logs yet.</p>
      )}
    </Card>
  );
}

function MiniMeter({
  label,
  value,
  figure,
  foot,
  neutral,
}: {
  label: string;
  value: number;
  figure: string;
  foot: string;
  neutral?: boolean;
}) {
  const v = Math.max(0, Math.min(1, value));
  const color = neutral ? 'var(--focus)' : v >= 0.9 ? 'var(--critical)' : v >= 0.7 ? 'var(--warning)' : 'var(--focus)';
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="truncate font-medium text-ink-2">{label}</span>
        <span className="tnum shrink-0 font-semibold text-ink">{figure}</span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 18%, var(--surface-2))` }}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
      >
        <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: color }} />
      </div>
      <div className="mt-1 truncate text-[11.5px] text-muted">{foot}</div>
    </div>
  );
}

/** A compact "right now" strip for the overview page. */
export function LiveStrip({ live }: { live: LiveStatus }) {
  const working = live.active.filter((a) => a.state === 'working');
  const cur = live.claudeBlocks.current;
  const primary = live.codexLimits?.primary;
  if (!working.length && !cur && !primary) return null;
  const primaryExpired = primary?.resetsAt !== undefined && primary.resetsAt < live.now;
  return (
    <a
      href="#/live"
      className="card group flex flex-col gap-4 p-4 transition-shadow hover:shadow-[var(--shadow-pop)] lg:flex-row lg:items-center lg:gap-8"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {working.length ? <span className="live-dot shrink-0" /> : <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--muted)]" />}
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">
            {working.length ? `${working.length} agent${working.length > 1 ? 's' : ''} working now` : 'No agents running'}
          </div>
          <div className="truncate text-[12.5px] text-muted">
            {working.length
              ? working.map((w) => `${w.project} · ${w.modelLabel}`).join('   ·   ')
              : live.active.length
                ? `Last active: ${live.active[0].project}, ${relative(live.active[0].lastActivity, live.now)}`
                : 'Agents show up here while they work'}
          </div>
        </div>
      </div>
      <div className="grid w-full gap-4 sm:grid-cols-2 lg:w-auto lg:grid-cols-[repeat(2,220px)]">
        {cur && (
          <MiniMeter
            label="Claude 5-hour window"
            value={live.claudeBlocks.maxTokens ? cur.tokens / live.claudeBlocks.maxTokens : 1}
            figure={compact(cur.tokens)}
            foot={`${live.claudeBlocks.maxTokens && cur.tokens <= live.claudeBlocks.maxTokens ? 'vs. busiest window' : 'busiest window yet'} · resets in ${shortDuration(cur.end - live.now)}`}
            neutral
          />
        )}
        {primary && (
          <MiniMeter
            label={`Codex ${windowName(primary.windowMinutes).toLowerCase()}`}
            value={primaryExpired ? 0 : primary.usedPercent / 100}
            figure={`${primaryExpired ? 0 : Math.round(primary.usedPercent)}%`}
            foot={primary.resetsAt && !primaryExpired ? `used · resets in ${shortDuration(primary.resetsAt - live.now)}` : 'used'}
          />
        )}
      </div>
      <ArrowRight size={16} className="hidden shrink-0 text-muted transition-transform group-hover:translate-x-0.5 lg:block" aria-hidden />
    </a>
  );
}
