import path from 'node:path';
import type { SourceStatus } from '../../shared/types.js';
import { FileCache, dirExists, readLines, walkFiles, type FileStat } from './files.js';
import {
  cloneSession,
  mergeSession,
  newSessionMeta,
  type ProjectHint,
  type RawEvent,
  type SessionMeta,
  type SourceSnapshot,
} from '../model.js';
import {
  clampText,
  decodeClaudeProjectDir,
  displayPath,
  folderName,
  homeJoin,
  normalizeFolder,
  num,
  parseTs,
  str,
} from '../util.js';

/**
 * Reads Claude Code's local transcripts: <config>/projects/<project>/<session>.jsonl
 * (plus sub-agent transcripts in the same tree). Each assistant line carries
 * the API usage for one response; a response split over several lines
 * shares a message id, so lines are de-duplicated on message id + request id.
 */

export interface ClaudeFileResult {
  events: RawEvent[];
  sessions: SessionMeta[];
}

export function claudeProjectRoots(configDirEnv?: string): string[] {
  const roots: string[] = [];
  if (configDirEnv && configDirEnv.trim()) {
    for (const dir of configDirEnv.split(',').map((d) => d.trim()).filter(Boolean)) {
      const expanded = dir.startsWith('~') ? homeJoin(dir.slice(1)) : dir;
      roots.push(path.join(expanded, 'projects'));
    }
  } else {
    roots.push(homeJoin('.config', 'claude', 'projects'), homeJoin('.claude', 'projects'));
  }
  return [...new Set(roots.map((r) => path.resolve(r)))];
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
  if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return undefined;
  return t;
}

export async function parseClaudeFile(file: FileStat, projectDirName: string): Promise<ClaudeFileResult> {
  const stem = path.basename(file.path, '.jsonl');
  const fileIsSubagent = /[\\/]subagents[\\/]/.test(file.path) || stem.startsWith('agent-');
  const fallbackFolder = normalizeFolder(decodeClaudeProjectDir(projectDirName));
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

  for await (const line of readLines(file.path)) {
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

export class ClaudeCodeSource {
  private cache = new FileCache<ClaudeFileResult>();
  private dirNames = new Map<string, string>();
  private memo?: SourceSnapshot;
  private files = 0;
  private scannedAt?: number;
  private error?: string;

  constructor(readonly roots: string[]) {}

  /** Re-scan the transcript folders. Returns true when anything changed. */
  async scan(): Promise<boolean> {
    try {
      const all: FileStat[] = [];
      for (const root of this.roots) {
        if (!dirExists(root)) continue;
        const files = await walkFiles(root, (name) => name.endsWith('.jsonl'));
        for (const f of files) {
          this.dirNames.set(f.path, path.relative(root, f.path).split(path.sep)[0] ?? '');
          all.push(f);
        }
      }
      this.files = all.length;
      const { changed } = await this.cache.sync(all, (f) => parseClaudeFile(f, this.dirNames.get(f.path) ?? ''));
      this.scannedAt = Date.now();
      this.error = undefined;
      if (changed) this.memo = undefined;
      return changed;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  snapshot(): SourceSnapshot {
    if (this.memo) return this.memo;
    const byKey = new Map<string, RawEvent>();
    const events: RawEvent[] = [];
    const sessions = new Map<string, SessionMeta>();
    for (const { result } of this.cache.results()) {
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
    for (const s of sessions.values()) {
      if (!s.projectKey.startsWith('dir:')) continue;
      const folder = s.projectKey.slice(4);
      let p = projects.get(s.projectKey);
      if (!p) {
        p = { key: s.projectKey, kind: 'folder', name: folderName(folder), path: displayPath(folder), branches: new Set() };
        projects.set(s.projectKey, p);
      }
      if (s.branch) p.branches!.add(s.branch);
    }
    for (const e of events) {
      if (!projects.has(e.projectKey) && e.projectKey.startsWith('dir:')) {
        const folder = e.projectKey.slice(4);
        projects.set(e.projectKey, { key: e.projectKey, kind: 'folder', name: folderName(folder), path: displayPath(folder) });
      }
    }
    this.memo = { events, sessions, projects };
    return this.memo;
  }

  status(): SourceStatus {
    const snap = this.snapshot();
    const found = this.roots.filter(dirExists);
    const sessions = snap.sessions.size;
    return {
      id: 'claude-code',
      label: 'Claude Code',
      provider: 'anthropic',
      kind: 'agent',
      connected: snap.events.length > 0,
      summary: found.length
        ? `${sessions.toLocaleString('en-US')} sessions in ${this.files.toLocaleString('en-US')} log files`
        : 'No Claude Code logs found',
      paths: this.roots.map(displayPath),
      files: this.files,
      events: snap.events.length,
      lastEventAt: snap.events.at(-1)?.ts,
      updatedAt: this.scannedAt,
      error: this.error,
      hint: found.length
        ? undefined
        : 'Looked in ~/.config/claude/projects and ~/.claude/projects. Set CLAUDE_CONFIG_DIR if your Claude Code config lives elsewhere.',
    };
  }
}
