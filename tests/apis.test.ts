import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiUsageSource, fetchAnthropicDaily, fetchOpenAIDaily } from '../server/sources/apis';

type Call = { url: URL; headers: Record<string, string> };

function mockFetch(handler: (url: URL) => unknown, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = handler(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const DAY = 86_400_000;
const day0 = Date.parse('2026-10-01T00:00:00Z') / DAY;

describe('Anthropic usage report', () => {
  it('pages through results and maps token fields', async () => {
    const calls: Call[] = [];
    const fetchImpl = mockFetch((url) => {
      const page = url.searchParams.get('page');
      const bucket = (d: string, results: unknown[]) => ({ starting_at: `${d}T00:00:00Z`, ending_at: 'x', results });
      if (!page) {
        return {
          data: [
            bucket('2026-10-01', [
              {
                model: 'claude-sonnet-5-5',
                workspace_id: 'wrkspc_1',
                service_tier: 'batch',
                uncached_input_tokens: 100,
                cache_read_input_tokens: 1000,
                cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
                output_tokens: 40,
                server_tool_use: { web_search_requests: 2 },
              },
            ]),
          ],
          has_more: true,
          next_page: 'page_2',
        };
      }
      return { data: [bucket('2026-10-02', [{ model: 'claude-haiku-5-5', workspace_id: null, uncached_input_tokens: 5, output_tokens: 1 }])], has_more: false, next_page: null };
    }, calls);

    const days = await fetchAnthropicDaily('sk-ant-admin01-test', day0, day0 + 2, fetchImpl);
    expect(Object.keys(days)).toEqual(['2026-10-01', '2026-10-02']);
    expect(days['2026-10-01'][0]).toEqual({
      model: 'claude-sonnet-5-5',
      project: 'wrkspc_1',
      input: 100,
      output: 40,
      cacheRead: 1000,
      cacheWrite: 100,
      cacheWrite1h: 70,
      requests: 0,
      webSearch: 2,
      batch: true,
    });
    expect(days['2026-10-02'][0].project).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname).toBe('/v1/organizations/usage_report/messages');
    expect(calls[0].url.searchParams.getAll('group_by[]')).toEqual(['model', 'workspace_id', 'service_tier']);
    expect(calls[0].url.searchParams.get('bucket_width')).toBe('1d');
    expect(calls[0].headers['x-api-key']).toBe('sk-ant-admin01-test');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[1].url.searchParams.get('page')).toBe('page_2');
  });
});

describe('OpenAI usage', () => {
  it('reads completions and embeddings, splitting cached input', async () => {
    const calls: Call[] = [];
    const fetchImpl = mockFetch((url) => {
      const start = Number(url.searchParams.get('start_time'));
      const r = url.pathname.endsWith('/completions')
        ? { model: 'gpt-5.4-mini', project_id: 'proj_1', input_tokens: 1000, input_cached_tokens: 600, output_tokens: 200, num_model_requests: 7, batch: false }
        : { model: 'text-embedding-3-small', project_id: null, input_tokens: 500, num_model_requests: 3 };
      return { data: [{ start_time: start, end_time: start + 86400, results: [r] }], has_more: false, next_page: null };
    }, calls);
    const days = await fetchOpenAIDaily('sk-admin-test', day0, day0 + 1, fetchImpl);
    const rows = days['2026-10-01'];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: 'gpt-5.4-mini', project: 'proj_1', input: 400, cacheRead: 600, output: 200, requests: 7 });
    expect(rows[1]).toMatchObject({ model: 'text-embedding-3-small', input: 500, output: 0, requests: 3 });
    expect(calls[0].url.searchParams.getAll('group_by')).toEqual(['project_id', 'model', 'batch']);
    expect(calls[0].headers.authorization).toBe('Bearer sk-admin-test');
  });
});

describe('ApiUsageSource', () => {
  it('caches finished days on disk and names projects', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-visualiser-cache-'));
    const fetchImpl = mockFetch((url) => {
      if (url.pathname.endsWith('/projects')) return { data: [{ id: 'proj_1', name: 'Course assistant bot' }], has_more: false };
      const start = Number(url.searchParams.get('start_time'));
      return {
        data: [{ start_time: start, end_time: start + 86400, results: [{ model: 'gpt-5.4-mini', project_id: 'proj_1', input_tokens: 10, output_tokens: 5, num_model_requests: 1 }] }],
        has_more: false,
      };
    });
    const source = new ApiUsageSource({ id: 'openai-api', key: 'sk-admin-x', lookbackDays: 7, cacheDir, refreshMs: 0, fetchImpl });
    expect(await source.refresh(true)).toBe(true);
    const snap = source.snapshot();
    expect(snap.projects.get('openai-proj:proj_1')?.name).toBe('Course assistant bot');
    expect(snap.events.every((e) => e.daily && e.source === 'openai-api')).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'openai-api-usage.json'))).toBe(true);
    expect(source.status().connected).toBe(true);
  });

  it('reports errors without throwing', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-visualiser-cache-'));
    const fetchImpl = mockFetch(() => new Response('{"error":"invalid key"}', { status: 401, statusText: 'Unauthorized' }));
    const source = new ApiUsageSource({ id: 'anthropic-api', key: 'bad', lookbackDays: 7, cacheDir, refreshMs: 0, fetchImpl });
    expect(await source.refresh(true)).toBe(false);
    expect(source.status().error).toMatch(/401/);
    expect(source.status().connected).toBe(false);
  });

  it('stays quiet without a key', async () => {
    const source = new ApiUsageSource({ id: 'openai-api', lookbackDays: 7, cacheDir: os.tmpdir(), refreshMs: 0 });
    expect(await source.refresh(true)).toBe(false);
    expect(source.status().hint).toMatch(/OPENAI_ADMIN_KEY/);
  });
});
