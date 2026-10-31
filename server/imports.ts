import fs from 'node:fs';
import path from 'node:path';
import type { ImportInfo, SourceId } from '../shared/types.js';
import { importBytes } from '../core/importer.js';
import { importInfo } from '../core/imports.js';
import { deserializeSnapshot, serializeSnapshot, type SourceSnapshot, type StoredSnapshot } from '../core/model.js';

/**
 * Imported files (chat exports, agent logs from another machine), saved as
 * parsed summaries under the cache directory. The original file is not kept,
 * and message text never is. A new import replaces the previous one for the
 * same source, since exports always contain the full history.
 */
export class ImportStore {
  private items: { info: ImportInfo; snapshot: SourceSnapshot }[] = [];

  constructor(private readonly dir: string) {
    this.load();
  }

  private load() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as { info: ImportInfo; snapshot: StoredSnapshot };
        this.items.push({ info: saved.info, snapshot: deserializeSnapshot(saved.snapshot) });
      } catch {
        // skip unreadable files
      }
    }
  }

  list(): ImportInfo[] {
    return this.items.map((i) => i.info).sort((a, b) => b.importedAt - a.importedAt);
  }

  latest(source: SourceId): ImportInfo | undefined {
    return this.list().find((i) => i.source === source);
  }

  snapshots(): SourceSnapshot[] {
    return this.items.map((i) => i.snapshot);
  }

  async add(fileName: string, bytes: Uint8Array): Promise<ImportInfo[]> {
    const results = await importBytes(fileName, bytes);
    fs.mkdirSync(this.dir, { recursive: true });
    const added: ImportInfo[] = [];
    for (const r of results) {
      for (const old of this.items.filter((i) => i.info.source === r.source)) this.remove(old.info.id);
      const info = importInfo(r, fileName);
      fs.writeFileSync(path.join(this.dir, `${info.id}.json`), JSON.stringify({ info, snapshot: serializeSnapshot(r.snapshot) }));
      this.items.push({ info, snapshot: r.snapshot });
      added.push(info);
    }
    return added;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.info.id !== id);
    try {
      fs.rmSync(path.join(this.dir, `${path.basename(id)}.json`), { force: true });
    } catch {
      // already gone
    }
    return this.items.length !== before;
  }
}
