import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeSource, readClaudeUsage } from '../server/sources/claudeCode';
import { jsonl, tempTree } from './helpers';

const CWD = '/Users/demo/code/atlas-api';
const SESSION = '11111111-2222-3333-4444-555555555555';

function assistant(opts: {
  id: string;
  requestId: string;
  ts: string;
  content: unknown[];
  usage?: Record<string, unknown>;
  model?: string;
  sidechain?: boolean;
  session?: string;
}) {
  return {
    type: 'assistant',
    uuid: `${opts.id}-${Math.random()}`,
    sessionId: opts.session ?? SESSION,
    timestamp: opts.ts,
    cwd: CWD,
    gitBranch: 'feat/rate-limits',
    version: '2.1.316',
    entrypoint: 'cli',
    isSidechain: opts.sidechain ?? false,
    requestId: opts.requestId,
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-5-5',
      role: 'assistant',
      content: opts.content,
      usage: opts.usage ?? {
        input_tokens: 2,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 50_000,
        output_tokens: 300,
        output_tokens_details: { thinking_tokens: 120 },
        cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 },
        server_tool_use: { web_search_requests: 0 },
        speed: 'standard',
      },
    },
  };
}

const sessionFile = jsonl(
  {
    type: 'user',
    uuid: 'u1',
    sessionId: SESSION,
    timestamp: '2026-10-30T09:00:00.000Z',
    cwd: CWD,
    message: { role: 'user', content: 'Add rate limiting to the public endpoints' },
  },
  // One response written as two lines (thinking, then a tool call) with identical usage.
  assistant({ id: 'msg_A', requestId: 'req_A', ts: '2026-10-30T09:00:05.000Z', content: [{ type: 'thinking', thinking: '' }] }),
  assistant({
    id: 'msg_A',
    requestId: 'req_A',
    ts: '2026-10-30T09:00:06.000Z',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
  }),
  {
    type: 'user',
    uuid: 'u2',
    sessionId: SESSION,
    timestamp: '2026-10-30T09:00:07.000Z',
    cwd: CWD,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }] },
  },
  assistant({
    id: 'msg_B',
    requestId: 'req_B',
    ts: '2026-10-30T09:01:00.000Z',
    content: [
      { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: {} },
      { type: 'tool_use', id: 'toolu_3', name: 'Read', input: {} },
    ],
  }),
  // Synthetic messages (e.g. API errors) carry no real usage.
  assistant({ id: 'msg_S', requestId: 'req_S', ts: '2026-10-30T09:01:30.000Z', content: [], model: '<synthetic>' }),
  // A request with a server-side compaction step itemised in `iterations`.
  assistant({
    id: 'msg_C',
    requestId: 'req_C',
    ts: '2026-10-30T09:02:00.000Z',
    content: [{ type: 'text', text: 'done' }],
    usage: {
      input_tokens: 10,
      output_tokens: 50,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
      iterations: [
        { input_tokens: 5000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, type: 'compaction' },
        { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, type: 'message' },
      ],
    },
  }),
  { type: 'ai-title', aiTitle: 'Rate limiting for public API', sessionId: SESSION },
);

// A sub-agent transcript in the same project.
const subagentFile = jsonl(
  assistant({
    id: 'msg_SUB',
    requestId: 'req_SUB',
    ts: '2026-10-30T09:01:10.000Z',
    content: [{ type: 'tool_use', id: 'toolu_9', name: 'Grep', input: {} }],
    model: 'claude-haiku-5-5',
    sidechain: true,
  }),
);

// A resumed conversation copies earlier lines into a new file; they must not count twice.
const resumedFile = jsonl(
  assistant({
    id: 'msg_B',
    requestId: 'req_B',
    ts: '2026-10-30T09:01:00.000Z',
    content: [
      { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: {} },
      { type: 'tool_use', id: 'toolu_3', name: 'Read', input: {} },
    ],
  }),
);

describe('readClaudeUsage', () => {
  it('reads cache tiers, thinking tokens and fast mode', () => {
    const u = readClaudeUsage({
      input_tokens: 4,
      output_tokens: 1151,
      cache_read_input_tokens: 71548,
      cache_creation_input_tokens: 25399,
      cache_creation: { ephemeral_1h_input_tokens: 25399, ephemeral_5m_input_tokens: 0 },
      output_tokens_details: { thinking_tokens: 725 },
      speed: 'fast',
      inference_geo: 'us',
    });
    expect(u).toMatchObject({
      input: 4,
      output: 1151,
      cacheRead: 71548,
      cacheWrite: 25399,
      cacheWrite1h: 25399,
      reasoning: 725,
      speed: 'fast',
      geo: 'us',
    });
  });

  it('sums iterations when a request ran server-side steps', () => {
    const u = readClaudeUsage({
      input_tokens: 10,
      output_tokens: 50,
      iterations: [
        { input_tokens: 5000, output_tokens: 800 },
        { input_tokens: 10, output_tokens: 50 },
      ],
    });
    expect(u.input).toBe(5010);
    expect(u.output).toBe(850);
  });
});

describe('ClaudeCodeSource', () => {
  const root = tempTree({
    [`projects/-Users-demo-code-atlas-api/${SESSION}.jsonl`]: sessionFile,
    [`projects/-Users-demo-code-atlas-api/${SESSION}/subagents/agent-abc.jsonl`]: subagentFile,
    [`projects/-Users-demo-code-atlas-api/99999999-0000-0000-0000-000000000000.jsonl`]: resumedFile,
  });
  const source = new ClaudeCodeSource([path.join(root, 'projects')]);

  it('parses responses once, merges split lines and skips synthetic ones', async () => {
    expect(await source.scan()).toBe(true);
    const snap = source.snapshot();
    const keys = snap.events.map((e) => e.key).sort();
    expect(keys).toEqual(['msg_A:req_A', 'msg_B:req_B', 'msg_C:req_C', 'msg_SUB:req_SUB']);
    const a = snap.events.find((e) => e.key === 'msg_A:req_A')!;
    expect(a.output).toBe(300);
    expect(a.cacheRead).toBe(50_000);
    expect(a.tools).toEqual(['Bash']);
    expect(a.projectKey).toBe(`dir:${CWD}`);
    const b = snap.events.find((e) => e.key === 'msg_B:req_B')!;
    expect(b.tools).toEqual(['Edit', 'Read']);
    const c = snap.events.find((e) => e.key === 'msg_C:req_C')!;
    expect(c.input).toBe(5010);
    expect(c.output).toBe(850);
  });

  it('marks sub-agent work and builds the session', () => {
    const snap = source.snapshot();
    const sub = snap.events.find((e) => e.key === 'msg_SUB:req_SUB')!;
    expect(sub.sidechain).toBe(true);
    expect(sub.model).toBe('claude-haiku-5-5');
    const s = snap.sessions.get(`claude-code:${SESSION}`)!;
    expect(s.title).toBe('Rate limiting for public API');
    expect(s.branch).toBe('feat/rate-limits');
    expect(s.entrypoint).toBe('cli');
    expect(s.promptIds.size).toBe(1);
    expect(s.firstTs).toBe(Date.parse('2026-10-30T09:00:00.000Z'));
  });

  it('names the project after its folder', () => {
    const p = source.snapshot().projects.get(`dir:${CWD}`)!;
    expect(p.name).toBe('atlas-api');
    expect(p.branches?.has('feat/rate-limits')).toBe(true);
  });

  it('reports nothing changed on an unchanged rescan', async () => {
    expect(await source.scan()).toBe(false);
    expect(source.status().connected).toBe(true);
  });
});
