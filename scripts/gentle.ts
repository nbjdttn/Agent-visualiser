#!/usr/bin/env tsx
/**
 * Gentle mode for a Mac that runs AI agents.
 *
 * While you're using the Mac (keyboard or mouse in the last couple of
 * minutes, or a video or call keeping the screen awake), the agents' heavy
 * jobs (simulations, builds, anything busy started by Claude Code or Codex)
 * drop to background priority, which on Apple silicon moves them onto the
 * efficiency cores. When you've been away for a while they get the whole
 * Mac back. From the phone app you can force Work mode (always gentle) or
 * Full speed (never gentle); Auto follows you.
 *
 *   npm run gentle -- install [--pause] [--away-after MIN] [--relay URL|off]
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
  type GentleMode,
  type StateMessage,
} from '../core/sync/control.js';
import {
  AGENT_ENV,
  agentJobs,
  decidePresence,
  Holder,
  jobNames,
  parseDisplayAssertions,
  parseIdleSeconds,
  parseNames,
  parsePs,
  recover,
  type Exec,
  type Held,
  type Presence,
  type Proc,
} from './gentle-lib.js';

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
const MEDIA_MS = 10_000;
const HEARTBEAT_MS = 30 * 60_000;
const MIN_CPU = 25;

export interface GentleConfig {
  v: 1;
  /** Installed as a background job (the phone only shows the switch then). */
  enabled: boolean;
  mode: GentleMode;
  /** What happens to agent jobs while you're here. */
  how: 'slow' | 'pause';
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
  how: 'slow' | 'pause';
  here: boolean;
  reason: string;
  idleSec?: number;
  held: Held[];
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
  return {
    v: 1,
    enabled: c.enabled ?? false,
    mode: c.mode === 'work' || c.mode === 'full' ? c.mode : 'auto',
    how: c.how === 'pause' ? 'pause' : 'slow',
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

async function readMedia(): Promise<string[]> {
  const r = await exec.run('pmset', ['-g', 'assertions']);
  return r.ok ? [...new Set(parseDisplayAssertions(r.out).map((a) => a.name))] : [];
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
const envCache = new Map<number, { command: string; marked: boolean }>();

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
    for (const p of unknown) envCache.set(p.pid, { command: p.command, marked: AGENT_ENV.test(envOf.get(p.pid) ?? '') });
  }
  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of envCache.keys()) if (!alive.has(pid)) envCache.delete(pid);
  const marked = new Set([...envCache.entries()].filter(([, v]) => v.marked).map(([pid]) => pid));
  return { procs, names, jobs: agentJobs(procs, names, marked, { uid, self: process.pid, minCpu: MIN_CPU }) };
}

// ---------------------------------------------------------------------------
// The phone link (an encrypted ntfy topic)
// ---------------------------------------------------------------------------

class Relay {
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPublish = 0;
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
    if (msg?.t !== 'set') return;
    const skew = Math.abs(Date.now() - msg.at);
    if (msg.at <= cfg.lastSetAt || skew > 15 * 60_000) return;
    cfg.lastSetAt = msg.at;
    saveConfig(cfg);
    this.onMode(msg.mode, msg.by);
  }

  /** Tell the phone what's happening (soon, and at most every few seconds). */
  publishSoon(delay = 2_000) {
    if (this.publishTimer) return;
    const wait = Math.max(delay, 5_000 - (Date.now() - this.lastPublish));
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

function describe(p: Presence, held: Map<number, Held>, how: 'slow' | 'pause'): string {
  const jobs = held.size ? `${how === 'pause' ? 'pausing' : 'slowing'} ${jobNames(held.values())}` : 'no busy agent jobs';
  switch (p.reason) {
    case 'work':
      return `Work mode: ${jobs}.`;
    case 'full':
      return 'Full speed: agent jobs are not slowed.';
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
    log(`Gentle mode is already running (process ${previous.pid}); this copy is not needed.`);
    return;
  }
  let cfg = loadConfig();
  saveConfig(cfg); // keeps the generated phone link

  if (previous?.held?.length) {
    const { procs } = await scan();
    const cmd = new Map(procs.map((p) => [p.pid, p.command]));
    const n = await recover(previous.held, exec, (pid) => cmd.get(pid));
    if (n) log(`Let go of ${n} job(s) held by the previous run.`);
  }

  const background = await backgroundPriorityWorks();
  if (!background && cfg.how === 'slow') log('Background priority isn’t available here; busy agent jobs will be capped at half speed instead.');
  const holder = new Holder(exec, log, Date.now, background);
  let presence: Presence = { here: false, reason: 'away' };
  let idleSec: number | undefined;
  let media: string[] = [];
  let lastMedia = 0;
  let lastScan = 0;
  let lastSummary = '';
  let lastHeartbeat = 0;
  let lastWrite = 0;

  const writeState = () => {
    lastWrite = Date.now();
    saveRuntime({ pid: process.pid, updatedAt: lastWrite, mode: cfg.mode, how: cfg.how, here: presence.here, reason: presence.reason, idleSec, held: [...holder.held.values()] });
  };

  const relay = new Relay(
    () => cfg,
    (mode, by) => {
      if (mode === cfg.mode) return relay.publishSoon(0);
      cfg.mode = mode;
      saveConfig(cfg);
      log(`From the phone${by ? ` (${by.slice(0, 6)})` : ''}: ${mode === 'work' ? 'Work mode' : mode === 'full' ? 'Full speed' : 'Auto'}.`);
    },
    () => ({ mode: cfg.mode, here: presence.here, reason: presence.reason, held: holder.held.size, how: cfg.how }),
  );
  if (cfg.control) void relay.listen();

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
    `Gentle mode is on: agent jobs are ${cfg.how === 'pause' ? 'paused' : 'slowed'} while you're at the Mac, and get it back after ${Math.round(cfg.awayAfterSec / 6) / 10} min away.` +
      (cfg.control ? ` Phone link: ${cfg.control.relay}.` : ' Phone link: off.'),
  );

  for (;;) {
    try {
      cfg = loadConfig(); // picks up `npm run gentle -- work|auto|full` and phone commands
      const now = Date.now();
      idleSec = await readIdleSeconds();
      if (now - lastMedia >= MEDIA_MS) {
        lastMedia = now;
        media = await readMedia();
      }
      presence = decidePresence({ idleSec, media: media.length > 0, mode: cfg.mode, awayAfterSec: cfg.awayAfterSec });

      if (presence.here) {
        if (now - lastScan >= SCAN_MS) {
          lastScan = now;
          const { procs, names, jobs } = await scan();
          holder.prune(new Set(procs.map((p) => p.pid)));
          for (const j of jobs) {
            const name = names.get(j.pid) ?? path.basename(j.command.split(' ')[0] ?? '?');
            await holder.hold(j, name, cfg.how);
          }
        }
      } else if (holder.held.size) {
        await holder.releaseAll();
      }

      const summary = describe(presence, holder.held, cfg.how) + (presence.reason === 'media' && media.length ? ` (${media.slice(0, 2).join(', ')})` : '');
      if (summary !== lastSummary) {
        lastSummary = summary;
        log(summary);
        writeState();
        relay.publishSoon();
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
  if (args.includes('--pause')) cfg.how = 'pause';
  if (args.includes('--slow')) cfg.how = 'slow';
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
  await launchctl('bootout', `${domain()}/${LABEL}`).catch(() => undefined);
  try {
    await launchctl('bootstrap', domain(), PLIST);
  } catch {
    await launchctl('load', '-w', PLIST);
  }

  // Send the phone its Work mode switch with a fresh usage update, if updates are set up here.
  let phone = '';
  if (cfg.control && fs.existsSync(path.join(CONFIG_DIR, 'sync.json'))) {
    try {
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
      await pexec(process.execPath, [tsxCli, path.join(ROOT, 'scripts', 'sync.ts'), 'once'], { cwd: ROOT, timeout: 180_000 });
      phone = '\nYour phone gets the Work mode switch now (pull down or reopen the app).';
    } catch {
      phone = '\nYour phone gets the Work mode switch with the next usage update (within about 10 minutes).';
    }
  }

  console.log(`
Gentle mode is on. While you're using this Mac, busy jobs started by Claude Code
or Codex are ${cfg.how === 'pause' ? 'paused' : 'moved to background priority (the efficiency cores on Apple silicon)'};
after ${Math.round(cfg.awayAfterSec / 6) / 10} minutes without keyboard or mouse (and no video or call on screen)
they get the whole Mac back. It starts again after a restart.${phone}

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
      ? 'Work mode: agent jobs stay slowed until you switch back to auto.'
      : mode === 'full'
        ? 'Full speed: agent jobs are never slowed until you switch back to auto.'
        : 'Auto: agent jobs are slowed while you use the Mac, and get it back when you step away.',
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
  console.log(`While here:  ${cfg.how === 'pause' ? 'pause' : 'slow (background priority)'} busy agent jobs`);
  console.log(`Phone link:  ${cfg.control ? `on, via ${cfg.control.relay}` : 'off'}`);
  if (fresh && state) {
    console.log(`Now:         ${describe({ here: state.here, reason: state.reason }, new Map(state.held.map((h) => [h.pid, h])), state.how)}`);
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
      console.log(`Gentle mode: agent jobs slow down while you use this Mac.

  npm run gentle -- install [--pause] [--away-after MIN] [--relay URL|off]
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
