import clsx from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sort?: (row: T) => number | string;
  align?: 'left' | 'right';
  className?: string;
  /** Hide on narrow screens. */
  hide?: 'sm' | 'md' | 'lg';
  width?: string;
}

const hideClass = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  initialSort,
  pageSize,
  emptyLabel = 'Nothing here yet',
  dense,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  pageSize?: number;
  emptyLabel?: string;
  dense?: boolean;
}) {
  const [sort, setSort] = useState(initialSort);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    const dir = sort!.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }, [rows, columns, sort]);
  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pages - 1);
  const shown = pageSize ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted;

  if (!rows.length) return <p className="py-8 text-center text-[13px] text-muted">{emptyLabel}</p>;

  return (
    <div>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={{ width: c.width }}
                    className={clsx(
                      'sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-3 py-2 text-[11.5px] font-medium text-muted',
                      c.align === 'right' ? 'text-right' : 'text-left',
                      c.hide && hideClass[c.hide],
                    )}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        className={clsx('inline-flex items-center gap-0.5 hover:text-ink', active && 'text-ink')}
                        onClick={() =>
                          setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'desc' }))
                        }
                      >
                        {c.header}
                        {active ? sort!.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : null}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={clsx('group', onRowClick && 'cursor-pointer')}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={clsx(
                      'border-b border-line px-3 align-middle transition-colors group-last:border-b-0',
                      dense ? 'py-1.5' : 'py-2.5',
                      onRowClick && 'group-hover:bg-surface-2',
                      c.align === 'right' ? 'tnum text-right' : 'text-left',
                      c.hide && hideClass[c.hide],
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageSize && pages > 1 && (
        <div className="mt-3 flex items-center justify-between px-1 text-[12px] text-muted">
          <span className="tnum">
            {current * pageSize + 1}–{Math.min(sorted.length, (current + 1) * pageSize)} of {sorted.length.toLocaleString('en-US')}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              className="rounded-lg border border-line px-2.5 py-1 font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              className="rounded-lg border border-line px-2.5 py-1 font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
