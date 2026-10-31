/**
 * Gentle mode, the testable part: is someone at the Mac, which processes are
 * the agents' heavy jobs, and holding those jobs back (and letting them go).
 *
 * Nothing here needs special macOS permissions: idle time comes from
 * IOHIDSystem's HIDIdleTime counter (no keystrokes or mouse positions are
 * read), videos and calls from power assertions, jobs from `ps`.
 */
import type { GentleHow, GentleMode } from '../core/sync/control.js';

export interface Proc {
  pid: number;
  ppid: number;
  uid: number;
  cpu: number;
  command: string;
}

/** A job we're holding back while you're at the Mac. */
export interface Held {
  pid: number;
  name: string;
  command: string;
  /**
   * share: runs part of every 50 ms so all agent jobs together leave some cores free.
   * slow: background priority (efficiency cores, low I/O). pause: stopped.
   * (cap: an older name for share, still understood when recovering.)
   */
  how: GentleHow | 'cap';
  since: number;
}

export interface Presence {
  here: boolean;
  /** input, media, work, full, away, unknown */
  reason: string;
}

/** Seconds since the last keyboard, mouse or trackpad input (HIDIdleTime is in nanoseconds). */
export function parseIdleSeconds(ioreg: string): number | undefined {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg);
  return m ? Number(m[1]) / 1e9 : undefined;
}

/** Keep-awake tools hold the screen on without anyone watching it. */
const KEEP_AWAKE = /caffeinate|amphetamine|keepingyouawake|lungo|theine|caffeine|jolt|nosleep|insomnia/i;

/** Apps keeping the screen awake for a person: a video, a call, a presentation. */
export function parseDisplayAssertions(pmset: string): { pid: number; name: string }[] {
  const out: { pid: number; name: string }[] = [];
  for (const line of pmset.split('\n')) {
    const m = /^\s*pid (\d+)\((.*?)\):.*\b(PreventUserIdleDisplaySleep|NoDisplaySleepAssertion)\b/.exec(line);
    if (m && !KEEP_AWAKE.test(m[2])) out.push({ pid: Number(m[1]), name: m[2] });
  }
  return out;
}

/**
 * Whether sound is playing: coreaudiod keeps the Mac awake while any audio
 * device is in use. A real video or call has sound; a muted clip looping in a
 * background tab doesn't, and shouldn't make the Mac think you're there.
 */
export function parseAudioPlaying(pmset: string): boolean {
  return pmset.split('\n').some((l) => /pid \d+\(coreaudiod\):.*PreventUserIdleSystemSleep/.test(l));
}

/** GPU utilisation from `ioreg -r -d 1 -w 0 -c IOAccelerator` (the busiest GPU), percent. */
export function parseGpuUtil(ioreg: string): number | undefined {
  const all = [...ioreg.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  return all.length ? Math.min(100, Math.max(...all)) : undefined;
}

/** Memory in use from `vm_stat`, counted like Activity Monitor: app memory + wired + compressed. */
export function parseVmStat(vmstat: string): number | undefined {
  const page = Number(/page size of (\d+) bytes/.exec(vmstat)?.[1] ?? 4096);
  const get = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(vmstat);
    return m ? Number(m[1]) : undefined;
  };
  const wired = get('Pages wired down');
  const compressed = get('Pages occupied by compressor') ?? 0;
  if (wired === undefined) return undefined;
  const anonymous = get('Anonymous pages');
  const app = anonymous !== undefined ? anonymous - (get('Pages purgeable') ?? 0) : (get('Pages active') ?? 0);
  return Math.max(0, app + wired + compressed) * page;
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parsePressure(level: string): 'normal' | 'warn' | 'critical' | undefined {
  const n = Number(level.trim());
  return n === 1 ? 'normal' : n === 2 ? 'warn' : n === 4 ? 'critical' : undefined;
}

/** Swap in use from `sysctl -n vm.swapusage` ("total = 2048.00M  used = 1234.56M  free = ..."), in bytes. */
export function parseSwap(s: string): number | undefined {
  const m = /used\s*=\s*([\d.]+)([KMGT])/.exec(s);
  if (!m) return undefined;
  return Number(m[1]) * 1024 ** ({ K: 1, M: 2, G: 3, T: 4 } as const)[m[2] as 'K' | 'M' | 'G' | 'T'];
}

export interface CpuTimes {
  idle: number;
  total: number;
}

/** Cores' worth busy between two readings of per-core CPU times (from os.cpus()). */
export function coresBusy(before: CpuTimes[], after: CpuTimes[]): number | undefined {
  if (!before.length || before.length !== after.length) return undefined;
  let busy = 0;
  for (let i = 0; i < after.length; i++) {
    const total = after[i].total - before[i].total;
    const idle = after[i].idle - before[i].idle;
    if (total > 0) busy += Math.max(0, Math.min(1, (total - idle) / total));
  }
  return busy;
}

/** CPU time from ps (`321:45.67` on macOS, `01:02:03` or `2-01:02:03` elsewhere), in seconds. */
export function parseCpuTime(s: string): number {
  const [days, rest] = s.includes('-') ? s.split('-') : ['0', s];
  const parts = rest.split(':').map(Number);
  let secs = 0;
  for (const p of parts) secs = secs * 60 + (Number.isFinite(p) ? p : 0);
  return Number(days) * 86_400 + secs;
}

/**
 * The share of time agent jobs may run so that together they use at most
 * `budget` cores, given that they'd use `demand` cores if left alone.
 */
export function shareFraction(demand: number, budget: number): number {
  if (!(demand > 0) || demand <= budget) return 1;
  return Math.max(0.1, Math.min(1, budget / demand));
}

/** Rows of `ps -axo pid=,ppid=,uid=,pcpu=,command=`. */
export function parsePs(out: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), cpu: parseFloat(m[4].replace(',', '.')), command: m[5] });
  }
  return rows;
}

/** Rows of `ps -axo pid=,ucomm=` (the executable's short name, which may contain spaces). */
export function parseNames(out: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) names.set(Number(m[1]), m[2]);
  }
  return names;
}

/** Claude Code or Codex itself (not the Claude desktop app, whose name is capitalised). */
export function isAgentRoot(name: string | undefined, command: string): boolean {
  if (name === 'claude' || name === 'codex') return true;
  if (name && /^node/.test(name)) {
    return /@anthropic-ai\/claude-code|@openai\/codex|\/(claude|codex)(\.js)?(\s|$)/.test(command);
  }
  return false;
}

/** Environment markers of work started by an agent, kept even after the job outlives its shell. */
export const AGENT_ENV = /(^|\s)(CLAUDECODE=1|CLAUDE_CODE_ENTRYPOINT=\S+|CODEX_SANDBOX=\S+|AV_GENTLE=1)(\s|$)/;

/** A job started with `AV_GENTLE=0` is left alone, e.g. one a scheduler of its own already keeps in check. */
export const OPT_OUT_ENV = /(^|\s)AV_GENTLE=0(\s|$)/;

/** A stopped process (state T in ps), e.g. one a crashed helper left paused. */
export const isStopped = (stat: string) => /^T/.test(stat.trim());

/** Our own processes (this helper and the usage sync) are never held. */
const OWN = /scripts\/(gentle|sync)\.ts/;

/**
 * The agents' jobs: every process below a running Claude Code or Codex, plus
 * any process whose environment says an agent started it (`marked`), that
 * belongs to this user. Only busy ones (≥ minCpu % of a core) are returned.
 */
export function agentJobs(procs: Proc[], names: Map<number, string>, marked: Set<number>, opts: { uid: number; self: number; minCpu: number }): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const roots = procs.filter((p) => isAgentRoot(names.get(p.pid), p.command));
  const below = new Set<number>();
  const stack = roots.flatMap((r) => children.get(r.pid) ?? []);
  while (stack.length) {
    const p = stack.pop()!;
    if (below.has(p.pid)) continue;
    if (isAgentRoot(names.get(p.pid), p.command)) continue; // a nested agent is a root of its own
    below.add(p.pid);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return procs.filter(
    (p) =>
      p.uid === opts.uid &&
      p.pid !== opts.self &&
      p.cpu >= opts.minCpu &&
      (below.has(p.pid) || marked.has(p.pid)) &&
      !isAgentRoot(names.get(p.pid), p.command) &&
      !OWN.test(p.command),
  );
}

/** How long a video or call (screen kept awake, sound playing) counts as "here" without any input. */
export const MEDIA_MAX_SEC = 15 * 60;

export function decidePresence(o: { idleSec?: number; media: boolean; mode: GentleMode; awayAfterSec: number }): Presence {
  if (o.mode === 'work') return { here: true, reason: 'work' };
  if (o.mode === 'full') return { here: false, reason: 'full' };
  if (o.idleSec === undefined) return { here: false, reason: 'unknown' };
  if (o.idleSec < o.awayAfterSec) return { here: true, reason: 'input' };
  if (o.media && o.idleSec < MEDIA_MAX_SEC) return { here: true, reason: 'media' };
  return { here: false, reason: 'away' };
}

export interface Exec {
  /** Run a command; ok is false if it couldn't run or exited non-zero. */
  run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }>;
  signal(pid: number, sig: 'SIGSTOP' | 'SIGCONT'): boolean;
  alive(pid: number): boolean;
}

/**
 * Holds jobs back and lets them go.
 *
 * share (the default): the jobs keep normal priority but run only part of
 * every 50 ms, a part set with setShare() so that together they leave a
 * couple of cores free for you. Nothing changes while they use less than that.
 *
 * slow: macOS background priority (`taskpolicy -b`), which on Apple silicon
 * moves the job onto the efficiency cores. If background priority can't be
 * set (or undone) here, share is used instead.
 *
 * pause: stopped until you're away.
 */
export class Holder {
  readonly held = new Map<number, Held>();
  private fraction = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly exec: Exec,
    private readonly log: (msg: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    /** Whether background priority can be set and undone here (see the helper's startup check). */
    private readonly background = true,
    private readonly periodMs = 50,
  ) {}

  /** The share of time shared jobs currently run (1 = not held back at all). */
  get share(): number {
    return this.fraction;
  }

  async hold(p: Proc, name: string, want: GentleHow): Promise<boolean> {
    if (this.held.has(p.pid)) return false;
    const base = { pid: p.pid, name, command: p.command, since: this.now() };
    if (want === 'pause') {
      if (!this.exec.signal(p.pid, 'SIGSTOP')) return false;
      this.held.set(p.pid, { ...base, how: 'pause' });
      return true;
    }
    if (want === 'slow' && this.background) {
      const r = await this.exec.run('taskpolicy', ['-b', '-p', String(p.pid)]);
      if (r.ok) {
        this.held.set(p.pid, { ...base, how: 'slow' });
        return true;
      }
      this.log(`Background priority was refused for ${name} (${p.pid}); sharing the cores with it instead.`);
    }
    this.held.set(p.pid, { ...base, how: 'share' });
    if (this.stopped) this.exec.signal(p.pid, 'SIGSTOP');
    this.sync();
    return true;
  }

  /** Let shared jobs run this share of the time (clamped to 10–100%). */
  setShare(fraction: number): void {
    this.fraction = Math.max(0.1, Math.min(1, fraction));
    this.sync();
  }

  async release(pid: number): Promise<void> {
    const h = this.held.get(pid);
    if (!h) return;
    this.held.delete(pid);
    if (this.exec.alive(pid)) {
      if (h.how === 'slow') {
        const r = await this.exec.run('taskpolicy', ['-B', '-p', String(pid)]);
        if (!r.ok) this.log(`Couldn't restore full priority for ${h.name} (${pid}).`);
      } else {
        this.exec.signal(pid, 'SIGCONT');
      }
    }
    this.sync();
  }

  async releaseAll(): Promise<number> {
    const pids = [...this.held.keys()];
    for (const pid of pids) await this.release(pid);
    this.fraction = 1;
    this.sync();
    return pids.length;
  }

  /** Forget jobs that have finished. */
  prune(alive: Set<number>): void {
    for (const pid of [...this.held.keys()]) if (!alive.has(pid)) this.held.delete(pid);
    this.sync();
  }

  private shared(): Held[] {
    return [...this.held.values()].filter((h) => h.how === 'share' || h.how === 'cap');
  }

  /** Start or stop the run/stop cycle to match the share and the jobs held. */
  private sync() {
    const needed = this.fraction < 0.98 && this.shared().length > 0;
    if (needed && !this.timer) this.runPhase();
    if (!needed && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!needed && this.stopped) {
      for (const h of this.shared()) this.exec.signal(h.pid, 'SIGCONT');
      this.stopped = false;
    }
  }

  private runPhase() {
    if (this.stopped) {
      for (const h of this.shared()) this.exec.signal(h.pid, 'SIGCONT');
      this.stopped = false;
    }
    const on = Math.max(1, Math.round(this.periodMs * this.fraction));
    this.timer = setTimeout(() => {
      for (const h of this.shared()) this.exec.signal(h.pid, 'SIGSTOP');
      this.stopped = true;
      this.timer = setTimeout(() => this.runPhase(), Math.max(1, this.periodMs - on));
    }, on);
  }
}

/** After a crash or restart: let go of anything the last run was still holding. */
export async function recover(previous: Held[], exec: Exec, commandOf: (pid: number) => string | undefined): Promise<number> {
  let n = 0;
  for (const h of previous) {
    if (!exec.alive(h.pid) || commandOf(h.pid) !== h.command) continue;
    if (h.how === 'slow') await exec.run('taskpolicy', ['-B', '-p', String(h.pid)]);
    else exec.signal(h.pid, 'SIGCONT');
    n++;
  }
  return n;
}

/** A short, friendly list of job names: "python3, julia and 2 more". */
export function jobNames(held: Iterable<Held>): string {
  const names = [...new Set([...held].map((h) => h.name))];
  if (names.length <= 3) return names.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
