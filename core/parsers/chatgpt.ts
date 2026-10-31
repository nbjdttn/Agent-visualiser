import { newSessionMeta, type ProjectHint, type RawEvent, type SessionMeta, type SourceSnapshot } from '../model';
import { estimateTokens, IMAGE_TOKENS } from '../tokens';
import { clampText, parseTs, str } from '../util';

/**
 * ChatGPT data export (Settings > Data controls > Export data): the
 * conversations.json inside the zip. Each conversation is a tree of messages
 * (`mapping`); every assistant message records the model that wrote it.
 *
 * The export has no token counts, so they are estimated from text length. Each
 * assistant reply is one model request whose prompt is everything before it in
 * its branch: the part already seen by the previous reply counts as a cache
 * read, the rest as new input, and the reply itself as output.
 */

interface Content {
  tokens: number;
  reasoning: boolean;
  /** Context the user never sees in the chat (custom instructions, memory). */
  hidden: boolean;
}

function partTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTokens(part);
  if (part && typeof part === 'object') {
    const p = part as Record<string, unknown>;
    if (typeof p.text === 'string') return estimateTokens(p.text);
    if (p.content_type === 'image_asset_pointer' || typeof p.asset_pointer === 'string') return IMAGE_TOKENS;
  }
  return 0;
}

function readContent(content: any): Content {
  const none = { tokens: 0, reasoning: false, hidden: false };
  if (!content || typeof content !== 'object') return none;
  const type = content.content_type;
  if (type === 'user_editable_context') {
    return { tokens: estimateTokens(`${content.user_profile ?? ''}\n${content.user_instructions ?? ''}`), reasoning: false, hidden: true };
  }
  if (type === 'model_editable_context') {
    return { tokens: estimateTokens(content.model_set_context ?? ''), reasoning: false, hidden: true };
  }
  if (type === 'thoughts' && Array.isArray(content.thoughts)) {
    const text = content.thoughts.map((t: any) => `${t?.summary ?? ''} ${t?.content ?? ''}`).join('\n');
    return { tokens: estimateTokens(text), reasoning: true, hidden: false };
  }
  if (type === 'reasoning_recap') return { tokens: estimateTokens(content.content ?? ''), reasoning: true, hidden: false };
  if (Array.isArray(content.parts)) {
    return { tokens: content.parts.reduce((s: number, p: unknown) => s + partTokens(p), 0), reasoning: false, hidden: false };
  }
  if (typeof content.text === 'string') return { tokens: estimateTokens(content.text), reasoning: false, hidden: false };
  if (typeof content.result === 'string') return { tokens: estimateTokens(content.result), reasoning: false, hidden: false };
  return none;
}

export function looksLikeChatGPTExport(json: unknown): boolean {
  return Array.isArray(json) && json.some((c) => c && typeof c === 'object' && 'mapping' in c);
}

const short = (id: string) => id.replace(/^g-(p-)?/, '').slice(0, 6);

export function parseChatGPTExport(json: unknown): SourceSnapshot {
  const convs: any[] = Array.isArray(json) ? json : [];
  const events: RawEvent[] = [];
  const sessions = new Map<string, SessionMeta>();
  const projects = new Map<string, ProjectHint>();

  const projectFor = (conv: any): string => {
    const gizmo = str(conv.gizmo_id) ?? (str(conv.conversation_template_id)?.startsWith('g-') ? conv.conversation_template_id : undefined);
    let key = 'chatgpt:chats';
    let hint: ProjectHint = { key, kind: 'chats', name: 'ChatGPT chats', provider: 'openai' };
    if (gizmo) {
      const isProject = gizmo.startsWith('g-p-') || conv.gizmo_type === 'snorlax';
      key = `chatgpt:${isProject ? 'project' : 'gpt'}:${gizmo}`;
      const named = str(conv.project_title) ?? str(conv.project_name) ?? str(conv.gizmo_title) ?? str(conv.gizmo_name);
      hint = {
        key,
        kind: 'chat-project',
        name: named ?? (isProject ? `ChatGPT project ${short(gizmo)}` : `Custom GPT ${short(gizmo)}`),
        provider: 'openai',
      };
    }
    if (!projects.has(key)) projects.set(key, hint);
    return key;
  };

  convs.forEach((conv, index) => {
    if (!conv || typeof conv !== 'object' || !conv.mapping || typeof conv.mapping !== 'object') return;
    const id = str(conv.conversation_id) ?? str(conv.id) ?? `conversation-${index}`;
    const sessionKey = `chatgpt:${id}`;
    const projectKey = projectFor(conv);
    const created = parseTs(conv.create_time) ?? 0;
    const meta = newSessionMeta(sessionKey, id, 'chatgpt', projectKey, created || Date.now());
    meta.title = clampText(str(conv.title) ?? 'Untitled chat');
    meta.titleRank = 3;
    meta.entrypoint = 'chatgpt';

    const mapping = conv.mapping as Record<string, any>;
    const kids = new Map<string, string[]>();
    const roots: string[] = [];
    for (const [nodeId, node] of Object.entries(mapping)) {
      const parent = str(node?.parent);
      if (parent && mapping[parent]) {
        const list = kids.get(parent);
        if (list) list.push(nodeId);
        else kids.set(parent, [nodeId]);
      } else roots.push(nodeId);
    }

    // Walk every branch (regenerated answers cost tokens too), tracking the
    // context size and how much of it the previous reply had already read.
    const stack: { id: string; ctx: number; seen: number; lastTs: number }[] = roots.map((r) => ({ id: r, ctx: 0, seen: 0, lastTs: created }));
    let first = Infinity;
    let last = 0;
    while (stack.length) {
      const { id: nodeId, ctx, seen, lastTs } = stack.pop()!;
      const msg = mapping[nodeId]?.message;
      let nextCtx = ctx;
      let nextSeen = seen;
      let ts = lastTs;
      if (msg && typeof msg === 'object') {
        ts = parseTs(msg.create_time) ?? lastTs;
        if (ts) {
          first = Math.min(first, ts);
          last = Math.max(last, ts);
        }
        const role = msg.author?.role;
        const c = readContent(msg.content);
        if (role === 'assistant' && c.tokens > 0 && !c.hidden) {
          const recipient = str(msg.recipient);
          events.push({
            key: `chatgpt:${str(msg.id) ?? nodeId}`,
            ts: ts || created,
            source: 'chatgpt',
            model: str(msg.metadata?.model_slug) ?? str(conv.default_model_slug) ?? 'chatgpt',
            projectKey,
            sessionKey,
            input: Math.max(0, ctx - seen),
            output: c.tokens,
            cacheRead: seen,
            cacheWrite: 0,
            cacheWrite1h: 0,
            reasoning: c.reasoning ? c.tokens : 0,
            requests: 1,
            estimated: true,
            tools: recipient && recipient !== 'all' ? [recipient] : undefined,
          });
          nextCtx = ctx + c.tokens;
          nextSeen = nextCtx;
        } else {
          nextCtx = ctx + c.tokens;
          if (role === 'user' && !c.hidden && c.tokens > 0 && !msg.metadata?.is_visually_hidden_from_conversation) {
            meta.promptIds.add(str(msg.id) ?? nodeId);
          }
        }
      }
      for (const child of kids.get(nodeId) ?? []) stack.push({ id: child, ctx: nextCtx, seen: nextSeen, lastTs: ts });
    }

    if (Number.isFinite(first)) meta.firstTs = Math.min(first, created || first);
    meta.lastTs = last || Math.max(parseTs(conv.update_time) ?? 0, meta.firstTs);
    meta.lastWrite = meta.lastTs;
    sessions.set(sessionKey, meta);
  });

  events.sort((a, b) => a.ts - b.ts);
  return { events, sessions, projects };
}
