import clsx from 'clsx';
import { Check, Cloud, Copy, ExternalLink, Laptop, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { relative } from '../lib/format';
import { useData } from '../lib/store';
import type { SyncView } from '../lib/sync';
import { Card, Kbd } from './ui';

const bigButton = 'inline-flex min-h-[46px] items-center justify-center gap-2 rounded-2xl px-5 text-[15px] font-semibold transition-opacity disabled:opacity-50';

function Badge({ tone, children }: { tone: 'on' | 'wait' | 'off'; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold',
        tone === 'on' ? 'border-good/40 text-good' : 'border-line text-ink-2',
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', tone === 'on' ? 'bg-good' : tone === 'wait' ? 'bg-ink-2' : 'bg-muted')} aria-hidden />
      {children}
    </span>
  );
}

function CodeBox({ view }: { view: SyncView }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <code className="block select-all break-all rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink" aria-label="This phone's code">
        {view.code}
      </code>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(view.code ?? '');
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2500);
            } catch {
              // clipboard blocked: the code is selectable
            }
          }}
          className={`${bigButton} bg-ink text-page`}
        >
          {copied ? <Check size={17} aria-hidden /> : <Copy size={17} aria-hidden />}
          {copied ? 'Copied' : 'Copy code'}
        </button>
        {view.registerUrl && (
          <a href={view.registerUrl} target="_blank" rel="noreferrer" className={`${bigButton} border border-line bg-surface text-ink`}>
            GitHub <ExternalLink size={15} aria-hidden />
          </a>
        )}
      </div>
    </div>
  );
}

/** Your data page: turn automatic updates on, register this phone, and see what has arrived. */
export function AutoUpdatesCard() {
  const { sync, syncing, enableSync, disableSync, checkSync } = useData();
  const [busy, setBusy] = useState(false);
  if (!sync) return null;

  const title = (badge: ReactNode) => (
    <div className="flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2.5 text-[17px] font-semibold">
        <RefreshCw size={18} className="text-ink-2" aria-hidden /> Automatic updates
      </h3>
      {badge}
    </div>
  );

  if (!sync.available) {
    return (
      <Card className="flex flex-col gap-2 p-5">
        {title(<Badge tone="off">Off</Badge>)}
        <p className="text-[14px] text-ink-2">Works in the published app.</p>
      </Card>
    );
  }

  if (!sync.enabled) {
    return (
      <Card className="flex flex-col gap-4 p-5">
        {title(<Badge tone="off">Off</Badge>)}
        <p className="text-[14px] leading-relaxed text-ink-2">Your Mac and cloud sessions send their usage here by themselves. Only this phone can read it.</p>
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
          className={`${bigButton} bg-ink text-page`}
        >
          {busy ? <Loader2 size={17} className="spin" aria-hidden /> : <RefreshCw size={17} aria-hidden />}
          Turn on for this {sync.deviceName ?? 'device'}
        </button>
      </Card>
    );
  }

  const hasData = sync.sources.length > 0;
  const notRegistered = sync.registered === false;
  return (
    <Card className="flex flex-col gap-4 p-5">
      {title(hasData ? <Badge tone="on">On</Badge> : <Badge tone="wait">{notRegistered ? 'Not linked' : 'Waiting'}</Badge>)}

      {hasData && (
        <ul className="flex flex-col divide-y divide-[var(--border)] rounded-2xl border border-line">
          {sync.sources.map((s) => (
            <li key={s.name} className="flex items-center gap-3 px-4 py-3">
              {s.kind === 'computer' ? <Laptop size={20} className="shrink-0 text-ink-2" aria-hidden /> : <Cloud size={20} className="shrink-0 text-ink-2" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold text-ink">{s.kind === 'cloud' ? 'Cloud sessions' : s.label}</div>
                <div className="text-[12.5px] text-muted">
                  {s.sessions.toLocaleString('en-US')} sessions · {relative(s.updatedAt)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {notRegistered && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[14px] text-ink-2">Link this phone: copy its code and send it to Claude, or add it on GitHub.</p>
          <CodeBox view={sync} />
        </div>
      )}

      {!hasData && !notRegistered && (
        <p className="text-[14px] leading-relaxed text-ink-2">
          Linked. Waiting for your Mac (<Kbd>npm run sync -- install</Kbd>) or the daily cloud update.
        </p>
      )}

      {sync.error && (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-serious" aria-hidden />
          {sync.error}
        </p>
      )}

      <button type="button" disabled={syncing} onClick={() => void checkSync()} className={`${bigButton} border border-line bg-surface-2 text-ink`}>
        <RefreshCw size={17} className={syncing ? 'spin' : undefined} aria-hidden />
        {syncing ? 'Checking…' : 'Check now'}
      </button>
      <p className="-mt-2 text-center text-[12px] text-muted" role="status" aria-live="polite">
        {sync.lastCheck ? `Checked ${relative(sync.lastCheck)}` : ''}
      </p>

      {!notRegistered && (
        <details>
          <summary className="cursor-pointer text-[13px] font-medium text-ink-2">This phone's code · turn off</summary>
          <div className="mt-3 flex flex-col gap-3">
            <CodeBox view={sync} />
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Turn off automatic updates on this phone? What it received is deleted from the phone.')) void disableSync();
              }}
              className="self-start rounded-lg px-1 py-1.5 text-[13px] font-medium text-ink-2 hover:text-critical"
            >
              Turn off on this phone
            </button>
          </div>
        </details>
      )}
    </Card>
  );
}
