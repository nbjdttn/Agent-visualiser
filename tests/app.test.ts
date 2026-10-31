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
    expect(ds.sources.map((s) => s.id)).toEqual(['claude-code', 'codex', 'anthropic-api', 'openai-api']);
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
