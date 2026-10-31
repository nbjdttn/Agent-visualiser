#!/usr/bin/env tsx
/**
 * Gentle mode for a Mac that runs AI agents.
 *
 * While you're using the Mac (keyboard or mouse in the last couple of
 * minutes, or a video or call keeping the screen awake), the agents' heavy
 * jobs (simulations, builds, anything busy started by Claude Code or Codex)
 * share the Mac so that a couple of cores stay free for you; they keep going
 * at nearly full speed. When you've been away for a while they get the whole
 * Mac back. From the phone app you can force Work mode (always gentle) or
 * Full speed (never gentle); Auto follows you. The phone also sees how many
 * cores the agents are using and how many are kept free for you.
 *
 *   npm run gentle -- install [--free-cores N] [--slow | --pause] [--away-after MIN] [--relay URL|off]
 *   npm run gentle -- status
 *   npm run gentle -- work | auto | full
 *   npm run gentle -- release          let every held job go right now
 *   npm run gentle -- uninstall
 *   npm run gentle -- run              what the background job runs
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_RELAY,
  isControlInfo,
  newControlInfo,
  nonce,
  openControl,
  sealControl,
  topicUrl,
  type ControlInfo,
  type CpuInfo,
  type GentleHow,
  type GentleMode,
  type MemInfo,
  type StateMessage,
} from '../core/sync/control.js';
import {
  AGENT_ENV,
  OPT_OUT_ENV,
  agentJobs,
  decidePresence,
  Holder,
  jobNames,
  coresBusy,
  parseCpuTime,
  parseGpuUtil,
  parsePressure,
  parseSwap,
  parseVmStat,
  type CpuTimes,
  parseDisplayAssertions,
  parseRemoteSession,
  parseIdleSeconds,
  parseAudioPlaying,
  isStopped,
  parseNames,
  parsePs,
  recover,
  shareFraction,
  type Exec,
  type Held,
  type Presence,
  type Proc,
} from './gentle-lib.js';
import { reloadAgent } from './launchd.js';

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agent-visualiser');
export const GENTLE_CONFIG = path.join(CONFIG_DIR, 'gentle.json');
const STATE_FILE = path.join(CONFIG_DIR, 'gentle-state.json');
const LABEL = 'io.github.agent-visualiser.gentle';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'agent-visualiser-gentle.log');

const TICK_MS = 2_000;
const SCAN_MS = 3_000;
const AWAY_SCAN_MS = 15_000;
const MEDIA_MS = 10_000;
const SYSTEM_MS = 10_000;
/** ntfy.sh allows a few hundred messages a day: a status at most every 15 s, a heartbeat hourly. */
const PUBLISH_GAP_MS = 15_000;
const HEARTBEAT_MS = 60 * 60_000;
const MIN_CPU = 25;
const CORES = Math.max(1, os.cpus().length);

export interface GentleConfig {
  v: 2;
  /** Installed as a background job (the phone only shows the switch then). */
  enabled: boolean;
  mode: GentleMode;
  /** What happens to agent jobs while you're here: share the cores, slow (efficiency cores) or pause. */
  how: GentleHow;
  /** Cores kept free for you while sharing. */
  freeCores: number;
  awayAfterSec: number;
  /** Phone control; null when turned off. */
  control: ControlInfo | null;
  /** The newest phone command applied (replay guard). */
  lastSetAt: number;
  /** The relay's id of the last message seen. */
  relaySince?: string;
}

interface RuntimeState {
  pid: number;
  updatedAt: number;
  mode: GentleMode;
  how: GentleHow;
  here: boolean;
  reason: string;
  idleSec?: number;
  held: Held[];
  cpu?: CpuInfo;
  gpu?: number;
  mem?: MemInfo;
}

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadConfig(): GentleConfig {
  let c: Partial<GentleConfig> = {};
  try {
    c = JSON.parse(fs.readFileSync(GENTLE_CONFIG, 'utf8'));
  } catch {
    // first run
  }
  // Version 1 always used background priority; sharing the cores is the default now.
  const how: GentleHow = c.how === 'pause' ? 'pause' : c.how === 'slow' && c.v === 2 ? 'slow' : 'share';
  return {
    v: 2,
    enabled: c.enabled ?? false,
    mode: c.mode === 'work' || c.mode === 'full' ? c.mode : 'auto',
    how,
    freeCores: Number.isFinite(c.freeCores) && c.freeCores! >= 1 ? Math.min(c.freeCores!, CORES - 1) : Math.min(2, CORES - 1),
    awayAfterSec: Number.isFinite(c.awayAfterSec) && c.awayAfterSec! >= 15 ? c.awayAfterSec! : 120,
    control: c.control === null ? null : isControlInfo(c.control) ? c.control : newControlInfo(),
    lastSetAt: c.lastSetAt ?? 0,
    relaySince: c.relaySince,
  };
}

function saveConfig(c: GentleConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${GENTLE_CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, GENTLE_CONFIG);
}

function loadRuntime(): RuntimeState | undefined {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as RuntimeState;
  } catch {
    return undefined;
  }
}

function saveRuntime(s: RuntimeState) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

const exec: Exec = {
  async run(cmd, args) {
    try {
      const { stdout } = await pexec(cmd, args, { timeout: 8_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
      return { ok: true, out: stdout };
    } catch (err) {
      return { ok: false, out: String((err as { stdout?: string }).stdout ?? '') };
    }
  },
  signal(pid, sig) {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

// ---------------------------------------------------------------------------
// Reading the Mac
// ---------------------------------------------------------------------------

let ioregArgs: string[] | undefined;
async function readIdleSeconds(): Promise<number | undefined> {
  for (const args of ioregArgs ? [ioregArgs] : [['-r', '-d', '1', '-c', 'IOHIDSystem'], ['-c', 'IOHIDSystem']]) {
    const r = await exec.run('ioreg', args);
    const idle = r.ok ? parseIdleSeconds(r.out) : undefined;
    if (idle !== undefined) {
      ioregArgs = args;
      return idle;
    }
  }
  return undefined;
}

/** Apps showing a video or call: they keep the screen awake and sound is playing. */
async function readMedia(): Promise<{ media: string[]; remote: boolean }> {
  const r = await exec.run('pmset', ['-g', 'assertions']);
  if (!r.ok) return { media: [], remote: false };
  const remote = parseRemoteSession(r.out);
  if (!parseAudioPlaying(r.out)) return { media: [], remote };
  return { media: [...new Set(parseDisplayAssertions(r.out).map((a) => a.name))], remote };
}

/**
 * Safety net at start: continue any agent job left stopped (by a helper that
 * crashed between two halves of its run/stop cycle, or a paused one).
 */
async function wakeStoppedJobs(): Promise<number> {
  const [ps, stat, ucomm] = await Promise.all([
    exec.run('ps', ['-axww', '-o', 'pid=,ppid=,uid=,pcpu=,command=']),
    exec.run('ps', ['-ax', '-o', 'pid=,stat=']),
    exec.run('ps', ['-ax', '-o', 'pid=,ucomm=']),
  ]);
  const stopped = new Set<number>();
  for (const line of stat.out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (m && isStopped(m[2])) stopped.add(Number(m[1]));
  }
  if (!stopped.size) return 0;
  const procs = parsePs(ps.out);
  const uid = process.getuid?.() ?? -1;
  const below = agentJobs(procs, parseNames(ucomm.out), new Set(), { uid, self: process.pid, minCpu: 0 });
  let n = 0;
  for (const p of below) if (stopped.has(p.pid) && exec.signal(p.pid, 'SIGCONT')) n++;
  return n;
}

/** pid → its CPU time at the last look, to measure how many cores jobs really use. */
const cpuSeen = new Map<number, { t: number; at: number }>();

const lastRates = new Map<number, number>();

/** Cores' worth the given processes used since the last look (new ones count at their ps average). */
async function coresUsed(jobs: Proc[]): Promise<number> {
  if (!jobs.length) {
    cpuSeen.clear();
    return 0;
  }
  const r = await exec.run('ps', ['-o', 'pid=,time=', '-p', jobs.map((j) => j.pid).join(',')]);
  const now = Date.now();
  const rate = new Map<number, number>();
  for (const line of r.out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const t = parseCpuTime(m[2]);
    const prev = cpuSeen.get(pid);
    cpuSeen.set(pid, { t, at: now });
    if (prev && now > prev.at && t >= prev.t) rate.set(pid, (t - prev.t) / ((now - prev.at) / 1000));
  }
  const ids = new Set(jobs.map((j) => j.pid));
  for (const pid of cpuSeen.keys()) if (!ids.has(pid)) cpuSeen.delete(pid);
  lastRates.clear();
  for (const [pid, r] of rate) lastRates.set(pid, r);
  return jobs.reduce((a, j) => a + (rate.get(j.pid) ?? j.cpu / 100), 0);
}

/** Per-core CPU times now (idle and total, in ms) for measuring how busy the whole Mac is. */
function cpuTimes(): CpuTimes[] {
  return os.cpus().map((c) => ({ idle: c.times.idle, total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }));
}

/** GPU use, memory in use (with pressure and swap): a quick look like Activity Monitor's. */
async function readSystem(): Promise<{ gpu?: number; mem?: MemInfo }> {
  const [gpu, vm, pressure, swap] = await Promise.all([
    exec.run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
    exec.run('vm_stat', []),
    exec.run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    exec.run('sysctl', ['-n', 'vm.swapusage']),
  ]);
  const used = vm.ok ? parseVmStat(vm.out) : undefined;
  const mem: MemInfo | undefined =
    used === undefined
      ? undefined
      : JSON.parse(JSON.stringify({ used, total: os.totalmem(), pressure: pressure.ok ? parsePressure(pressure.out) : undefined, swap: swap.ok ? parseSwap(swap.out) : undefined }));
  return { gpu: gpu.ok ? parseGpuUtil(gpu.out) : undefined, mem };
}

/**
 * Can this Mac set background priority on a process and undo it? Tried on a
 * throwaway `sleep`, so a job is never left slowed by a one-way change.
 */
async function backgroundPriorityWorks(): Promise<boolean> {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    if (!child.pid) return false;
    const on = await exec.run('taskpolicy', ['-b', '-p', String(child.pid)]);
    const off = on.ok ? await exec.run('taskpolicy', ['-B', '-p', String(child.pid)]) : on;
    return on.ok && off.ok;
  } finally {
    child.kill();
  }
}

/** pid → whether its environment says an agent started it (cached per command line). */
const envCache = new Map<number, { command: string; marked: boolean; optOut: boolean }>();

async function scan(): Promise<{ procs: Proc[]; names: Map<number, string>; jobs: Proc[] }> {
  const [ps, ucomm] = await Promise.all([exec.run('ps', ['-axww', '-o', 'pid=,ppid=,uid=,pcpu=,command=']), exec.run('ps', ['-ax', '-o', 'pid=,ucomm='])]);
  const procs = parsePs(ps.out);
  const names = parseNames(ucomm.out);
  const uid = process.getuid?.() ?? -1;
  const busy = procs.filter((p) => p.uid === uid && p.cpu >= MIN_CPU && p.pid !== process.pid);
  const unknown = busy.filter((p) => envCache.get(p.pid)?.command !== p.command);
  if (unknown.length) {
    const r = await exec.run('ps', ['-Eww', '-o', 'pid=,command=', '-p', unknown.map((p) => p.pid).join(',')]);
    const envOf = new Map<number, string>();
    for (const line of r.out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) envOf.set(Number(m[1]), m[2]);
    }
    for (const p of unknown) {
      const env = envOf.get(p.pid) ?? '';
      envCache.set(p.pid, { command: p.command, marked: AGENT_ENV.test(env), optOut: OPT_OUT_ENV.test(env) });
    }
  }
  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of envCache.keys()) if (!alive.has(pid)) envCache.delete(pid);
  const marked = new Set([...envCache.entries()].filter(([, v]) => v.marked).map(([pid]) => pid));
  const optOut = new Set([...envCache.entries()].filter(([, v]) => v.optOut).map(([pid]) => pid));
  const jobs = agentJobs(procs, names, marked, { uid, self: process.pid, minCpu: MIN_CPU }).filter((p) => !optOut.has(p.pid));
  return { procs, names, jobs };
}

// ---------------------------------------------------------------------------
// The phone link (an encrypted ntfy topic)
// ---------------------------------------------------------------------------

class Relay {
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPublish = 0;
  private publishDue = 0;
  private lastPing = 0;
  private abort: AbortController | undefined;

  constructor(
    private readonly getConfig: () => GentleConfig,
    private readonly onMode: (mode: GentleMode, by?: string) => void,
    private readonly snapshot: () => Omit<StateMessage, 't' | 'at' | 'n'>,
  ) {}

  /** Listen for phone commands for as long as the helper runs. */
  async listen(): Promise<never> {
    let backoff = 5_000;
    for (;;) {
      const cfg = this.getConfig();
      const info = cfg.control;
      if (!info) {
        await sleep(60_000);
        continue;
      }
      this.abort = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const pet = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => this.abort?.abort(), 150_000);
      };
      try {
        const since = cfg.relaySince ?? '10m';
        const res = await fetch(`${topicUrl(info)}/json?since=${encodeURIComponent(since)}`, {
          signal: this.abort.signal,
          headers: { 'User-Agent': 'agent-visualiser-gentle' },
        });
        if (!res.ok || !res.body) throw new Error(`relay answered ${res.status}`);
        backoff = 5_000;
        pet();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pet();
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            await this.handle(info, line);
          }
        }
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) log(`Phone link: ${err instanceof Error ? err.message : String(err)}; retrying.`);
      } finally {
        clearTimeout(watchdog);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  }

  private async handle(info: ControlInfo, line: string) {
    let e: { id?: string; event?: string; message?: string };
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.event !== 'message' || !e.message) return;
    const cfg = this.getConfig();
    if (e.id) {
      cfg.relaySince = e.id;
      saveConfig(cfg);
    }
    const msg = await openControl(info, e.message);
    if (!msg || msg.t === 'state') return;
    const skew = Math.abs(Date.now() - msg.at);
    if (skew > 15 * 60_000) return;
    if (msg.t === 'ping') {
      // The app was opened: send a fresh status unless one went out moments ago.
      if (msg.at > this.lastPing && Date.now() - this.lastPublish > 20_000) this.publishSoon(1_500, true);
      this.lastPing = Math.max(this.lastPing, msg.at);
      return;
    }
    if (msg.at <= cfg.lastSetAt) return;
    cfg.lastSetAt = msg.at;
    saveConfig(cfg);
    this.onMode(msg.mode, msg.by);
  }

  /**
   * Tell the phone what's happening: soon, and at most every 15 seconds; an
   * answer to the phone (a command or "the app is open") goes out within seconds.
   */
  publishSoon(delay = 2_000, answer = false) {
    const gap = answer ? 3_000 : PUBLISH_GAP_MS;
    const wait = Math.max(delay, gap - (Date.now() - this.lastPublish));
    if (this.publishTimer) {
      if (!answer || this.publishDue <= Date.now() + wait) return;
      clearTimeout(this.publishTimer);
    }
    this.publishDue = Date.now() + wait;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publish();
    }, wait);
  }

  async publish() {
    const info = this.getConfig().control;
    if (!info) return;
    this.lastPublish = Date.now();
    try {
      const body = await sealControl(info, { t: 'state', ...this.snapshot(), at: Date.now(), n: nonce() });
      const res = await fetch(topicUrl(info), { method: 'POST', body, headers: { 'User-Agent': 'agent-visualiser-gentle' } });
      if (!res.ok) log(`Phone link: couldn't send the status (${res.status}).`);
    } catch (err) {
      log(`Phone link: couldn't send the status (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  stop() {
    this.abort?.abort();
    clearTimeout(this.publishTimer);
  }
}

// ---------------------------------------------------------------------------
// The background loop
// ---------------------------------------------------------------------------

function describe(p: Presence, held: Map<number, Held>, how: GentleHow, freeCores: number): string {
  const jobs =
    how === 'share'
      ? `keeping ${freeCores} of ${CORES} cores free for you`
      : held.size
        ? `${how === 'pause' ? 'pausing' : 'slowing'} ${jobNames(held.values())}`
        : 'no busy agent jobs';
  switch (p.reason) {
    case 'work':
      return `Work mode: ${jobs}.`;
    case 'full':
      return 'Full speed: agent jobs have the whole Mac.';
    case 'input':
      return `You're at the Mac: ${jobs}.`;
    case 'media':
      return `A video or call is on: ${jobs}.`;
    case 'unknown':
      return "Can't read the keyboard and mouse idle time; leaving agent jobs alone.";
    default:
      return "You're away: agent jobs have the whole Mac.";
  }
}

async function run() {
  if (process.platform !== 'darwin' && !process.env.GENTLE_ANY_PLATFORM) {
    console.log('Gentle mode watches a Mac’s keyboard and mouse, so it only runs on macOS.');
    return;
  }
  const previous = loadRuntime();
  if (previous && previous.pid !== process.pid && exec.alive(previous.pid) && Date.now() - previous.updatedAt < 150_000) {
    // Only if that process really is gentle mode (after a restart the number may belong to something else).
    const r = await exec.run('ps', ['-o', 'command=', '-p', String(previous.pid)]);
    if (/scripts\/gentle\.ts/.test(r.out)) {
      log(`Gentle mode is already running (process ${previous.pid}); this copy is not needed.`);
      return;
    }
  }
  let cfg = loadConfig();
  saveConfig(cfg); // keeps the generated phone link

  if (previous?.held?.length) {
    const { procs } = await scan();
    const cmd = new Map(procs.map((p) => [p.pid, p.command]));
    const n = await recover(previous.held, exec, (pid) => cmd.get(pid));
    if (n) log(`Let go of ${n} job(s) held by the previous run.`);
  }
  const woken = await wakeStoppedJobs();
  if (woken) log(`Continued ${woken} agent job(s) that had been left stopped.`);

  const background = await backgroundPriorityWorks();
  if (!background && cfg.how === 'slow') log('Background priority isn’t available here; agent jobs will share the cores instead.');
  const holder = new Holder(exec, log, Date.now, background);
  let presence: Presence = { here: false, reason: 'away' };
  let idleSec: number | undefined;
  let media: string[] = [];
  let remote = false;
  let agentsCores = 0;
  let busyCores: number | undefined;
  let gpu: number | undefined;
  let mem: MemInfo | undefined;
  let times = cpuTimes();
  let lastSystem = 0;
  let demand: number | undefined;
  let lastMedia = 0;
  let lastScan = 0;
  let lastSummary = '';
  let lastHeartbeat = 0;
  let lastWrite = 0;

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const cpu = (): CpuInfo => ({
    cores: CORES,
    agents: round1(agentsCores),
    free: !presence.here ? 0 : cfg.how === 'pause' && holder.held.size ? CORES : cfg.freeCores,
    ...(busyCores !== undefined ? { busy: round1(Math.max(busyCores, agentsCores)) } : {}),
  });
  const writeState = () => {
    lastWrite = Date.now();
    saveRuntime({
      pid: process.pid,
      updatedAt: lastWrite,
      mode: cfg.mode,
      how: cfg.how,
      here: presence.here,
      reason: presence.reason,
      idleSec,
      held: [...holder.held.values()],
      cpu: cpu(),
      gpu,
      mem,
    });
  };

  const relay = new Relay(
    () => cfg,
    (mode, by) => {
      if (mode === cfg.mode) return relay.publishSoon(1_500, true);
      cfg.mode = mode;
      saveConfig(cfg);
      relay.publishSoon(2_500, true); // after the next look round, so the answer shows the new mode at work
      log(`From the phone${by ? ` (${by.slice(0, 6)})` : ''}: ${mode === 'work' ? 'Work mode' : mode === 'full' ? 'Full speed' : 'Auto'}.`);
    },
    () => ({
      mode: cfg.mode,
      here: presence.here,
      reason: presence.reason,
      held: holder.held.size,
      how: cfg.how,
      live: presence.here ? 'gentle' : 'full',
      cpu: cpu(),
      ...(gpu !== undefined ? { gpu } : {}),
      ...(mem ? { mem } : {}),
    }),
  );
  if (cfg.control) void relay.listen();

  // Whatever happens, never leave a job stopped: continue them all on the way out.
  process.on('exit', () => {
    for (const h of holder.held.values()) if (h.how !== 'slow') exec.signal(h.pid, 'SIGCONT');
  });
  for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(ev, (err) => {
      log(`Unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      void holder.releaseAll().finally(() => process.exit(1));
    });
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const n = await holder.releaseAll();
    writeState();
    relay.stop();
    log(`Stopped (${signal})${n ? `; let go of ${n} job(s)` : ''}.`);
    process.exit(0);
  };
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => void stop(s));

  log(
    `Gentle mode is on: while you're at the Mac, agent jobs ${
      cfg.how === 'share' ? `leave ${cfg.freeCores} of ${CORES} cores free for you` : cfg.how === 'pause' ? 'are paused' : 'run on background priority'
    }; they get the whole Mac back after ${Math.round(cfg.awayAfterSec / 6) / 10} min away.` + (cfg.control ? ` Phone link: ${cfg.control.relay}.` : ' Phone link: off.'),
  );

  for (;;) {
    try {
      cfg = loadConfig(); // picks up `npm run gentle -- work|auto|full` and phone commands
      const now = Date.now();
      idleSec = await readIdleSeconds();
      if (now - lastMedia >= MEDIA_MS) {
        lastMedia = now;
        ({ media, remote } = await readMedia());
      }
      if (now - lastSystem >= SYSTEM_MS) {
        lastSystem = now;
        const t = cpuTimes();
        busyCores = coresBusy(times, t);
        times = t;
        ({ gpu, mem } = await readSystem());
      }
      presence = decidePresence({ idleSec, media: media.length > 0, remote, mode: cfg.mode, awayAfterSec: cfg.awayAfterSec });

      if (presence.here) {
        if (now - lastScan >= SCAN_MS) {
          lastScan = now;
          const { procs, names, jobs } = await scan();
          holder.prune(new Set(procs.map((p) => p.pid)));
          let added = false;
          for (const j of jobs) {
            const name = names.get(j.pid) ?? path.basename(j.command.split(' ')[0] ?? '?');
            if (await holder.hold(j, name, cfg.how)) added = true;
          }
          if (added) writeState(); // recorded before any of them is ever stopped, for recovery
          // Everything held plus anything busy, even if sharing has made a job look quiet.
          const jobPids = new Set(jobs.map((j) => j.pid));
          const tracked = procs.filter((p) => jobPids.has(p.pid) || holder.held.has(p.pid));
          agentsCores = await coresUsed(tracked);
          if (cfg.how !== 'pause') {
            // What the shared jobs would use if left alone: what they used, given they ran only part of the time.
            const shared = tracked.filter((p) => ['share', 'cap'].includes(holder.held.get(p.pid)?.how ?? ''));
            const used = shared.reduce((a, p) => a + (lastRates.get(p.pid) ?? p.cpu / 100), 0);
            const wanted = Math.min(CORES, used / holder.share);
            demand = demand === undefined ? wanted : 0.5 * demand + 0.5 * wanted;
            holder.setShare(shareFraction(demand, Math.max(1, CORES - cfg.freeCores)));
          }
        }
      } else {
        if (holder.held.size) await holder.releaseAll();
        demand = undefined;
        if (now - lastScan >= AWAY_SCAN_MS) {
          lastScan = now;
          agentsCores = await coresUsed((await scan()).jobs);
        }
      }

      const summary = describe(presence, holder.held, cfg.how, cfg.freeCores) + (presence.reason === 'media' && media.length ? ` (${media.slice(0, 2).join(', ')})` : '');
      if (summary !== lastSummary) {
        lastSummary = summary;
        log(summary);
        writeState();
        relay.publishSoon(8_000); // a moment's grace, so stepping away and straight back sends one message
      } else if (now - lastWrite >= 60_000) {
        writeState();
      }
      if (now - lastHeartbeat >= HEARTBEAT_MS || lastHeartbeat === 0) {
        lastHeartbeat = now;
        if (cfg.control) relay.publishSoon(0);
      }
    } catch (err) {
      log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(TICK_MS);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(): string {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() };
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  const args = [process.execPath, tsxCli, path.join(ROOT, 'scripts', 'gentle.ts'), 'run'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

const launchctl = (...args: string[]) => pexec('launchctl', args);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function install(args: string[]) {
  if (process.platform !== 'darwin') {
    console.log('Gentle mode watches a Mac’s keyboard and mouse, so it only installs on macOS.');
    return;
  }
  const home = os.homedir();
  const blocked = ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents'].find((d) => ROOT.startsWith(path.join(home, d) + path.sep));
  if (blocked) {
    console.error(`This folder is inside ~/${blocked}, which macOS keeps background jobs out of.
Move or clone the repository somewhere else, e.g. ~/Agent-visualiser, and run this there.`);
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  cfg.enabled = true;
  if (args.includes('--share')) cfg.how = 'share';
  if (args.includes('--pause')) cfg.how = 'pause';
  if (args.includes('--slow')) cfg.how = 'slow';
  const free = Number(option(args, '--free-cores'));
  if (Number.isFinite(free) && free >= 1) cfg.freeCores = Math.min(Math.round(free), CORES - 1);
  const away = Number(option(args, '--away-after'));
  if (Number.isFinite(away) && away > 0) cfg.awayAfterSec = Math.max(15, Math.round(away * 60));
  const relay = option(args, '--relay');
  if (relay === 'off') cfg.control = null;
  else if (relay && /^https:\/\//.test(relay)) cfg.control = newControlInfo(relay);
  else if (!cfg.control) cfg.control = newControlInfo(DEFAULT_RELAY);
  saveConfig(cfg);

  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(PLIST, plist());
  await reloadAgent(LABEL, PLIST);

  // Send the phone its Work mode switch with a fresh usage update, if updates are set up here.
  let phone = '';
  if (cfg.control && fs.existsSync(path.join(CONFIG_DIR, 'sync.json'))) {
    // The usage sync may still be running older code that doesn't send the switch: restart it.
    await launchctl('kickstart', '-k', `${domain()}/io.github.agent-visualiser.sync`).catch(() => undefined);
    try {
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
      await pexec(process.execPath, [tsxCli, path.join(ROOT, 'scripts', 'sync.ts'), 'once'], { cwd: ROOT, timeout: 180_000 });
      phone = '\nYour phone gets the Work mode switch now (pull down or reopen the app).';
    } catch {
      phone = '\nYour phone gets the Work mode switch with the next usage update (within about 10 minutes).';
    }
  }

  const whileHere =
    cfg.how === 'share'
      ? `share the Mac so ${cfg.freeCores} of its ${CORES} cores stay free for you (they keep going nearly flat out)`
      : cfg.how === 'pause'
        ? 'are paused'
        : 'move to background priority (the efficiency cores on Apple silicon)';
  console.log(`
Gentle mode is on. While you're using this Mac, busy jobs started by Claude Code
or Codex ${whileHere}; after ${Math.round(cfg.awayAfterSec / 6) / 10} minutes without keyboard or mouse (and no
video or call on screen) they get the whole Mac back. It starts again after a restart.${phone}

  Switch:     npm run gentle -- work | auto | full
  Status:     npm run gentle -- status
  Log:        ${LOG}
  Stop it:    npm run gentle -- uninstall`);
}

async function uninstall() {
  const cfg = loadConfig();
  cfg.enabled = false;
  saveConfig(cfg);
  if (process.platform === 'darwin') {
    await launchctl('bootout', `${domain()}/${LABEL}`).catch(() => launchctl('unload', '-w', PLIST).catch(() => undefined));
    fs.rmSync(PLIST, { force: true });
  }
  await release(true);
  console.log('Gentle mode is off. Agent jobs run at full speed again.');
}

/** Let go of everything the helper is holding (for when it isn't running to do it). */
async function release(quiet = false) {
  const state = loadRuntime();
  if (!state?.held?.length) {
    if (!quiet) console.log('Nothing is being held.');
    return;
  }
  const r = await exec.run('ps', ['-axww', '-o', 'pid=,ppid=,uid=,pcpu=,command=']);
  const cmd = new Map(parsePs(r.out).map((p) => [p.pid, p.command]));
  const n = await recover(state.held, exec, (pid) => cmd.get(pid));
  saveRuntime({ ...state, held: [], updatedAt: Date.now() });
  if (!quiet) console.log(n ? `Let go of ${n} job(s).` : 'Those jobs have already finished.');
}

async function setMode(mode: GentleMode) {
  const cfg = loadConfig();
  cfg.mode = mode;
  saveConfig(cfg);
  console.log(
    mode === 'work'
      ? 'Work mode: agent jobs stay gentle until you switch back to auto.'
      : mode === 'full'
        ? 'Full speed: agent jobs have the whole Mac until you switch back to auto.'
        : 'Auto: agent jobs are gentle while you use the Mac, and get it back when you step away.',
  );
}

async function status() {
  const cfg = loadConfig();
  const state = loadRuntime();
  let running = false;
  if (process.platform === 'darwin') running = await launchctl('print', `${domain()}/${LABEL}`).then(() => true, () => false);
  const fresh = state && Date.now() - state.updatedAt < 120_000 && exec.alive(state.pid);
  console.log(`Gentle mode: ${running ? 'running' : cfg.enabled ? 'installed, not running' : 'not installed'}`);
  console.log(`Mode:        ${cfg.mode}${cfg.mode === 'auto' ? ` (away after ${Math.round(cfg.awayAfterSec / 6) / 10} min)` : ''}`);
  console.log(
    `While here:  ${cfg.how === 'share' ? `keep ${cfg.freeCores} of ${CORES} cores free (agent jobs share the rest)` : cfg.how === 'pause' ? 'pause busy agent jobs' : 'background priority for busy agent jobs'}`,
  );
  console.log(`Phone link:  ${cfg.control ? `on, via ${cfg.control.relay}` : 'off'}`);
  if (fresh && state) {
    console.log(`Now:         ${describe({ here: state.here, reason: state.reason }, new Map(state.held.map((h) => [h.pid, h])), state.how, cfg.freeCores)}`);
    if (state.cpu) {
      console.log(
        `CPU:         ${state.cpu.busy !== undefined ? `${state.cpu.busy} of ${state.cpu.cores} cores busy, ` : ''}agents ${state.cpu.agents}${state.cpu.free ? `, ${state.cpu.free} kept free for you` : ''}`,
      );
    }
    if (state.gpu !== undefined) console.log(`GPU:         ${state.gpu}%`);
    if (state.mem) {
      const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
      console.log(`Memory:      ${gb(state.mem.used)} of ${gb(state.mem.total)}${state.mem.pressure ? `, pressure ${state.mem.pressure}` : ''}${state.mem.swap ? `, ${gb(state.mem.swap)} swapped` : ''}`);
    }
    for (const h of state.held) console.log(`  ${String(h.pid).padStart(6)}  ${h.how.padEnd(5)}  ${h.name}  since ${new Date(h.since).toLocaleTimeString()}`);
  }
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'run':
      return run();
    case 'install':
      return install(rest);
    case 'uninstall':
      return uninstall();
    case 'status':
      return status();
    case 'release':
      return release();
    case 'work':
    case 'auto':
    case 'full':
      return setMode(cmd);
    case 'plist':
      return void process.stdout.write(plist());
    default:
      console.log(`Gentle mode: agent jobs leave you room while you use this Mac.

  npm run gentle -- install [--free-cores N] [--slow | --pause] [--away-after MIN] [--relay URL|off]
  npm run gentle -- status
  npm run gentle -- work | auto | full
  npm run gentle -- release
  npm run gentle -- uninstall`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
