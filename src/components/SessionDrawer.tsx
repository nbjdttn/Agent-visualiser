import { Clock, FolderGit2, GitBranch, Layers, Terminal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionDetail } from '../../shared/types';
import { SLOTS, TOKEN_TYPES } from '../lib/colors';
import { cacheHitRate, type Bucket, type Data, type SeriesDef } from '../lib/data';
import { compact, dateTime, duration, full, pct, timeOfDay, usd } from '../lib/format';
import { href } from '../lib/router';
import { useData, useDrawer } from '../lib/store';
import { BarList } from './charts/BarList';
import { Legend } from './charts/Legend';
import { TimeSeriesChart } from './charts/TimeSeriesChart';
import { ProviderDot, SourceBadge } from './ui';

export function SessionDrawer() {
  const { sessionKey, openSession } = useDrawer();
  const { data } = useData();
  useEffect(() => {
    if (!sessionKey) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openSession(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sessionKey, openSession]);
  if (!sessionKey || !data) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Session details">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={() => openSession(null)} />
      <div className="fade-in scrollbar-thin absolute inset-y-0 right-0 w-full max-w-[640px] overflow-y-auto border-l border-line bg-page shadow-[var(--shadow-pop)]">
        <SessionBody data={data} sessionKey={sessionKey} onClose={() => openSession(null)} />
      </div>
    </div>
  );
}

function SessionBody({ data, sessionKey, onClose }: { data: Data; sessionKey: string; onClose: () => void }) {
  const s = data.sessionByKey.get(sessionKey);
  const { sessionDetail } = useData();
  const [detail, setDetail] = useState<SessionDetail>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setError(undefined);
    sessionDetail(sessionKey)
      .then((d) => {
        if (cancelled) return;
        if (d) setDetail(d);
        else setError('not found');
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionKey, sessionDetail]);

  const chart = useMemo(() => {
    if (!detail) return undefined;
    const series: SeriesDef[] = TOKEN_TYPES.map((t) => ({ key: t.key, label: t.label, color: t.color }));
    const buckets: Bucket[] = detail.events.map((e, i) => ({
      start: i,
      end: i,
      label: `Request ${i + 1} · ${timeOfDay(e.ts)} · ${e.model}${e.sidechain ? ' · sub-agent' : ''}`,
      short: timeOfDay(e.ts),
      values: [e.cacheRead, e.cacheWrite, e.input, e.output],
      total: e.cacheRead + e.cacheWrite + e.input + e.output,
    }));
    return { series, buckets };
  }, [detail]);

  if (!s) {
    return (
      <div className="p-6">
        <button type="button" onClick={onClose} className="float-right rounded-lg p-1.5 hover:bg-surface" aria-label="Close">
          <X size={18} />
        </button>
        <p className="text-[14px] text-muted">This session is no longer in the dataset.</p>
      </div>
    );
  }

  const source = data.sourceIds[s.src];
  const project = data.projects[s.proj];
  const tokens = s.input + s.output + s.cacheRead + s.cacheWrite;
  const totals = { ...s, tokens };
  const tools = s.tools.map(([name, count]) => ({
    key: name,
    label: name.startsWith('mcp__') ? name.replace(/^mcp__/, 'mcp · ').replace(/__/g, ' · ') : name,
    value: count,
    display: full(count),
    color: SLOTS[0],
  }));

  return (
    <div className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SourceBadge source={source} />
            {s.models.slice(0, 3).map((m) => (
              <span key={m} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2">
                <ProviderDot provider={data.models[m].provider} size={6} />
                {data.models[m].label}
              </span>
            ))}
          </div>
          <h2 className="text-[18px] font-semibold leading-snug tracking-[-0.01em]">{s.title || 'Untitled session'}</h2>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-1.5 text-ink-2 hover:bg-surface" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
        <Meta icon={<FolderGit2 size={14} />} label="Project">
          <a href={href({ page: 'project', key: project.key })} onClick={onClose} className="font-medium text-ink hover:underline">
            {project.name}
          </a>
          {project.path && <span className="ml-1.5 text-muted">{project.path}</span>}
        </Meta>
        <Meta icon={<Clock size={14} />} label="When">
          {dateTime(s.start)} · {duration(s.end - s.start)}
        </Meta>
        {s.branch && (
          <Meta icon={<GitBranch size={14} />} label="Branch">
            <span className="font-mono text-[12px]">{s.branch}</span>
          </Meta>
        )}
        {(s.entrypoint || s.version) && (
          <Meta icon={<Terminal size={14} />} label="Client">
            {[s.entrypoint, s.version && `v${s.version}`].filter(Boolean).join(' · ')}
          </Meta>
        )}
      </dl>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Tokens" value={compact(tokens)} />
        <Stat label="Est. cost" value={usd(s.cost)} />
        <Stat label={s.estimated ? 'Replies' : 'Requests'} value={full(s.requests)} />
        <Stat label="Cache hit" value={pct(cacheHitRate(totals))} />
      </div>

      {s.subagentTokens > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-[12.5px] text-ink-2">
          <Layers size={14} className="text-muted" aria-hidden />
          Sub-agents used <span className="font-semibold text-ink">{compact(s.subagentTokens)}</span> tokens (
          {pct(s.subagentTokens / (tokens || 1))} of this session).
        </div>
      )}

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[14px] font-semibold">{s.estimated ? 'Tokens per reply (estimated)' : 'Tokens per request'}</h3>
          <span className="text-[12px] text-muted">{detail ? `${detail.events.length} ${s.estimated ? 'replies' : 'requests'}` : ''}</span>
        </div>
        {chart && <Legend series={chart.series} hidden={hidden} onChange={setHidden} />}
        <div className="card mt-3 p-3">
          {error && <p className="py-8 text-center text-[13px] text-muted">Could not load the timeline.</p>}
          {!detail && !error && <div className="h-[220px] animate-pulse rounded-lg bg-surface-2" />}
          {chart && (
            <TimeSeriesChart
              buckets={chart.buckets}
              series={chart.series}
              kind="bar"
              height={220}
              format={(v) => compact(v)}
              hidden={hidden}
            />
          )}
        </div>
        <p className="mt-2 text-[12px] text-muted">
          {s.estimated
            ? 'Each bar is one reply. Chat exports have no token counts, so these are estimated from message length: each reply re-reads the conversation so far.'
            : 'Each bar is one model response. Cache reads grow as the conversation gets longer; a drop usually means the context was compacted.'}
        </p>
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-[14px] font-semibold">Tools used</h3>
        <div className="card p-2">
          <BarList items={tools} emptyLabel="No tool calls recorded" limit={10} />
        </div>
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-[14px] font-semibold">Token breakdown</h3>
        <div className="card divide-y divide-[var(--border)] text-[13px]">
          {[
            ['Input (uncached)', s.input],
            ['Cache writes', s.cacheWrite],
            ['Cache reads', s.cacheRead],
            ['Output', s.output],
            ['  of which reasoning', s.reasoning],
          ].map(([label, v]) => (
            <div key={label as string} className="flex items-center justify-between px-4 py-2">
              <span className="whitespace-pre text-ink-2">{label}</span>
              <span className="tnum font-medium">{full(v as number)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 font-mono text-[11px] text-muted">{s.id}</p>
      </section>
    </div>
  );
}

function Meta({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 text-muted" aria-hidden>
        {icon}
      </span>
      <dt className="sr-only">{label}</dt>
      <dd className="min-w-0 truncate text-ink-2">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em]">{value}</div>
    </div>
  );
}
