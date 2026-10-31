import { ArrowLeft, FolderGit2, GitBranch, Globe } from 'lucide-react';
import { useMemo } from 'react';
import { applyFilters, cacheHitRate, delta, filterSessions, previousRange, sum, type Data } from '../lib/data';
import { compact, full, pct, relative, usd } from '../lib/format';
import { useData, useDrawer, useFilters } from '../lib/store';
import { CalendarCard, HourCard, ModelsCard, sessionColumns, ToolsCard } from '../components/cards';
import { DataTable } from '../components/DataTable';
import { StatTile } from '../components/StatTile';
import { UsageOverTime } from '../components/UsageOverTime';
import { Card, CardHeader, EmptyState, Pill, ProviderBadge, SourceBadge } from '../components/ui';

export function ProjectDetailPage({ data, projectKey }: { data: Data; projectKey: string }) {
  const { refetching } = useData();
  const { filters, range } = useFilters();
  const { openSession } = useDrawer();
  const idx = data.projectByKey.get(projectKey);
  const scoped = useMemo(() => ({ ...filters, project: projectKey }), [filters, projectKey]);
  const facts = useMemo(() => (idx === undefined ? [] : applyFilters(data, scoped, range)), [data, scoped, range, idx]);
  const prevFacts = useMemo(() => (idx === undefined ? [] : applyFilters(data, scoped, previousRange(range))), [data, scoped, range, idx]);
  const sessions = useMemo(() => (idx === undefined ? [] : filterSessions(data, scoped, range)), [data, scoped, range, idx]);
  const allTime = useMemo(() => (idx === undefined ? [] : data.facts.filter((f) => f.proj === idx)), [data, idx]);
  const cols = useMemo(() => sessionColumns(data, { project: false }), [data]);

  if (idx === undefined) {
    return (
      <Card>
        <EmptyState title="Project not found">
          It may have been renamed or have no usage yet. <a href="#/projects" className="underline">Back to projects</a>
        </EmptyState>
      </Card>
    );
  }

  const p = data.projects[idx];
  const isFolder = p.kind === 'folder';
  const t = sum(facts);
  const prev = sum(prevFacts);
  const sources = [...new Set(allTime.map((f) => f.source))];
  const providers = [...new Set(allTime.map((f) => f.provider))];
  const first = allTime.reduce((m, f) => Math.min(m, f.day), Infinity);
  const lastSession = data.sessions.filter((s) => s.proj === idx).reduce((m, s) => Math.max(m, s.end), 0);
  const activeDays = new Set(facts.map((f) => f.day)).size;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <a href="#/projects" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
          <ArrowLeft size={14} /> Projects
        </a>
        <Card className="mt-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2">
                {p.kind === 'folder' ? <FolderGit2 size={18} /> : <Globe size={18} />}
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-[20px] font-semibold tracking-[-0.02em]">{p.name}</h2>
                <p className="truncate font-mono text-[12px] text-muted">
                  {p.path ?? (p.kind === 'openai-project' ? 'OpenAI API project' : 'Anthropic API workspace')}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {providers.map((pr) => (
                    <ProviderBadge key={pr} provider={pr} />
                  ))}
                  {sources.map((s) => (
                    <SourceBadge key={s} source={s} />
                  ))}
                  {p.repo && <Pill>{p.repo}</Pill>}
                  {p.branches?.slice(0, 6).map((b) => (
                    <Pill key={b}>
                      <GitBranch size={11} aria-hidden /> {b}
                    </Pill>
                  ))}
                </div>
              </div>
            </div>
            <div className="text-right text-[12.5px] text-muted">
              {Number.isFinite(first) && <div>First seen {relative(first * 86_400_000)}</div>}
              {lastSession > 0 && <div>Last session {relative(lastSession)}</div>}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Tokens" value={compact(t.tokens)} delta={delta(t.tokens, prev.tokens)} />
        <StatTile label="Estimated cost" value={usd(t.cost)} delta={delta(t.cost, prev.cost)} />
        {isFolder ? (
          <StatTile label="Sessions" value={full(sessions.length)} hint={`${activeDays} active days`} />
        ) : (
          <StatTile label="Active days" value={full(activeDays)} hint={`of ${range.days} in this period`} />
        )}
        {t.requests > 0 ? (
          <StatTile label="Requests" value={compact(t.requests)} delta={delta(t.requests, prev.requests)} />
        ) : (
          <StatTile label="Output tokens" value={compact(t.output)} delta={delta(t.output, prev.output)} />
        )}
        <StatTile label="Cache hit rate" value={pct(cacheHitRate(t))} good="up" hint="prompt tokens read from cache" />
      </div>

      <UsageOverTime
        data={data}
        facts={facts}
        range={range}
        splits={['model', 'source', 'provider', 'tokenType']}
        defaultSplit="model"
        refetching={refetching}
      />

      {isFolder ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
            <ModelsCard data={data} facts={facts} refetching={refetching} />
            <ToolsCard data={data} sessions={sessions} refetching={refetching} />
          </div>

          <div className="grid gap-4 lg:gap-5 xl:grid-cols-5">
            <div className="xl:col-span-3">
              <CalendarCard facts={facts} range={range} sessions={sessions} refetching={refetching} />
            </div>
            <div className="xl:col-span-2">
              <HourCard facts={facts.filter((f) => f.hour >= 0)} refetching={refetching} />
            </div>
          </div>

          <Card className="p-4 sm:p-5">
            <CardHeader title="Sessions in this project" subtitle={`${sessions.length} sessions in this period`} />
            <div className="-mx-3 mt-3">
              <DataTable
                columns={cols}
                rows={sessions}
                rowKey={(s) => s.key}
                onRowClick={(s) => openSession(s.key)}
                initialSort={{ key: 'start', dir: 'desc' }}
                pageSize={20}
                emptyLabel="No sessions in this period"
              />
            </div>
          </Card>
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
          <ModelsCard data={data} facts={facts} refetching={refetching} />
          <CalendarCard facts={facts} range={range} sessions={[]} refetching={refetching} />
        </div>
      )}
    </div>
  );
}
