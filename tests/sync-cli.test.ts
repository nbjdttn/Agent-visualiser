import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceCode, generateDeviceKey, openJson, type DeviceKey, type Envelope } from '../core/sync/envelope';
import { expandRollup, type CloudPayload, type ComputerPayload, type SyncIndex } from '../core/sync/payload';
import { jsonl } from './helpers';

const ROOT = path.resolve(__dirname, '..');
const TSX = createRequire(import.meta.url).resolve('tsx/cli');

/** Runs scripts/sync.ts against a scratch repository and a local "GitHub" (a bare repo). */
describe('npm run sync', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  let phone: DeviceKey;

  const run = (...args: string[]) =>
    execFileSync(process.execPath, [TSX, path.join(ROOT, 'scripts', 'sync.ts'), ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const remote = (...args: string[]) => execFileSync('git', ['-C', path.join(tmp, 'remote.git'), ...args], { encoding: 'utf8' }).trim();
  const show = (file: string) => remote('show', `usage-data:${file}`);

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sync-cli-'));
    execFileSync('git', ['init', '--quiet', '--bare', path.join(tmp, 'remote.git')]);
    execFileSync('git', ['init', '--quiet', path.join(tmp, 'work')]);
    const claudeDir = path.join(tmp, 'claude', 'projects', '-work-atlas');
    fs.mkdirSync(claudeDir, { recursive: true });
    const line = (id: string, ts: string, output: number) => ({
      type: 'assistant',
      uuid: id,
      sessionId: 'sess-1',
      timestamp: ts,
      cwd: '/work/atlas',
      requestId: `req-${id}`,
      message: {
        id,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
      },
    });
    fs.writeFileSync(
      path.join(claudeDir, 'sess-1.jsonl'),
      jsonl(
        { type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-10-30T09:00:00Z', cwd: '/work/atlas', message: { role: 'user', content: 'Speed up the build' } },
        line('m1', '2026-10-30T09:00:05Z', 200),
        line('m2', '2026-10-30T09:20:00Z', 300),
        line('m3', '2026-10-30T11:05:00Z', 400),
      ),
    );
    env = {
      ...process.env,
      SYNC_REMOTE: path.join(tmp, 'remote.git'),
      SYNC_REPO_DIR: path.join(tmp, 'work'),
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
      XDG_CACHE_HOME: path.join(tmp, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
      CODEX_HOME: path.join(tmp, 'codex'),
      PRICING_OFFLINE: '1',
    };
    phone = await generateDeviceKey();
  });

  it('waits for a device before sending anything', () => {
    expect(run('once')).toMatch(/no devices registered yet/);
    expect(remote('for-each-ref')).toBe('');
  });

  it('registers a phone from its code', () => {
    expect(run('add-device', `Here it is: ${deviceCode(phone.publicKey)}`, 'iPhone')).toMatch(/Added device/);
    expect(JSON.parse(show(`devices/${phone.kid}.json`))).toMatchObject({ kid: phone.kid, publicKey: phone.publicKey, name: 'iPhone' });
    expect(run('add-device', deviceCode(phone.publicKey))).toMatch(/already registered/);
  });

  it("sends this computer's usage, readable only by the phone", async () => {
    // 3 responses x (10 input + 1,000 cache read + 100 cache write) + 900 output
    expect(run('once')).toMatch(/Sent 1 sessions, 4\.2K tokens/);
    const index = JSON.parse(show('index.json')) as SyncIndex;
    const [file] = Object.keys(index.files);
    expect(file).toMatch(/^computer-[0-9a-f]{10}\.json$/);
    expect(index.files[file]).toMatchObject({ kind: 'computer', recipients: [phone.kid] });
    const raw = show(file);
    expect(raw).not.toContain('atlas');
    const payload = await openJson<ComputerPayload>(JSON.parse(raw) as Envelope, phone);
    expect(payload.kind).toBe('computer');
    const snap = expandRollup(payload.rollup);
    expect(snap.events).toHaveLength(2); // 09:00 and 11:00
    expect(snap.events.reduce((a, e) => a + e.output, 0)).toBe(900);
    expect(snap.events[0].tools).toEqual(['Bash', 'Bash']);
    expect([...snap.sessions.values()][0]).toMatchObject({ id: 'sess-1', cwd: '/work/atlas' });
    expect(payload.statuses.map((s) => s.id)).toEqual(['claude-code', 'codex']);
  });

  it('adds cloud sessions without touching the computer file', async () => {
    const before = JSON.parse(show('index.json')) as SyncIndex;
    const input = path.join(tmp, 'cloud.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        sessions: [{ id: 'session_1', title: 'Phone app', created_at: '2026-10-31T10:00:00Z', updated_at: '2026-10-31T12:00:00Z', repo: 'nbjdttn/Agent-visualiser', model: 'claude-opus-5-5', input_tokens: 5655, output_tokens: 601534, cache_read_tokens: 120853516, cache_write_tokens: 937278, cost_usd: 43.72 }],
        limits: [{ type: 'seven_day', status: 'allowed', resetsAt: 1793840400 }],
      }),
    );
    expect(run('cloud', input)).toMatch(/Sent 1 cloud sessions, 122\.4M tokens, \$43\.72 to 1 device/);
    const index = JSON.parse(show('index.json')) as SyncIndex;
    expect(Object.keys(index.files).sort()).toEqual([...Object.keys(before.files), 'cloud.json'].sort());
    const cloud = await openJson<CloudPayload>(JSON.parse(show('cloud.json')) as Envelope, phone);
    expect(cloud.sessions[0]).toMatchObject({ id: 'session_1', repo: 'nbjdttn/Agent-visualiser', cost: 43.72 });
    expect(cloud.limits[0]).toMatchObject({ type: 'seven_day', status: 'allowed' });
    // Each update replaces the branch's single commit.
    expect(remote('rev-list', '--count', 'usage-data')).toBe('1');
  });

  it("doesn't publish again when nothing changed, and removes devices", () => {
    expect(run('status')).toMatch(/Devices \(1\)/);
    expect(run('remove-device', phone.kid)).toMatch(/Removed/);
    expect(remote('ls-tree', '--name-only', 'usage-data', 'devices/')).toBe('');
    expect(run('once')).toMatch(/no devices registered yet/);
  });
});
