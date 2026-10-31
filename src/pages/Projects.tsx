import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PROVIDER_LABEL, type Provider, type SourceId } from '../../shared/types';
import { PROVIDER_COLOR } from '../lib/colors';
import { applyFilters, filterSessions, groupBy, sparkValues, type Data } from '../lib/data';
import { compact, relative, usd } from '../lib/format';
import { href, navigate } from '../lib/router';
import { useData, useFilters } from '../lib/store';
import { ChartCard } from '../components/ChartCard';
import { projectSegments, projectSubtitle, SimpleTable } from '../components/cards';
import { SegmentedBar } from '../components/charts/SegmentedBar';
import { Sparkline } from '../components/charts/Sparkline';
import { Treemap } from '../components/charts/Treemap';
import { DataTable, type Column } from '../components/DataTable';
import { Card, CardHeader, Pill, SourceBadge } from '../components/ui';

interface Row {
  idx: number;
  key: string;
  name: string;
  path?: string;
  kind: string;
  tokens: number;
  cost: number;
  requests: number;
  sessions: number;
  last: number;
  split: Record<Provider, number>;
  sources: SourceId[];
  spark: number[];
}

export function ProjectsPage({ data }: { data: Data }) {
  const { refetching } = useData();
  const { filters, range } = useFilters();
  const [q, setQ] = useState('');
  const facts = useMemo(() => applyFilters(data, filters, range, { project: false }), [data, filters, range]);
  const sessions = useMemo(() => filterSessions(data, { ...filters, project: null }, range), [data, filters, range]);

  const rows: Row[] = useMemo(() => {
    const totals = groupBy(facts, (f) => f.proj);
    const split = projectSegments(facts);
    const bySource = new Map<number, Set<SourceId>>();
    const lastDay = new Map<number, number>();
    const factsByProj = new Map<number, typeof facts>();
    for (const f of facts) {
      let s = bySource.get(f.proj);
      if (!s) bySource.set(f.proj, (s = new Set()));
      s.add(f.source);
      lastDay.set(f.proj, Math.max(lastDay.get(f.proj) ?? 0, f.day));
      let list = factsByProj.get(f.proj);
      if (!list) factsByProj.set(f.proj, (list = []));
      list.push(f);
    }
    const sessionCount = new Map<number, number>();
    const lastSession = new Map<number, number>();
    for (const s of sessions) {
      sessionCount.set(s.proj, (sessionCount.get(s.proj) ?? 0) + 1);
      lastSession.set(s.proj, Math.max(lastSession.get(s.proj) ?? 0, s.end));
    }
    return [...totals.entries()].map(([idx, t]) => {
      const p = data.projects[idx];
      return {
        idx,
        key: p.key,
        name: p.name,
        path: p.path,
        kind: p.kind,
        tokens: t.tokens,
        cost: t.cost,
        requests: t.requests,
        sessions: sessionCount.get(idx) ?? 0,
        last: lastSession.get(idx) ?? (lastDay.get(idx) ?? 0) * 86_400_000,
        split: split.get(idx)!,
        sources: data.sourceIds.filter((s) => bySource.get(idx)?.has(s)),
        spark: sparkValues(factsByProj.get(idx) ?? [], range, 'tokens', 24),
      };
    });
  }, [data, facts, sessions, range]);

  const shown = rows.filter((r) => (r.name + ' ' + (r.path ?? '')).toLowerCase().includes(q.toLowerCase()));
  const treemapProjects = useMemo(
    () =>
      [...rows]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 40)
        .map((r) => ({
          key: r.key,
          name: r.name,
          path: r.path,
          parts: (['anthropic', 'openai'] as Provider[]).map((p) => ({ provider: p, value: r.split[p] })),
        })),
    [rows],
  );
  const total = rows.reduce((s, r) => s + r.tokens, 0);

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Project',
      cell: (r) => (
        <div className="min-w-[160px]">
          <a href={href({ page: 'project', key: r.key })} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </a>
          <div className="truncate text-[12px] text-muted">{projectSubtitle(data.projects[r.idx])}</div>
        </div>
      ),
      sort: (r) => r.name.toLowerCase(),
    },
    {
      key: 'sources',
      header: 'Used by',
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.sources.map((s) => (
            <SourceBadge key={s} source={s} />
          ))}
        </div>
      ),
      hide: 'md',
    },
    {
      key: 'split',
      header: 'Claude / OpenAI',
      cell: (r) => (
        <div className="w-[120px]">
          <SegmentedBar
            variant="thin"
            legend={false}
            parts={(['anthropic', 'openai'] as Provider[]).map((p) => ({
              key: p,
              label: PROVIDER_LABEL[p],
              value: r.split[p],
              display: compact(r.split[p]),
              color: PROVIDER_COLOR[p],
            }))}
          />
        </div>
      ),
      hide: 'lg',
    },
    { key: 'sessions', header: 'Sessions', cell: (r) => (r.sessions ? r.sessions.toLocaleString('en-US') : '–'), sort: (r) => r.sessions, align: 'right', hide: 'sm' },
    { key: 'tokens', header: 'Tokens', cell: (r) => <span className="font-semibold">{compact(r.tokens)}</span>, sort: (r) => r.tokens, align: 'right' },
    { key: 'cost', header: 'Est. cost', cell: (r) => usd(r.cost), sort: (r) => r.cost, align: 'right' },
    { key: 'last', header: 'Last active', cell: (r) => <span className="whitespace-nowrap text-ink-2">{relative(r.last)}</span>, sort: (r) => r.last, align: 'right', hide: 'md' },
    { key: 'trend', header: 'Trend', cell: (r) => <Sparkline values={r.spark} width={84} height={24} fill={false} />, hide: 'lg' },
  ];

  return (
    <div className="flex flex-col gap-5">
      <ChartCard
        title="Where your tokens go"
        subtitle={`${rows.length} projects · ${compact(total)} tokens · each block is a project, split by provider`}
        refetching={refetching}
        actions={
          <div className="flex items-center gap-3 text-[12px] text-ink-2">
            {(['anthropic', 'openai'] as Provider[]).map((p) => (
              <span key={p} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: PROVIDER_COLOR[p] }} />
                {PROVIDER_LABEL[p]}
              </span>
            ))}
          </div>
        }
        table={() => (
          <SimpleTable
            headers={['Project', 'Claude', 'OpenAI', 'Total']}
            rows={[...rows].sort((a, b) => b.tokens - a.tokens).map((r) => [r.name, compact(r.split.anthropic), compact(r.split.openai), compact(r.tokens)])}
          />
        )}
      >
        {rows.length ? (
          <Treemap projects={treemapProjects} format={compact} onSelect={(key) => navigate({ page: 'project', key })} />
        ) : (
          <p className="py-16 text-center text-[13px] text-muted">No project activity in this period</p>
        )}
      </ChartCard>

      <Card className={`p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
        <CardHeader
          title="All projects"
          subtitle="Folders your agents worked in, ChatGPT and Claude projects, and API projects"
          actions={
            <label className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search projects"
                className="h-8 w-[220px] rounded-[10px] border border-line bg-surface-2 pl-8 pr-3 text-[13px] text-ink placeholder:text-muted"
              />
            </label>
          }
        />
        <div className="-mx-3 mt-3">
          <DataTable
            columns={columns}
            rows={shown}
            rowKey={(r) => r.key}
            onRowClick={(r) => navigate({ page: 'project', key: r.key })}
            initialSort={{ key: 'tokens', dir: 'desc' }}
            pageSize={25}
            emptyLabel="No projects match"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 px-1 text-[12px] text-muted">
          <Pill>Folders come from Claude Code and Codex logs</Pill>
          <Pill>ChatGPT projects, custom GPTs and Claude projects come from your chat exports</Pill>
        </div>
      </Card>
    </div>
  );
}
