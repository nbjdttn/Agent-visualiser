import { Laptop } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  latestState,
  nonce,
  parseRelayLines,
  sealControl,
  topicUrl,
  type ControlInfo,
  type GentleMode,
  type StateMessage,
} from '../../core/sync/control';
import { relative } from '../lib/format';
import { useData } from '../lib/store';
import { Card, Segmented } from './ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchState(info: ControlInfo): Promise<StateMessage | null> {
  const res = await fetch(`${topicUrl(info)}/json?poll=1&since=3h`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return latestState(info, parseRelayLines(await res.text()));
}

async function sendMode(info: ControlInfo, mode: GentleMode, by?: string): Promise<number> {
  const at = Date.now();
  const body = await sealControl(info, { t: 'set', mode, at, by, n: nonce() });
  const res = await fetch(topicUrl(info), { method: 'POST', body });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return at;
}

function jobsText(s: StateMessage): string {
  if (!s.held) return 'no busy agent jobs';
  return `${s.held} agent job${s.held === 1 ? '' : 's'} ${s.how === 'pause' ? 'paused' : 'slowed'}`;
}

function statusText(s: StateMessage): string {
  if (s.mode === 'work') return `Work mode · ${jobsText(s)}`;
  if (s.mode === 'full') return 'Full speed · agents are never slowed';
  if (!s.here) return "You're away · agents have the whole Mac";
  return `${s.reason === 'media' ? 'Video or call on' : "You're at your Mac"} · ${jobsText(s)}`;
}

/**
 * Gentle mode on the Mac, from the phone: Auto follows your keyboard and
 * mouse, Work mode keeps the agents' heavy jobs slowed, Full speed lets them
 * have the whole Mac. Shown once gentle mode is installed on a computer.
 */
export function MacCard() {
  const { sync } = useData();
  const mac = sync?.computers?.find((c) => c.control);
  const info = mac?.control;
  const [state, setState] = useState<StateMessage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<GentleMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const infoRef = useRef(info);
  infoRef.current = info;

  const refresh = useCallback(async () => {
    const i = infoRef.current;
    if (!i) return null;
    try {
      const s = await fetchState(i);
      setState(s);
      setError(null);
      return s;
    } catch {
      setError("Can't reach your Mac's link right now");
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!info?.topic) return;
    void refresh();
    const tick = () => document.visibilityState === 'visible' && void refresh();
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [info?.topic, refresh]);

  const choose = async (mode: GentleMode) => {
    if (!info || pending) return;
    setPending(mode);
    setError(null);
    try {
      const sentAt = await sendMode(info, mode, sync?.kid);
      let heard = false;
      for (const wait of [1200, 2000, 3000, 5000, 8000]) {
        await sleep(wait);
        const s = await refresh();
        if (s && s.mode === mode && s.at >= sentAt - 5_000) {
          heard = true;
          break;
        }
      }
      if (!heard) setError('Sent. Your Mac will switch when it’s awake.');
    } catch {
      setError("Couldn't send it. Check your connection.");
    } finally {
      setPending(null);
    }
  };

  if (!info || !mac) return null;
  const stale = state && Date.now() - state.at > 75 * 60_000;
  const status = pending
    ? 'Telling your Mac…'
    : error
      ? error
      : !loaded
        ? 'Checking…'
        : !state
          ? 'Not heard from your Mac in the last 3 hours'
          : stale
            ? `Last heard ${relative(state.at)} · ${statusText(state)}`
            : statusText(state);
  const busy = state && !stale && (state.mode === 'work' || (state.mode === 'auto' && state.here)) && state.held > 0;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] ${busy ? 'bg-[color-mix(in_srgb,var(--warning)_22%,transparent)] text-ink' : 'bg-surface-2 text-ink-2'}`}
          aria-hidden
        >
          <Laptop size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold text-ink lg:text-[15px]">{mac.name}</h2>
          <p className="truncate text-[14px] text-muted lg:text-[13px]">{status}</p>
        </div>
      </div>
      <div className="mt-3">
        <Segmented
          size="md"
          block
          label="Agents on your Mac"
          value={pending ?? state?.mode ?? 'auto'}
          onChange={(m) => void choose(m)}
          options={[
            { value: 'auto', label: 'Auto', title: 'Slow agent jobs while you use the Mac' },
            { value: 'work', label: 'Work mode', title: 'Keep agent jobs slowed' },
            { value: 'full', label: 'Full speed', title: 'Never slow agent jobs' },
          ]}
        />
      </div>
    </Card>
  );
}
