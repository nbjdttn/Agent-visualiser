import clsx from 'clsx';
import { Boxes, CalendarDays, ChevronDown, Cpu, FolderGit2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PROVIDER_LABEL, SOURCE_META, type SourceId } from '../../shared/types';
import { PRESETS, presetLabel, sum, applyFilters, type Data } from '../lib/data';
import { compact, rangeLabel } from '../lib/format';
import { useData, useFilters } from '../lib/store';
import { fromIsoDate, isoDate } from '../lib/time';
import { MenuItem, Popover, TriggerButton } from './Popover';
import { ProviderDot, Segmented } from './ui';

/** One row of filters above the content; everything below re-renders against the same slice. */
export function FilterBar({ hideProject }: { hideProject?: boolean }) {
  const { data } = useData();
  const { filters, range, setFilters, resetFilters } = useFilters();
  const activeCount =
    (filters.provider !== 'all' ? 1 : 0) + (filters.sources.length ? 1 : 0) + (filters.project ? 1 : 0) + (filters.model ? 1 : 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangePicker />
      <Segmented
        label="Provider"
        value={filters.provider}
        onChange={(provider) => setFilters({ provider })}
        options={[
          { value: 'all', label: 'All' },
          {
            value: 'anthropic',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <ProviderDot provider="anthropic" size={7} />
                Claude
              </span>
            ),
          },
          {
            value: 'openai',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <ProviderDot provider="openai" size={7} />
                OpenAI
              </span>
            ),
          },
        ]}
      />
      {data && <SourcePicker data={data} />}
      {data && !hideProject && <ProjectPicker data={data} />}
      {data && <ModelPicker data={data} />}
      {activeCount > 0 && (
        <button type="button" onClick={resetFilters} className="ml-1 text-[12px] font-medium text-ink-2 hover:text-ink">
          Clear filters
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        Showing {rangeLabel(range.from, range.to)}
        {filters.provider !== 'all' ? `, ${PROVIDER_LABEL[filters.provider]} only` : ''}
      </span>
    </div>
  );
}

function CustomRange({ close }: { close: () => void }) {
  const { range, setFilters, today } = useFilters();
  const [from, setFrom] = useState(isoDate(range.from));
  const [to, setTo] = useState(isoDate(range.to));
  return (
    <div className="mx-1 mt-1.5 border-t border-line px-1.5 pb-1 pt-2.5">
      <div className="mb-1.5 text-[11px] font-medium text-muted">Custom range</div>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={from}
          max={isoDate(today)}
          onChange={(e) => setFrom(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-[12px] text-ink"
          aria-label="From"
        />
        <span className="text-muted">–</span>
        <input
          type="date"
          value={to}
          max={isoDate(today)}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-[12px] text-ink"
          aria-label="To"
        />
      </div>
      <button
        type="button"
        className="mt-2 w-full rounded-lg bg-ink py-1.5 text-[12px] font-medium text-page hover:opacity-90"
        onClick={() => {
          const f = fromIsoDate(from);
          const t = fromIsoDate(to);
          if (f !== undefined && t !== undefined) {
            setFilters({ preset: 'custom', from: Math.min(f, t), to: Math.max(f, t) });
            close();
          }
        }}
      >
        Apply range
      </button>
    </div>
  );
}

function DateRangePicker() {
  const { filters, range, setFilters } = useFilters();
  return (
    <Popover
      label="Date range"
      width={280}
      trigger={(open) => (
        <TriggerButton open={open} active>
          <CalendarDays size={14} className="text-muted" aria-hidden />
          <span>{filters.preset === 'custom' ? 'Custom' : presetLabel(filters)}</span>
          <span className="hidden font-normal text-muted md:inline">· {rangeLabel(range.from, range.to)}</span>
          <ChevronDown size={14} className="text-muted" aria-hidden />
        </TriggerButton>
      )}
    >
      {(close) => (
        <div>
          {PRESETS.map((p) => (
            <MenuItem
              key={p.id}
              selected={filters.preset === p.id}
              onClick={() => {
                setFilters({ preset: p.id });
                close();
              }}
              right={p.short}
            >
              {p.label}
            </MenuItem>
          ))}
          <CustomRange close={close} />
        </div>
      )}
    </Popover>
  );
}

function SourcePicker({ data }: { data: Data }) {
  const { filters, setFilters } = useFilters();
  const sel = filters.sources;
  const label = sel.length === 0 ? 'All sources' : sel.length === 1 ? SOURCE_META[sel[0]].short : `${sel.length} sources`;
  const connected = new Set(data.raw.sources.filter((s) => s.connected).map((s) => s.id));
  const toggle = (id: SourceId) => {
    const next = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
    setFilters({ sources: next.length === data.sourceIds.length ? [] : next });
  };
  return (
    <Popover
      label="Sources"
      width={260}
      trigger={(open) => (
        <TriggerButton open={open} active={sel.length > 0}>
          <Boxes size={14} className="text-muted" aria-hidden />
          {label}
          <ChevronDown size={14} className="text-muted" aria-hidden />
        </TriggerButton>
      )}
    >
      {() => (
        <div>
          <MenuItem selected={sel.length === 0} onClick={() => setFilters({ sources: [] })}>
            All sources
          </MenuItem>
          <div className="mx-2 my-1 border-t border-line" />
          {data.sourceIds.map((id) => (
            <MenuItem
              key={id}
              selected={sel.includes(id)}
              onClick={() => toggle(id)}
              right={connected.has(id) ? undefined : 'not connected'}
            >
              <span className="inline-flex items-center gap-2">
                <ProviderDot provider={SOURCE_META[id].provider} size={7} />
                {SOURCE_META[id].label}
              </span>
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

function SearchList({
  items,
  selected,
  onSelect,
  allLabel,
  placeholder,
}: {
  items: { key: string; label: string; sub?: string; right?: string; dot?: React.ReactNode }[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  allLabel: string;
  placeholder: string;
}) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => (i.label + ' ' + (i.sub ?? '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="mb-1 h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-ink placeholder:text-muted"
      />
      <div className="scrollbar-thin max-h-[300px] overflow-y-auto">
        <MenuItem selected={selected === null} onClick={() => onSelect(null)}>
          {allLabel}
        </MenuItem>
        {shown.map((i) => (
          <MenuItem key={i.key} selected={selected === i.key} onClick={() => onSelect(i.key)} right={i.right}>
            <span className="flex min-w-0 items-center gap-2">
              {i.dot}
              <span className="min-w-0">
                <span className="block truncate">{i.label}</span>
                {i.sub && <span className="block truncate text-[11px] text-muted">{i.sub}</span>}
              </span>
            </span>
          </MenuItem>
        ))}
        {!shown.length && <p className="px-3 py-3 text-[12px] text-muted">No matches</p>}
      </div>
    </div>
  );
}

function ProjectPicker({ data }: { data: Data }) {
  const { filters, range, setFilters } = useFilters();
  const items = useMemo(() => {
    const facts = applyFilters(data, filters, range, { project: false });
    const byProj = new Map<number, number>();
    for (const f of facts) byProj.set(f.proj, (byProj.get(f.proj) ?? 0) + f.tokens);
    return data.projects
      .map((p, i) => ({ p, v: byProj.get(i) ?? 0 }))
      .sort((a, b) => b.v - a.v)
      .map(({ p, v }) => ({ key: p.key, label: p.name, sub: p.path, right: v ? compact(v) : '–' }));
  }, [data, filters, range]);
  const current = filters.project ? data.projects[data.projectByKey.get(filters.project) ?? -1] : undefined;
  return (
    <Popover
      label="Project"
      width={320}
      trigger={(open) => (
        <TriggerButton open={open} active={Boolean(current)}>
          <FolderGit2 size={14} className="text-muted" aria-hidden />
          <span className="max-w-[160px] truncate">{current ? current.name : 'All projects'}</span>
          <ChevronDown size={14} className="text-muted" aria-hidden />
        </TriggerButton>
      )}
    >
      {(close) => (
        <SearchList
          items={items}
          selected={filters.project}
          allLabel="All projects"
          placeholder="Search projects…"
          onSelect={(key) => {
            setFilters({ project: key });
            close();
          }}
        />
      )}
    </Popover>
  );
}

function ModelPicker({ data }: { data: Data }) {
  const { filters, range, setFilters } = useFilters();
  const items = useMemo(() => {
    const facts = applyFilters(data, filters, range, { model: false });
    const t = sum(facts);
    const byModel = new Map<number, number>();
    for (const f of facts) byModel.set(f.model, (byModel.get(f.model) ?? 0) + f.tokens);
    return data.models
      .map((m, i) => ({ m, v: byModel.get(i) ?? 0 }))
      .filter(({ v }) => v > 0 || t.tokens === 0)
      .sort((a, b) => b.v - a.v)
      .map(({ m, v }) => ({
        key: m.id,
        label: m.label,
        sub: m.id,
        right: v ? compact(v) : '–',
        dot: <ProviderDot provider={m.provider} size={7} />,
      }));
  }, [data, filters, range]);
  const current = filters.model ? data.models[data.modelById.get(filters.model) ?? -1] : undefined;
  return (
    <Popover
      label="Model"
      width={300}
      trigger={(open) => (
        <TriggerButton open={open} active={Boolean(current)}>
          <Cpu size={14} className={clsx('text-muted')} aria-hidden />
          <span className="max-w-[140px] truncate">{current ? current.label : 'All models'}</span>
          <ChevronDown size={14} className="text-muted" aria-hidden />
        </TriggerButton>
      )}
    >
      {(close) => (
        <SearchList
          items={items}
          selected={filters.model}
          allLabel="All models"
          placeholder="Search models…"
          onSelect={(key) => {
            setFilters({ model: key });
            close();
          }}
        />
      )}
    </Popover>
  );
}
