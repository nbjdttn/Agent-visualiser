import path from 'node:path';
import type { SourceStatus } from '../../shared/types.js';
import type { SourceSnapshot } from '../../core/model.js';
import { buildClaudeSnapshot, parseClaudeLines, type ClaudeFileResult } from '../../core/parsers/claudeCode.js';
import { displayPath } from '../../core/util.js';
import { expandHome, homeJoin } from '../util.js';
import { FileCache, dirExists, readLines, walkFiles, type FileStat } from './files.js';

export { readClaudeUsage } from '../../core/parsers/claudeCode.js';

/** Where Claude Code keeps transcripts: $CLAUDE_CONFIG_DIR, or ~/.config/claude and ~/.claude. */
export function claudeProjectRoots(configDirEnv?: string): string[] {
  const roots: string[] = [];
  if (configDirEnv && configDirEnv.trim()) {
    for (const dir of configDirEnv.split(',').map((d) => d.trim()).filter(Boolean)) {
      roots.push(path.join(expandHome(dir), 'projects'));
    }
  } else {
    roots.push(homeJoin('.config', 'claude', 'projects'), homeJoin('.claude', 'projects'));
  }
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

/** Scans Claude Code transcripts on this machine, re-parsing only files that changed. */
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
      const { changed } = await this.cache.sync(all, (f) =>
        parseClaudeLines(readLines(f.path), { path: f.path, mtimeMs: f.mtimeMs, projectDirName: this.dirNames.get(f.path) ?? '' }),
      );
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
    this.memo ??= buildClaudeSnapshot(this.cache.results().map((r) => r.result));
    return this.memo;
  }

  status(): SourceStatus {
    const snap = this.snapshot();
    const found = this.roots.filter(dirExists);
    return {
      id: 'claude-code',
      label: 'Claude Code',
      provider: 'anthropic',
      kind: 'agent',
      connected: snap.events.length > 0,
      summary: found.length
        ? `${snap.sessions.size.toLocaleString('en-US')} sessions in ${this.files.toLocaleString('en-US')} log files`
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
