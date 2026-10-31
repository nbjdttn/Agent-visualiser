/**
 * Gentle mode, the testable part: is someone at the Mac, which processes are
 * the agents' heavy jobs, and holding those jobs back (and letting them go).
 *
 * Nothing here needs special macOS permissions: idle time comes from
 * IOHIDSystem's HIDIdleTime counter (no keystrokes or mouse positions are
 * read), videos and calls from power assertions, jobs from `ps`.
 */
import type { GentleMode } from '../core/sync/control.js';

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
  /** slow: background priority (efficiency cores, low I/O). cap: stopped half the time. pause: stopped. */
  how: 'slow' | 'cap' | 'pause';
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

/** How long a playing video or call counts as "here" without any input. */
export const MEDIA_MAX_SEC = 30 * 60;

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
 * Holds jobs back and lets them go. "slow" uses macOS background priority
 * (`taskpolicy -b`), which on Apple silicon moves the job to the efficiency
 * cores and leaves the performance cores to you; if that's refused, the job is
 * capped instead (stopped for half of every 200 ms). "pause" stops the job
 * until you're away.
 */
export class Holder {
  readonly held = new Map<number, Held>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private phase = false;

  constructor(
    private readonly exec: Exec,
    private readonly log: (msg: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    /** Whether background priority can be set and undone here (see the helper's startup check). */
    private readonly background = true,
  ) {}

  async hold(p: Proc, name: string, want: 'slow' | 'pause'): Promise<boolean> {
    if (this.held.has(p.pid)) return false;
    const base = { pid: p.pid, name, command: p.command, since: this.now() };
    if (want === 'pause') {
      if (!this.exec.signal(p.pid, 'SIGSTOP')) return false;
      this.held.set(p.pid, { ...base, how: 'pause' });
      return true;
    }
    const r = this.background ? await this.exec.run('taskpolicy', ['-b', '-p', String(p.pid)]) : { ok: false };
    if (r.ok) {
      this.held.set(p.pid, { ...base, how: 'slow' });
    } else {
      if (this.background) this.log(`Background priority was refused for ${name} (${p.pid}); capping it at half speed instead.`);
      this.held.set(p.pid, { ...base, how: 'cap' });
      this.startCycle();
    }
    return true;
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
    this.stopCycleIfIdle();
  }

  async releaseAll(): Promise<number> {
    const pids = [...this.held.keys()];
    for (const pid of pids) await this.release(pid);
    return pids.length;
  }

  /** Forget jobs that have finished. */
  prune(alive: Set<number>): void {
    for (const pid of [...this.held.keys()]) if (!alive.has(pid)) this.held.delete(pid);
    this.stopCycleIfIdle();
  }

  /** One step of the half-speed cap: alternately stop and continue capped jobs. */
  cycle(): void {
    this.phase = !this.phase;
    for (const h of this.held.values()) if (h.how === 'cap') this.exec.signal(h.pid, this.phase ? 'SIGSTOP' : 'SIGCONT');
  }

  private startCycle() {
    if (!this.timer) this.timer = setInterval(() => this.cycle(), 100);
  }

  private stopCycleIfIdle() {
    if (this.timer && ![...this.held.values()].some((h) => h.how === 'cap')) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.phase = false;
    }
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
