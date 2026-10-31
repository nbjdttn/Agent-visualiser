import {
  cloneSession,
  mergeSession,
  newSessionMeta,
  type ProjectHint,
  type RawEvent,
  type SessionMeta,
  type SourceSnapshot,
} from '../model';
import { basename, clampText, decodeClaudeProjectDir, displayPath, folderName, normalizeFolder, num, parseTs, str } from '../util';

/**
 * Claude Code transcripts: <config>/projects/<project>/<session>.jsonl, plus
 * sub-agent transcripts in the same tree. Each assistant line carries the API
 * usage for one response; a response split over several lines shares a
 * message id, so lines are de-duplicated on message id + request id.
 *
 * Runs on the server (reading files) and in the phone app (imported files).
 */

export interface ClaudeFileResult {
  events: RawEvent[];
  sessions: SessionMeta[];
}

export interface ClaudeFileInfo {
  path: string;
  mtimeMs: number;
  /** Name of the project folder under projects/, used when a line has no cwd. */
  projectDirName: string;
}

interface ClaudeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  webSearch: number;
  speed?: string;
  geo?: string;
}

/** Read an API usage object. Requests with server-side steps itemise them in `iterations`. */
export function readClaudeUsage(u: Record<string, any>): ClaudeUsage {
  const parts: Record<string, any>[] = Array.isArray(u.iterations) && u.iterations.length > 0 ? u.iterations : [u];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWrite1h = 0;
  for (const p of parts) {
    input += num(p.input_tokens);
    output += num(p.output_tokens);
    cacheRead += num(p.cache_read_input_tokens);
    const cw = num(p.cache_creation_input_tokens);
    cacheWrite += cw;
    cacheWrite1h += Math.min(cw, num(p.cache_creation?.ephemeral_1h_input_tokens));
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    reasoning: Math.min(output, num(u.output_tokens_details?.thinking_tokens)),
    webSearch: num(u.server_tool_use?.web_search_requests),
    speed: str(u.speed),
    geo: str(u.inference_geo),
  };
}

function promptText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const block = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    text = block?.text;
  }
  const t = text?.trim();
  if (!t) return undefined;
  const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(t);
  if (cmd) {
    if (BUILTIN_COMMANDS.has(cmd[1])) return undefined;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return `/${cmd[1]}${args ? ` ${args}` : ''}`;
  }
  if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return undefined;
  return t;
}

/** Claude Code's own commands say nothing about what a session was for. */
const BUILTIN_COMMANDS = new Set(
  'clear compact resume continue model exit quit login logout config cost help status context permissions mcp memory agents hooks ide doctor rewind export usage add-dir remote-control init theme vim terminal-setup bug feedback release-notes upgrade privacy-settings statusline output-style todos bashes plugin plugins'.split(' '),
);

/** Recognise a Claude Code transcript from one of its lines. */
export function looksLikeClaudeCodeLine(line: string): boolean {
  return line.includes('"sessionId"') && /"type":"(assistant|user|summary|ai-title|attachment|last-prompt|queue-operation)"/.test(line);
}

export async function parseClaudeLines(
  lines: AsyncIterable<string> | Iterable<string>,
  file: ClaudeFileInfo,
): Promise<ClaudeFileResult> {
  const stem = basename(file.path).replace(/\.jsonl$/, '');
  const fileIsSubagent = /[\\/]subagents[\\/]/.test(file.path) || stem.startsWith('agent-');
  const fallbackFolder = normalizeFolder(decodeClaudeProjectDir(file.projectDirName || 'unknown'));
  const events = new Map<string, RawEvent>();
  const toolIds = new Map<string, Set<string>>();
  const sessions = new Map<string, SessionMeta>();

  const projectKeyFor = (cwd?: string) => `dir:${cwd ? normalizeFolder(cwd) : fallbackFolder}`;

  /** Find or create the session a line belongs to. `ts` is undefined for lines without a timestamp. */
  const touch = (o: Record<string, any>, ts: number | undefined): SessionMeta => {
    const id = str(o.sessionId) ?? stem;
    const cwd = str(o.cwd);
    let s = sessions.get(id);
    if (!s) {
      const t = ts ?? file.mtimeMs;
      s = newSessionMeta(`claude-code:${id}`, id, 'claude-code', projectKeyFor(cwd), t);
      sessions.set(id, s);
    }
    if (ts !== undefined) {
      if (ts < s.firstTs) s.firstTs = ts;
      if (ts > s.lastTs) s.lastTs = ts;
    }
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      s.projectKey = projectKeyFor(cwd);
    }
    const branch = str(o.gitBranch);
    if (branch && branch !== 'HEAD') s.branch = branch;
    s.entrypoint ??= str(o.entrypoint);
    s.version = str(o.version) ?? s.version;
    return s;
  };

  for await (const line of lines) {
    if (!line) continue;
    const assistant = line.includes('"type":"assistant"') && line.includes('"usage"');
    const title = !assistant && line.includes('"type":"ai-title"');
    const lastPrompt = !assistant && line.includes('"type":"last-prompt"');
    const user = !assistant && !title && line.includes('"type":"user"') && !line.includes('"tool_use_id"');
    if (!assistant && !title && !lastPrompt && !user) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const stamped = parseTs(o.timestamp);
    const ts = stamped ?? file.mtimeMs;

    if (o.type === 'assistant') {
      const s = touch(o, stamped);
      const msg = o.message ?? {};
      const model = str(msg.model);
      if (!msg.usage || !model || model === '<synthetic>') continue;
      const usage = readClaudeUsage(msg.usage);
      if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) continue;
      const key = str(msg.id) ? `${msg.id}:${o.requestId ?? ''}` : `uuid:${o.uuid ?? ts}`;
      const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
      let ids = toolIds.get(key);
      const tools: string[] = [];
      for (const b of blocks) {
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const id = str(b.id) ?? `${key}:${tools.length}`;
        if (!ids) toolIds.set(key, (ids = new Set()));
        if (ids.has(id)) continue;
        ids.add(id);
        tools.push(b.name);
      }
      const existing = events.get(key);
      if (existing) {
        if (usage.output > existing.output) Object.assign(existing, usage);
        if (tools.length) existing.tools = [...(existing.tools ?? []), ...tools];
        continue;
      }
      events.set(key, {
        key,
        ts,
        source: 'claude-code',
        model,
        projectKey: s.projectKey,
        sessionKey: s.key,
        ...usage,
        requests: 1,
        sidechain: o.isSidechain === true || fileIsSubagent,
        tools: tools.length ? tools : undefined,
      });
    } else if (o.type === 'ai-title') {
      const s = touch(o, stamped);
      const t = str(o.aiTitle);
      if (t && s.titleRank <= 3) {
        s.title = clampText(t);
        s.titleRank = 3;
      }
    } else if (o.type === 'last-prompt') {
      const id = str(o.sessionId) ?? stem;
      const s = sessions.get(id);
      const t = str(o.lastPrompt);
      if (s && t && s.titleRank < 1) {
        s.title = clampText(t);
        s.titleRank = 0.5;
      }
    } else if (o.type === 'user') {
      if (o.isMeta || o.isSidechain) continue;
      const text = promptText(o.message?.content);
      const s = touch(o, stamped);
      if (!text) continue;
      s.promptIds.add(str(o.uuid) ?? `${ts}`);
      if (s.titleRank < 1) {
        s.title = clampText(text);
        s.titleRank = 1;
      }
    }
  }

  // The file's mtime tells us when this session was last written to. Credit it
  // to the session with the newest activity (older sessions can appear in a
  // file when a conversation is resumed).
  let newest: SessionMeta | undefined;
  for (const s of sessions.values()) if (!newest || s.lastTs > newest.lastTs) newest = s;
  for (const s of sessions.values()) s.lastWrite = s === newest ? Math.max(file.mtimeMs, s.lastTs) : s.lastTs;

  return { events: [...events.values()], sessions: [...sessions.values()] };
}

/** Merge per-file results: de-duplicate responses across files and fold sessions together. */
export function buildClaudeSnapshot(results: ClaudeFileResult[]): SourceSnapshot {
  const byKey = new Map<string, RawEvent>();
  const events: RawEvent[] = [];
  const sessions = new Map<string, SessionMeta>();
  for (const result of results) {
    for (const e of result.events) {
      const prev = byKey.get(e.key);
      if (!prev) {
        const copy = { ...e };
        byKey.set(e.key, copy);
        events.push(copy);
      } else if (e.output > prev.output || (e.tools?.length ?? 0) > (prev.tools?.length ?? 0)) {
        Object.assign(prev, { ...e, ts: Math.min(prev.ts, e.ts) });
      }
    }
    for (const s of result.sessions) {
      const prev = sessions.get(s.key);
      if (prev) mergeSession(prev, s);
      else sessions.set(s.key, cloneSession(s));
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const projects = new Map<string, ProjectHint>();
  const ensure = (key: string) => {
    let p = projects.get(key);
    if (!p && key.startsWith('dir:')) {
      const folder = key.slice(4);
      p = { key, kind: 'folder', name: folderName(folder), path: displayPath(folder), branches: new Set() };
      projects.set(key, p);
    }
    return p;
  };
  for (const s of sessions.values()) {
    const p = ensure(s.projectKey);
    if (p && s.branch) p.branches!.add(s.branch);
  }
  for (const e of events) ensure(e.projectKey);
  return { events, sessions, projects };
}
