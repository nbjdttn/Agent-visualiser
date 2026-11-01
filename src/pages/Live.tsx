import { Radio } from 'lucide-react';
import { PROVIDER_LABEL, type Provider } from '../../shared/types';
import { compact, full, relative, usd } from '../lib/format';
import { useData } from '../lib/store';
import { ActiveSessionCard, BlockCard, CodexLimitsCard } from '../components/Live';
import { MacLive } from '../components/MacCard';
import { Card, EmptyState, ProviderDot } from '../components/ui';

/** On the phone: your Mac's agents, through gentle mode's phone link. */
export function PhoneLivePage() {
  const { sync } = useData();
  if (!sync?.computers?.some((c) => c.control)) {
    return (
      <Card>
        <EmptyState title="Live needs your Mac's phone link" icon={<Radio size={22} />}>
          Install automatic updates and gentle mode on your Mac (<code className="font-mono">npm run sync -- install</code>,{' '}
          <code className="font-mono">npm run gentle -- install</code>); its agents then appear here, with their projects.
        </EmptyState>
      </Card>
    );
  }
  return <MacLive />;
}

export function LivePage() {
  const { live } = useData();
  if (!live) {
    return (
      <Card className="p-6">
        <div className="h-40 animate-pulse rounded-xl bg-surface-2" />
      </Card>
    );
  }
  const working = live.active.filter((a) => a.state === 'working');
  const idle = live.active.filter((a) => a.state === 'idle');
  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">
            {working.length ? `${working.length} agent${working.length > 1 ? 's' : ''} working` : 'No agents working right now'}
          </h2>
          <span className="text-[12px] text-muted">Updates every few seconds</span>
        </div>
        {live.active.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {[...working, ...idle].map((s) => (
              <ActiveSessionCard key={s.key} s={s} now={live.now} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState title="Nothing running" icon={<Radio size={22} />}>
              Start Claude Code or Codex in any folder and it appears here within seconds, with its project, model and token
              burn.
            </EmptyState>
          </Card>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <BlockCard
          title="Claude Code · 5-hour window"
          blocks={live.claudeBlocks}
          now={live.now}
          note="Claude subscription limits reset on 5-hour windows. Anthropic doesn't publish exact limits, so this compares the current window with your busiest earlier one rather than with a quota."
        />
        <CodexLimitsCard limits={live.codexLimits} now={live.now} />
        <BlockCard title="Codex · 5-hour window" blocks={live.codexBlocks} now={live.now} />
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold">Today so far</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {(['anthropic', 'openai'] as Provider[]).map((p) => (
            <Card key={p} className="flex items-center justify-between gap-4 p-5">
              <div>
                <div className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-2">
                  <ProviderDot provider={p} />
                  {PROVIDER_LABEL[p]}
                </div>
                <div className="mt-1.5 text-[30px] font-semibold leading-none tracking-[-0.02em]">{compact(live.today[p].tokens)}</div>
                <div className="mt-1 text-[12.5px] text-muted">tokens today</div>
              </div>
              <div className="text-right text-[13px]">
                <div className="font-semibold">{usd(live.today[p].cost)}</div>
                <div className="text-muted">est. cost</div>
                <div className="mt-2 font-semibold">{full(live.today[p].requests)}</div>
                <div className="text-muted">requests</div>
              </div>
            </Card>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-muted">Last updated {relative(live.now)}.</p>
      </section>
    </div>
  );
}
