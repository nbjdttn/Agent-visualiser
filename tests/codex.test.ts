import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CodexSource, cleanRepoUrl, codexUsage } from '../server/sources/codex';
import { jsonl, tempTree } from './helpers';

const CWD = '/Users/demo/research/thesis-nlp';
const NEW_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const OLD_ID = '0188aaaa-bbbb-7ccc-8ddd-ffffffffffff';

const usage = (input: number, cached: number, output: number, reasoning: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

// Current format: one token_usage_record per model response.
const newRollout = jsonl(
  {
    timestamp: '2026-10-30T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: NEW_ID,
      session_id: NEW_ID,
      timestamp: '2026-10-30T10:00:00.000Z',
      cwd: CWD,
      originator: 'codex_cli_rs',
      cli_version: '0.98.0',
      git: { branch: 'exp/contrastive', repository_url: 'git@github.com:demo-lab/thesis-nlp.git' },
    },
  },
  { timestamp: '2026-10-30T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Speed up the evaluation harness' } },
  { timestamp: '2026-10-30T10:00:02.000Z', type: 'turn_context', payload: { turn_id: 't1', cwd: CWD, model: 'gpt-6.1-sol' } },
  { timestamp: '2026-10-30T10:00:05.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
  {
    timestamp: '2026-10-30T10:00:06.000Z',
    type: 'token_usage_record',
    payload: { thread_id: NEW_ID, turn_id: 't1', session_id: NEW_ID, root_turn_id: 't1', response_id: 'resp_1', usage: usage(20_000, 0, 900, 400) },
  },
  { timestamp: '2026-10-30T10:00:08.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '' } },
  {
    timestamp: '2026-10-30T10:00:09.000Z',
    type: 'token_usage_record',
    payload: { thread_id: NEW_ID, turn_id: 't1', session_id: NEW_ID, root_turn_id: 't1', response_id: 'resp_2', usage: usage(24_000, 19_000, 600, 200) },
  },
  {
    timestamp: '2026-10-30T10:00:10.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: usage(44_000, 19_000, 1500, 600), last_token_usage: usage(24_000, 19_000, 600, 200) },
      rate_limits: {
        primary: { used_percent: 41.5, window_minutes: 300, resets_at: 1793460000 },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1793900000 },
        plan_type: 'pro',
      },
    },
  },
);

// Older format: only cumulative token_count events, including a repeat and a reset.
const oldRollout = jsonl(
  { timestamp: '2026-09-01T08:00:00.000Z', type: 'session_meta', payload: { id: OLD_ID, timestamp: '2026-09-01T08:00:00.000Z', cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.30.0' } },
  { timestamp: '2026-09-01T08:00:01.000Z', type: 'turn_context', payload: { cwd: CWD, model: 'gpt-5-codex' } },
  { timestamp: '2026-09-01T08:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(10_000, 0, 500, 100), last_token_usage: usage(10_000, 0, 500, 100) } } },
  // Same total again (rate-limit refresh): adds nothing.
  { timestamp: '2026-09-01T08:00:06.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(10_000, 0, 500, 100), last_token_usage: usage(10_000, 0, 500, 100) } } },
  { timestamp: '2026-09-01T08:00:09.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(25_000, 8_000, 900, 300), last_token_usage: usage(15_000, 8_000, 400, 200) } } },
  // Process restarted: totals reset, so the last response's usage is used instead.
  { timestamp: '2026-09-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(3_000, 1_000, 100, 0), last_token_usage: usage(3_000, 1_000, 100, 0) } } },
);

describe('codexUsage', () => {
  it('splits cached input out of input and keeps reasoning inside output', () => {
    expect(codexUsage(usage(24_000, 19_000, 600, 200))).toEqual({
      input: 5_000,
      cacheRead: 19_000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 600,
      reasoning: 200,
    });
  });
});

describe('cleanRepoUrl', () => {
  it('normalises ssh and https remotes', () => {
    expect(cleanRepoUrl('git@github.com:demo-lab/thesis-nlp.git')).toBe('github.com/demo-lab/thesis-nlp');
    expect(cleanRepoUrl('https://token@github.com/demo-lab/x.git')).toBe('github.com/demo-lab/x');
  });
});

describe('CodexSource', () => {
  const files: Record<string, string | Buffer> = {
    [`sessions/2026/10/30/rollout-2026-10-30T10-00-00-${NEW_ID}.jsonl`]: newRollout,
    [`sessions/2026/09/01/rollout-2026-09-01T08-00-00-${OLD_ID}.jsonl`]: oldRollout,
  };
  const z = zlib as typeof zlib & { zstdCompressSync?: (b: Buffer) => Buffer };
  const ZST_ID = '0177aaaa-bbbb-7ccc-8ddd-000000000000';
  if (typeof z.zstdCompressSync === 'function') {
    files[`archived_sessions/rollout-2026-08-01T08-00-00-${ZST_ID}.jsonl.zst`] = z.zstdCompressSync(
      Buffer.from(newRollout.replaceAll(NEW_ID, ZST_ID).replaceAll('resp_', 'zresp_')),
    );
  }
  const root = tempTree(files);
  const source = new CodexSource([path.join(root, 'sessions'), path.join(root, 'archived_sessions')]);

  it('reads per-response usage records with the turn model', async () => {
    await source.scan();
    const snap = source.snapshot();
    const recs = snap.events.filter((e) => e.key.startsWith('codex:resp_'));
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ model: 'gpt-6.1-sol', input: 20_000, cacheRead: 0, output: 900, tools: ['shell'] });
    expect(recs[1]).toMatchObject({ input: 5_000, cacheRead: 19_000, output: 600, tools: ['apply_patch'] });
    expect(recs[0].projectKey).toBe(`dir:${CWD}`);
  });

  it('falls back to growth of cumulative totals for older logs', () => {
    const old = source.snapshot().events.filter((e) => e.sessionKey === `codex:${OLD_ID}`);
    expect(old.map((e) => e.input + e.cacheRead)).toEqual([10_000, 15_000, 3_000]);
    expect(old.every((e) => e.model === 'gpt-5-codex')).toBe(true);
  });

  it('keeps the newest rate-limit snapshot and session details', () => {
    const snap = source.snapshot();
    expect(snap.codexLimits?.primary).toMatchObject({ usedPercent: 41.5, windowMinutes: 300, resetsAt: 1793460000_000 });
    expect(snap.codexLimits?.planType).toBe('pro');
    const s = snap.sessions.get(`codex:${NEW_ID}`)!;
    expect(s.title).toBe('Speed up the evaluation harness');
    expect(s.branch).toBe('exp/contrastive');
    expect(snap.projects.get(`dir:${CWD}`)?.repo).toBe('github.com/demo-lab/thesis-nlp');
  });

  it.runIf(typeof z.zstdCompressSync === 'function')('reads zstd-compressed rollouts', () => {
    const zs = source.snapshot().events.filter((e) => e.key.startsWith('codex:zresp_'));
    expect(zs).toHaveLength(2);
  });
});

describe('Codex carried-over totals', () => {
  const PARENT = '0166aaaa-bbbb-7ccc-8ddd-111111111111';
  const FORK = '0166aaaa-bbbb-7ccc-8ddd-222222222222';
  const CHILD = '0166aaaa-bbbb-7ccc-8ddd-333333333333';
  const count = (ts: string, total: ReturnType<typeof usage>, last: ReturnType<typeof usage>) => ({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  });
  const meta = (id: string) => ({ timestamp: '2026-07-10T08:00:00.000Z', type: 'session_meta', payload: { id, cwd: CWD } });
  const parentLines = [
    meta(PARENT),
    count('2026-07-10T08:00:05.000Z', usage(10_000, 0, 500, 0), usage(10_000, 0, 500, 0)),
    count('2026-07-10T08:01:00.000Z', usage(30_000, 9_000, 900, 0), usage(20_000, 9_000, 400, 0)),
  ];
  const root = tempTree({
    [`sessions/2026/07/10/rollout-a-${PARENT}.jsonl`]: jsonl(...parentLines),
    // A fork copies the parent's lines, then carries on.
    [`sessions/2026/07/11/rollout-b-${FORK}.jsonl`]: jsonl(
      meta(FORK),
      ...parentLines.slice(1),
      count('2026-07-11T09:00:00.000Z', usage(45_000, 25_000, 1_200, 0), usage(15_000, 14_000, 300, 0)),
    ),
    // A spawned agent / resumed session whose first total is the parent's huge running total.
    [`sessions/2026/07/12/rollout-c-${CHILD}.jsonl`]: jsonl(
      meta(CHILD),
      count('2026-07-12T10:00:00.000Z', usage(900_000_000, 850_000_000, 4_000_000, 0), usage(5_000, 1_000, 200, 0)),
      count('2026-07-12T10:01:00.000Z', usage(900_007_000, 850_003_000, 4_000_300, 0), usage(7_000, 3_000, 300, 0)),
    ),
  });
  const source = new CodexSource([path.join(root, 'sessions')]);

  it('counts copied lines once and never the carried-over running total', async () => {
    await source.scan();
    const events = source.snapshot().events;
    const tokens = events.reduce((a, e) => a + e.input + e.cacheRead + e.output, 0);
    // Parent 10,500 + 20,400; fork's own step 15,300; child 5,200 + 7,300.
    expect(tokens).toBe(10_500 + 20_400 + 15_300 + 5_200 + 7_300);
    expect(events.filter((e) => e.ts === Date.parse('2026-07-12T10:00:00.000Z'))[0]?.input).toBe(4_000);
  });
});
