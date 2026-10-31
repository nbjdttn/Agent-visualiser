import fs from 'node:fs';
import path from 'node:path';
import type { SourceStatus } from '../../shared/types.js';
import type { SourceSnapshot } from '../../core/model.js';
import { buildCodexSnapshot, parseCodexLines, type CodexFileResult } from '../../core/parsers/codex.js';
import { displayPath } from '../../core/util.js';
import { expandHome, homeJoin } from '../util.js';
import { FileCache, dirExists, readLines, walkFiles, type FileStat } from './files.js';

export { cleanRepoUrl, codexUsage } from '../../core/parsers/codex.js';

/** Where Codex keeps rollouts: $CODEX_HOME (default ~/.codex) sessions/ and archived_sessions/. */
export function codexRoots(codexHomeEnv?: string): string[] {
  const home = codexHomeEnv?.trim() ? expandHome(codexHomeEnv.trim()) : homeJoin('.codex');
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')].map((p) => path.resolve(p));
}

/** Scans Codex rollouts (plain or .zst) on this machine, re-parsing only files that changed. */
export class CodexSource {
  private cache = new FileCache<CodexFileResult>();
  private memo?: SourceSnapshot;
  private files = 0;
  private scannedAt?: number;
  private error?: string;

  constructor(readonly roots: string[]) {}

  async scan(): Promise<boolean> {
    try {
      const all: FileStat[] = [];
      for (const root of this.roots) {
        if (!dirExists(root)) continue;
        const files = await walkFiles(root, (n) => n.endsWith('.jsonl') || n.endsWith('.jsonl.zst'));
        for (const f of files) {
          // While Codex compresses a file both copies can exist briefly; read the plain one.
          if (f.path.endsWith('.zst') && fs.existsSync(f.path.slice(0, -4))) continue;
          all.push(f);
        }
      }
      this.files = all.length;
      const { changed } = await this.cache.sync(all, (f) => parseCodexLines(readLines(f.path), { path: f.path, mtimeMs: f.mtimeMs }));
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
    this.memo ??= buildCodexSnapshot(this.cache.results().map((r) => r.result));
    return this.memo;
  }

  status(): SourceStatus {
    const snap = this.snapshot();
    const found = this.roots.filter(dirExists);
    return {
      id: 'codex',
      label: 'Codex CLI',
      provider: 'openai',
      kind: 'agent',
      connected: snap.events.length > 0,
      summary: found.length
        ? `${snap.sessions.size.toLocaleString('en-US')} sessions in ${this.files.toLocaleString('en-US')} rollout files`
        : 'No Codex logs found',
      paths: this.roots.map(displayPath),
      files: this.files,
      events: snap.events.length,
      lastEventAt: snap.events.at(-1)?.ts,
      updatedAt: this.scannedAt,
      error: this.error,
      hint: found.length ? undefined : 'Looked in ~/.codex/sessions. Set CODEX_HOME if Codex keeps its data elsewhere.',
    };
  }
}
