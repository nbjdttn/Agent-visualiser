import { ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SessionInfo } from '../../shared/types';
import type { Data } from '../lib/data';
import { full } from '../lib/format';
import { useData, useDrawer } from '../lib/store';
import { sessionColumns } from './cards';
import { DataTable } from './DataTable';
import { Card, CardHeader } from './ui';

/** Every session in the period, searchable; tap one for its detail. */
export function AllSessionsCard({ data, sessions }: { data: Data; sessions: SessionInfo[] }) {
  const { refetching } = useData();
  const { openSession } = useDrawer();
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
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

  return (
    <Card className={`p-4 sm:p-5 ${refetching ? 'refetching' : ''}`}>
      <button type="button" onClick={() => setShowAll((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={showAll}>
        <CardHeader title="All sessions" subtitle={`${full(sessions.length)} in this period`} />
        <ChevronDown size={20} className={`shrink-0 text-ink-2 transition-transform ${showAll ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {showAll && (
        <>
          <label className="relative mt-3 block">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="h-10 w-full rounded-xl border border-line bg-surface-2 pl-9 pr-3 text-[16px] text-ink placeholder:text-muted lg:h-8 lg:w-[280px] lg:text-[13px]"
            />
          </label>
          <div className="-mx-3 mt-3">
            <DataTable
              columns={cols}
              rows={shown}
              rowKey={(s) => s.key}
              onRowClick={(s) => openSession(s.key)}
              initialSort={{ key: 'start', dir: 'desc' }}
              pageSize={40}
              emptyLabel="Nothing matches"
            />
          </div>
        </>
      )}
    </Card>
  );
}
