import clsx from 'clsx';
import { Laptop } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  latestState,
  nonce,
  parseRelayLines,
  sealControl,
  topicUrl,
  type ControlInfo,
  type CpuInfo,
  type GentleMode,
  type MemInfo,
  type StateMessage,
} from '../../core/sync/control';
import { relative } from '../lib/format';
import { useData } from '../lib/store';
import { Card } from './ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastPing = 0;

async function fetchState(info: ControlInfo): Promise<StateMessage | null> {
  const res = await fetch(`${topicUrl(info)}/json?poll=1&since=3h`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return latestState(info, parseRelayLines(await res.text()));
}

async function post(info: ControlInfo, body: string) {
  const res = await fetch(topicUrl(info), { method: 'POST', body });
  if (!res.ok) throw new Error(`relay ${res.status}`);
}

const MODES: { value: GentleMode; label: string; title: string }[] = [
  { value: 'work', label: 'Work', title: 'Always gentle: agent jobs keep cores free for you' },
  { value: 'auto', label: 'Auto', title: 'Gentle while you use the Mac, full speed when you step away' },
  { value: 'full', label: 'Full speed', title: 'Agent jobs always get the whole Mac' },
];

/**
 * Your Mac's gentle mode, from the phone. The switch shows your choice (white)
 * and what the Mac is doing right now (glowing green: Work or Full speed); below the
 * name is a short system panel: one block per CPU core (blue for the agents,
 * grey for everything else, glowing green for the ones kept free for you),
 * then GPU and memory.
 */
export function MacCard() {
  const { sync } = useData();
  const mac = sync?.computers?.find((c) => c.control);
  const info = mac?.control;
  const [state, setState] = useState<StateMessage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<GentleMode | null>(null);
  const [offline, setOffline] = useState(false);
  const infoRef = useRef(info);
  infoRef.current = info;

  const refresh = useCallback(async () => {
    const i = infoRef.current;
    if (!i) return null;
    try {
      const s = await fetchState(i);
      setState(s);
      setOffline(false);
      return s;
    } catch {
      setOffline(true);
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  /** Ask the Mac for a fresh status (at most once a minute), then read it. */
  const wake = useCallback(async () => {
    const i = infoRef.current;
    if (!i) return;
    void refresh();
    if (Date.now() - lastPing < 60_000) return;
    lastPing = Date.now();
    try {
      await post(i, await sealControl(i, { t: 'ping', at: Date.now(), n: nonce() }));
      await sleep(2500);
      await refresh();
    } catch {
      // the cached status is shown
    }
  }, [refresh]);

  useEffect(() => {
    if (!info?.topic) return;
    void wake();
    const onVisible = () => document.visibilityState === 'visible' && void wake();
    // Fresh numbers about once a minute while the card is on screen.
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void wake(), 61_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [info?.topic, wake, refresh]);

  const choose = async (mode: GentleMode) => {
    if (!info || pending || mode === (state?.mode ?? 'auto')) return;
    setPending(mode);
    try {
      const at = Date.now();
      await post(info, await sealControl(info, { t: 'set', mode, at, by: sync?.kid, n: nonce() }));
      for (const wait of [2000, 2000, 3000, 4000, 6000, 8000]) {
        await sleep(wait);
        const s = await refresh();
        if (s && s.mode === mode && s.at >= at - 5_000) break;
      }
    } catch {
      setOffline(true);
    } finally {
      setPending(null);
    }
  };

  if (!info || !mac) return null;
  const stale = !state || Date.now() - state.at > 75 * 60_000;
  const current = state?.mode ?? 'auto';
  const live = state && !stale ? (state.live ?? (state.here ? 'gentle' : 'full')) : undefined;
  const nowOption: GentleMode | undefined = live === 'gentle' ? 'work' : live === 'full' ? 'full' : undefined;
  const note = offline ? 'Offline' : !loaded ? '' : !state ? 'Not connected' : stale ? relative(state.at) : '';

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] transition-colors',
            live === 'gentle' ? 'bg-[color-mix(in_srgb,var(--good)_18%,transparent)] text-[var(--good-text)]' : 'bg-surface-2 text-ink-2',
          )}
          aria-hidden
        >
          <Laptop size={22} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink lg:text-[15px]">{mac.name}</h2>
        {note ? <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium text-muted">{note}</span> : null}
      </div>

      {state && !stale && (state.cpu || state.gpu !== undefined || state.mem) ? (
        <div className="mt-3.5 flex flex-col gap-2.5">
          {state.cpu ? <CpuRow cpu={state.cpu} gentle={live === 'gentle'} /> : null}
          {state.gpu !== undefined ? <BarRow label="GPU" value={`${Math.round(state.gpu)}%`} fraction={state.gpu / 100} color="var(--s3)" /> : null}
          {state.mem ? <MemRow mem={state.mem} /> : null}
        </div>
      ) : null}

      {/* The white button is your choice; the green glow is what the Mac is doing right now
          (Work while it keeps cores free for you, Full speed while the agents have it all). */}
      <div role="radiogroup" aria-label="Agents on your Mac" className="mt-3.5 flex h-12 w-full items-center gap-1 rounded-[15px] border border-line bg-surface-2 p-1 lg:h-11">
        {MODES.map((m) => {
          const chosen = (pending ?? current) === m.value;
          const glowing = !pending && nowOption === m.value;
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={chosen}
              title={glowing ? `${m.title} (what your Mac is doing now)` : m.title}
              onClick={() => void choose(m.value)}
              className={clsx(
                'flex h-full flex-1 items-center justify-center gap-2 rounded-[11px] text-[15px] font-semibold transition-all duration-300',
                chosen ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-line' : 'text-ink-2 hover:text-ink',
                glowing && 'mode-glow',
                glowing && !chosen && 'text-[var(--good-text)]',
                chosen && pending && 'animate-pulse',
              )}
            >
              {glowing ? <span className="live-dot" aria-hidden /> : null}
              {m.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/** A label, a bar and a value on one line. */
function Row({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-10 shrink-0 text-[12.5px] font-semibold text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
      <span className="tnum w-[76px] shrink-0 text-right text-[13px] font-medium text-ink-2">{value}</span>
    </div>
  );
}

function BarRow({ label, value, fraction, color }: { label: string; value: string; fraction: number; color: string }) {
  return (
    <Row label={label} value={value}>
      <div className="h-3 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%`, background: color }} />
      </div>
    </Row>
  );
}

/** One block per core: blue for the agents, grey for everything else, glowing green for the ones kept free for you. */
function CpuRow({ cpu, gentle }: { cpu: CpuInfo; gentle: boolean }) {
  const cores = Math.max(1, Math.min(64, Math.round(cpu.cores)));
  const free = gentle ? Math.max(0, Math.min(cores, Math.round(cpu.free))) : 0;
  const agents = Math.max(0, cpu.agents);
  const others = Math.max(0, (cpu.busy ?? agents) - agents);
  const label = `CPU: ${(cpu.busy ?? agents).toFixed(1)} of ${cores} cores busy, agents ${agents.toFixed(1)}${free ? `, ${free} kept free for you` : ''}`;
  return (
    <Row label="CPU" value={`${(cpu.busy ?? agents).toFixed(1)}/${cores}`}>
      <div className="flex gap-[3px]" role="img" aria-label={label} title={label}>
        {Array.from({ length: cores }, (_, i) => {
          const kept = i >= cores - free;
          const a = Math.max(0, Math.min(1, agents - i));
          const o = Math.max(0, Math.min(1 - a, agents + others - i - a));
          return (
            <span key={i} className={clsx('relative flex h-3.5 flex-1 overflow-hidden rounded-[4px]', kept ? 'core-free' : 'bg-surface-2')}>
              {!kept && a > 0 ? <span className="h-full bg-[var(--s1)] transition-[width] duration-700" style={{ width: `${a * 100}%` }} /> : null}
              {!kept && o > 0 ? <span className="h-full bg-[var(--border-strong)] transition-[width] duration-700" style={{ width: `${o * 100}%` }} /> : null}
            </span>
          );
        })}
      </div>
    </Row>
  );
}

/** Memory in use, coloured by macOS memory pressure (green, amber, red), with swap if there is any. */
function MemRow({ mem }: { mem: MemInfo }) {
  const gb = (b: number) => (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1);
  mem = { ...mem, used: Math.min(mem.used, mem.total) };
  const color = mem.pressure === 'critical' ? 'var(--critical)' : mem.pressure === 'warn' ? 'var(--warning)' : 'var(--good)';
  const swap = mem.swap && mem.swap >= 256 * 1024 ** 2 ? ` · ${gb(mem.swap)} GB swap` : '';
  return (
    <Row label="Mem" value={`${gb(mem.used)}/${gb(mem.total)} GB`}>
      <div className="h-3 overflow-hidden rounded-full bg-surface-2" title={`Memory ${gb(mem.used)} of ${gb(mem.total)} GB${mem.pressure ? `, pressure ${mem.pressure}` : ''}${swap}`}>
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(2, Math.min(100, (mem.used / Math.max(1, mem.total)) * 100))}%`, background: color }} />
      </div>
    </Row>
  );
}
