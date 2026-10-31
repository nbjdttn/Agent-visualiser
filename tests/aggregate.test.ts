import { describe, expect, it } from 'vitest';
import { buildDataset, prettyModel } from '../core/aggregate';
import { computeBlocks } from '../core/live';
import { newSessionMeta, type RawEvent, type SourceSnapshot } from '../core/model';
import { Pricing } from '../core/pricing';
import { DemoSource } from '../core/demo';
import { localDayIndex, localHour } from '../core/util';

const ev = (over: Partial<RawEvent>): RawEvent => ({
  key: '',
  ts: Date.parse('2026-10-30T10:15:00Z'),
  source: 'claude-code',
  model: 'claude-opus-5-5',
  projectKey: 'dir:/work/a',
  input: 10,
  output: 100,
  cacheRead: 1000,
  cacheWrite: 50,
  cacheWrite1h: 0,
  reasoning: 20,
  requests: 1,
  ...over,
});

describe('prettyModel', () => {
  it('turns ids into readable names', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(prettyModel('claude-opus-4-1')).toBe('Opus 4.1');
    expect(prettyModel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(prettyModel('gpt-5.3-codex')).toBe('GPT-5.3 Codex');
    expect(prettyModel('gpt-5.4-mini')).toBe('GPT-5.4 mini');
    expect(prettyModel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(prettyModel('o4-mini')).toBe('o4-mini');
  });
});

describe('buildDataset', () => {
  const sessions = new Map([['claude-code:s1', { ...newSessionMeta('claude-code:s1', 's1', 'claude-code', 'dir:/work/a', 0), title: 'Fix the tests', titleRank: 3 }]]);
  const local: SourceSnapshot = {
    events: [
      ev({ sessionKey: 'claude-code:s1', tools: ['Bash', 'Edit'] }),
      ev({ sessionKey: 'claude-code:s1', ts: Date.parse('2026-10-30T10:45:00Z'), tools: ['Bash'], sidechain: true, model: 'claude-haiku-5-5' }),
      ev({ source: 'codex', model: 'gpt-5.3-codex', projectKey: 'dir:/work/b', input: 5000, output: 400, cacheRead: 20000, cacheWrite: 0 }),
    ],
    sessions,
    projects: new Map([['dir:/work/a', { key: 'dir:/work/a', kind: 'folder', name: 'a', path: '/work/a' }]]),
  };
  const api: SourceSnapshot = {
    events: [ev({ source: 'openai-api', model: 'gpt-5.4-mini', projectKey: 'openai-proj:p1', ts: Date.parse('2026-10-29T00:00:00Z'), daily: true, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 300 })],
    sessions: new Map(),
    projects: new Map([['openai-proj:p1', { key: 'openai-proj:p1', kind: 'openai-project', name: 'Course bot', provider: 'openai' }]]),
  };
  const built = buildDataset({ snapshots: [local, api], pricing: new Pricing(), statuses: [], demo: false, version: 3 });
  const ds = built.dataset;

  it('ranks models and projects by tokens', () => {
    expect(ds.models[0].id).toBe('gpt-5.4-mini');
    expect(ds.models.map((m) => m.provider)).toContain('anthropic');
    expect(ds.projects[0].name).toBe('Course bot');
    expect(ds.projects.find((p) => p.key === 'dir:/work/b')?.name).toBe('b');
  });

  it('buckets agent usage by local hour and API usage by UTC day', () => {
    const agent = ds.facts.find((f) => ds.models[f[3]].id === 'gpt-5.3-codex')!;
    expect(agent[0]).toBe(localDayIndex(Date.parse('2026-10-30T10:15:00Z')));
    expect(agent[1]).toBe(localHour(Date.parse('2026-10-30T10:15:00Z')));
    const daily = ds.facts.find((f) => ds.models[f[3]].id === 'gpt-5.4-mini')!;
    expect(daily[0]).toBe(Date.parse('2026-10-29T00:00:00Z') / 86_400_000);
    expect(daily[1]).toBe(-1);
    expect(daily[10]).toBe(300);
    expect(daily[11]).toBeCloseTo(0.75, 6); // 1M input tokens at $0.75/M
  });

  it('totals sessions, tools and sub-agent share', () => {
    const s = ds.sessions.find((x) => x.key === 'claude-code:s1')!;
    expect(s.title).toBe('Fix the tests');
    expect(s.requests).toBe(2);
    expect(s.tools).toEqual([
      ['Bash', 2],
      ['Edit', 1],
    ]);
    expect(s.subagentTokens).toBe(10 + 100 + 1000 + 50);
    expect(s.models).toHaveLength(2);
    expect(s.cost).toBeGreaterThan(0);
  });
});

describe('computeBlocks', () => {
  const h = 3_600_000;
  const t0 = Date.parse('2026-10-31T08:20:00Z');
  const events = [
    ev({ ts: t0 - 30 * h }),
    ev({ ts: t0 - 29 * h }),
    ev({ ts: t0 }),
    ev({ ts: t0 + 0.5 * h }),
  ];
  it('starts a block at the hour of the first message and lasts five hours', () => {
    const now = t0 + 0.6 * h;
    const b = computeBlocks(events, now);
    expect(b.recent).toHaveLength(2);
    expect(b.current?.start).toBe(Date.parse('2026-10-31T08:00:00Z'));
    expect(b.current?.end).toBe(Date.parse('2026-10-31T13:00:00Z'));
    expect(b.current?.requests).toBe(2);
    // Still being used, so it projects forward at the current pace.
    expect(b.current!.projectedTokens).toBeGreaterThan(b.current!.tokens);
  });
  it('stops projecting once the window goes quiet', () => {
    const b = computeBlocks(events, t0 + 2 * h);
    expect(b.current!.projectedTokens).toBe(b.current!.tokens);
  });
  it('has no current block once the window has passed', () => {
    expect(computeBlocks(events, t0 + 6 * h).current).toBeUndefined();
  });
});

describe('DemoSource', () => {
  it('is deterministic and has live sessions', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const a = new DemoSource(now).snapshot();
    const b = new DemoSource(now).snapshot();
    expect(a.events.length).toBe(b.events.length);
    expect(a.events.length).toBeGreaterThan(1000);
    const recent = a.events.filter((e) => now - e.ts < 5 * 60_000 && !e.daily);
    expect(recent.length).toBeGreaterThan(0);
    expect(a.codexLimits?.primary?.usedPercent).toBeGreaterThan(0);
  });
});
