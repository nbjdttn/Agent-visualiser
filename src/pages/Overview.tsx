import { useMemo } from 'react';
import { PROVIDER_LABEL, type Provider } from '../../shared/types';
import { PROVIDER_COLOR } from '../lib/colors';
import {
  applyFilters,
  cacheHitRate,
  delta,
  filterSessions,
  groupBy,
  previousRange,
  presetLabel,
  sparkValues,
  sum,
  type Data,
} from '../lib/data';
import { compact, full, pct, usd } from '../lib/format';
import { useData, useFilters } from '../lib/store';
import { CalendarCard, HourCard, ModelsCard, MonthlyCard, ProjectsCard, RecentSessionsCard, ToolsCard } from '../components/cards';
import { SegmentedBar } from '../components/charts/SegmentedBar';
import { LiveStrip } from '../components/Live';
import { StatTile } from '../components/StatTile';
import { UsageOverTime } from '../components/UsageOverTime';
import { Card, Delta } from '../components/ui';

export function OverviewPage({ data }: { data: Data }) {
  const { live, refetching } = useData();
  const { filters, range } = useFilters();
  const prev = useMemo(() => previousRange(range), [range]);
  const facts = useMemo(() => applyFilters(data, filters, range), [data, filters, range]);
  const prevFacts = useMemo(() => applyFilters(data, filters, prev), [data, filters, prev]);
  const sessions = useMemo(() => filterSessions(data, filters, range), [data, filters, range]);
  const prevSessions = useMemo(() => filterSessions(data, filters, prev), [data, filters, prev]);
  const t = useMemo(() => sum(facts), [facts]);
  const p = useMemo(() => sum(prevFacts), [prevFacts]);
  const byProvider = useMemo(() => groupBy(facts, (f) => f.provider), [facts]);
  const projects = useMemo(() => groupBy(facts, (f) => f.proj), [facts]);
  const prevProjects = useMemo(() => groupBy(prevFacts, (f) => f.proj), [prevFacts]);
  const sparkTokens = useMemo(() => sparkValues(facts, range, 'tokens'), [facts, range]);
  const sparkCost = useMemo(() => sparkValues(facts, range, 'cost'), [facts, range]);
  const sparkReq = useMemo(() => sparkValues(facts, range, 'requests'), [facts, range]);
  const topProject = [...projects.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0];
  const agentFacts = useMemo(() => facts.filter((f) => f.hour >= 0), [facts]);

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      {live && <LiveStrip live={live} />}

      <div className="grid gap-4 lg:grid-cols-12 lg:gap-5">
        <Card className={`flex flex-col justify-between gap-5 p-5 lg:col-span-5 ${refetching ? 'refetching' : ''}`}>
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-ink-2">Tokens · {presetLabel(filters).toLowerCase()}</span>
              <Delta value={delta(t.tokens, p.tokens)} label="vs previous" />
            </div>
            <div className="mt-2 flex items-end gap-3">
              <div className="text-[52px] font-semibold leading-[0.95] tracking-[-0.035em]" title={`${full(t.tokens)} tokens`}>
                {compact(t.tokens)}
              </div>
            </div>
            <p className="mt-2 text-[13px] text-ink-2">
              <span className="font-semibold text-ink">{usd(t.cost)}</span> estimated ·{' '}
              <span className="font-semibold text-ink">{full(t.requests)}</span> requests ·{' '}
              <span className="font-semibold text-ink">{full(sessions.length)}</span> agent sessions
            </p>
          </div>
          <div>
            <SegmentedBar
              parts={(['anthropic', 'openai'] as Provider[]).map((pr) => ({
                key: pr,
                label: PROVIDER_LABEL[pr],
                value: byProvider.get(pr)?.tokens ?? 0,
                display: compact(byProvider.get(pr)?.tokens ?? 0),
                color: PROVIDER_COLOR[pr],
              }))}
            />
          </div>
          <div className="grid grid-cols-4 gap-2 border-t border-line pt-4">
            {[
              ['Input', t.input],
              ['Output', t.output],
              ['Cache read', t.cacheRead],
              ['Cache write', t.cacheWrite],
            ].map(([label, v]) => (
              <div key={label as string} className="min-w-0">
                <div className="truncate text-[11.5px] text-muted">{label}</div>
                <div className="tnum mt-0.5 text-[15px] font-semibold">{compact(v as number)}</div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:col-span-7 lg:gap-5 xl:grid-cols-3">
          <StatTile label="Estimated cost" value={usd(t.cost)} delta={delta(t.cost, p.cost)} spark={sparkCost} hint="at public API prices" />
          <StatTile label="Total tokens" value={compact(t.tokens)} delta={delta(t.tokens, p.tokens)} spark={sparkTokens} hint={`${compact(t.tokens / Math.max(1, range.days))} per day`} />
          <StatTile label="Requests" value={compact(t.requests)} delta={delta(t.requests, p.requests)} spark={sparkReq} hint="model responses" />
          <StatTile
            label="Agent sessions"
            value={full(sessions.length)}
            delta={delta(sessions.length, prevSessions.length)}
            hint={sessions.length ? `${compact(sessions.reduce((s, x) => s + x.input + x.output + x.cacheRead + x.cacheWrite, 0) / sessions.length)} tokens each` : 'none yet'}
          />
          <StatTile
            label="Active projects"
            value={full(projects.size)}
            delta={delta(projects.size, prevProjects.size)}
            hint={topProject ? `Top: ${data.projects[topProject[0]].name}` : '–'}
          />
          <StatTile
            label="Cache hit rate"
            value={pct(cacheHitRate(t))}
            delta={cacheHitRate(p) ? cacheHitRate(t) - cacheHitRate(p) : undefined}
            good="up"
            hint="prompt tokens read from cache"
          />
        </div>
      </div>

      <UsageOverTime data={data} facts={facts} range={range} refetching={refetching} />

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <ModelsCard data={data} facts={facts} refetching={refetching} />
        <ProjectsCard data={data} facts={facts} refetching={refetching} />
      </div>

      <div className="grid gap-4 lg:gap-5 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <CalendarCard facts={facts} range={range} sessions={sessions} refetching={refetching} />
        </div>
        <div className="xl:col-span-2">
          <HourCard facts={agentFacts} refetching={refetching} />
        </div>
      </div>

      <div className="grid gap-4 lg:gap-5 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          <RecentSessionsCard data={data} sessions={sessions} refetching={refetching} />
        </div>
        <div className="xl:col-span-2">
          <ToolsCard data={data} sessions={sessions} refetching={refetching} />
        </div>
      </div>

      <MonthlyCard facts={facts} sessions={sessions} refetching={refetching} />
    </div>
  );
}
