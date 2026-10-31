import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDataset, prettyModel } from '../core/aggregate';
import { importBytes, ImportError } from '../core/importer';
import { deserializeSnapshot, serializeSnapshot } from '../core/model';
import { parseChatGPTExport } from '../core/parsers/chatgpt';
import { CLAUDE_CHAT_MODEL, parseClaudeAiExport } from '../core/parsers/claudeAi';
import { chatModelAlias, Pricing } from '../core/pricing';
import { estimateTokens } from '../core/tokens';

const t0 = Date.parse('2026-10-20T09:00:00Z') / 1000;

/** A ChatGPT conversation: hidden custom instructions, two turns and a regenerated answer. */
const chatgptExport = [
  {
    title: 'Explain backpropagation',
    create_time: t0,
    update_time: t0 + 600,
    conversation_id: 'conv-1',
    default_model_slug: 'gpt-5-5',
    gizmo_id: null,
    current_node: 'a2',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['sys'] },
      sys: {
        id: 'sys',
        parent: 'root',
        children: ['u1'],
        message: {
          id: 'sys',
          author: { role: 'user' },
          create_time: t0,
          content: { content_type: 'user_editable_context', user_profile: 'x'.repeat(400), user_instructions: '' },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
      u1: {
        id: 'u1',
        parent: 'sys',
        children: ['a1', 'a1b'],
        message: { id: 'u1', author: { role: 'user' }, create_time: t0 + 10, content: { content_type: 'text', parts: ['y'.repeat(400)] }, metadata: {} },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: ['u2'],
        message: {
          id: 'a1',
          author: { role: 'assistant' },
          create_time: t0 + 20,
          content: { content_type: 'text', parts: ['z'.repeat(800)] },
          metadata: { model_slug: 'gpt-5-5-thinking' },
          recipient: 'all',
        },
      },
      // A regenerated answer: another request with the same prompt.
      a1b: {
        id: 'a1b',
        parent: 'u1',
        children: [],
        message: {
          id: 'a1b',
          author: { role: 'assistant' },
          create_time: t0 + 30,
          content: { content_type: 'text', parts: ['w'.repeat(400)] },
          metadata: { model_slug: 'gpt-5-5' },
        },
      },
      u2: {
        id: 'u2',
        parent: 'a1',
        children: ['a2'],
        message: { id: 'u2', author: { role: 'user' }, create_time: t0 + 300, content: { content_type: 'text', parts: ['q'.repeat(200)] }, metadata: {} },
      },
      a2: {
        id: 'a2',
        parent: 'u2',
        children: [],
        message: {
          id: 'a2',
          author: { role: 'assistant' },
          create_time: t0 + 310,
          content: { content_type: 'text', parts: ['r'.repeat(1200)] },
          metadata: { model_slug: 'gpt-5-5' },
          recipient: 'python',
        },
      },
    },
  },
  {
    title: 'Lecture plan',
    create_time: t0 + 86_400,
    conversation_id: 'conv-2',
    gizmo_id: 'g-p-67abcdef12',
    gizmo_type: 'snorlax',
    mapping: {
      u: { id: 'u', parent: null, children: ['a'], message: { id: 'u', author: { role: 'user' }, create_time: t0 + 86_400, content: { content_type: 'text', parts: ['plan'] } } },
      a: {
        id: 'a',
        parent: 'u',
        children: [],
        message: { id: 'a', author: { role: 'assistant' }, create_time: t0 + 86_410, content: { content_type: 'text', parts: ['week one'] }, metadata: { model_slug: 'gpt-4o' } },
      },
    },
  },
];

const claudeExport = [
  {
    uuid: 'c-1',
    name: 'Tighten the abstract',
    created_at: '2026-10-21T10:00:00.000Z',
    updated_at: '2026-10-21T10:10:00.000Z',
    project_uuid: 'p-1',
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        created_at: '2026-10-21T10:00:00.000Z',
        text: 'a'.repeat(400),
        content: [{ type: 'text', text: 'a'.repeat(400) }],
        attachments: [{ file_name: 'draft.txt', extracted_content: 'b'.repeat(800) }],
        files: [],
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        created_at: '2026-10-21T10:00:20.000Z',
        content: [
          { type: 'thinking', thinking: 'c'.repeat(200) },
          { type: 'tool_use', name: 'web_search', input: { query: 'abstract tips' } },
          { type: 'tool_result', content: [{ type: 'text', text: 'd'.repeat(400) }] },
          { type: 'text', text: 'e'.repeat(600) },
        ],
      },
      { uuid: 'm3', sender: 'human', created_at: '2026-10-21T10:05:00.000Z', text: 'shorter please', content: [] },
      { uuid: 'm4', sender: 'assistant', created_at: '2026-10-21T10:05:10.000Z', text: 'f'.repeat(300), content: [] },
    ],
  },
];
const claudeProjects = [{ uuid: 'p-1', name: 'Paper revisions', docs: [] }];

describe('token estimates', () => {
  it('counts about four characters per token, one per CJK character', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('ChatGPT export', () => {
  const snap = parseChatGPTExport(chatgptExport);

  it('turns every assistant message into a request with growing context', () => {
    const conv1 = snap.events.filter((e) => e.sessionKey === 'chatgpt:conv-1');
    expect(conv1.map((e) => e.key)).toEqual(['chatgpt:a1', 'chatgpt:a1b', 'chatgpt:a2']);
    const [a1, a1b, a2] = conv1;
    // instructions (401 characters -> 101) + first prompt (100) are new input for the first answer
    expect(a1).toMatchObject({ input: 201, cacheRead: 0, output: 200, model: 'gpt-5-5-thinking', estimated: true });
    // the regenerated answer reads the same prompt again
    expect(a1b).toMatchObject({ input: 201, cacheRead: 0, output: 100 });
    // the second answer re-reads the earlier turn from cache and adds the new prompt
    expect(a2).toMatchObject({ input: 50, cacheRead: 401, output: 300, tools: ['python'] });
  });

  it('builds sessions and projects', () => {
    const s = snap.sessions.get('chatgpt:conv-1')!;
    expect(s.title).toBe('Explain backpropagation');
    expect(s.promptIds.size).toBe(2); // hidden instructions are not prompts
    expect(s.projectKey).toBe('chatgpt:chats');
    const p = snap.projects.get('chatgpt:project:g-p-67abcdef12')!;
    expect(p).toMatchObject({ kind: 'chat-project', provider: 'openai' });
    expect(p.name).toMatch(/^ChatGPT project /);
  });

  it('maps ChatGPT model slugs to priced API models', () => {
    expect(chatModelAlias('gpt-5-5-thinking')).toBe('gpt-5.5-thinking');
    expect(chatModelAlias('text-davinci-002-render-sha')).toBe('gpt-3.5-turbo');
    expect(chatModelAlias('gpt-4-0613')).toBe('gpt-4-0613');
    const pricing = new Pricing();
    expect(pricing.resolve('gpt-5-5-thinking')).toBe('gpt-5.5');
    expect(prettyModel('gpt-5-5-thinking')).toBe('GPT-5.5 Thinking');
    expect(prettyModel('gpt-4o')).toBe('GPT-4o');
  });
});

describe('claude.ai export', () => {
  const snap = parseClaudeAiExport(claudeExport, claudeProjects);

  it('estimates each reply, counting attachments and tool results as input', () => {
    const [r1, r2] = snap.events;
    expect(r1).toMatchObject({
      model: CLAUDE_CHAT_MODEL,
      input: 100 + 200 + 100, // prompt + attachment + web search result
      cacheRead: 0,
      output: 50 + 7 + 150, // thinking + tool call input (25 characters) + answer
      reasoning: 50,
      tools: ['web_search'],
    });
    expect(r2.cacheRead).toBe(r1.input + r1.output);
    expect(r2.input).toBe(4);
    expect(r2.output).toBe(75);
  });

  it('names projects from projects.json', () => {
    expect(snap.projects.get('claude-ai:project:p-1')?.name).toBe('Paper revisions');
    const s = snap.sessions.get('claude-ai:c-1')!;
    expect(s.title).toBe('Tighten the abstract');
    expect(s.promptIds.size).toBe(2);
  });

  it('shows the unknown model as Claude chat without a price', () => {
    expect(prettyModel(CLAUDE_CHAT_MODEL)).toBe('Claude chat');
    expect(new Pricing().resolve(CLAUDE_CHAT_MODEL)).toBeUndefined();
  });
});

describe('importBytes', () => {
  it('reads a ChatGPT export zip', async () => {
    const zip = zipSync({
      'conversations.json': strToU8(JSON.stringify(chatgptExport)),
      'chat.html': strToU8('<html></html>'),
      'user.json': strToU8('{}'),
    });
    const [r] = await importBytes('chatgpt-export.zip', zip);
    expect(r.source).toBe('chatgpt');
    expect(r.summary.conversations).toBe(2);
    expect(r.summary.replies).toBe(4);
  });

  it('reads a claude.ai export zip with projects', async () => {
    const zip = zipSync({
      'conversations.json': strToU8(JSON.stringify(claudeExport)),
      'projects.json': strToU8(JSON.stringify(claudeProjects)),
    });
    const [r] = await importBytes('data-2026.zip', zip);
    expect(r.source).toBe('claude-ai');
    expect(r.snapshot.projects.get('claude-ai:project:p-1')?.name).toBe('Paper revisions');
  });

  it('reads a bare conversations.json', async () => {
    const [r] = await importBytes('conversations.json', strToU8(JSON.stringify(claudeExport)));
    expect(r.source).toBe('claude-ai');
  });

  it('reads Claude Code session files', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's-1',
      cwd: '/Users/me/code/app',
      timestamp: '2026-10-22T08:00:00Z',
      requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 1000 } },
    });
    const [r] = await importBytes('s-1.jsonl', strToU8(`${line}\n${line}\n`));
    expect(r.source).toBe('claude-code');
    expect(r.snapshot.events).toHaveLength(1);
    expect(r.snapshot.projects.get('dir:/Users/me/code/app')?.path).toBe('~/code/app');
  });

  it('explains what went wrong with an unrelated file', async () => {
    await expect(importBytes('notes.json', strToU8('{"hello": "world"}'))).rejects.toBeInstanceOf(ImportError);
    await expect(importBytes('photos.zip', zipSync({ 'a.png': new Uint8Array([1, 2, 3]) }))).rejects.toThrow(/no conversations.json/);
  });

  it('survives a save/load round trip and feeds the dataset', async () => {
    const [r] = await importBytes('conversations.json', strToU8(JSON.stringify(chatgptExport)));
    const restored = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(r.snapshot))));
    const { dataset } = buildDataset({ snapshots: [restored], pricing: new Pricing(), statuses: [], demo: false, version: 1 });
    expect(dataset.sessions).toHaveLength(2);
    expect(dataset.sessions.find((s) => s.key === 'chatgpt:conv-1')?.prompts).toBe(2);
    expect(dataset.models.map((m) => m.label)).toContain('GPT-5.5 Thinking');
    expect(dataset.facts.reduce((s, f) => s + f[11], 0)).toBeGreaterThan(0);
  });
});
