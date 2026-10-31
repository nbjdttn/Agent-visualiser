import { newSessionMeta, type ProjectHint, type RawEvent, type SessionMeta, type SourceSnapshot } from '../model';
import { estimateTokens, IMAGE_TOKENS } from '../tokens';
import { clampText, parseTs, str } from '../util';

/**
 * claude.ai data export (Settings > Privacy > Export data): conversations.json
 * and projects.json inside the zip. Messages are listed in order, as human or
 * assistant turns; newer exports link edited branches with
 * parent_message_uuid.
 *
 * The export has no token counts and usually no model name, so tokens are
 * estimated from text and the model shows as "Claude chat" (no cost estimate).
 */

export const CLAUDE_CHAT_MODEL = 'claude-chat';

export function looksLikeClaudeAiExport(json: unknown): boolean {
  return Array.isArray(json) && json.some((c) => c && typeof c === 'object' && 'chat_messages' in c);
}

interface MessageTokens {
  /** Text the model wrote, including thinking and tool calls. */
  output: number;
  reasoning: number;
  /** Text the model read inside its own turn (tool results such as web search). */
  toolContext: number;
  /** Everything in a human turn, including attachments. */
  human: number;
  tools: string[];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if ('content' in v) return textOf(v.content);
  }
  return '';
}

function measure(m: any): MessageTokens {
  const out: MessageTokens = { output: 0, reasoning: 0, toolContext: 0, human: 0, tools: [] };
  const blocks: any[] = Array.isArray(m.content) ? m.content : [];
  let body = 0;
  if (blocks.length) {
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') body += estimateTokens(b.text);
      else if (b.type === 'thinking') {
        const t = estimateTokens(b.thinking ?? b.text);
        body += t;
        out.reasoning += t;
      } else if (b.type === 'tool_use') {
        body += estimateTokens(JSON.stringify(b.input ?? {}));
        if (typeof b.name === 'string') out.tools.push(b.name);
      } else if (b.type === 'tool_result') out.toolContext += estimateTokens(textOf(b.content));
      else if (b.type === 'image') body += IMAGE_TOKENS;
    }
  } else body = estimateTokens(m.text);

  let attached = 0;
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    attached += a?.extracted_content ? estimateTokens(a.extracted_content) : IMAGE_TOKENS;
  }
  for (const f of Array.isArray(m.files) ? m.files : []) if (f) attached += IMAGE_TOKENS;

  if (m.sender === 'assistant') out.output = body;
  else out.human = body + attached;
  return out;
}

export function parseClaudeAiExport(json: unknown, projectsJson?: unknown): SourceSnapshot {
  const convs: any[] = Array.isArray(json) ? json : [];
  const projectNames = new Map<string, string>();
  for (const p of Array.isArray(projectsJson) ? projectsJson : []) {
    if (p && typeof p.uuid === 'string') projectNames.set(p.uuid, str(p.name) ?? 'Claude project');
  }
  const events: RawEvent[] = [];
  const sessions = new Map<string, SessionMeta>();
  const projects = new Map<string, ProjectHint>();

  const projectFor = (conv: any): string => {
    const uuid = str(conv.project_uuid) ?? str(conv.project?.uuid);
    if (!uuid) {
      if (!projects.has('claude-ai:chats')) {
        projects.set('claude-ai:chats', { key: 'claude-ai:chats', kind: 'chats', name: 'claude.ai chats', provider: 'anthropic' });
      }
      return 'claude-ai:chats';
    }
    const key = `claude-ai:project:${uuid}`;
    if (!projects.has(key)) {
      const name = projectNames.get(uuid) ?? str(conv.project?.name) ?? `Claude project ${uuid.slice(0, 6)}`;
      projects.set(key, { key, kind: 'chat-project', name, provider: 'anthropic' });
    }
    return key;
  };

  convs.forEach((conv, index) => {
    if (!conv || typeof conv !== 'object' || !Array.isArray(conv.chat_messages)) return;
    const id = str(conv.uuid) ?? `conversation-${index}`;
    const sessionKey = `claude-ai:${id}`;
    const projectKey = projectFor(conv);
    const created = parseTs(conv.created_at) ?? 0;
    const meta = newSessionMeta(sessionKey, id, 'claude-ai', projectKey, created || Date.now());
    meta.title = clampText(str(conv.name) ?? 'Untitled chat');
    meta.titleRank = 3;
    meta.entrypoint = 'claude.ai';
    const convModel = str(conv.model) ?? str(conv.settings?.model);

    const messages: any[] = conv.chat_messages.filter((m: any) => m && typeof m === 'object');
    const byId = new Map<string, any>(messages.filter((m) => typeof m.uuid === 'string').map((m) => [m.uuid, m]));
    const branched = messages.some((m) => str(m.parent_message_uuid) && byId.has(m.parent_message_uuid));
    // Context state after each message: total prompt size and the part the last reply had read.
    const state = new Map<string, { ctx: number; seen: number }>();
    let linear = { ctx: 0, seen: 0 };
    let first = Infinity;
    let last = 0;

    messages.forEach((m, i) => {
      const parent = branched ? state.get(m.parent_message_uuid) : linear;
      const before = parent ?? { ctx: 0, seen: 0 };
      const ts = parseTs(m.created_at) ?? created;
      if (ts) {
        first = Math.min(first, ts);
        last = Math.max(last, ts);
      }
      const t = measure(m);
      let after: { ctx: number; seen: number };
      if (m.sender === 'assistant') {
        if (t.output > 0) {
          events.push({
            key: `claude-ai:${str(m.uuid) ?? `${id}:${i}`}`,
            ts: ts || created,
            source: 'claude-ai',
            model: str(m.model) ?? convModel ?? CLAUDE_CHAT_MODEL,
            projectKey,
            sessionKey,
            input: Math.max(0, before.ctx - before.seen) + t.toolContext,
            output: t.output,
            cacheRead: before.seen,
            cacheWrite: 0,
            cacheWrite1h: 0,
            reasoning: Math.min(t.reasoning, t.output),
            requests: 1,
            estimated: true,
            tools: t.tools.length ? t.tools : undefined,
          });
        }
        const ctx = before.ctx + t.toolContext + t.output;
        after = { ctx, seen: ctx };
      } else {
        after = { ctx: before.ctx + t.human, seen: before.seen };
        if (t.human > 0) meta.promptIds.add(str(m.uuid) ?? `${id}:${i}`);
      }
      if (branched && typeof m.uuid === 'string') state.set(m.uuid, after);
      linear = after;
    });

    if (Number.isFinite(first)) meta.firstTs = Math.min(first, created || first);
    meta.lastTs = last || Math.max(parseTs(conv.updated_at) ?? 0, meta.firstTs);
    meta.lastWrite = meta.lastTs;
    sessions.set(sessionKey, meta);
  });

  events.sort((a, b) => a.ts - b.ts);
  return { events, sessions, projects };
}
