import clsx from 'clsx';
import { Activity, Cpu, Database, FolderKanban, LayoutDashboard, Monitor, Moon, RotateCw, ScrollText, Sun, Upload } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { compact, usd } from '../lib/format';
import { href, type Route } from '../lib/router';
import { useData, useTheme, type ThemePref } from '../lib/store';
import { ProviderDot } from './ui';

interface NavItem {
  route: Route;
  label: string;
  short: string;
  icon: typeof Activity;
  match: Route['page'][];
  /** Only shown when a local server provides live data. */
  serverOnly?: boolean;
}

const NAV: NavItem[] = [
  { route: { page: 'overview' }, label: 'Overview', short: 'Overview', icon: LayoutDashboard, match: ['overview'] },
  { route: { page: 'live' }, label: 'Live', short: 'Live', icon: Activity, match: ['live'], serverOnly: true },
  { route: { page: 'projects' }, label: 'Projects', short: 'Projects', icon: FolderKanban, match: ['projects', 'project'] },
  { route: { page: 'sessions' }, label: 'Sessions & chats', short: 'Chats', icon: ScrollText, match: ['sessions'] },
  { route: { page: 'models' }, label: 'Models', short: 'Models', icon: Cpu, match: ['models'] },
  { route: { page: 'sources' }, label: 'Your data', short: 'Data', icon: Database, match: ['sources'] },
];

/** The app icon: two usage rings (Claude orange outside, OpenAI green inside) around an AI sparkle. */
export function Logo({ size = 30 }: { size?: number }) {
  const id = useId().replace(/:/g, '');
  // Same geometry as public/icons/app-icon.svg, on a 32-unit grid.
  const ring = (r: number, degrees: number) => {
    const a = ((degrees - 90) * Math.PI) / 180;
    return `M16 ${16 - r} A${r} ${r} 0 ${degrees > 180 ? 1 : 0} 1 ${(16 + r * Math.cos(a)).toFixed(2)} ${(16 + r * Math.sin(a)).toFixed(2)}`;
  };
  const k = 0.42;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2733" />
          <stop offset="1" stopColor="#0c0b10" />
        </linearGradient>
        <linearGradient id={`${id}o`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffa36c" />
          <stop offset="1" stopColor="#e2582b" />
        </linearGradient>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ff0b4" />
          <stop offset="1" stopColor="#11a37f" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.2" fill={`url(#${id}bg)`} />
      <circle cx="16" cy="16" r="9.94" fill="none" stroke="#fff" strokeOpacity="0.08" strokeWidth="3" />
      <circle cx="16" cy="16" r="6" fill="none" stroke="#fff" strokeOpacity="0.08" strokeWidth="3" />
      <path d={ring(9.94, 284)} fill="none" stroke={`url(#${id}o)`} strokeWidth="3" strokeLinecap="round" />
      <path d={ring(6, 212)} fill="none" stroke={`url(#${id}g)`} strokeWidth="3" strokeLinecap="round" />
      <path
        d={`M16 13.4 C${16 + k} ${16 - k} ${16 + k} ${16 - k} 18.6 16 C${16 + k} ${16 + k} ${16 + k} ${16 + k} 16 18.6 C${16 - k} ${16 + k} ${16 - k} ${16 + k} 13.4 16 C${16 - k} ${16 - k} ${16 - k} ${16 - k} 16 13.4 Z`}
        fill="#fff"
      />
    </svg>
  );
}

function useNav(): NavItem[] {
  const { mode } = useData();
  return NAV.filter((n) => !n.serverOnly || mode === 'server');
}

/** Desktop navigation. */
function Sidebar({ route }: { route: Route }) {
  const { live, data } = useData();
  const nav = useNav();
  const working = live?.active.filter((a) => a.state === 'working').length ?? 0;
  return (
    <nav className="flex h-full flex-col gap-1 px-3 py-4" aria-label="Main">
      <a href="#/" className="mb-5 flex items-center gap-2.5 px-2">
        <Logo />
        <div className="leading-tight">
          <div className="text-[14.5px] font-semibold tracking-[-0.01em]">Agent Visualiser</div>
          <div className="text-[11.5px] text-muted">Claude + OpenAI usage</div>
        </div>
      </a>
      {nav.map((item) => {
        const active = item.match.includes(route.page);
        const Icon = item.icon;
        return (
          <a
            key={item.label}
            href={href(item.route)}
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
        {data?.raw.demo && <DemoNote />}
      </div>
    </nav>
  );
}

function DemoNote({ compactLayout }: { compactLayout?: boolean }) {
  return (
    <a
      href="#/sources"
      className={clsx(
        'block rounded-xl border border-dashed border-line-strong text-[12.5px] leading-snug text-ink-2 hover:bg-surface',
        compactLayout ? 'px-3 py-2' : 'px-3 py-2.5',
      )}
    >
      <span className="font-semibold text-ink">Demo data.</span> Import your ChatGPT or claude.ai history to see your own
      usage →
    </a>
  );
}

/** Phone navigation: a bottom tab bar that respects the home indicator. */
function TabBar({ route }: { route: Route }) {
  const nav = useNav().filter((n) => !n.serverOnly);
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[color-mix(in_srgb,var(--page)_88%,transparent)] backdrop-blur-xl lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-[640px]">
        {nav.map((item) => {
          const active = item.match.includes(route.page);
          const Icon = item.icon;
          return (
            <a
              key={item.label}
              href={href(item.route)}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'flex min-h-[54px] flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-medium',
                active ? 'text-ink' : 'text-muted',
              )}
            >
              <Icon size={21} strokeWidth={active ? 2.3 : 1.9} aria-hidden />
              {item.short}
            </a>
          );
        })}
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
      className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-line bg-surface text-ink-2 hover:text-ink"
      title={label}
      aria-label={label}
    >
      <Icon size={16} />
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
  const { refresh, refetching, live, mode, data } = useData();
  const [spinning, setSpinning] = useState(false);
  const busy = spinning || refetching || live?.scanning;

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[244px] border-r border-line bg-page lg:block">
        <Sidebar route={route} />
      </aside>

      <div className="lg:pl-[244px]">
        <header
          className="z-20 border-b border-line bg-[color-mix(in_srgb,var(--page)_82%,transparent)] backdrop-blur-xl lg:sticky lg:top-0"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <a href="#/" className="shrink-0 lg:hidden" aria-label="Agent Visualiser home">
                <Logo size={28} />
              </a>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[19px] font-semibold tracking-[-0.02em]">{title}</h1>
                {subtitle && <p className="truncate text-[12.5px] text-muted">{subtitle}</p>}
              </div>
              {mode === 'server' && (
                <button
                  type="button"
                  onClick={async () => {
                    setSpinning(true);
                    await refresh();
                    setSpinning(false);
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 text-[13px] font-medium text-ink-2 hover:text-ink"
                  title="Re-scan logs and refresh API usage"
                  aria-label="Refresh"
                >
                  <RotateCw size={15} className={busy ? 'spin' : ''} aria-hidden />
                  <span className="hidden sm:inline">Refresh</span>
                </button>
              )}
              {mode === 'device' && route.page !== 'sources' && (
                <a
                  href="#/sources"
                  className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line bg-surface px-2.5 text-[13px] font-medium text-ink-2 hover:text-ink"
                  aria-label="Import data"
                >
                  <Upload size={15} aria-hidden />
                  <span className="hidden sm:inline">Import</span>
                </a>
              )}
              <ThemeToggle />
            </div>
            {filters}
          </div>
        </header>
        <main className="mx-auto max-w-[1480px] px-4 pb-[calc(84px_+_env(safe-area-inset-bottom))] pt-4 sm:px-6 lg:px-8 lg:py-6">
          {data?.raw.demo && route.page !== 'sources' && (
            <div className="mb-4 lg:hidden">
              <DemoNote compactLayout />
            </div>
          )}
          {children}
        </main>
      </div>
      <TabBar route={route} />
    </div>
  );
}
