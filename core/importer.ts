import { unzipSync } from 'fflate';
import type { SourceId } from '../shared/types';
import type { SourceSnapshot } from './model';
import { looksLikeChatGPTExport, parseChatGPTExport } from './parsers/chatgpt';
import { buildClaudeSnapshot, looksLikeClaudeCodeLine, parseClaudeLines, type ClaudeFileResult } from './parsers/claudeCode';
import { looksLikeClaudeAiExport, parseClaudeAiExport } from './parsers/claudeAi';
import { buildCodexSnapshot, looksLikeCodexLine, parseCodexLines, type CodexFileResult } from './parsers/codex';

/**
 * Turns a file the user picked into usage data. Accepts:
 *  - the ChatGPT or claude.ai data export (.zip, or the conversations.json in it)
 *  - Claude Code or Codex session logs (.jsonl, or a .zip of them)
 * Runs in the browser (a Web Worker on the phone) and on the server.
 */

export interface ImportSummary {
  conversations: number;
  replies: number;
  tokens: number;
  from?: number;
  to?: number;
}

export interface ImportResult {
  source: SourceId;
  snapshot: SourceSnapshot;
  summary: ImportSummary;
}

export type Progress = (stage: string) => void;

export class ImportError extends Error {}

const isZip = (b: Uint8Array) => b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

function summarize(source: SourceId, snapshot: SourceSnapshot): ImportResult {
  let from = Infinity;
  let to = -Infinity;
  let tokens = 0;
  for (const e of snapshot.events) {
    from = Math.min(from, e.ts);
    to = Math.max(to, e.ts);
    tokens += e.input + e.output + e.cacheRead + e.cacheWrite;
  }
  return {
    source,
    snapshot,
    summary: {
      conversations: snapshot.sessions.size,
      replies: snapshot.events.length,
      tokens,
      from: Number.isFinite(from) ? from : undefined,
      to: Number.isFinite(to) ? to : undefined,
    },
  };
}

function firstLines(text: string, n = 20): string[] {
  const out: string[] = [];
  let start = 0;
  while (out.length < n && start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    if (line) out.push(line);
    start = end + 1;
  }
  return out;
}

export async function importBytes(fileName: string, bytes: Uint8Array, progress: Progress = () => {}): Promise<ImportResult[]> {
  const decoder = new TextDecoder();
  let files: { name: string; data: Uint8Array }[];
  if (isZip(bytes)) {
    progress('Opening the zip');
    const unzipped = unzipSync(bytes, {
      filter: (f) => /(^|\/)(conversations|projects)\.json$/i.test(f.name) || /\.jsonl$/i.test(f.name),
    });
    files = Object.entries(unzipped)
      .filter(([name]) => !name.startsWith('__MACOSX/'))
      .map(([name, data]) => ({ name, data }));
    if (!files.length) {
      throw new ImportError('That zip has no conversations.json or .jsonl session files. Pick the export zip from ChatGPT or claude.ai.');
    }
  } else {
    files = [{ name: fileName, data: bytes }];
  }

  const results: ImportResult[] = [];
  const projectsFile = files.find((f) => /(^|\/)projects\.json$/i.test(f.name));
  const claude: ClaudeFileResult[] = [];
  const codex: CodexFileResult[] = [];

  for (const f of files) {
    if (f === projectsFile) continue;
    const text = decoder.decode(f.data);
    const head = text.trimStart();
    const sample = firstLines(head);
    const jsonl = /\.jsonl$/i.test(f.name) || (head.startsWith('{') && sample.length > 1 && sample[1].startsWith('{'));
    if (jsonl) {
      const lines = text.split(/\r?\n/);
      const parts = f.name.split('/');
      const info = { path: f.name, mtimeMs: Date.now(), projectDirName: parts.length > 1 ? parts[parts.length - 2] : '' };
      if (sample.some(looksLikeCodexLine)) {
        progress('Reading Codex sessions');
        codex.push(await parseCodexLines(lines, info));
      } else if (sample.some(looksLikeClaudeCodeLine)) {
        progress('Reading Claude Code sessions');
        claude.push(await parseClaudeLines(lines, info));
      }
      continue;
    }
    progress('Reading your conversations');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ImportError(`${f.name} isn't valid JSON. Pick the export zip as it was downloaded.`);
    }
    if (looksLikeChatGPTExport(json)) {
      progress('Estimating ChatGPT tokens');
      results.push(summarize('chatgpt', parseChatGPTExport(json)));
    } else if (looksLikeClaudeAiExport(json)) {
      progress('Estimating Claude tokens');
      const projects = projectsFile ? JSON.parse(decoder.decode(projectsFile.data)) : undefined;
      results.push(summarize('claude-ai', parseClaudeAiExport(json, projects)));
    } else if (Array.isArray(json) && json.length === 0) {
      throw new ImportError('That export has no conversations in it.');
    } else {
      throw new ImportError(`${f.name} doesn't look like a ChatGPT or claude.ai export.`);
    }
  }

  if (claude.length) results.push(summarize('claude-code', buildClaudeSnapshot(claude)));
  if (codex.length) results.push(summarize('codex', buildCodexSnapshot(codex)));
  if (!results.length) {
    throw new ImportError('Nothing usable in that file. Pick the ChatGPT or claude.ai export zip, or Claude Code / Codex .jsonl session files.');
  }
  return results;
}
