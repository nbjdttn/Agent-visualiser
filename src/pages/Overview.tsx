import { useMemo } from 'react';
import type { Provider } from '../../shared/types';
import {
  applyFilters,
  delta,
  filterSessions,
  groupBy,
  previousRange,
  presetLabel,
  sessionCounts,
  sum,
  trendBuckets,
  type Data,
} from '../lib/data';
import { compact, dayLabel, full, usd } from '../lib/format';
import { useData, useFilters } from '../lib/store';
import { HeroCard } from '../components/Hero';
import { CalendarCard, HourCard, ModelsCard, ProjectsCard } from '../components/cards';
import { LiveStrip } from '../components/Live';
import { MacCard } from '../components/MacCard';
import { BiggestSessionsCard, CostCard, MonthsCard } from '../components/overviewCards';
import { StatTile } from '../components/StatTile';
import { UsageOverTime } from '../components/UsageOverTime';
import { Delta } from '../components/ui';

export function OverviewPage({ data }: { data: Data }) {
  const { live, refetching, sync } = useData();
  const { filters, range, today } = useFilters();
  const prev = useMemo(() => previousRange(range), [range]);
  const facts = useMemo(() => applyFilters(data, filters, range), [data, filters, range]);
  const prevFacts = useMemo(() => applyFilters(data, filters, prev), [data, filters, prev]);
  const sessions = useMemo(() => filterSessions(data, filters, range), [data, filters, range]);
  const prevSessions = useMemo(() => filterSessions(data, filters, prev), [data, filters, prev]);
  const t = useMemo(() => sum(facts), [facts]);
  const p = useMemo(() => sum(prevFacts), [prevFacts]);
  const trend = useMemo(() => trendBuckets(facts, range), [facts, range]);
  const byProvider = useMemo(() => {
    const totals = groupBy(facts, (f) => f.provider);
    return (['anthropic', 'openai'] as Provider[])
      .filter((pr) => filters.provider === 'all' || filters.provider === pr)
      .map((pr) => ({
        p: pr,
        tokens: totals.get(pr)?.tokens ?? 0,
        daily: trendBuckets(
          facts.filter((f) => f.provider === pr),
          range,
        ).totals.map((x) => x.tokens),
      }));
  }, [facts, range, filters.provider]);
  const sessionSpark = useMemo(() => sessionCounts(sessions, range), [sessions, range]);
  const busiest = useMemo(() => [...groupBy(facts, (f) => f.day).entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0], [facts]);
  const agentFacts = useMemo(() => facts.filter((f) => f.hour >= 0), [facts]);
  const perDay = (x: number, days: number) => x / Math.max(1, days);

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      {live && <LiveStrip live={live} />}
      <MacCard />

      <div className="grid gap-4 lg:grid-cols-12 lg:gap-5">
        <div className={`lg:col-span-7 ${refetching ? 'refetching' : ''}`}>
          <HeroCard
            label={presetLabel(filters)}
            tokens={t.tokens}
            cost={t.cost}
            change={<Delta value={delta(t.tokens, p.tokens)} />}
            byProvider={byProvider}
            trend={trend.labels}
            limits={sync?.limits}
          />
        </div>
        <div className="lg:col-span-5">
          <CalendarCard facts={facts} range={range} sessions={sessions} refetching={refetching} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-12 lg:gap-5">
        <div className="min-w-0 lg:col-span-7">
          <HourCard facts={agentFacts} refetching={refetching} />
        </div>
        <div className="grid grid-cols-2 gap-4 lg:col-span-5 lg:gap-5">
          <StatTile label="Cost" value={usd(t.cost)} delta={delta(t.cost, p.cost)} spark={trend.totals.map((x) => x.cost)} />
          <StatTile label="Sessions" value={full(sessions.length)} delta={delta(sessions.length, prevSessions.length)} spark={sessionSpark} />
          <StatTile
            label="Per day"
            value={compact(perDay(t.tokens, range.days))}
            delta={delta(perDay(t.tokens, range.days), perDay(p.tokens, prev.days))}
            spark={trend.totals.map((x) => x.tokens)}
          />
          <StatTile label="Busiest day" value={busiest ? compact(busiest[1].tokens) : '–'} hint={busiest ? dayLabel(busiest[0], { weekday: true }) : undefined} />
        </div>
      </div>

      <CostCard data={data} facts={facts} range={range} refetching={refetching} />

      <BiggestSessionsCard data={data} sessions={sessions} refetching={refetching} />

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <ProjectsCard data={data} facts={facts} refetching={refetching} />
        <ModelsCard data={data} facts={facts} refetching={refetching} />
      </div>

      <MonthsCard data={data} filters={filters} today={today} refetching={refetching} />

      <UsageOverTime data={data} facts={facts} range={range} title="Explore" refetching={refetching} />
    </div>
  );
}
