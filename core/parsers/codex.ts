import type { CodexLimits, RateLimitWindowStatus } from '../../shared/types';
import {
  cloneSession,
  mergeSession,
  newSessionMeta,
  type ProjectHint,
  type RawEvent,
  type SessionMeta,
  type SourceSnapshot,
} from '../model';
import { basename, clampText, displayPath, folderName, normalizeFolder, num, parseTs, str } from '../util';

/**
 * Codex CLI rollouts: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *
 * Each line is {timestamp, type, payload}. Newer versions write one
 * `token_usage_record` per model response; older ones only write cumulative
 * `token_count` events, so usage is taken from records when a file has them
 * and from the growth of the running total otherwise. In OpenAI's
 * accounting input includes cached input and output includes reasoning.
 *
 * Runs on the server (reading files) and in the phone app (imported files).
 */

export interface CodexFileResult {
  events: RawEvent[];
  session?: SessionMeta;
  repo?: string;
  limits?: CodexLimits;
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** Convert Codex token usage to non-overlapping counts. */
export function codexUsage(u: TokenUsage) {
  const input = num(u.input_tokens);
  const cached = Math.min(num(u.cached_input_tokens), input);
  const cacheWrite = num(u.cache_write_input_tokens);
  let output = num(u.output_tokens);
  const reasoning = num(u.reasoning_output_tokens);
  // Output normally includes reasoning. If the reported total says otherwise, add it back.
  const total = num(u.total_tokens);
  if (reasoning > 0 && total > 0 && Math.abs(total - (input + output + reasoning)) < Math.abs(total - (input + output))) {
    output += reasoning;
  }
  return {
    input: Math.max(0, input - cached - cacheWrite),
    cacheRead: cached,
    cacheWrite,
    cacheWrite1h: 0,
    output,
    reasoning: Math.min(reasoning, output),
  };
}

function diffUsage(a: TokenUsage, b: TokenUsage): TokenUsage | undefined {
  const keys: (keyof TokenUsage)[] = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  const out: TokenUsage = {};
  for (const k of keys) {
    const d = num(a[k]) - num(b[k]);
    if (d < 0) return undefined; // the running total was reset
    out[k] = d;
  }
  return out;
}

function readWindow(w: any, ts: number): RateLimitWindowStatus | undefined {
  if (!w || typeof w.used_percent !== 'number') return undefined;
  let resetsAt: number | undefined;
  if (typeof w.resets_at === 'number') resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
  else if (typeof w.resets_in_seconds === 'number') resetsAt = ts + w.resets_in_seconds * 1000;
  return {
    usedPercent: w.used_percent,
    windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
    resetsAt,
  };
}

/** Normalise a git remote to host/owner/repo for display. */
export function cleanRepoUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let u = url.trim().replace(/\.git$/, '');
  u = u.replace(/^git@([^:]+):/, '$1/').replace(/^[a-z+]+:\/\//, '').replace(/^[^@/]+@/, '');
  return u || undefined;
}

/** Recognise a Codex rollout from one of its lines. */
export function looksLikeCodexLine(line: string): boolean {
  return /"type":"(session_meta|turn_context|response_item|event_msg|token_usage_record)"/.test(line) && line.includes('"payload"');
}

const INTERESTING = [
  '"session_meta"',
  '"turn_context"',
  '"token_usage_record"',
  '"token_count"',
  '"user_message"',
  '"type":"function_call"',
  '"type":"custom_tool_call"',
  '"type":"local_shell_call"',
  '"type":"web_search_call"',
];

export async function parseCodexLines(
  lines: AsyncIterable<string> | Iterable<string>,
  file: { path: string; mtimeMs: number },
): Promise<CodexFileResult> {
  const name = basename(file.path);
  const stemMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(name);
  let sessionId = stemMatch?.[1] ?? name.replace(/\.jsonl(\.zst)?$/, '');
  let cwd: string | undefined;
  let model = 'unknown';
  let sub = false;
  let repo: string | undefined;
  let branch: string | undefined;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let title: string | undefined;
  const prompts = new Set<string>();
  const turnModels = new Map<string, string>();
  const records: RawEvent[] = [];
  const counted: RawEvent[] = [];
  let toolsForRecord: string[] = [];
  let toolsForCount: string[] = [];
  let prevTotal: TokenUsage | undefined;
  let limits: CodexLimits | undefined;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  const projectKey = () => `dir:${cwd ? normalizeFolder(cwd) : 'unknown'}`;
  const make = (key: string, ts: number, m: string, u: TokenUsage, tools: string[]): RawEvent => ({
    key,
    ts,
    source: 'codex',
    model: m,
    projectKey: projectKey(),
    sessionKey: `codex:${sessionId}`,
    ...codexUsage(u),
    requests: 1,
    sidechain: sub,
    tools: tools.length ? tools : undefined,
  });

  for await (const line of lines) {
    if (!line || !INTERESTING.some((s) => line.includes(s))) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = parseTs(o.timestamp) ?? file.mtimeMs;
    const p = o.payload && typeof o.payload === 'object' ? o.payload : o;
    const kind = o.payload ? o.type : undefined;

    if (kind === 'session_meta') {
      sessionId = str(p.session_id) ?? str(p.id) ?? sessionId;
      cwd = str(p.cwd) ?? cwd;
      version = str(p.cli_version) ?? version;
      entrypoint = str(p.originator) ?? entrypoint;
      sub = Boolean(
        p.parent_thread_id ||
          p.agent_role ||
          p.agent_nickname ||
          (p.source && typeof p.source === 'object' && 'subagent' in p.source),
      );
      repo = cleanRepoUrl(str(p.git?.repository_url)) ?? repo;
      branch = str(p.git?.branch) ?? branch;
      continue;
    }
    firstTs = Math.min(firstTs ?? ts, ts);
    lastTs = Math.max(lastTs ?? ts, ts);

    if (kind === 'turn_context') {
      model = str(p.model) ?? model;
      cwd = str(p.cwd) ?? cwd;
      if (str(p.turn_id) && str(p.model)) turnModels.set(p.turn_id, p.model);
    } else if (kind === 'token_usage_record') {
      if (!p.usage) continue;
      const m = turnModels.get(p.turn_id) ?? model;
      const e = make(`codex:${p.response_id ?? `${sessionId}:${records.length}`}`, ts, m, p.usage, toolsForRecord);
      if (str(p.session_id)) e.sessionKey = `codex:${p.session_id}`;
      records.push(e);
      toolsForRecord = [];
    } else if (kind === 'event_msg' && p.type === 'token_count') {
      if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) {
        limits = {
          primary: readWindow(p.rate_limits.primary, ts),
          secondary: readWindow(p.rate_limits.secondary, ts),
          planType: str(p.rate_limits.plan_type),
          updatedAt: ts,
        };
      }
      const total: TokenUsage | undefined = p.info?.total_token_usage;
      if (!total) continue;
      let delta: TokenUsage | undefined = prevTotal ? diffUsage(total, prevTotal) : total;
      if (!delta) delta = p.info?.last_token_usage ?? total;
      prevTotal = total;
      if (!delta || (num(delta.input_tokens) <= 0 && num(delta.output_tokens) <= 0)) continue;
      counted.push(make('', ts, model, delta, toolsForCount));
      toolsForCount = [];
    } else if (kind === 'event_msg' && p.type === 'user_message') {
      const text = str(p.message)?.trim();
      if (!text || text.startsWith('<')) continue;
      prompts.add(`${ts}:${prompts.size}`);
      title ??= clampText(text);
    } else {
      const t = kind === 'response_item' ? p.type : o.type;
      let tool: string | undefined;
      if (t === 'function_call' || t === 'custom_tool_call') tool = str(p.name);
      else if (t === 'local_shell_call') tool = 'shell';
      else if (t === 'web_search_call') tool = 'web_search';
      if (tool) {
        toolsForRecord.push(tool);
        toolsForCount.push(tool);
      }
    }
  }

  const events = records.length ? records : counted;
  let session: SessionMeta | undefined;
  if (events.length || prompts.size) {
    const start = firstTs ?? file.mtimeMs;
    session = newSessionMeta(`codex:${sessionId}`, sessionId, 'codex', projectKey(), start);
    session.cwd = cwd;
    session.lastTs = lastTs ?? start;
    session.lastWrite = Math.max(file.mtimeMs, session.lastTs);
    session.branch = branch;
    session.repo = repo;
    session.version = version;
    session.entrypoint = entrypoint;
    if (!sub) {
      session.promptIds = prompts;
      if (title) {
        session.title = title;
        session.titleRank = 1;
      }
    }
  }
  return { events, session, repo, limits };
}

/** Merge per-file results: de-duplicate per-response records and fold sessions together. */
export function buildCodexSnapshot(results: CodexFileResult[]): SourceSnapshot {
  const seen = new Set<string>();
  const events: RawEvent[] = [];
  const sessions = new Map<string, SessionMeta>();
  const projects = new Map<string, ProjectHint>();
  let limits: CodexLimits | undefined;
  for (const result of results) {
    for (const e of result.events) {
      if (e.key) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
      }
      events.push({ ...e });
    }
    if (result.session) {
      const prev = sessions.get(result.session.key);
      if (prev) mergeSession(prev, result.session);
      else sessions.set(result.session.key, cloneSession(result.session));
      const pk = result.session.projectKey;
      if (pk.startsWith('dir:') && pk !== 'dir:unknown') {
        const folder = pk.slice(4);
        let p = projects.get(pk);
        if (!p) {
          p = { key: pk, kind: 'folder', name: folderName(folder), path: displayPath(folder), branches: new Set() };
          projects.set(pk, p);
        }
        if (result.session.branch) p.branches!.add(result.session.branch);
        p.repo ??= result.repo;
      }
    }
    if (result.limits && (!limits || result.limits.updatedAt > limits.updatedAt)) limits = result.limits;
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, sessions, projects, codexLimits: limits };
}
