import clsx from 'clsx';
import {
  CheckCircle2,
  CircleDashed,
  KeyRound,
  Loader2,
  Lock,
  Share,
  ShieldCheck,
  SquarePlus,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { SOURCE_META, type ImportInfo, type SourceId, type SourceStatus } from '../../shared/types';
import type { Data } from '../lib/data';
import { compact, dateTime, relative } from '../lib/format';
import { useData } from '../lib/store';
import { AutoUpdatesCard } from '../components/AutoUpdates';
import { Card, CardHeader, Kbd, ProviderDot } from '../components/ui';

const fmtDay = (ts?: number) => (ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');

function StatusIcon({ s }: { s: SourceStatus }) {
  if (s.error) return <TriangleAlert size={16} className="text-serious" aria-label="Error" />;
  if (s.connected) return <CheckCircle2 size={16} className="text-good" aria-label="Connected" />;
  return <CircleDashed size={16} className="text-muted" aria-label="Not connected" />;
}

/** A button that opens the file picker and imports what the user chooses. */
function ImportButton({ label, accept, primary = true }: { label: string; accept?: string; primary?: boolean }) {
  const { importFile, importing } = useData();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
      <button
        type="button"
        disabled={Boolean(importing)}
        onClick={() => input.current?.click()}
        className={clsx(
          'inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-2xl px-5 text-[15px] font-semibold transition-opacity disabled:opacity-50 sm:w-auto',
          primary ? 'bg-ink text-page hover:opacity-90' : 'border border-line bg-surface text-ink hover:bg-surface-2',
        )}
      >
        <Upload size={16} aria-hidden />
        {label}
      </button>
    </>
  );
}

function Steps({ children }: { children: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {children.map((step, i) => (
        <li key={i} className="flex gap-3 text-[13.5px] leading-snug text-ink-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink">
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

function ImportedLine({ info }: { info: ImportInfo }) {
  const { removeImport } = useData();
  const noun = SOURCE_META[info.source].kind === 'chat' ? 'conversations' : 'sessions';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-ink">
          {info.conversations.toLocaleString('en-US')} {noun} · {compact(info.tokens)} tokens
        </div>
        <div className="truncate text-[12px] text-muted">
          {info.from && info.to ? `${fmtDay(info.from)} – ${fmtDay(info.to)} · ` : ''}imported {relative(info.importedAt)} from {info.fileName}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          if (window.confirm(`Remove the imported ${SOURCE_META[info.source].label}? You can import the file again any time.`)) {
            void removeImport(info.id);
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface hover:text-critical"
      >
        <Trash2 size={14} aria-hidden /> Remove
      </button>
    </div>
  );
}

function ChatCard({ source, imported, children }: { source: SourceId; imported?: ImportInfo; children: ReactNode[] }) {
  const meta = SOURCE_META[source];
  const app = source === 'chatgpt' ? 'ChatGPT' : 'claude.ai';
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <ProviderDot provider={meta.provider} size={10} />
          <h3 className="text-[16px] font-semibold">{app}</h3>
        </div>
        {imported ? (
          <CheckCircle2 size={18} className="shrink-0 text-good" aria-label="Imported" />
        ) : (
          <CircleDashed size={18} className="shrink-0 text-muted" aria-label="Not imported yet" />
        )}
      </div>
      {imported && <ImportedLine info={imported} />}
      <ImportButton label={imported ? 'Import newer export' : 'Import export'} accept=".zip,.json,application/zip,application/json" primary={!imported} />
      <details className="group">
        <summary className="cursor-pointer text-[13px] font-medium text-ink-2 hover:text-ink">How to get the export</summary>
        <div className="mt-3">
          <Steps>{children}</Steps>
        </div>
      </details>
    </Card>
  );
}

function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

export function SourcesPage({ data }: { data: Data }) {
  const { mode, imports, importing, importError, lastImported, clearImports } = useData();
  const ds = data.raw;
  const device = mode === 'device';
  const latest = (source: SourceId) => imports.find((i) => i.source === source);
  const agentImports = imports.filter((i) => SOURCE_META[i.source].kind === 'agent');
  const statuses = new Map(ds.sources.map((s) => [s.id, s]));

  return (
    <div className="flex flex-col gap-5">
      {(importing || importError) && (
        <Card className={clsx('flex items-start gap-3 p-4', importError && 'border-critical/40')}>
          {importing ? (
            <Loader2 size={18} className="spin mt-0.5 shrink-0 text-focus" aria-hidden />
          ) : (
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-critical" aria-hidden />
          )}
          <div className="text-[13.5px]" role="status" aria-live="polite">
            <div className="font-semibold">{importing ? `${importing}…` : 'That file could not be imported'}</div>
            <div className="text-ink-2">{importing ? 'Large exports take a few seconds. Keep this screen open.' : importError}</div>
          </div>
        </Card>
      )}

      {ds.demo && !importing && (
        <Card className="border-dashed p-5">
          <h2 className="text-[15px] font-semibold">Showing demo data</h2>
          <p className="mt-1 text-[13.5px] text-ink-2">Turn on automatic updates or import a chat export to see yours.</p>
        </Card>
      )}
      {lastImported && lastImported.length > 0 && !importing && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold">
            <CheckCircle2 size={17} className="text-good" aria-hidden />
            Imported{' '}
            {lastImported
              .map((i) => `${i.conversations.toLocaleString('en-US')} ${SOURCE_META[i.source].kind === 'chat' ? 'conversations' : 'sessions'} from ${SOURCE_META[i.source].short}`)
              .join(' and ')}
            .
          </span>
          <a href="#/" className="text-[13px] font-semibold text-ink hover:underline">
            Open overview →
          </a>
        </Card>
      )}

      {device && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Coding agents</h2>
          <AutoUpdatesCard />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Chats</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <ChatCard source="chatgpt" imported={latest('chatgpt')}>
            {[
              <>
                In ChatGPT, open <b className="font-semibold text-ink">Settings → Data controls → Export data</b> and confirm.
              </>,
              <>OpenAI emails you a download link, usually within minutes.</>,
              <>Open the link on this {device ? 'iPhone' : 'device'} and download the zip.</>,
              <>Tap Import below and pick the zip (on iPhone it's in Files → Downloads).</>,
            ]}
          </ChatCard>
          <ChatCard source="claude-ai" imported={latest('claude-ai')}>
            {[
              <>
                On claude.ai, open <b className="font-semibold text-ink">Settings → Privacy → Export data</b>.
              </>,
              <>Anthropic emails you a download link.</>,
              <>Open the link on this {device ? 'iPhone' : 'device'} and download the zip.</>,
              <>Tap Import below and pick the zip.</>,
            ]}
          </ChatCard>
        </div>
        <p className="text-[12.5px] text-muted">Chat tokens are estimated from message length.</p>
      </section>

      {device ? (
        <details className="group rounded-[16px] border border-line bg-surface px-5 py-4">
          <summary className="cursor-pointer text-[14px] font-medium text-ink-2">Import log files by hand</summary>
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-[13px] text-ink-2">
              A zip of <Kbd>~/.claude/projects</Kbd> or <Kbd>~/.codex/sessions</Kbd>, or single <Kbd>.jsonl</Kbd> files.
            </p>
            {agentImports.map((i) => (
              <ImportedLine key={i.id} info={i} />
            ))}
            <ImportButton label="Import session files" primary={false} />
          </div>
        </details>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Coding agents</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {(['claude-code', 'codex'] as SourceId[]).map((id) => {
              const st = statuses.get(id);
              return st ? <SourceCard key={id} s={st} /> : null;
            })}
          </div>
        </section>
      )}

      {!device && (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">Organisation APIs (optional)</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {(['anthropic-api', 'openai-api'] as SourceId[]).map((id) => {
              const s = statuses.get(id);
              return s ? <SourceCard key={id} s={s} /> : null;
            })}
          </div>
        </section>
      )}

      {device && !isStandalone() && (
        <Card className="flex items-start gap-3 p-5">
          <SquarePlus size={20} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
          <div>
            <h3 className="text-[15px] font-semibold">Add to Home Screen</h3>
            <p className="mt-1 text-[13.5px] text-ink-2">
              Tap <Share size={13} className="inline -translate-y-px" aria-label="Share" /> Share, then{' '}
              <b className="font-semibold text-ink">Add to Home Screen</b>.
            </p>
          </div>
        </Card>
      )}

      <details className="group rounded-[16px] border border-line bg-surface px-5 py-4">
        <summary className="cursor-pointer text-[14px] font-medium text-ink-2">How the numbers work</summary>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <CardHeader title="How costs are estimated" />
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Every reply is priced from its token counts at public per-token API prices, cache reads included. On a Claude or
            ChatGPT subscription this is what the same usage would cost on the API, not what you pay.
          </p>
          <p className="mt-3 text-[12.5px] text-muted">
            Prices:{' '}
            {ds.pricing.source === 'litellm'
              ? 'LiteLLM price list, fetched today'
              : ds.pricing.source === 'litellm-cache'
                ? 'LiteLLM price list (cached)'
                : 'built-in price list'}
            {ds.pricing.updatedAt ? `, updated ${relative(ds.pricing.updatedAt)}` : ''}.
          </p>
          {ds.pricing.unpriced.length > 0 && (
            <p className="mt-2 text-[12.5px] text-ink-2">
              No price for: <span className="font-mono text-[11.5px]">{ds.pricing.unpriced.join(', ')}</span>. Their tokens count;
              their cost shows as $0.
            </p>
          )}
        </Card>
        <Card className="p-5">
          <CardHeader title="How tokens are counted" />
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink-2">
            <li>
              <b className="font-medium text-ink">Input</b>: new prompt tokens (your message, files, tool results).
            </li>
            <li>
              <b className="font-medium text-ink">Cache read</b>: the earlier conversation, which every reply reads again.
              It's usually most of the total.
            </li>
            <li>
              <b className="font-medium text-ink">Output</b>: the reply, including reasoning.
            </li>
          </ul>
        </Card>
        <Card className="p-5">
          <CardHeader title="Privacy" />
          <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            {device ? (
              <>
                <li className="flex gap-2">
                  <Lock size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <span>Files are read on this device and never uploaded. Only token counts, titles and dates are kept, not the messages.</span>
                </li>
                <li className="flex gap-2">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <span>The data lives in this browser's storage. Deleting it below removes it.</span>
                </li>
              </>
            ) : (
              <>
                <li className="flex gap-2">
                  <Lock size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <span>Logs and imports are read on this computer and never leave it.</span>
                </li>
                <li className="flex gap-2">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <span>The server listens on 127.0.0.1 and rejects requests addressed to other host names.</span>
                </li>
                <li className="flex gap-2">
                  <KeyRound size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  <span>
                    Admin keys stay in your <Kbd>.env</Kbd> file and are only sent to Anthropic and OpenAI.
                  </span>
                </li>
              </>
            )}
          </ul>
        </Card>
      </div>
      </details>

      {imports.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-[12px] text-muted">
            Data built {relative(ds.generatedAt)} · {imports.length} import{imports.length === 1 ? '' : 's'}
          </p>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Delete all imported data from this device? You can import the files again later.')) void clearImports();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-critical"
          >
            <Trash2 size={14} aria-hidden /> Delete all imported data
          </button>
        </div>
      )}
      {device && !imports.length && (
        <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted">
          <Lock size={12} aria-hidden /> Data stays on this device · time zone {ds.timezone}
        </p>
      )}
    </div>
  );
}

function SourceCard({ s }: { s: SourceStatus }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <ProviderDot provider={s.provider} size={10} />
          <div>
            <h3 className="text-[15px] font-semibold">{s.label}</h3>
            <p className="text-[12px] text-muted">{SOURCE_META[s.id].description}</p>
          </div>
        </div>
        <StatusIcon s={s} />
      </div>
      <p className="text-[13px] font-medium text-ink">{s.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        {s.paths && (
          <>
            <dt className="text-muted">Looks in</dt>
            <dd className="font-mono text-[11.5px] text-ink-2">{s.paths.join(', ')}</dd>
          </>
        )}
        {s.events !== undefined && (
          <>
            <dt className="text-muted">Records</dt>
            <dd className="tnum text-ink-2">{s.events.toLocaleString('en-US')}</dd>
          </>
        )}
        {s.lastEventAt && (
          <>
            <dt className="text-muted">Latest usage</dt>
            <dd className="text-ink-2">
              {dateTime(s.lastEventAt)} ({relative(s.lastEventAt)})
            </dd>
          </>
        )}
      </dl>
      {s.error && <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11.5px] text-ink-2">{s.error}</p>}
      {s.hint && <p className="text-[12.5px] leading-relaxed text-ink-2">{s.hint}</p>}
    </Card>
  );
}
