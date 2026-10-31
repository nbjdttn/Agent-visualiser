/**
 * Automatic updates for the Agent Visualiser phone app.
 *
 * On a computer, this reads the Claude Code and Codex logs (the same way the
 * desktop server does), sums them per hour, encrypts the result for the
 * registered phones and publishes it to the `usage-data` branch of this
 * repository. The phone downloads and decrypts it; nobody else can read it.
 *
 *   npm run sync -- install              keep this computer's usage flowing to your phone (macOS background job)
 *   npm run sync -- once                 scan and publish once
 *   npm run sync -- watch                keep running and publish changes (what the background job runs)
 *   npm run sync -- status               what has been sent, and to which devices
 *   npm run sync -- report               tokens and cost per month, source and model, and the busiest days
 *   npm run sync -- uninstall            stop the background job
 *   npm run sync -- init                 create the usage-data branch (done automatically by the other commands)
 *   npm run sync -- add-device CODE [NAME]   register a phone (the code from Data -> Automatic updates)
 *   npm run sync -- remove-device ID
 *   npm run sync -- cloud FILE           publish Claude Code cloud-session totals gathered by the scheduled collector
 *
 * Options: --dry-run (build and encrypt, but don't push).
 * Environment: SYNC_REMOTE (default origin), SYNC_BRANCH (default usage-data),
 * SYNC_INTERVAL_MINUTES (default 10), CLAUDE_CONFIG_DIR, CODEX_HOME, SYNC_REPO_DIR.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tokensOf } from '../core/aggregate.js';
import { Pricing } from '../core/pricing.js';
import { kidOf, parseDeviceCode, publicKeyBytes, sealJson, type DevicePublic } from '../core/sync/envelope.js';
import {
  ARCHIVE_VERSION,
  CLOUD_FILE,
  DEVICES_DIR,
  INDEX_FILE,
  SYNC_BRANCH,
  cloudPayloadFrom,
  computerFile,
  emptyArchive,
  mergeIntoArchive,
  rollupFromArchive,
  rollupSnapshots,
  type ComputerPayload,
  type Rollup,
  type RollupArchive,
  type SyncIndex,
  type SyncKind,
  type SyncPayload,
} from '../core/sync/payload.js';
import { refreshPricing } from '../server/pricing.js';
import { ClaudeCodeSource, claudeProjectRoots } from '../server/sources/claudeCode.js';
import { CodexSource, codexRoots } from '../server/sources/codex.js';

const pexec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The git repository to publish from (tests point this at a scratch clone). */
const REPO = process.env.SYNC_REPO_DIR ? path.resolve(process.env.SYNC_REPO_DIR) : ROOT;
const REMOTE = process.env.SYNC_REMOTE || 'origin';
const BRANCH = process.env.SYNC_BRANCH || SYNC_BRANCH;
const LOCAL_REF = `refs/agent-visualiser/${BRANCH}`;
const INTERVAL_MS = Math.max(2, Number(process.env.SYNC_INTERVAL_MINUTES) || 10) * 60_000;
const SCAN_MS = 2 * 60_000;
const DEVICE_CHECK_MS = 15 * 60_000;
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agent-visualiser');
const STATE_FILE = path.join(CONFIG_DIR, 'sync.json');
/** Everything this computer has sent, kept after Claude Code or Codex delete their old logs. */
const ARCHIVE_FILE = path.join(CONFIG_DIR, 'archive.json');
const CACHE_DIR = process.env.AGENT_VISUALISER_CACHE || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'agent-visualiser');
const LABEL = 'io.github.agent-visualiser.sync';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'agent-visualiser-sync.log');
const dryRun = process.argv.includes('--dry-run');

const BRANCH_README = `# Agent Visualiser usage data

This branch holds **encrypted** usage updates for the Agent Visualiser phone app.
Each file is sealed for the devices listed in \`devices/\`: only those phones can read it.
\`index.json\` only says which files changed and when.

It is rewritten automatically (each update replaces the branch's single commit).
To add a phone, open the app's Data tab -> Automatic updates.
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
const usd = (n: number) => `$${n.toFixed(2)}`;

class GitError extends Error {}

async function git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await pexec('git', ['-C', REPO, ...args], { env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args[0]}: ${(e.stderr || e.message).trim()}`);
  }
}

interface State {
  computerId: string;
  lastHash?: string;
  lastPublishAt?: number;
  lastRecipients?: string[];
}

function loadState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
    if (s.computerId) return s;
  } catch {
    // first run
  }
  return { computerId: crypto.randomBytes(5).toString('hex') };
}

function saveState(s: State) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
}

function loadArchive(): RollupArchive {
  try {
    const a = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')) as RollupArchive;
    if (a.v === ARCHIVE_VERSION && a.rows) return a;
  } catch {
    // none yet
  }
  return emptyArchive();
}

function saveArchive(a: RollupArchive) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${ARCHIVE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(a));
  fs.renameSync(tmp, ARCHIVE_FILE);
}

async function computerName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await pexec('scutil', ['--get', 'ComputerName']);
      if (stdout.trim()) return stdout.trim();
    } catch {
      // fall back to the host name
    }
  }
  return os.hostname().replace(/\.local$/, '');
}

// ---------------------------------------------------------------------------
// The usage-data branch
// ---------------------------------------------------------------------------

async function fetchBranch(): Promise<string> {
  await git(['update-ref', '-d', LOCAL_REF]).catch(() => undefined);
  try {
    await git(['fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/${BRANCH}:${LOCAL_REF}`]);
  } catch (err) {
    if (/couldn't find remote ref|no such ref|not found/i.test(String(err))) return '';
    throw err;
  }
  return git(['rev-parse', '--verify', LOCAL_REF]);
}

async function readDevices(sha: string): Promise<DevicePublic[]> {
  if (!sha) return [];
  const names = (await git(['ls-tree', '--name-only', sha, `${DEVICES_DIR}/`])).split('\n').filter((n) => n.endsWith('.json'));
  const out = new Map<string, DevicePublic>();
  for (const name of names) {
    try {
      const d = JSON.parse(await git(['show', `${sha}:${name}`])) as Partial<DevicePublic>;
      if (!d.publicKey) continue;
      publicKeyBytes(d.publicKey);
      const kid = await kidOf(d.publicKey);
      out.set(kid, { kid, publicKey: d.publicKey, name: d.name, added: d.added });
    } catch {
      log(`Skipping ${name}: it doesn't contain a device key`);
    }
  }
  return [...out.values()];
}

async function readIndex(sha: string): Promise<SyncIndex> {
  if (sha) {
    try {
      const idx = JSON.parse(await git(['show', `${sha}:${INDEX_FILE}`])) as SyncIndex;
      if (idx && idx.files) return idx;
    } catch {
      // no index yet
    }
  }
  return { v: 1, files: {} };
}

let identityEnv: NodeJS.ProcessEnv | undefined;
async function identity(): Promise<NodeJS.ProcessEnv> {
  if (!identityEnv) {
    const name = (await git(['config', 'user.name']).catch(() => '')) || 'Agent Visualiser';
    const email = (await git(['config', 'user.email']).catch(() => '')) || 'agent-visualiser@users.noreply.github.com';
    identityEnv = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  }
  return identityEnv;
}

/** Build a single parentless commit: the branch's current files plus these changes (null deletes). */
async function writeCommit(old: string, files: Record<string, string | null>, message: string): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sync-'));
  const env = { ...(await identity()), GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    await git(old ? ['read-tree', old] : ['read-tree', '--empty'], env);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        await git(['update-index', '--force-remove', file], env);
        continue;
      }
      const blobFile = path.join(tmp, 'blob');
      fs.writeFileSync(blobFile, content);
      const blob = await git(['hash-object', '-w', blobFile]);
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], env);
    }
    const tree = await git(['write-tree'], env);
    return await git(['commit-tree', tree, '-m', message], env);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface BranchState {
  old: string;
  devices: DevicePublic[];
  index: SyncIndex;
}

type UpdateResult = { pushed: boolean; devices: DevicePublic[]; reason?: string };

/**
 * Read the branch, apply a change and push it, retrying if something else
 * (another computer, the cloud collector, a device added on GitHub) pushed in
 * between: --force-with-lease only replaces the version that was read.
 */
async function updateBranch(
  make: (s: BranchState) => Promise<{ files: Record<string, string | null>; message: string } | { skip: string }>,
): Promise<UpdateResult> {
  for (let attempt = 1; ; attempt++) {
    const old = await fetchBranch();
    const devices = await readDevices(old);
    const index = await readIndex(old);
    const change = await make({ old, devices, index });
    if ('skip' in change) return { pushed: false, devices, reason: change.skip };
    if (dryRun) return { pushed: false, devices, reason: 'dry run' };
    const commit = await writeCommit(old, change.files, change.message);
    try {
      await git(['push', '--quiet', `--force-with-lease=refs/heads/${BRANCH}:${old}`, REMOTE, `${commit}:refs/heads/${BRANCH}`]);
      return { pushed: true, devices };
    } catch (err) {
      if (attempt >= 4 || !/stale info|rejected|fetch first|non-fast-forward|failed to push/i.test(String(err))) throw err;
      await sleep(1500 * attempt);
    }
  }
}

async function publishPayload(file: string, kind: SyncKind, payload: SyncPayload): Promise<UpdateResult> {
  return updateBranch(async ({ devices, index }) => {
    if (!devices.length) return { skip: 'no devices registered yet' };
    const envelope = await sealJson(payload, devices);
    index.files[file] = { kind, updatedAt: payload.generatedAt, recipients: devices.map((d) => d.kid) };
    return {
      files: { [file]: JSON.stringify(envelope), [INDEX_FILE]: JSON.stringify(index, null, 2) + '\n', 'README.md': BRANCH_README },
      message: kind === 'cloud' ? 'Update cloud-session usage' : 'Update computer usage',
    };
  });
}

// ---------------------------------------------------------------------------
// This computer's agent logs
// ---------------------------------------------------------------------------

class ComputerScanner {
  private claude = new ClaudeCodeSource(claudeProjectRoots(process.env.CLAUDE_CONFIG_DIR));
  private codex = new CodexSource(codexRoots(process.env.CODEX_HOME));
  private pricing = new Pricing();
  private pricedAt = 0;

  async build(): Promise<{ payload: ComputerPayload; hash: string }> {
    if (Date.now() - this.pricedAt > 12 * 3600_000) {
      await refreshPricing(this.pricing, CACHE_DIR, ['1', 'true', 'yes'].includes(String(process.env.PRICING_OFFLINE).toLowerCase()));
      this.pricedAt = Date.now();
    }
    await Promise.all([this.claude.scan(), this.codex.scan()]);
    const fresh = rollupSnapshots([this.claude.snapshot(), this.codex.snapshot()], this.pricing);
    const archive = mergeIntoArchive(loadArchive(), fresh);
    saveArchive(archive);
    const rollup = rollupFromArchive(archive, fresh.codexLimits);
    const statuses = [this.claude.status(), this.codex.status()];
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(rollup))
      .update(JSON.stringify(statuses.map((s) => ({ ...s, updatedAt: undefined }))))
      .digest('hex');
    return { payload: { v: 1, kind: 'computer', name: await computerName(), generatedAt: Date.now(), rollup, statuses }, hash };
  }
}

function describeComputer(p: ComputerPayload): string {
  const tokens = p.rollup.rows.reduce((a, r) => a + r[5] + r[6] + r[7] + r[8], 0);
  const cost = p.rollup.rows.reduce((a, r) => a + r[12], 0) / 1e6;
  const sessions = p.rollup.sessions.length;
  return `${sessions} sessions, ${compact(tokens)} tokens, ${usd(cost)} at API prices`;
}

async function publishComputer(scanner: ComputerScanner, state: State, force = false): Promise<UpdateResult | undefined> {
  const { payload, hash } = await scanner.build();
  if (!force && hash === state.lastHash) return undefined;
  const size = JSON.stringify(payload).length;
  const res = await publishPayload(computerFile(state.computerId), 'computer', payload);
  if (res.pushed || res.reason === 'no devices registered yet') {
    state.lastHash = hash;
    state.lastPublishAt = Date.now();
    state.lastRecipients = res.devices.map((d) => d.kid).sort();
    saveState(state);
  }
  const to = res.devices.length === 1 ? '1 device' : `${res.devices.length} devices`;
  log(res.pushed ? `Sent ${describeComputer(payload)} (${compact(size)}B before compression) to ${to}.` : `Not sent (${res.reason}): ${describeComputer(payload)}.`);
  return res;
}

async function once() {
  const state = loadState();
  saveState(state);
  const res = await publishComputer(new ComputerScanner(), state, true);
  if (res?.reason === 'no devices registered yet') {
    console.log('\nNo phone is registered yet. On the phone, open the app -> Data -> Automatic updates -> Set up, then run this again.');
  }
}

async function watch() {
  const state = loadState();
  saveState(state);
  const scanner = new ComputerScanner();
  let lastDeviceCheck = 0;
  log(`Watching Claude Code and Codex logs; publishing at most every ${INTERVAL_MS / 60_000} minutes.`);
  for (;;) {
    try {
      const now = Date.now();
      const due = now - (state.lastPublishAt ?? 0) >= INTERVAL_MS;
      if (due) await publishComputer(scanner, state);
      if (now - lastDeviceCheck >= DEVICE_CHECK_MS) {
        lastDeviceCheck = now;
        const devices = (await readDevices(await fetchBranch())).map((d) => d.kid).sort();
        if (devices.join() !== (state.lastRecipients ?? []).join()) {
          log('The list of devices changed; sending to the new list.');
          await publishComputer(scanner, state, true);
        }
      }
    } catch (err) {
      log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(SCAN_MS);
  }
}

// ---------------------------------------------------------------------------
// Background job (macOS launchd)
// ---------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(): string {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'SYNC_REMOTE', 'SYNC_BRANCH', 'SYNC_INTERVAL_MINUTES']) if (process.env[k]) env[k] = process.env[k]!;
  const args = [process.execPath, tsxCli, path.join(ROOT, 'scripts', 'sync.ts'), 'watch'];
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
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]) {
  return pexec('launchctl', args);
}

async function install() {
  if (process.platform !== 'darwin') {
    console.log(`The background job is set up automatically on macOS. Here, keep this running instead (for example with systemd or tmux):

  cd ${ROOT} && npm run sync -- watch

or publish every 10 minutes from cron:

  */10 * * * * cd ${ROOT} && npm run sync -- once >> ~/.cache/agent-visualiser-sync.log 2>&1
`);
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
  console.log('Checking that this computer can publish to GitHub...');
  try {
    await once();
  } catch (err) {
    console.error(`\nCouldn't publish: ${err instanceof Error ? err.message : String(err)}
Check that \`git push\` works in ${ROOT} (it needs write access to ${await git(['remote', 'get-url', REMOTE]).catch(() => REMOTE)}).`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(PLIST, plist());
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await launchctl('bootout', `${domain}/${LABEL}`).catch(() => undefined);
  try {
    await launchctl('bootstrap', domain, PLIST);
  } catch {
    await launchctl('load', '-w', PLIST);
  }
  console.log(`
Installed. This Mac now sends its Claude Code and Codex usage to your phone in the
background, at most every ${INTERVAL_MS / 60_000} minutes while there's something new. It starts again after a restart.
  Log:        ${LOG}
  Stop it:    npm run sync -- uninstall`);
}

async function uninstall() {
  if (process.platform !== 'darwin') {
    console.log('Nothing to uninstall here: stop the `npm run sync -- watch` process or remove the cron line.');
    return;
  }
  await launchctl('bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`).catch(() => launchctl('unload', '-w', PLIST).catch(() => undefined));
  fs.rmSync(PLIST, { force: true });
  console.log('Stopped. This computer no longer sends updates. (What it sent before stays on the phone.)');
}

async function status() {
  const state = loadState();
  const old = await fetchBranch();
  const [devices, index] = [await readDevices(old), await readIndex(old)];
  console.log(`Repository:  ${await git(['remote', 'get-url', REMOTE]).catch(() => REMOTE)} (branch ${BRANCH})`);
  console.log(`This computer: computer-${state.computerId}`);
  console.log(`Last sent:   ${state.lastPublishAt ? new Date(state.lastPublishAt).toLocaleString() : 'never'}`);
  if (process.platform === 'darwin') {
    const loaded = await launchctl('print', `gui/${process.getuid?.() ?? 501}/${LABEL}`).then(
      () => true,
      () => false,
    );
    console.log(`Background:  ${loaded ? 'running' : 'not installed'}`);
  }
  console.log(`\nDevices (${devices.length}):`);
  for (const d of devices) console.log(`  ${d.kid}  ${d.name ?? ''}${d.added ? `  added ${d.added}` : ''}`);
  console.log(`\nFiles:`);
  for (const [name, f] of Object.entries(index.files)) console.log(`  ${name}  ${f.kind}, ${new Date(f.updatedAt).toLocaleString()}, for ${f.recipients.length} device(s)`);
}

async function report() {
  const { payload } = await new ComputerScanner().build();
  const r: Rollup = payload.rollup;
  const name = (i: number) => r.strings[i] ?? '?';
  const months = new Map<string, Map<string, { tokens: number; cost: number }>>();
  const days = new Map<string, { tokens: number; source: string }>();
  for (const row of r.rows) {
    const d = new Date(row[0] * 3600_000);
    const month = d.toISOString().slice(0, 7);
    const day = d.toISOString().slice(0, 10);
    const key = `${name(row[1])} · ${name(row[2])}`;
    const tokens = row[5] + row[6] + row[7] + row[8];
    let m = months.get(month);
    if (!m) months.set(month, (m = new Map()));
    const t = m.get(key) ?? { tokens: 0, cost: 0 };
    t.tokens += tokens;
    t.cost += row[12] / 1e6;
    m.set(key, t);
    const dk = `${day} ${name(row[1])}`;
    days.set(dk, { tokens: (days.get(dk)?.tokens ?? 0) + tokens, source: name(row[1]) });
  }
  console.log(`${payload.name}: ${r.sessions.length} sessions\n`);
  for (const [month, m] of [...months.entries()].sort()) {
    const total = [...m.values()].reduce((a, t) => a + t.tokens, 0);
    console.log(`${month}  ${compact(total).padStart(7)} tokens`);
    for (const [key, t] of [...m.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 5)) {
      console.log(`           ${compact(t.tokens).padStart(7)}  ${usd(t.cost).padStart(9)}  ${key}`);
    }
  }
  console.log('\nBusiest days:');
  for (const [k, v] of [...days.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 8)) console.log(`  ${k}  ${compact(v.tokens)}`);
}

// ---------------------------------------------------------------------------
// Devices and the cloud collector
// ---------------------------------------------------------------------------

async function addDevice(code: string, name?: string) {
  const device = await parseDeviceCode(code, name);
  const res = await updateBranch(async ({ devices }) =>
    devices.some((d) => d.kid === device.kid)
      ? { skip: 'already registered' }
      : {
          files: { [`${DEVICES_DIR}/${device.kid}.json`]: JSON.stringify(device, null, 2) + '\n', 'README.md': BRANCH_README },
          message: 'Add a device for automatic updates',
        },
  );
  console.log(res.pushed ? `Added device ${device.kid}${device.name ? ` (${device.name})` : ''}. It receives the next update from each source.` : `Device ${device.kid}: ${res.reason}.`);
}

async function init() {
  const res = await updateBranch(async ({ old, index }) =>
    old
      ? { skip: 'the branch already exists' }
      : { files: { 'README.md': BRANCH_README, [INDEX_FILE]: JSON.stringify(index, null, 2) + '\n' }, message: 'Start the usage-data branch' },
  );
  console.log(res.pushed ? `Created the ${BRANCH} branch.` : `Nothing to do: ${res.reason}.`);
}

async function removeDevice(kid: string) {
  const res = await updateBranch(async ({ devices }) =>
    devices.some((d) => d.kid === kid) ? { files: { [`${DEVICES_DIR}/${kid}.json`]: null }, message: 'Remove a device' } : { skip: 'not registered' },
  );
  console.log(res.pushed ? `Removed ${kid}. Updates from now on are not encrypted for it.` : `${kid}: ${res.reason}.`);
}

async function cloud(file: string) {
  const payload = cloudPayloadFrom(JSON.parse(fs.readFileSync(file, 'utf8')));
  const tokens = payload.sessions.reduce((a, s) => a + tokensOf(s), 0);
  const cost = payload.sessions.reduce((a, s) => a + s.cost, 0);
  const res = await publishPayload(CLOUD_FILE, 'cloud', payload);
  const what = `${payload.sessions.length} cloud sessions, ${compact(tokens)} tokens, ${usd(cost)}`;
  console.log(res.pushed ? `Sent ${what} to ${res.devices.length} device(s).` : `Not sent (${res.reason}): ${what}.`);
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2).filter((a) => a !== '--dry-run');
  switch (cmd) {
    case 'once':
      return once();
    case 'watch':
      return watch();
    case 'install':
      return install();
    case 'uninstall':
      return uninstall();
    case 'status':
      return status();
    case 'report':
      return report();
    case 'init':
      return init();
    case 'add-device':
      if (!rest[0]) throw new Error('Usage: npm run sync -- add-device CODE [NAME]');
      return addDevice(rest[0], rest.slice(1).join(' '));
    case 'remove-device':
      if (!rest[0]) throw new Error('Usage: npm run sync -- remove-device ID');
      return removeDevice(rest[0]);
    case 'cloud':
      if (!rest[0]) throw new Error('Usage: npm run sync -- cloud FILE');
      return cloud(rest[0]);
    case 'plist':
      // What `install` writes on macOS, for checking.
      return void process.stdout.write(plist());
    default: {
      const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
      console.log(header.replace(/^\/\*\*?|^ \* ?/gm, '').trim());
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
