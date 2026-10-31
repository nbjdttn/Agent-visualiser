import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Dataset, LiveStatus } from '../shared/types';
import { createApp } from '../server/app';
import type { Config } from '../server/config';
import { Store } from '../server/store';

const empty = path.join(os.tmpdir(), 'agent-visualiser-nothing-here');
const config: Config = {
  port: 0,
  host: '127.0.0.1',
  claudeRoots: [path.join(empty, 'claude')],
  codexRoots: [path.join(empty, 'codex')],
  apiLookbackDays: 30,
  apiRefreshMs: 60_000,
  scanIntervalMs: 0,
  pricingOffline: true,
  demo: 'auto',
  cacheDir: path.join(os.tmpdir(), 'agent-visualiser-test-cache'),
  staticDir: path.join(empty, 'dist'),
};

describe('HTTP API', async () => {
  const store = new Store(config);
  await store.init();
  const app = createApp(store);
  const get = (p: string, host = 'localhost:4777') => app.request(p, { headers: { host } });

  it('falls back to demo data when nothing is connected', async () => {
    const res = await get('/api/dataset');
    expect(res.status).toBe(200);
    const ds = (await res.json()) as Dataset;
    expect(ds.demo).toBe(true);
    expect(ds.facts.length).toBeGreaterThan(100);
    expect(ds.sources.map((s) => s.id)).toEqual(['claude-code', 'codex', 'claude-ai', 'chatgpt', 'anthropic-api', 'openai-api']);
  });

  it('serves live status with active sessions', async () => {
    const live = (await (await get('/api/live')).json()) as LiveStatus;
    expect(live.demo).toBe(true);
    expect(live.active.some((a) => a.state === 'working')).toBe(true);
    expect(live.claudeBlocks.current).toBeDefined();
  });

  it('serves a session timeline', async () => {
    const ds = (await (await get('/api/dataset')).json()) as Dataset;
    const key = ds.sessions[0].key;
    const res = await get(`/api/session/${encodeURIComponent(key)}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { events: unknown[] };
    expect(detail.events.length).toBe(ds.sessions[0].requests);
    expect((await get('/api/session/nope')).status).toBe(404);
  });

  it('rejects requests addressed to other host names (DNS rebinding)', async () => {
    expect((await get('/api/dataset', 'evil.example.com')).status).toBe(403);
    expect((await get('/api/health', '127.0.0.1:4777')).status).toBe(200);
  });

  it('only refreshes when the app header is present (no cross-site POSTs)', async () => {
    const bare = await app.request('/api/refresh', { method: 'POST', headers: { host: 'localhost:4777' } });
    expect(bare.status).toBe(403);
    const ok = await app.request('/api/refresh', {
      method: 'POST',
      headers: { host: 'localhost:4777', 'x-agent-visualiser': '1' },
    });
    expect(ok.status).toBe(200);
  });
});

describe('imports through the API', async () => {
  const cacheDir = path.join(os.tmpdir(), `agent-visualiser-import-test-${Date.now()}`);
  const store = new Store({ ...config, cacheDir, demo: 'off' });
  await store.init();
  const app = createApp(store);
  const exportJson = JSON.stringify([
    {
      uuid: 'c-1',
      name: 'Hello',
      created_at: '2026-10-20T10:00:00Z',
      chat_messages: [
        { uuid: 'm1', sender: 'human', created_at: '2026-10-20T10:00:00Z', text: 'hi there', content: [] },
        { uuid: 'm2', sender: 'assistant', created_at: '2026-10-20T10:00:05Z', text: 'hello! how can I help?', content: [] },
      ],
    },
  ]);
  const post = (body: string, headers: Record<string, string> = {}) =>
    app.request('/api/import', { method: 'POST', body, headers: { host: 'localhost', 'x-agent-visualiser': '1', 'x-file-name': 'conversations.json', ...headers } });

  it('imports a claude.ai export, lists it and removes it', async () => {
    const res = await post(exportJson);
    expect(res.status).toBe(200);
    const [info] = (await res.json()) as { id: string; source: string; conversations: number }[];
    expect(info).toMatchObject({ source: 'claude-ai', conversations: 1 });
    const ds = (await (await app.request('/api/dataset', { headers: { host: 'localhost' } })).json()) as Dataset;
    expect(ds.sources.find((s) => s.id === 'claude-ai')?.connected).toBe(true);
    expect(ds.sessions.some((s) => s.key === 'claude-ai:c-1')).toBe(true);
    const list = (await (await app.request('/api/imports', { headers: { host: 'localhost' } })).json()) as unknown[];
    expect(list).toHaveLength(1);
    const del = await app.request(`/api/import/${info.id}`, { method: 'DELETE', headers: { host: 'localhost', 'x-agent-visualiser': '1' } });
    expect(del.status).toBe(200);
  });

  it('explains files it cannot read', async () => {
    const res = await post('{"not":"an export"}', { 'x-file-name': 'random.json' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/doesn't look like/);
  });

  it('marks pages it serves so the app uses the API', async () => {
    const fs = await import('node:fs');
    const dist = path.join(cacheDir, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<html><head><title>x</title></head><body></body></html>');
    const withStatic = createApp(store, { staticDir: dist });
    const html = await (await withStatic.request('/', { headers: { host: 'localhost' } })).text();
    expect(html).toContain('<meta name="av-server"');
  });
});
