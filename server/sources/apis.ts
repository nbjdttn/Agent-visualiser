import fs from 'node:fs';
import path from 'node:path';
import type { SourceId, SourceStatus } from '../../shared/types.js';
import type { ProjectHint, RawEvent, SourceSnapshot } from '../../core/model.js';
import { DAY_MS, num, str } from '../../core/util.js';

/**
 * Organisation usage from the providers' admin APIs, fetched as daily
 * buckets. Finished days never change, so they are cached on disk and only
 * the last few days are re-fetched.
 */

type FetchFn = typeof fetch;

export interface DailyRow {
  model: string;
  project: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  requests: number;
  webSearch: number;
  batch: boolean;
}

interface CacheFile {
  days: Record<string, DailyRow[]>;
  names: Record<string, string>;
  updatedAt: number;
}

const USER_AGENT = 'agent-visualiser/0.1 (+https://github.com/nbjdttn/Agent-visualiser)';

async function getJson(fetchImpl: FetchFn, url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetchImpl(url, { headers: { ...headers, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Anthropic: GET /v1/organizations/usage_report/messages (Admin API key)
// ---------------------------------------------------------------------------

export async function fetchAnthropicDaily(
  key: string,
  fromDay: number,
  toDayExclusive: number,
  fetchImpl: FetchFn = fetch,
): Promise<Record<string, DailyRow[]>> {
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const out: Record<string, DailyRow[]> = {};
  let page: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const q = new URLSearchParams({
      starting_at: new Date(fromDay * DAY_MS).toISOString(),
      ending_at: new Date(toDayExclusive * DAY_MS).toISOString(),
      bucket_width: '1d',
      limit: '31',
    });
    for (const g of ['model', 'workspace_id', 'service_tier']) q.append('group_by[]', g);
    if (page) q.set('page', page);
    const json = await getJson(fetchImpl, `https://api.anthropic.com/v1/organizations/usage_report/messages?${q}`, headers);
    for (const bucket of json.data ?? []) {
      const day = String(bucket.starting_at).slice(0, 10);
      const rows = (out[day] ??= []);
      for (const r of bucket.results ?? []) {
        const cw5 = num(r.cache_creation?.ephemeral_5m_input_tokens);
        const cw1 = num(r.cache_creation?.ephemeral_1h_input_tokens);
        rows.push({
          model: str(r.model) ?? 'unknown',
          project: str(r.workspace_id) ?? null,
          input: num(r.uncached_input_tokens),
          output: num(r.output_tokens),
          cacheRead: num(r.cache_read_input_tokens),
          cacheWrite: cw5 + cw1,
          cacheWrite1h: cw1,
          requests: 0,
          webSearch: num(r.server_tool_use?.web_search_requests),
          batch: r.service_tier === 'batch',
        });
      }
    }
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }
  return out;
}

export async function fetchAnthropicWorkspaces(key: string, fetchImpl: FetchFn = fetch): Promise<Record<string, string>> {
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const names: Record<string, string> = {};
  let after: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const q = new URLSearchParams({ limit: '100', include_archived: 'true' });
    if (after) q.set('after_id', after);
    const json = await getJson(fetchImpl, `https://api.anthropic.com/v1/organizations/workspaces?${q}`, headers);
    for (const w of json.data ?? []) if (w.id) names[w.id] = w.name ?? w.id;
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return names;
}

// ---------------------------------------------------------------------------
// OpenAI: GET /v1/organization/usage/{completions,embeddings} (Admin key)
// ---------------------------------------------------------------------------

export async function fetchOpenAIDaily(
  key: string,
  fromDay: number,
  toDayExclusive: number,
  fetchImpl: FetchFn = fetch,
): Promise<Record<string, DailyRow[]>> {
  const headers = { authorization: `Bearer ${key}` };
  const out: Record<string, DailyRow[]> = {};
  for (const kind of ['completions', 'embeddings'] as const) {
    let page: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const q = new URLSearchParams({
        start_time: String(fromDay * 86_400),
        end_time: String(toDayExclusive * 86_400),
        bucket_width: '1d',
        limit: '31',
      });
      q.append('group_by', 'project_id');
      q.append('group_by', 'model');
      if (kind === 'completions') q.append('group_by', 'batch');
      if (page) q.set('page', page);
      const json = await getJson(fetchImpl, `https://api.openai.com/v1/organization/usage/${kind}?${q}`, headers);
      for (const bucket of json.data ?? []) {
        const day = new Date(num(bucket.start_time) * 1000).toISOString().slice(0, 10);
        const rows = (out[day] ??= []);
        for (const r of bucket.results ?? []) {
          const input = num(r.input_tokens);
          const cached = Math.min(num(r.input_cached_tokens), input);
          rows.push({
            model: str(r.model) ?? 'unknown',
            project: str(r.project_id) ?? null,
            input: input - cached,
            output: num(r.output_tokens),
            cacheRead: cached,
            cacheWrite: 0,
            cacheWrite1h: 0,
            requests: num(r.num_model_requests),
            webSearch: 0,
            batch: r.batch === true,
          });
        }
      }
      if (!json.has_more || !json.next_page) break;
      page = json.next_page;
    }
  }
  return out;
}

export async function fetchOpenAIProjects(key: string, fetchImpl: FetchFn = fetch): Promise<Record<string, string>> {
  const headers = { authorization: `Bearer ${key}` };
  const names: Record<string, string> = {};
  let after: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const q = new URLSearchParams({ limit: '100', include_archived: 'true' });
    if (after) q.set('after', after);
    const json = await getJson(fetchImpl, `https://api.openai.com/v1/organization/projects?${q}`, headers);
    for (const p of json.data ?? []) if (p.id) names[p.id] = p.name ?? p.id;
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Shared source wrapper with on-disk cache
// ---------------------------------------------------------------------------

interface ApiSourceOptions {
  id: Extract<SourceId, 'anthropic-api' | 'openai-api'>;
  key?: string;
  lookbackDays: number;
  cacheDir: string;
  refreshMs: number;
  fetchImpl?: FetchFn;
}

export class ApiUsageSource {
  private cache: CacheFile = { days: {}, names: {}, updatedAt: 0 };
  private memo?: SourceSnapshot;
  private lastAttempt = 0;
  private error?: string;
  private inflight?: Promise<boolean>;

  constructor(private opts: ApiSourceOptions) {
    this.load();
  }

  get id() {
    return this.opts.id;
  }

  get configured(): boolean {
    return Boolean(this.opts.key);
  }

  private get file() {
    return path.join(this.opts.cacheDir, `${this.opts.id}-usage.json`);
  }

  private load() {
    if (!this.opts.key) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CacheFile;
      if (data && data.days) this.cache = data;
    } catch {
      // nothing cached yet
    }
  }

  private save() {
    try {
      fs.mkdirSync(this.opts.cacheDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cache));
    } catch {
      // caching is best-effort
    }
  }

  /** Fetch new days when the refresh interval has passed. Returns true when data changed. */
  refresh(force = false): Promise<boolean> {
    if (!this.opts.key) return Promise.resolve(false);
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.lastAttempt < this.opts.refreshMs) return Promise.resolve(false);
    this.lastAttempt = Date.now();
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<boolean> {
    const key = this.opts.key!;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const today = Math.floor(Date.now() / DAY_MS);
    const start = today - this.opts.lookbackDays + 1;
    const cachedDays = Object.keys(this.cache.days).sort();
    const lastCached = cachedDays.length ? Math.floor(Date.parse(cachedDays.at(-1)!) / DAY_MS) : undefined;
    // Re-fetch the last two cached days too: the newest buckets fill in late.
    const from = lastCached !== undefined && lastCached >= start ? Math.max(start, lastCached - 2) : start;
    try {
      const isAnthropic = this.opts.id === 'anthropic-api';
      const [days, names] = await Promise.all([
        isAnthropic ? fetchAnthropicDaily(key, from, today + 1, fetchImpl) : fetchOpenAIDaily(key, from, today + 1, fetchImpl),
        (isAnthropic ? fetchAnthropicWorkspaces(key, fetchImpl) : fetchOpenAIProjects(key, fetchImpl)).catch(
          () => this.cache.names,
        ),
      ]);
      for (const [day, rows] of Object.entries(days)) this.cache.days[day] = rows;
      const minDay = new Date(start * DAY_MS).toISOString().slice(0, 10);
      for (const day of Object.keys(this.cache.days)) if (day < minDay) delete this.cache.days[day];
      this.cache.names = { ...this.cache.names, ...names };
      this.cache.updatedAt = Date.now();
      this.error = undefined;
      this.save();
      this.memo = undefined;
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  snapshot(): SourceSnapshot {
    if (this.memo) return this.memo;
    const isAnthropic = this.opts.id === 'anthropic-api';
    const prefix = isAnthropic ? 'anthropic-ws' : 'openai-proj';
    const events: RawEvent[] = [];
    const projects = new Map<string, ProjectHint>();
    for (const [day, rows] of Object.entries(this.cache.days)) {
      const ts = Date.parse(`${day}T00:00:00Z`);
      for (const r of rows) {
        const pid = r.project ?? 'default';
        const projectKey = `${prefix}:${pid}`;
        if (!projects.has(projectKey)) {
          const name =
            (r.project && this.cache.names[r.project]) ||
            (r.project ? r.project : isAnthropic ? 'Default workspace' : 'Default project');
          projects.set(projectKey, {
            key: projectKey,
            kind: isAnthropic ? 'anthropic-workspace' : 'openai-project',
            name,
            provider: isAnthropic ? 'anthropic' : 'openai',
          });
        }
        events.push({
          key: '',
          ts,
          source: this.opts.id,
          model: r.model,
          projectKey,
          input: r.input,
          output: r.output,
          cacheRead: r.cacheRead,
          cacheWrite: r.cacheWrite,
          cacheWrite1h: r.cacheWrite1h,
          reasoning: 0,
          requests: r.requests,
          webSearch: r.webSearch,
          batch: r.batch,
          daily: true,
        });
      }
    }
    events.sort((a, b) => a.ts - b.ts);
    this.memo = { events, sessions: new Map(), projects };
    return this.memo;
  }

  status(): SourceStatus {
    const isAnthropic = this.opts.id === 'anthropic-api';
    const snap = this.snapshot();
    const days = Object.keys(this.cache.days).length;
    return {
      id: this.opts.id,
      label: isAnthropic ? 'Anthropic API' : 'OpenAI API',
      provider: isAnthropic ? 'anthropic' : 'openai',
      kind: 'api',
      connected: this.configured && !this.error && days > 0,
      summary: !this.configured
        ? 'Not connected'
        : this.error
          ? 'Could not fetch usage'
          : days
            ? `${days} days of organisation usage, ${snap.projects.size} ${isAnthropic ? 'workspaces' : 'projects'}`
            : 'Fetching usage…',
      events: snap.events.length,
      lastEventAt: snap.events.at(-1)?.ts,
      updatedAt: this.cache.updatedAt || undefined,
      error: this.error,
      hint: this.configured
        ? undefined
        : isAnthropic
          ? 'Add ANTHROPIC_ADMIN_KEY (sk-ant-admin01-…) to .env to include API usage by model and workspace. Admin keys are available to Claude Console organisations.'
          : 'Add OPENAI_ADMIN_KEY (sk-admin-…) to .env to include API usage by model and project.',
    };
  }
}
