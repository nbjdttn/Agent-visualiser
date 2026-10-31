import clsx from 'clsx';
import {
  Activity,
  Cpu,
  FolderKanban,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  PlugZap,
  RotateCw,
  ScrollText,
  Sun,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { compact, usd } from '../lib/format';
import { href, type Route } from '../lib/router';
import { useData, useTheme, type ThemePref } from '../lib/store';
import { ProviderDot } from './ui';

const NAV: { route: Route; label: string; icon: typeof Activity; match: Route['page'][] }[] = [
  { route: { page: 'overview' }, label: 'Overview', icon: LayoutDashboard, match: ['overview'] },
  { route: { page: 'live' }, label: 'Live', icon: Activity, match: ['live'] },
  { route: { page: 'projects' }, label: 'Projects', icon: FolderKanban, match: ['projects', 'project'] },
  { route: { page: 'sessions' }, label: 'Sessions', icon: ScrollText, match: ['sessions'] },
  { route: { page: 'models' }, label: 'Models', icon: Cpu, match: ['models'] },
  { route: { page: 'sources' }, label: 'Data sources', icon: PlugZap, match: ['sources'] },
];

export function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="9" style={{ fill: 'var(--text)' }} />
      <path d="M9 21.5l4.2-6 3.6 3.6 6.2-8.6" fill="none" style={{ stroke: 'var(--page)' }} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23" cy="10.5" r="2.6" style={{ fill: 'var(--anthropic)' }} />
      <circle cx="9" cy="21.5" r="2.6" style={{ fill: 'var(--openai)' }} />
    </svg>
  );
}

function Sidebar({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const { live, data } = useData();
  const working = live?.active.filter((a) => a.state === 'working').length ?? 0;
  return (
    <nav className="flex h-full flex-col gap-1 px-3 py-4" aria-label="Main">
      <a href="#/" onClick={onNavigate} className="mb-5 flex items-center gap-2.5 px-2">
        <Logo />
        <div className="leading-tight">
          <div className="text-[14.5px] font-semibold tracking-[-0.01em]">Agent Visualiser</div>
          <div className="text-[11.5px] text-muted">Claude + OpenAI usage</div>
        </div>
      </a>
      {NAV.map((item) => {
        const active = item.match.includes(route.page);
        const Icon = item.icon;
        return (
          <a
            key={item.label}
            href={href(item.route)}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] font-medium transition-colors',
              active ? 'bg-surface text-ink shadow-[var(--shadow)] ring-1 ring-line' : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
            )}
          >
            <Icon size={16} strokeWidth={2} className={active ? 'text-ink' : 'text-muted'} aria-hidden />
            <span className="flex-1">{item.label}</span>
            {item.route.page === 'live' && working > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-ink">
                <span className="live-dot" style={{ width: 6, height: 6 }} />
                {working}
              </span>
            )}
          </a>
        );
      })}

      <div className="mt-auto flex flex-col gap-3">
        {live && (
          <div className="rounded-xl border border-line bg-surface p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Today</div>
            {(['anthropic', 'openai'] as const).map((p) => (
              <div key={p} className="flex items-center justify-between py-0.5 text-[12.5px]">
                <span className="inline-flex items-center gap-1.5 text-ink-2">
                  <ProviderDot provider={p} size={7} />
                  {p === 'anthropic' ? 'Claude' : 'OpenAI'}
                </span>
                <span className="tnum text-ink">
                  {compact(live.today[p].tokens)} <span className="text-muted">· {usd(live.today[p].cost)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {data?.raw.demo && (
          <a
            href="#/sources"
            onClick={onNavigate}
            className="rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-[12px] leading-snug text-ink-2 hover:bg-surface"
          >
            <span className="font-semibold text-ink">Demo data.</span> Connect Claude Code, Codex or your API keys to see
            your own usage.
          </a>
        )}
      </div>
    </nav>
  );
}

function ThemeToggle() {
  const [pref, setPref] = useTheme();
  const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor;
  const label = pref === 'system' ? 'Theme: match system' : pref === 'light' ? 'Theme: light' : 'Theme: dark';
  return (
    <button
      type="button"
      onClick={() => setPref(next[pref])}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-line bg-surface text-ink-2 hover:text-ink"
      title={label}
      aria-label={label}
    >
      <Icon size={15} />
    </button>
  );
}

export function AppShell({
  route,
  title,
  subtitle,
  filters,
  children,
}: {
  route: Route;
  title: ReactNode;
  subtitle?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
}) {
  const { refresh, refetching, live } = useData();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => setMobileOpen(false), [route]);
  const busy = spinning || refetching || live?.scanning;

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[244px] border-r border-line bg-page lg:block">
        <Sidebar route={route} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="fade-in absolute inset-y-0 left-0 w-[260px] border-r border-line bg-page">
            <button
              type="button"
              className="absolute right-3 top-4 rounded-lg p-1.5 text-ink-2 hover:bg-surface"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X size={18} />
            </button>
            <Sidebar route={route} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="lg:pl-[244px]">
        <header className="z-20 border-b border-line lg:sticky lg:top-0 bg-[color-mix(in_srgb,var(--page)_82%,transparent)] backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="-ml-1 rounded-lg p-1.5 text-ink-2 hover:bg-surface lg:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation"
              >
                <Menu size={20} />
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[19px] font-semibold tracking-[-0.02em]">{title}</h1>
                {subtitle && <p className="truncate text-[12.5px] text-muted">{subtitle}</p>}
              </div>
              <button
                type="button"
                onClick={async () => {
                  setSpinning(true);
                  await refresh();
                  setSpinning(false);
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 text-[13px] font-medium text-ink-2 hover:text-ink"
                title="Re-scan logs and refresh API usage"
              >
                <RotateCw size={14} className={busy ? 'spin' : ''} aria-hidden />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <ThemeToggle />
            </div>
            {filters}
          </div>
        </header>
        <main className="mx-auto max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">{children}</main>
      </div>
    </div>
  );
}
