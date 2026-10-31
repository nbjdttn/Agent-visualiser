import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { filterSessions, type Data } from '../lib/data';
import { compact, usd } from '../lib/format';
import { useData, useDrawer, useFilters } from '../lib/store';
import { sessionColumns } from '../components/cards';
import { DataTable } from '../components/DataTable';
import { Card, CardHeader } from '../components/ui';

export function SessionsPage({ data }: { data: Data }) {
  const { refetching } = useData();
  const { filters, range } = useFilters();
  const { openSession } = useDrawer();
  const [q, setQ] = useState('');
  const sessions = useMemo(() => filterSessions(data, filters, range), [data, filters, range]);
  const cols = useMemo(() => sessionColumns(data), [data]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? sessions.filter((s) =>
        [s.title, data.projects[s.proj]?.name, data.projects[s.proj]?.path, s.branch, ...s.models.map((m) => data.models[m].label)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : sessions;
  const tokens = shown.reduce((s, x) => s + x.input + x.output + x.cacheRead + x.cacheWrite, 0);
  const cost = shown.reduce((s, x) => s + x.cost, 0);
  return (
    <Card className={`p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
      <CardHeader
        title="Agent sessions"
        subtitle={`${shown.length.toLocaleString('en-US')} sessions · ${compact(tokens)} tokens · ${usd(cost)} estimated`}
        actions={
          <label className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title, project, branch, model"
              className="h-8 w-[260px] max-w-full rounded-[10px] border border-line bg-surface-2 pl-8 pr-3 text-[13px] text-ink placeholder:text-muted"
            />
          </label>
        }
      />
      <div className="-mx-3 mt-3">
        <DataTable
          columns={cols}
          rows={shown}
          rowKey={(s) => s.key}
          onRowClick={(s) => openSession(s.key)}
          initialSort={{ key: 'start', dir: 'desc' }}
          pageSize={40}
          emptyLabel="No agent sessions match these filters"
        />
      </div>
    </Card>
  );
}
