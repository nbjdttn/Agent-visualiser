import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

export interface FileStat {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Recursively list files under root that pass `accept`. Missing or unreadable dirs are skipped. */
export async function walkFiles(root: string, accept: (name: string) => boolean, maxDepth = 6): Promise<FileStat[]> {
  const out: FileStat[] = [];
  async function walk(dir: string, depth: number) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth && !entry.name.startsWith('.')) await walk(full, depth + 1);
        } else if (entry.isFile() && accept(entry.name)) {
          try {
            const st = await fsp.stat(full);
            out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // file vanished between readdir and stat
          }
        }
      }),
    );
  }
  await walk(root, 0);
  return out;
}

export function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

type ZstdZlib = typeof zlib & { createZstdDecompress?: () => NodeJS.ReadWriteStream };

/**
 * Yield the lines of a text file. Handles plain files and `.zst` files
 * (Codex compresses older sessions), using Node's built-in zstd when present
 * and a pure-JS decoder otherwise.
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  let input: Readable;
  if (file.endsWith('.zst')) {
    const z = zlib as ZstdZlib;
    if (typeof z.createZstdDecompress === 'function') {
      input = fs.createReadStream(file).pipe(z.createZstdDecompress()) as unknown as Readable;
    } else {
      const { decompress } = await import('fzstd');
      const bytes = decompress(new Uint8Array(await fsp.readFile(file)));
      input = Readable.from([Buffer.from(bytes)]);
    }
  } else {
    input = fs.createReadStream(file);
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length > 0) yield line;
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

/**
 * Keeps parse results per file and re-parses only files whose size or
 * modification time changed since the last scan.
 */
export class FileCache<R> {
  private entries = new Map<string, { size: number; mtimeMs: number; result: R }>();

  async sync(files: FileStat[], parse: (file: FileStat) => Promise<R>, concurrency = 8): Promise<{ changed: boolean }> {
    let changed = false;
    const seen = new Set<string>();
    const todo: FileStat[] = [];
    for (const f of files) {
      seen.add(f.path);
      const prev = this.entries.get(f.path);
      if (!prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) todo.push(f);
    }
    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const f = todo[next++];
        try {
          const result = await parse(f);
          this.entries.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, result });
        } catch {
          // Unreadable file: drop it and retry on the next scan.
          this.entries.delete(f.path);
        }
        changed = true;
      }
    });
    await Promise.all(workers);
    return { changed };
  }

  results(): { path: string; mtimeMs: number; result: R }[] {
    return [...this.entries.entries()]
      .map(([p, e]) => ({ path: p, mtimeMs: e.mtimeMs, result: e.result }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  get size(): number {
    return this.entries.size;
  }
}
