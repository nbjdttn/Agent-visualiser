import { CheckCircle2, CircleDashed, KeyRound, Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { SOURCE_META, type SourceStatus } from '../../shared/types';
import type { Data } from '../lib/data';
import { dateTime, relative } from '../lib/format';
import { Card, CardHeader, Kbd, ProviderDot } from '../components/ui';

function StatusIcon({ s }: { s: SourceStatus }) {
  if (s.error) return <TriangleAlert size={16} className="text-serious" aria-label="Error" />;
  if (s.connected) return <CheckCircle2 size={16} className="text-good" aria-label="Connected" />;
  return <CircleDashed size={16} className="text-muted" aria-label="Not connected" />;
}

export function SourcesPage({ data }: { data: Data }) {
  const ds = data.raw;
  return (
    <div className="flex flex-col gap-5">
      {ds.demo && (
        <Card className="border-dashed p-5">
          <h2 className="text-[15px] font-semibold">You are looking at demo data</h2>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-2">
            Nothing was found on this machine yet, so the dashboard shows a generated history. It switches to your real usage
            automatically as soon as Claude Code or Codex logs appear, or when you add an admin key. Run{' '}
            <Kbd>npm run dev</Kbd> without <Kbd>--demo</Kbd> and set <Kbd>DEMO=0</Kbd> to turn the demo off for good.
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {ds.sources.map((s) => (
          <Card key={s.id} className="flex flex-col gap-3 p-5">
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
              {s.updatedAt && (
                <>
                  <dt className="text-muted">Checked</dt>
                  <dd className="text-ink-2">{relative(s.updatedAt)}</dd>
                </>
              )}
            </dl>
            {s.error && (
              <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11.5px] text-ink-2">{s.error}</p>
            )}
            {s.hint && <p className="text-[12.5px] leading-relaxed text-ink-2">{s.hint}</p>}
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <CardHeader title="How costs are estimated" />
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Every response is priced from its token counts with public per-token prices (cache writes and reads included,
            long-prompt tiers and fast mode applied where the logs say so). On a Claude or ChatGPT subscription this is the
            API-equivalent value of your usage, not what you pay.
          </p>
          <p className="mt-3 text-[12.5px] text-muted">
            Prices: {ds.pricing.source === 'litellm' ? 'LiteLLM price list, fetched today' : ds.pricing.source === 'litellm-cache' ? 'LiteLLM price list (cached)' : 'bundled snapshot'}
            {ds.pricing.updatedAt ? `, updated ${relative(ds.pricing.updatedAt)}` : ''}.
          </p>
          {ds.pricing.unpriced.length > 0 && (
            <p className="mt-2 text-[12.5px] text-ink-2">
              No price found for: <span className="font-mono text-[11.5px]">{ds.pricing.unpriced.join(', ')}</span>. Their tokens
              count, their cost shows as $0.
            </p>
          )}
        </Card>
        <Card className="p-5">
          <CardHeader title="How tokens are counted" />
          <ul className="mt-2 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink-2">
            <li>
              <b className="font-medium text-ink">Input</b>: new prompt tokens that were not served from cache.
            </li>
            <li>
              <b className="font-medium text-ink">Cache write / read</b>: prompt tokens stored in or re-read from the prompt
              cache. Agents re-read their whole context on every step, so cache reads usually dominate.
            </li>
            <li>
              <b className="font-medium text-ink">Output</b>: generated tokens, including reasoning.
            </li>
          </ul>
        </Card>
        <Card className="p-5">
          <CardHeader title="Privacy" />
          <ul className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            <li className="flex gap-2">
              <Lock size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
              <span>Logs are read on this machine and never leave it. The browser gets totals and session titles from your own server.</span>
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
          </ul>
        </Card>
      </div>

      <Card className="p-5">
        <CardHeader title="Double counting" />
        <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-ink-2">
          If Claude Code or Codex runs on an API key from the same organisation as your admin key, that usage appears twice: once
          from the local logs (by folder) and once in the organisation report (by workspace or project). Use the Sources filter
          at the top to look at one side at a time. Subscription usage (Claude Pro/Max, ChatGPT plans) only appears in the local
          logs.
        </p>
        <p className="mt-3 text-[12px] text-muted">Data built {relative(ds.generatedAt)} · time zone {ds.timezone}</p>
      </Card>
    </div>
  );
}
