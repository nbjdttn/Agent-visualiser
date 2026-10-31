import clsx from 'clsx';
import { BarChart3, Table2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Card, CardHeader } from './ui';

/**
 * A chart in a card, with its accessible twin: every chart can flip to a
 * table of the same numbers.
 */
export function ChartCard({
  title,
  subtitle,
  actions,
  legend,
  table,
  children,
  className,
  refetching,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  legend?: ReactNode;
  table?: () => ReactNode;
  children: ReactNode;
  className?: string;
  refetching?: boolean;
  footer?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Card className={clsx('flex min-w-0 flex-col p-4 sm:p-5', className)}>
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
          (actions || table) && (
            <>
              {actions}
              {table && (
                <button
                  type="button"
                  onClick={() => setShowTable((s) => !s)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2 hover:text-ink lg:h-7 lg:w-7 lg:rounded-lg"
                  title={showTable ? 'Show chart' : 'Show as table'}
                  aria-label={showTable ? 'Show chart' : 'Show as table'}
                  aria-pressed={showTable}
                >
                  {showTable ? <BarChart3 size={18} /> : <Table2 size={18} />}
                </button>
              )}
            </>
          )
        }
      />
      {legend && !showTable && <div className="mt-3">{legend}</div>}
      <div className={clsx('mt-4 min-h-0 flex-1', refetching && 'refetching')}>
        {showTable && table ? <div className="scrollbar-thin max-h-[380px] overflow-auto">{table()}</div> : children}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </Card>
  );
}
