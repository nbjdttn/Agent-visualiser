import { useMemo } from 'react';
import { PROVIDER_LABEL, SOURCE_META, type ProjectInfo, type Provider, type SessionInfo } from '../../shared/types';
import { PROVIDER_COLOR } from '../lib/colors';
import {
  addInto,
  dailyTotals,
  emptyTotals,
  groupBy,
  hourMatrix,
  type Data,
  type Fact,
  type Range,
  type Totals,
} from '../lib/data';
import { compact, dayLabel, duration, monthLabel, pct, relative, usd } from '../lib/format';
import { href } from '../lib/router';
import { useDrawer, useFilters } from '../lib/store';
import { monthStart } from '../lib/time';
import { ChartCard } from './ChartCard';
import { BarList, type BarItem } from './charts/BarList';
import { CalendarHeatmap, HourHeatmap, ScaleLegend } from './charts/Heatmaps';
import { TooltipRow } from './charts/Tooltip';
import { DataTable, type Column } from './DataTable';
import { Card, CardHeader, Delta, ProviderDot, SourceBadge } from './ui';

/** A short description under a project's name. */
export function projectSubtitle(p: ProjectInfo): string {
  switch (p.kind) {
    case 'folder':
      return p.path ?? 'Folder';
    case 'repo':
      return p.path ? `${p.path} · cloud sessions` : 'Cloud sessions without a repository';
    case 'openai-project':
      return 'OpenAI API project';
    case 'anthropic-workspace':
      return 'Anthropic API workspace';
    case 'chat-project':
      return p.provider === 'openai' ? 'ChatGPT project or GPT' : 'Claude project';
    case 'chats':
      return p.provider === 'openai' ? 'ChatGPT chats outside projects' : 'claude.ai chats outside projects';
  }
}

export function ModelsCard({ data, facts, refetching }: { data: Data; facts: Fact[]; refetching?: boolean }) {
  const { filters, setFilters } = useFilters();
  const items: BarItem[] = useMemo(() => {
    const by = groupBy(facts, (f) => f.model);
    return [...by.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([i, t]) => {
        const m = data.models[i];
        return {
          key: m.id,
          label: m.label,
          title: m.id,
          sublabel: PROVIDER_LABEL[m.provider],
          value: t.tokens,
          display: compact(t.tokens),
          secondary: usd(t.cost),
          color: PROVIDER_COLOR[m.provider],
          icon: <ProviderDot provider={m.provider} />,
          active: filters.model === m.id,
        };
      });
  }, [data, facts, filters.model]);
  return (
    <ChartCard
      title="Models"
      refetching={refetching}
      table={() => <SimpleTable rows={items.map((i) => [String(i.label), i.display, i.secondary ?? ''])} headers={['Model', 'Tokens', 'Est. cost']} />}
    >
      <BarList items={items} onSelect={(key) => setFilters({ model: filters.model === key ? null : key })} emptyLabel="No model usage in this period" />
    </ChartCard>
  );
}

export function projectSegments(facts: Fact[]) {
  const by = new Map<number, Record<Provider, number>>();
  for (const f of facts) {
    let r = by.get(f.proj);
    if (!r) by.set(f.proj, (r = { anthropic: 0, openai: 0 }));
    r[f.provider] += f.tokens;
  }
  return by;
}

export function ProjectsCard({ data, facts, refetching }: { data: Data; facts: Fact[]; refetching?: boolean }) {
  const items: BarItem[] = useMemo(() => {
    const by = groupBy(facts, (f) => f.proj);
    const split = projectSegments(facts);
    return [...by.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([i, t]) => {
        const p = data.projects[i];
        const s = split.get(i)!;
        return {
          key: p.key,
          label: p.name,
          title: p.path ?? p.name,
          sublabel: projectSubtitle(p),
          value: t.tokens,
          display: compact(t.tokens),
          secondary: usd(t.cost),
          color: 'var(--s1)',
          segments: (['anthropic', 'openai'] as Provider[]).map((pr) => ({ value: s[pr], color: PROVIDER_COLOR[pr], label: PROVIDER_LABEL[pr] })),
        };
      });
  }, [data, facts]);
  return (
    <ChartCard
      title="Projects"
      refetching={refetching}
      actions={
        <a href="#/projects" className="text-[12px] font-medium text-ink-2 hover:text-ink">
          All projects →
        </a>
      }
      table={() => <SimpleTable rows={items.map((i) => [String(i.label), i.display, i.secondary ?? ''])} headers={['Project', 'Tokens', 'Est. cost']} />}
    >
      <BarList items={items} onSelect={(key) => (window.location.hash = href({ page: 'project', key }).slice(1))} emptyLabel="No project activity in this period" />
    </ChartCard>
  );
}

export function ToolsCard({ data, sessions, refetching }: { data: Data; sessions: SessionInfo[]; refetching?: boolean }) {
  const items: BarItem[] = useMemo(() => {
    const counts = new Map<string, { n: number; provider: Provider; source: string }>();
    for (const s of sessions) {
      const source = data.sourceIds[s.src];
      const provider = SOURCE_META[source].provider;
      for (const [name, n] of s.tools) {
        const k = `${source}:${name}`;
        const c = counts.get(k);
        if (c) c.n += n;
        else counts.set(k, { n, provider, source: SOURCE_META[source].short });
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([k, c]) => {
        const name = k.split(':').slice(1).join(':');
        return {
          key: k,
          label: name.startsWith('mcp__') ? name.replace(/^mcp__/, 'mcp · ').replace(/__/g, ' · ') : name,
          sublabel: c.source,
          value: c.n,
          display: c.n.toLocaleString('en-US'),
          color: PROVIDER_COLOR[c.provider],
          icon: <ProviderDot provider={c.provider} />,
        };
      });
  }, [data, sessions]);
  return (
    <ChartCard
      title="Tools"
      refetching={refetching}
      table={() => <SimpleTable rows={items.map((i) => [String(i.label), String(i.sublabel), i.display])} headers={['Tool', 'Agent', 'Calls']} />}
    >
      <BarList items={items} limit={6} emptyLabel="No tool calls recorded" />
    </ChartCard>
  );
}

export function CalendarCard({ facts, range, sessions, refetching }: { facts: Fact[]; range: Range; sessions: SessionInfo[]; refetching?: boolean }) {
  const daily = useMemo(() => dailyTotals(facts), [facts]);
  const values = useMemo(() => new Map([...daily.entries()].map(([d, t]) => [d, t.tokens])), [daily]);
  const sessionsByDay = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of sessions) {
      const d = new Date(s.start);
      const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
      m.set(day, (m.get(day) ?? 0) + 1);
    }
    return m;
  }, [sessions]);
  let busiest: [number, number] | undefined;
  for (const [d, v] of values) if (!busiest || v > busiest[1]) busiest = [d, v];
  const activeDays = [...values.values()].filter((v) => v > 0).length;
  return (
    <ChartCard
      title="Active days"
      subtitle={
        busiest
          ? `${activeDays} active day${activeDays === 1 ? '' : 's'}`
          : undefined
      }
      refetching={refetching}
      actions={<ScaleLegend />}
      table={() => (
        <SimpleTable
          headers={['Day', 'Tokens', 'Est. cost', 'Sessions']}
          rows={[...daily.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([d, t]) => [dayLabel(d, { weekday: true, year: true }), compact(t.tokens), usd(t.cost), String(sessionsByDay.get(d) ?? 0)])}
        />
      )}
    >
      <CalendarHeatmap
        from={range.from}
        to={range.to}
        values={values}
        format={compact}
        details={(day) => (
          <>
            <TooltipRow label="est. cost" value={usd(daily.get(day)?.cost ?? 0)} muted />
            <TooltipRow label="sessions started" value={String(sessionsByDay.get(day) ?? 0)} muted />
          </>
        )}
      />
    </ChartCard>
  );
}

export function HourCard({ facts, refetching }: { facts: Fact[]; refetching?: boolean }) {
  const matrix = useMemo(() => hourMatrix(facts, 'tokens'), [facts]);
  let peak = { r: 0, c: 0, v: 0 };
  matrix.forEach((row, r) => row.forEach((v, c) => v > peak.v && (peak = { r, c, v })));
  const days = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  const hour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  return (
    <ChartCard
      title="When you work"
      subtitle={peak.v ? `Busiest: ${days[peak.r]} ${hour(peak.c)}` : undefined}
      refetching={refetching}
      table={() => (
        <SimpleTable
          headers={['Day', ...Array.from({ length: 24 }, (_, h) => String(h))]}
          rows={matrix.map((row, r) => [days[r], ...row.map((v) => (v ? compact(v) : ''))])}
        />
      )}
    >
      <HourHeatmap matrix={matrix} format={compact} />
    </ChartCard>
  );
}

export function sessionColumns(data: Data, opts: { project?: boolean } = { project: true }): Column<SessionInfo>[] {
  const cols: Column<SessionInfo>[] = [
    {
      key: 'title',
      header: 'Session',
      cell: (s) => (
        <div className="min-w-[180px] max-w-[420px]">
          <div className="truncate font-medium text-ink">{s.title || 'Untitled session'}</div>
          {opts.project !== false && (
            <div className="truncate text-[12px] text-muted">
              {data.projects[s.proj]?.name}
              {s.branch ? ` · ${s.branch}` : ''}
            </div>
          )}
        </div>
      ),
      sort: (s) => s.title.toLowerCase(),
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: (s) => <SourceBadge source={data.sourceIds[s.src]} />,
      sort: (s) => s.src,
      hide: 'sm',
    },
    {
      key: 'model',
      header: 'Model',
      cell: (s) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-2">
          {s.models[0] !== undefined && <ProviderDot provider={data.models[s.models[0]].provider} size={6} />}
          {s.models[0] !== undefined ? data.models[s.models[0]].label : '–'}
          {s.models.length > 1 && <span className="text-muted">+{s.models.length - 1}</span>}
        </span>
      ),
      hide: 'lg',
    },
    {
      key: 'start',
      header: 'Started',
      cell: (s) => <span className="whitespace-nowrap text-ink-2">{relative(s.start)}</span>,
      sort: (s) => s.start,
      hide: 'md',
    },
    {
      key: 'duration',
      header: 'Duration',
      cell: (s) => <span className="whitespace-nowrap text-ink-2">{duration(s.end - s.start)}</span>,
      sort: (s) => s.end - s.start,
      align: 'right',
      hide: 'lg',
    },
    {
      key: 'tokens',
      header: 'Tokens',
      cell: (s) => <span className="font-medium">{compact(s.input + s.output + s.cacheRead + s.cacheWrite)}</span>,
      sort: (s) => s.input + s.output + s.cacheRead + s.cacheWrite,
      align: 'right',
    },
    {
      key: 'cost',
      header: 'Est. cost',
      cell: (s) => usd(s.cost),
      sort: (s) => s.cost,
      align: 'right',
    },
  ];
  return cols;
}

export function RecentSessionsCard({ data, sessions, refetching }: { data: Data; sessions: SessionInfo[]; refetching?: boolean }) {
  const { openSession } = useDrawer();
  const cols = useMemo<Column<SessionInfo>[]>(() => {
    const base = sessionColumns(data);
    const pick = (key: string) => base.find((c) => c.key === key)!;
    return [
      {
        key: 'title',
        header: 'Session',
        cell: (s) => (
          <div className="min-w-[160px] max-w-[340px]">
            <div className="truncate font-medium text-ink">{s.title || 'Untitled session'}</div>
            <div className="truncate text-[12px] text-muted">
              {data.projects[s.proj]?.name}
              {s.models[0] !== undefined ? ` · ${data.models[s.models[0]].label}` : ''}
              <span className="sm:hidden"> · {relative(s.start)}</span>
            </div>
          </div>
        ),
      },
      { ...pick('agent'), sort: undefined },
      { ...pick('start'), hide: 'sm', sort: undefined },
      { ...pick('tokens'), sort: undefined },
      { ...pick('cost'), sort: undefined, hide: 'sm' },
    ];
  }, [data]);
  return (
    <Card className={`flex flex-col p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
      <CardHeader
        title="Recent sessions & chats"
        subtitle={`${sessions.length.toLocaleString('en-US')} in this period`}
        actions={
          <a href="#/sessions" className="text-[12px] font-medium text-ink-2 hover:text-ink">
            All sessions →
          </a>
        }
      />
      <div className="-mx-3 mt-3">
        <DataTable
          columns={cols}
          rows={sessions.slice(0, 8)}
          rowKey={(s) => s.key}
          onRowClick={(s) => openSession(s.key)}
          emptyLabel="No sessions or chats in this period"
          dense
        />
      </div>
    </Card>
  );
}

export function MonthlyCard({ facts, sessions, refetching }: { facts: Fact[]; sessions: SessionInfo[]; refetching?: boolean }) {
  const rows = useMemo(() => {
    const by = new Map<number, { all: Totals; anthropic: Totals; openai: Totals; sessions: number }>();
    for (const f of facts) {
      const m = monthStart(f.day);
      let r = by.get(m);
      if (!r) by.set(m, (r = { all: emptyTotals(), anthropic: emptyTotals(), openai: emptyTotals(), sessions: 0 }));
      addInto(r.all, f);
      addInto(r[f.provider], f);
    }
    for (const s of sessions) {
      const d = new Date(s.start);
      const m = Date.UTC(d.getFullYear(), d.getMonth(), 1) / 86_400_000;
      const r = by.get(m);
      if (r) r.sessions++;
    }
    const list = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([month, r]) => ({ month, ...r }));
    return list.map((r, i) => ({ ...r, prev: i > 0 ? list[i - 1].all.tokens : undefined })).reverse();
  }, [facts, sessions]);
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'month', header: 'Month', cell: (r) => <span className="font-medium">{monthLabel(r.month)}</span>, sort: (r) => r.month },
    {
      key: 'anthropic',
      header: (
        <span className="inline-flex items-center gap-1.5">
          <ProviderDot provider="anthropic" size={6} />
          Claude
        </span>
      ),
      cell: (r) => compact(r.anthropic.tokens),
      sort: (r) => r.anthropic.tokens,
      align: 'right',
    },
    {
      key: 'openai',
      header: (
        <span className="inline-flex items-center gap-1.5">
          <ProviderDot provider="openai" size={6} />
          OpenAI
        </span>
      ),
      cell: (r) => compact(r.openai.tokens),
      sort: (r) => r.openai.tokens,
      align: 'right',
    },
    { key: 'tokens', header: 'Total tokens', cell: (r) => <span className="font-semibold">{compact(r.all.tokens)}</span>, sort: (r) => r.all.tokens, align: 'right' },
    { key: 'cost', header: 'Est. cost', cell: (r) => usd(r.all.cost), sort: (r) => r.all.cost, align: 'right' },
    { key: 'sessions', header: 'Sessions', cell: (r) => r.sessions.toLocaleString('en-US'), sort: (r) => r.sessions, align: 'right', hide: 'sm' },
    {
      key: 'cache',
      header: 'Cache hit',
      cell: (r) => pct(r.all.cacheRead / (r.all.input + r.all.cacheRead + r.all.cacheWrite || 1)),
      align: 'right',
      hide: 'md',
    },
    {
      key: 'delta',
      header: 'vs previous',
      cell: (r) => (r.prev === undefined ? <span className="text-muted">–</span> : <Delta value={r.prev ? (r.all.tokens - r.prev) / r.prev : Infinity} />),
      align: 'right',
      hide: 'sm',
    },
  ];
  return (
    <Card className={`p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
      <CardHeader
        title="Monthly totals"
        subtitle={
          rows.length > 1
            ? 'Tokens per provider and estimated cost, month by month'
            : 'Pick a longer date range (90 days, 1 year or all time) to compare months'
        }
      />
      <div className="-mx-3 mt-3">
        <DataTable columns={cols} rows={rows} rowKey={(r) => String(r.month)} emptyLabel="No usage in this period" />
      </div>
    </Card>
  );
}

export function SimpleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="text-left text-muted">
          {headers.map((h, i) => (
            <th key={h + i} className={`sticky top-0 bg-surface px-2 py-1.5 font-medium ${i ? 'text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-t border-line">
            {r.map((c, i) => (
              <td key={i} className={`px-2 py-1.5 ${i ? 'tnum text-right' : 'text-ink-2'}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
