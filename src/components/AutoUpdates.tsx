import clsx from 'clsx';
import { Check, Cloud, Copy, ExternalLink, Laptop, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ClaudeWindow } from '../../core/sync/payload';
import { relative } from '../lib/format';
import { useData } from '../lib/store';
import type { SyncView } from '../lib/sync';
import { Card, Kbd } from './ui';

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
};
const STATUS_LABEL: Record<string, string> = {
  allowed: 'OK',
  allowed_warning: 'getting close',
  rejected: 'reached',
};

function when(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function Badge({ tone, children }: { tone: 'on' | 'wait' | 'off'; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold',
        tone === 'on' ? 'border-good/40 text-good' : tone === 'wait' ? 'border-line text-ink-2' : 'border-line text-muted',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', tone === 'on' ? 'bg-good' : tone === 'wait' ? 'bg-ink-2' : 'bg-muted')} aria-hidden />
      {children}
    </span>
  );
}

function CodeBox({ view }: { view: SyncView }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.code ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked: the text is selectable instead.
    }
  };
  return (
    <div className="flex flex-col gap-2.5">
      <code
        className="block select-all break-all rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink"
        aria-label="This phone's code"
      >
        {view.code}
      </code>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-semibold text-page hover:opacity-90"
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? 'Copied' : 'Copy code'}
        </button>
        {view.registerUrl && (
          <a
            href={view.registerUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-line bg-surface px-4 text-[14px] font-semibold text-ink hover:bg-surface-2"
          >
            Add on GitHub <ExternalLink size={14} aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}

function LimitLine({ w }: { w: ClaudeWindow }) {
  const label = WINDOW_LABEL[w.type] ?? w.type.replace(/_/g, ' ');
  const status = STATUS_LABEL[w.status] ?? w.status.replace(/_/g, ' ');
  const future = w.resetsAt && w.resetsAt > Date.now();
  return (
    <li className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-ink-2">
        {label}: <b className={clsx('font-semibold', w.status === 'rejected' ? 'text-critical' : 'text-ink')}>{status}</b>
        {w.overage ? ' · using extra usage' : ''}
      </span>
      <span className="shrink-0 text-[12px] text-muted">{future ? `resets ${when(w.resetsAt!)}` : `as of ${relative(w.seenAt)}`}</span>
    </li>
  );
}

/** Data tab: turn automatic updates on, register this phone, and see what has arrived. */
export function AutoUpdatesCard() {
  const { sync, syncing, enableSync, disableSync, checkSync } = useData();
  const [busy, setBusy] = useState(false);
  if (!sync) return null;

  const header = (badge: ReactNode) => (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <RefreshCw size={18} className="shrink-0 text-ink-2" aria-hidden />
        <h3 className="text-[16px] font-semibold">Automatic updates</h3>
      </div>
      {badge}
    </div>
  );

  if (!sync.available) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        {header(<Badge tone="off">Off</Badge>)}
        <p className="text-[13.5px] leading-relaxed text-ink-2">Automatic updates work in the published app on GitHub Pages.</p>
      </Card>
    );
  }

  if (!sync.enabled) {
    return (
      <Card className="flex flex-col gap-4 p-5">
        {header(<Badge tone="off">Off</Badge>)}
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Your computer and your Claude Code cloud sessions can send their usage here by themselves: exact tokens for
          every session and project, no exports needed. It's encrypted before it leaves them, so only this phone can read it.
        </p>
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await enableSync();
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-semibold text-page hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="spin" aria-hidden /> : <RefreshCw size={16} aria-hidden />}
            Turn on for this {sync.deviceName ?? 'device'}
          </button>
        </div>
      </Card>
    );
  }

  const hasData = sync.sources.length > 0;
  const status = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
      <span role="status" aria-live="polite">
        {syncing ? 'Checking for updates…' : sync.lastCheck ? `Checked ${relative(sync.lastCheck)}` : 'Not checked yet'}
      </span>
      <button
        type="button"
        disabled={syncing}
        onClick={() => void checkSync()}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        <RefreshCw size={13} className={syncing ? 'spin' : undefined} aria-hidden /> Check now
      </button>
    </div>
  );
  const problems = (
    <>
      {sync.error && (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[12.5px] text-ink-2">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-serious" aria-hidden />
          {sync.error}
        </p>
      )}
      {sync.waiting.length > 0 && (
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          {sync.waiting.length === 1 ? 'One source has' : `${sync.waiting.length} sources have`} data that isn't encrypted for this
          phone yet. It will be with their next update (a computer sends one within 15 minutes; cloud sessions once a day).
        </p>
      )}
    </>
  );

  if (!hasData) {
    return (
      <Card className="flex flex-col gap-4 p-5">
        {header(<Badge tone="wait">Waiting</Badge>)}
        <ol className="flex flex-col gap-4 text-[13.5px] leading-relaxed text-ink-2">
          <li className="flex flex-col gap-2.5">
            <span>
              <b className="font-semibold text-ink">1. Register this phone.</b> Copy its code and send it to Claude with "add this
              phone to my Agent Visualiser updates", or add it on GitHub yourself (then tap Commit changes).
            </span>
            <CodeBox view={sync} />
          </li>
          <li>
            <b className="font-semibold text-ink">2. Let your Mac send updates.</b> In a Claude Code session on the Mac, ask it to
            clone {sync.repo ? <Kbd>github.com/{sync.repo}</Kbd> : 'this repository'} and run <Kbd>npm install</Kbd> then{' '}
            <Kbd>npm run sync -- install</Kbd>. From then on it sends your Claude Code and Codex usage every few minutes while
            you work.
          </li>
          <li>
            <b className="font-semibold text-ink">3. Cloud sessions</b> (Claude Code on the web and in the app) arrive once a day
            from a scheduled task.
          </li>
        </ol>
        {problems}
        {status}
      </Card>
    );
  }

  const limits = sync.limits.filter((w) => w.status);
  return (
    <Card className="flex flex-col gap-4 p-5">
      {header(<Badge tone="on">On</Badge>)}
      <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-line">
        {sync.sources.map((s) => (
          <li key={s.name} className="flex items-center gap-3 px-3.5 py-3">
            {s.kind === 'computer' ? (
              <Laptop size={18} className="shrink-0 text-ink-2" aria-hidden />
            ) : (
              <Cloud size={18} className="shrink-0 text-ink-2" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold text-ink">{s.label}</div>
              <div className="text-[12px] text-muted">
                {s.sessions.toLocaleString('en-US')} session{s.sessions === 1 ? '' : 's'} · sent {relative(s.updatedAt)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {limits.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Claude plan (last reported)</h4>
          <ul className="flex flex-col gap-1">
            {limits.map((w) => (
              <LimitLine key={w.type} w={w} />
            ))}
          </ul>
        </div>
      )}
      {problems}
      {status}
      <details className="group">
        <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-ink">Add another computer, or this phone's code</summary>
        <div className="mt-3 flex flex-col gap-3 text-[13px] leading-relaxed text-ink-2">
          <p>
            On another computer, clone the repository and run <Kbd>npm install</Kbd> and <Kbd>npm run sync -- install</Kbd>.
            This phone's code, in case you need to register it again:
          </p>
          <CodeBox view={sync} />
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Turn off automatic updates on this phone? Its key and everything it received are deleted. Your computers keep sending until you remove the phone from the devices folder on GitHub.')) {
                void disableSync();
              }
            }}
            className="self-start rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-critical"
          >
            Turn off on this phone
          </button>
        </div>
      </details>
    </Card>
  );
}
