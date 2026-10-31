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
        <div className="mt-3 grid grid-cols-3 gap-1">
          {state.cpu ? <CpuGauge cpu={state.cpu} gentle={live === 'gentle'} /> : <span />}
          {state.gpu !== undefined ? (
            <Gauge
              label="GPU"
              value={`${Math.round(state.gpu)}%`}
              parts={[{ from: 0, to: state.gpu / 100, color: 'var(--s3)' }]}
              needle={state.gpu / 100}
              title={`GPU ${Math.round(state.gpu)}% busy`}
            />
          ) : (
            <span />
          )}
          {state.mem ? <MemGauge mem={state.mem} /> : <span />}
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

/** Dials sweep 240°, with the gap at the bottom like a car's speedometer. */
const START = 150;
const SWEEP = 240;
const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * A speedometer-style dial: coloured arc parts on a track, a needle that
 * swings to the value, the number in the gap below the hub, and optionally a
 * thin glowing green band outside the arc (the cores kept free for you).
 */
function Gauge({
  label,
  value,
  sub,
  parts,
  needle,
  band,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  parts: { from: number; to: number; color: string }[];
  needle: number;
  band?: { from: number; to: number };
  title: string;
}) {
  const W = 100;
  const H = 88;
  const r = 37;
  const sw = 8;
  const cx = W / 2;
  const cy = 50;
  const track = arc(cx, cy, r, START, START + SWEEP);
  return (
    <div className="flex flex-col items-center" role="img" aria-label={title} title={title}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible" aria-hidden>
        <path d={track} fill="none" style={{ stroke: 'var(--surface-2)' }} strokeWidth={sw} strokeLinecap="round" />
        {parts
          .filter((p) => clamp01(p.to) - clamp01(p.from) > 0.004)
          .map((p, i) => (
            <path
              key={i}
              d={track}
              pathLength={100}
              fill="none"
              style={{ stroke: p.color, transition: 'stroke-dasharray 700ms ease, stroke-dashoffset 700ms ease' }}
              strokeWidth={sw}
              strokeLinecap="round"
              strokeDasharray={`${((clamp01(p.to) - clamp01(p.from)) * 100).toFixed(2)} 200`}
              strokeDashoffset={(-clamp01(p.from) * 100).toFixed(2)}
            />
          ))}
        {band && band.to - band.from > 0.004 ? (
          <path
            d={arc(cx, cy, r + sw / 2 + 4.5, START + SWEEP * clamp01(band.from), START + SWEEP * clamp01(band.to))}
            fill="none"
            className="gauge-band"
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        ) : null}
        <g style={{ transform: `rotate(${START + SWEEP * clamp01(needle)}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: 'transform 800ms cubic-bezier(0.2, 0.7, 0.2, 1)' }}>
          <line x1={cx - 5} y1={cy} x2={cx + r - sw / 2 - 5} y2={cy} style={{ stroke: 'var(--text)' }} strokeWidth={2.5} strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r={5} style={{ fill: 'var(--text)' }} />
        <circle cx={cx} cy={cy} r={2} style={{ fill: 'var(--surface)' }} />
        <text x={cx} y={cy + 32} textAnchor="middle" className="tnum" style={{ fill: 'var(--text)', fontSize: 15.5, fontWeight: 700 }}>
          {value}
          {sub ? <tspan style={{ fill: 'var(--muted)', fontSize: 11.5, fontWeight: 600 }}>{sub}</tspan> : null}
        </text>
      </svg>
      <span className="-mt-0.5 text-[12.5px] font-semibold text-muted">{label}</span>
    </div>
  );
}

/** CPU: agents in blue, everything else in grey, the needle at the total; the cores kept free for you glow green. */
function CpuGauge({ cpu, gentle }: { cpu: CpuInfo; gentle: boolean }) {
  const cores = Math.max(1, cpu.cores);
  const busy = Math.max(cpu.busy ?? cpu.agents, cpu.agents);
  const free = gentle ? Math.max(0, Math.min(cores, cpu.free)) : 0;
  return (
    <Gauge
      label="CPU"
      value={busy.toFixed(1)}
      sub={`/${cores}`}
      parts={[
        { from: 0, to: cpu.agents / cores, color: 'var(--s1)' },
        { from: cpu.agents / cores, to: busy / cores, color: 'var(--border-strong)' },
      ]}
      needle={busy / cores}
      band={free ? { from: 1 - free / cores, to: 1 } : undefined}
      title={`CPU: ${busy.toFixed(1)} of ${cores} cores busy, agents ${cpu.agents.toFixed(1)}${free ? `; ${free} kept free for you` : ''}`}
    />
  );
}

/** Memory in use, coloured by macOS memory pressure (green, amber, red). */
function MemGauge({ mem }: { mem: MemInfo }) {
  const gb = (b: number) => (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1);
  const used = Math.min(mem.used, mem.total);
  const color = mem.pressure === 'critical' ? 'var(--critical)' : mem.pressure === 'warn' ? 'var(--warning)' : 'var(--good)';
  const swap = mem.swap && mem.swap >= 256 * 1024 ** 2 ? `, ${gb(mem.swap)} GB swapped` : '';
  return (
    <Gauge
      label="Memory"
      value={gb(used)}
      sub={`/${gb(mem.total)} GB`}
      parts={[{ from: 0, to: used / Math.max(1, mem.total), color }]}
      needle={used / Math.max(1, mem.total)}
      title={`Memory: ${gb(used)} of ${gb(mem.total)} GB${mem.pressure ? `, pressure ${mem.pressure}` : ''}${swap}`}
    />
  );
}
