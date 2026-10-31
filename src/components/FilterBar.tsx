import clsx from 'clsx';
import { Boxes, CalendarDays, ChevronDown, Cpu, FolderGit2, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PROVIDER_LABEL, SOURCE_META, type SourceId } from '../../shared/types';
import { PRESETS, presetLabel, sum, applyFilters, type Data } from '../lib/data';
import { compact, rangeLabel } from '../lib/format';
import { useData, useFilters } from '../lib/store';
import { fromIsoDate, isoDate } from '../lib/time';
import { MenuItem, Popover, TriggerButton } from './Popover';
import { ProviderDot, Segmented } from './ui';

interface ListItem {
  key: string;
  label: string;
  sub?: string;
  right?: string;
  dot?: ReactNode;
}

/** One row of filters above the content; everything below re-renders against the same slice. */
export function FilterBar({ hideProject }: { hideProject?: boolean }) {
  const { data } = useData();
  const { filters, range, setFilters, resetFilters } = useFilters();
  const [sheet, setSheet] = useState(false);
  const sheetCount = (filters.sources.length ? 1 : 0) + (filters.project && !hideProject ? 1 : 0) + (filters.model ? 1 : 0);
  const activeCount = sheetCount + (filters.provider !== 'all' ? 1 : 0);

  const provider = (
    <Segmented
      label="Provider"
      value={filters.provider}
      onChange={(p) => setFilters({ provider: p })}
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
  );

  return (
    <>
      {/* Phone: date, provider and a sheet with the rest. */}
      <div className="flex items-center gap-2 lg:hidden">
        <DateRangePicker compactLabel />
        {provider}
        {data && (
          <button
            type="button"
            onClick={() => setSheet(true)}
            className={clsx(
              'relative ml-auto inline-flex h-8 w-9 shrink-0 items-center justify-center rounded-[10px] border bg-surface',
              sheetCount ? 'border-line-strong text-ink' : 'border-line text-ink-2',
            )}
            aria-label={`More filters${sheetCount ? `, ${sheetCount} active` : ''}`}
          >
            <SlidersHorizontal size={16} aria-hidden />
            {sheetCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-semibold text-page">
                {sheetCount}
              </span>
            )}
          </button>
        )}
      </div>
      {/* Rendered at the top of the page: the blurred header would otherwise trap a fixed-position sheet. */}
      {sheet && data && createPortal(<FilterSheet data={data} hideProject={hideProject} onClose={() => setSheet(false)} />, document.body)}

      {/* Desktop: everything in one row. */}
      <div className="hidden flex-wrap items-center gap-2 lg:flex">
        <DateRangePicker />
        {provider}
        {data && <SourcePicker data={data} />}
        {data && !hideProject && <ProjectPicker data={data} />}
        {data && <ModelPicker data={data} />}
        {activeCount > 0 && (
          <button type="button" onClick={resetFilters} className="ml-1 text-[12px] font-medium text-ink-2 hover:text-ink">
            Clear filters
          </button>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        Showing {rangeLabel(range.from, range.to)}
        {filters.provider !== 'all' ? `, ${PROVIDER_LABEL[filters.provider]} only` : ''}
      </span>
    </>
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
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-[13px] text-ink"
          aria-label="From"
        />
        <span className="text-muted">–</span>
        <input
          type="date"
          value={to}
          max={isoDate(today)}
          onChange={(e) => setTo(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 text-[13px] text-ink"
          aria-label="To"
        />
      </div>
      <button
        type="button"
        className="mt-2 w-full rounded-lg bg-ink py-2 text-[13px] font-medium text-page hover:opacity-90"
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

function DateRangePicker({ compactLabel }: { compactLabel?: boolean }) {
  const { filters, range, setFilters } = useFilters();
  const preset = PRESETS.find((p) => p.id === filters.preset);
  return (
    <Popover
      label="Date range"
      width={280}
      trigger={(open) => (
        <TriggerButton open={open} active>
          <CalendarDays size={14} className="text-muted" aria-hidden />
          <span>{filters.preset === 'custom' ? 'Custom' : compactLabel ? preset?.short : presetLabel(filters)}</span>
          {!compactLabel && <span className="hidden font-normal text-muted md:inline">· {rangeLabel(range.from, range.to)}</span>}
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

/** Sources worth offering: API sources only when a server could provide them. */
function useSourceOptions(data: Data): SourceId[] {
  const { mode } = useData();
  return data.sourceIds.filter((id) => mode === 'server' || SOURCE_META[id].kind !== 'api');
}

function SourceList({ data }: { data: Data }) {
  const { filters, setFilters } = useFilters();
  const options = useSourceOptions(data);
  const sel = filters.sources;
  const connected = new Set(data.raw.sources.filter((s) => s.connected).map((s) => s.id));
  const toggle = (id: SourceId) => {
    const next = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
    setFilters({ sources: next.length === options.length ? [] : next });
  };
  return (
    <div>
      <MenuItem selected={sel.length === 0} onClick={() => setFilters({ sources: [] })}>
        All sources
      </MenuItem>
      <div className="mx-2 my-1 border-t border-line" />
      {options.map((id) => (
        <MenuItem key={id} selected={sel.includes(id)} onClick={() => toggle(id)} right={connected.has(id) ? undefined : 'no data'}>
          <span className="inline-flex items-center gap-2">
            <ProviderDot provider={SOURCE_META[id].provider} size={7} />
            {SOURCE_META[id].label}
          </span>
        </MenuItem>
      ))}
    </div>
  );
}

function SourcePicker({ data }: { data: Data }) {
  const { filters } = useFilters();
  const sel = filters.sources;
  const label = sel.length === 0 ? 'All sources' : sel.length === 1 ? SOURCE_META[sel[0]].short : `${sel.length} sources`;
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
      {() => <SourceList data={data} />}
    </Popover>
  );
}

function SearchList({
  items,
  selected,
  onSelect,
  allLabel,
  placeholder,
  autoFocus = true,
  maxHeight = 300,
}: {
  items: ListItem[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  allLabel: string;
  placeholder: string;
  autoFocus?: boolean;
  maxHeight?: number;
}) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => (i.label + ' ' + (i.sub ?? '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      {items.length > 6 && (
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="mb-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-[16px] text-ink placeholder:text-muted lg:h-8 lg:text-[13px]"
        />
      )}
      <div className="scrollbar-thin overflow-y-auto" style={{ maxHeight }}>
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

function useProjectItems(data: Data): ListItem[] {
  const { filters, range } = useFilters();
  return useMemo(() => {
    const facts = applyFilters(data, filters, range, { project: false });
    const byProj = new Map<number, number>();
    for (const f of facts) byProj.set(f.proj, (byProj.get(f.proj) ?? 0) + f.tokens);
    return data.projects
      .map((p, i) => ({ p, v: byProj.get(i) ?? 0 }))
      .filter(({ v }) => v > 0)
      .sort((a, b) => b.v - a.v)
      .map(({ p, v }) => ({ key: p.key, label: p.name, sub: p.path, right: compact(v) }));
  }, [data, filters, range]);
}

function useModelItems(data: Data): ListItem[] {
  const { filters, range } = useFilters();
  return useMemo(() => {
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
}

function ProjectPicker({ data }: { data: Data }) {
  const { filters, setFilters } = useFilters();
  const items = useProjectItems(data);
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
  const { filters, setFilters } = useFilters();
  const items = useModelItems(data);
  const current = filters.model ? data.models[data.modelById.get(filters.model) ?? -1] : undefined;
  return (
    <Popover
      label="Model"
      width={300}
      trigger={(open) => (
        <TriggerButton open={open} active={Boolean(current)}>
          <Cpu size={14} className="text-muted" aria-hidden />
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

/** Phone filters: a bottom sheet with sources, projects and models. */
function FilterSheet({ data, hideProject, onClose }: { data: Data; hideProject?: boolean; onClose: () => void }) {
  const { filters, setFilters, resetFilters } = useFilters();
  const projects = useProjectItems(data);
  const models = useModelItems(data);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="border-t border-line px-2 pb-2 pt-3">
      <h3 className="mb-1 px-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{title}</h3>
      {children}
    </section>
  );
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Filters">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="fade-in scrollbar-thin absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-line bg-surface shadow-[var(--shadow-pop)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between bg-surface px-4 pb-2 pt-3">
          <button type="button" onClick={resetFilters} className="text-[14px] font-medium text-ink-2">
            Clear
          </button>
          <span className="text-[15px] font-semibold">Filters</span>
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-[14px] font-semibold text-ink" aria-label="Done">
            Done <X size={16} aria-hidden />
          </button>
        </div>
        <Section title="Source">
          <SourceList data={data} />
        </Section>
        {!hideProject && (
          <Section title="Project">
            <SearchList
              items={projects}
              selected={filters.project}
              allLabel="All projects"
              placeholder="Search projects"
              autoFocus={false}
              maxHeight={260}
              onSelect={(key) => setFilters({ project: key })}
            />
          </Section>
        )}
        <Section title="Model">
          <SearchList
            items={models}
            selected={filters.model}
            allLabel="All models"
            placeholder="Search models"
            autoFocus={false}
            maxHeight={260}
            onSelect={(key) => setFilters({ model: key })}
          />
        </Section>
      </div>
    </div>
  );
}
