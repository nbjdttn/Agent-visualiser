import { describe, expect, it } from 'vitest';
import { buildDataset } from '../core/aggregate';
import { newSessionMeta, type RawEvent, type SourceSnapshot } from '../core/model';
import { Pricing } from '../core/pricing';
import {
  deviceCode,
  fromB64u,
  generateDeviceKey,
  kidOf,
  NotForThisDevice,
  openJson,
  parseDeviceCode,
  sealJson,
  toB64u,
} from '../core/sync/envelope';
import { cloudPayloadFrom, cloudSnapshot, expandRollup, mergeCloudPayload, repoName, rollupSnapshots } from '../core/sync/payload';
import { HOUR_MS } from '../core/util';

const ev = (over: Partial<RawEvent>): RawEvent => ({
  key: '',
  ts: Date.parse('2026-10-30T10:15:00Z'),
  source: 'claude-code',
  model: 'claude-opus-5-5',
  projectKey: 'dir:/work/a',
  sessionKey: 'claude-code:s1',
  input: 10,
  output: 100,
  cacheRead: 1000,
  cacheWrite: 50,
  cacheWrite1h: 0,
  reasoning: 20,
  requests: 1,
  ...over,
});

describe('envelope', () => {
  it('round-trips base64url', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(60_003));
    expect(fromB64u(toB64u(bytes))).toEqual(bytes);
    expect(toB64u(new Uint8Array([251, 255]))).toBe('-_8');
  });

  it('encrypts for each registered device and nobody else', async () => {
    const phone = await generateDeviceKey();
    const tablet = await generateDeviceKey();
    const stranger = await generateDeviceKey();
    const value = { hello: 'world', n: [1, 2, 3] };
    const env = await sealJson(value, [phone, tablet, phone]);
    expect(env.recipients).toHaveLength(2);
    expect(await openJson(env, phone)).toEqual(value);
    expect(await openJson(env, tablet)).toEqual(value);
    await expect(openJson(env, stranger)).rejects.toBeInstanceOf(NotForThisDevice);
    // A device that claims another's id still can't read it.
    await expect(openJson(env, { kid: phone.kid, privateKey: stranger.privateKey })).rejects.toThrow();
    // Tampering is detected.
    const bad = { ...env, ct: env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(openJson(bad, phone)).rejects.toThrow();
  });

  it('reads device codes pasted with extra text and line breaks', async () => {
    const phone = await generateDeviceKey();
    const code = deviceCode(phone.publicKey);
    const pasted = `Add this phone: ${code.slice(0, 30)}\n${code.slice(30)} thanks`;
    const parsed = await parseDeviceCode(pasted, 'iPhone');
    expect(parsed.publicKey).toBe(phone.publicKey);
    expect(parsed.kid).toBe(phone.kid);
    expect(parsed.kid).toBe(await kidOf(phone.publicKey));
    expect(parsed.name).toBe('iPhone');
    await expect(parseDeviceCode('avsync1.AAAA')).rejects.toThrow();
    await expect(parseDeviceCode('hello')).rejects.toThrow();
  });
});

describe('computer roll-ups', () => {
  const sessions = new Map([
    ['claude-code:s1', { ...newSessionMeta('claude-code:s1', 's1', 'claude-code', 'dir:/work/a', 0), title: 'Fix the tests', titleRank: 3 }],
  ]);
  const t = Date.parse('2026-10-30T10:15:00Z');
  const snapshot = (): SourceSnapshot => ({
    events: [
      ev({ key: 'a', ts: t, tools: ['Bash', 'Read'] }),
      ev({ key: 'a', ts: t }), // duplicate, counted once
      ev({ key: 'b', ts: t + 10 * 60_000, tools: ['Bash'] }),
      ev({ key: 'c', ts: t + 60 * 60_000, sidechain: true }),
      // A long prompt: priced at the higher tier per response, which must survive the roll-up.
      ev({ key: 'd', ts: t + 61 * 60_000, model: 'claude-sonnet-4-5', input: 250_000, cacheRead: 0, cacheWrite: 0 }),
      ev({ key: 'e', ts: t + 2 * 60 * 60_000, source: 'codex', model: 'gpt-5.5', projectKey: 'dir:/work/b', sessionKey: 'codex:x' }),
    ],
    sessions,
    projects: new Map([['dir:/work/a', { key: 'dir:/work/a', kind: 'folder', name: 'a', path: '/work/a', branches: new Set(['main']) }]]),
  });

  it('keeps every total, cost and tool count while shrinking the events', () => {
    const pricing = new Pricing();
    const direct = buildDataset({ snapshots: [snapshot()], pricing, statuses: [], demo: false, version: 1 }).dataset;
    const rollup = rollupSnapshots([snapshot()], pricing);
    expect(rollup.rows.length).toBeLessThan(5);
    const viaSync = buildDataset({ snapshots: [expandRollup(JSON.parse(JSON.stringify(rollup)))], pricing, statuses: [], demo: false, version: 1 }).dataset;

    const sum = (facts: number[][], i: number) => facts.reduce((a, f) => a + f[i], 0);
    for (const i of [5, 6, 7, 8, 9, 10]) expect(sum(viaSync.facts, i)).toBe(sum(direct.facts, i));
    expect(sum(viaSync.facts, 11)).toBeCloseTo(sum(direct.facts, 11), 5);

    const s1 = viaSync.sessions.find((s) => s.id === 's1')!;
    const d1 = direct.sessions.find((s) => s.id === 's1')!;
    expect(s1.title).toBe('Fix the tests');
    expect(s1.requests).toBe(d1.requests);
    expect(s1.tools).toEqual(d1.tools);
    expect(s1.subagentTokens).toBe(d1.subagentTokens);
    expect(s1.cost).toBeCloseTo(d1.cost, 5);
    expect(viaSync.projects.find((p) => p.key === 'dir:/work/a')?.branches).toEqual(['main']);
  });
});

describe('cloud sessions', () => {
  const created = Date.parse('2026-10-30T07:42:56Z');

  it('accepts what the collector writes, in either naming style', () => {
    const p = cloudPayloadFrom(
      {
        collectedAt: '2026-10-31T13:00:00Z',
        sessions: [
          {
            id: 'session_1',
            title: 'Banking dashboard',
            created_at: '2026-10-30T07:42:56.569910Z',
            updated_at: '2026-10-31T11:49:09Z',
            origin: 'ios',
            configured_model: 'claude-opus-5-5',
            repo: 'https://github.com/SymbolicModel/GettingStarted',
            usage: { input_tokens: 182587, output_tokens: 1627376, cache_read_tokens: 276148975, cache_write_tokens: 3967279, cost_usd: 119.37 },
          },
          { id: 'session_2', created: created, updated: created + 1000, input: '1,000', output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
          { id: 'empty', created, updated: created, input: 0, output: 0 },
        ],
        limits: [{ type: 'seven_day', status: 'allowed', resetsAt: 1793840400, isUsingOverage: false }],
      },
      0,
    );
    expect(p.generatedAt).toBe(Date.parse('2026-10-31T13:00:00Z'));
    expect(p.sessions.map((s) => s.id)).toEqual(['session_1', 'session_2']);
    expect(p.sessions[0]).toMatchObject({ repo: 'SymbolicModel/GettingStarted', model: 'claude-opus-5-5', cacheRead: 276148975, cost: 119.37 });
    expect(p.sessions[1].input).toBe(1000);
    expect(p.limits[0]).toMatchObject({ type: 'seven_day', status: 'allowed', resetsAt: 1793840400 * 1000 });
    expect(() => cloudPayloadFrom({ nope: true })).toThrow();
    expect(repoName('git@github.com:nbjdttn/Agent-visualiser.git')).toBe('nbjdttn/Agent-visualiser');
  });

  it('splits a session across the hours it ran, keeping totals exact', () => {
    const created = Date.parse('2026-10-30T08:00:00Z');
    const day1 = cloudPayloadFrom({
      collectedAt: created + 30 * HOUR_MS,
      sessions: [{ id: 's', title: 'T', created, updated: created + 3 * HOUR_MS, model: 'claude-opus-5-5', repo: 'a/b', input: 1001, output: 999, cacheRead: 10_000_001, cacheWrite: 7, cost: 12.5 }],
    });
    // The next day the same session carried on for an hour.
    const day2 = cloudPayloadFrom({
      sessions: [{ id: 's', title: 'T', created, updated: created + 26 * HOUR_MS, model: 'claude-opus-5-5', repo: 'a/b', input: 2001, output: 1999, cacheRead: 20_000_001, cacheWrite: 7, cost: 25 }],
    });
    let history = mergeCloudPayload({}, day1);
    history = mergeCloudPayload(history, day1); // the same reading twice changes nothing
    expect(history.s.readings).toHaveLength(1);
    history = mergeCloudPayload(history, day2);
    expect(history.s.readings).toHaveLength(2);

    const snap = cloudSnapshot(history);
    const total = (k: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost') => snap.events.reduce((a, e) => a + (e[k] ?? 0), 0);
    expect(total('input')).toBe(2001);
    expect(total('output')).toBe(1999);
    expect(total('cacheRead')).toBe(20_000_001);
    expect(total('cacheWrite')).toBe(7);
    expect(total('cost')).toBeCloseTo(25, 9);
    expect(snap.events.every((e) => Number.isInteger(e.input) && e.rollup && e.sessionKey === 'claude-code:s')).toBe(true);
    // The first reading covers the first 3 hours; the second the 23 hours after it.
    const early = snap.events.filter((e) => e.ts < created + 3 * HOUR_MS);
    expect(early.map((e) => e.ts)).toEqual([0, 1, 2].map((h) => created + h * HOUR_MS));
    expect(early.reduce((a, e) => a + e.input, 0)).toBe(1001);
    expect(snap.events.at(-1)!.ts).toBe(created + 25 * HOUR_MS);
    expect(snap.projects.get('repo:a/b')).toMatchObject({ kind: 'repo', name: 'b', path: 'a/b' });

    const ds = buildDataset({ snapshots: [snap], pricing: new Pricing(), statuses: [], demo: false, version: 1 }).dataset;
    expect(ds.sessions[0]).toMatchObject({ title: 'T', input: 2001 });
    expect(ds.sessions[0].cost).toBeCloseTo(25, 6);
  });

  it('starts over if a session reports smaller totals', () => {
    const a = cloudPayloadFrom({ sessions: [{ id: 's', created, updated: created + HOUR_MS, input: 100, output: 1 }] });
    const b = cloudPayloadFrom({ sessions: [{ id: 's', created, updated: created + 2 * HOUR_MS, input: 50, output: 1 }] });
    const h = mergeCloudPayload(mergeCloudPayload({}, a), b);
    expect(h.s.readings).toEqual([[created + 2 * HOUR_MS, 50, 1, 0, 0, 0]]);
  });
});

describe('computer archive', () => {
  it('keeps sessions whose logs were deleted, and the larger version of each hour', async () => {
    const { emptyArchive, mergeIntoArchive, rollupFromArchive } = await import('../core/sync/payload');
    const pricing = new Pricing();
    const t = Date.parse('2026-07-10T10:15:00Z');
    const snap = (events: RawEvent[]): SourceSnapshot => ({
      events,
      sessions: new Map(
        [...new Set(events.map((e) => e.sessionKey!))].map((k) => [k, { ...newSessionMeta(k, k.split(':')[1], 'claude-code', 'dir:/w', t), title: k, titleRank: 3 }]),
      ),
      projects: new Map(),
    });
    // July: two sessions in the logs.
    let archive = mergeIntoArchive(emptyArchive(), rollupSnapshots([snap([ev({ key: 'a', ts: t, sessionKey: 'claude-code:old' }), ev({ key: 'b', ts: t, sessionKey: 'claude-code:new' })])], pricing));
    // Later: Claude Code deleted the old session's log; the new one grew within the same hour.
    archive = mergeIntoArchive(
      JSON.parse(JSON.stringify(archive)),
      rollupSnapshots([snap([ev({ key: 'b', ts: t, sessionKey: 'claude-code:new' }), ev({ key: 'c', ts: t + 60_000, sessionKey: 'claude-code:new' })])], pricing),
    );
    const out = expandRollup(rollupFromArchive(archive));
    const by = (k: string) => out.events.filter((e) => e.sessionKey === k).reduce((a, e) => a + e.output, 0);
    expect(by('claude-code:old')).toBe(100);
    expect(by('claude-code:new')).toBe(200);
    expect([...out.sessions.keys()].sort()).toEqual(['claude-code:new', 'claude-code:old']);
  });
});
