import clsx from 'clsx';
import { Laptop } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
            <Ring
              label="GPU"
              value={`${Math.round(state.gpu)}`}
              unit="%"
              parts={[{ to: state.gpu / 100, color: 'var(--s3)' }]}
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

/** Rings sweep 270°, open at the bottom, where the label sits. */
const START = 135;
const SWEEP = 270;
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
 * A glowing ring: a softly tinted track, the value as a gradient arc that
 * glows in its own colour with a bright cap at the tip, the number in the
 * middle and the label in the opening at the bottom. Parts follow each other
 * round the ring; the first is the main one (it glows); a later part is drawn
 * quietly. `band` is a thin glowing green arc outside the ring (the cores kept
 * free for you).
 */
function Ring({
  label,
  value,
  unit,
  parts,
  band,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  parts: { to: number; color: string; quiet?: boolean }[];
  band?: { from: number; to: number };
  title: string;
}) {
  const uid = useId().replace(/:/g, '');
  const W = 104;
  const H = 98;
  const r = 37;
  const sw = 9;
  const cx = W / 2;
  const cy = 50;
  const track = arc(cx, cy, r, START, START + SWEEP);
  const main = parts[0]?.color ?? 'var(--s1)';
  // Each part ends where it says and starts where the one before ended; later parts are drawn
  // underneath from the start of the ring, so only the stretch beyond the earlier part shows.
  let from = 0;
  const segs = parts.map((p) => {
    const seg = { ...p, from, to: Math.max(from, clamp01(p.to)) };
    from = seg.to;
    return seg;
  });
  const lead = segs[0];
  const tip = lead && lead.to - lead.from > 0.01 ? polar(cx, cy, r, START + SWEEP * lead.to) : undefined;
  return (
    <div className="flex justify-center" role="img" aria-label={title} title={title}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible" aria-hidden>
        <defs>
          <linearGradient id={`${uid}g`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor={`color-mix(in srgb, ${main} 70%, white)`} />
            <stop offset="1" stopColor={main} />
          </linearGradient>
        </defs>
        <path d={track} fill="none" style={{ stroke: `color-mix(in srgb, ${main} 14%, transparent)` }} strokeWidth={sw} strokeLinecap="round" />
        {segs
          .slice()
          .reverse()
          .filter((p) => p.to - p.from > 0.004)
          .map((p, i) => {
            const isLead = p === lead;
            return (
              <path
                key={i}
                d={track}
                pathLength={100}
                fill="none"
                strokeWidth={sw}
                strokeLinecap="round"
                strokeDasharray={`${(p.to * 100).toFixed(2)} 200`}
                style={{
                  stroke: isLead ? `url(#${uid}g)` : `color-mix(in srgb, ${p.color} 55%, transparent)`,
                  filter: isLead ? `drop-shadow(0 0 5px color-mix(in srgb, ${p.color} 60%, transparent))` : undefined,
                  transition: 'stroke-dasharray 800ms cubic-bezier(0.2, 0.7, 0.2, 1)',
                }}
              />
            );
          })}
        {tip ? <circle cx={tip[0]} cy={tip[1]} r={2.2} style={{ fill: 'white', opacity: 0.9 }} /> : null}
        {band && band.to - band.from > 0.004 ? (
          <path d={arc(cx, cy, r + sw / 2 + 4.5, START + SWEEP * clamp01(band.from), START + SWEEP * clamp01(band.to))} fill="none" className="gauge-band" strokeWidth={3.5} strokeLinecap="round" />
        ) : null}
        <text x={cx} y={cy + 7} textAnchor="middle" className="tnum" style={{ fill: 'var(--text)', fontSize: 21, fontWeight: 750, letterSpacing: '-0.02em' }}>
          {value}
          {unit ? <tspan style={{ fill: 'var(--muted)', fontSize: 12, fontWeight: 600 }}>{unit}</tspan> : null}
        </text>
        <text x={cx} y={cy + r + 3} textAnchor="middle" style={{ fill: 'var(--muted)', fontSize: 12, fontWeight: 650 }}>
          {label}
        </text>
      </svg>
    </div>
  );
}

/** CPU: the agents glow blue, everything else follows quietly; the cores kept free for you glow green outside the ring. */
function CpuGauge({ cpu, gentle }: { cpu: CpuInfo; gentle: boolean }) {
  const cores = Math.max(1, cpu.cores);
  const busy = Math.max(cpu.busy ?? cpu.agents, cpu.agents);
  const free = gentle ? Math.max(0, Math.min(cores, cpu.free)) : 0;
  return (
    <Ring
      label="CPU"
      value={busy.toFixed(1)}
      unit={`/${cores}`}
      parts={[
        { to: cpu.agents / cores, color: 'var(--s1)' },
        { to: busy / cores, color: 'var(--muted)', quiet: true },
      ]}
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
    <Ring
      label="Memory"
      value={gb(used)}
      unit={`/${gb(mem.total)}G`}
      parts={[{ to: used / Math.max(1, mem.total), color }]}
      title={`Memory: ${gb(used)} of ${gb(mem.total)} GB${mem.pressure ? `, pressure ${mem.pressure}` : ''}${swap}`}
    />
  );
}
