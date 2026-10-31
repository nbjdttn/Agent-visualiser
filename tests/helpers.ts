import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a throwaway directory tree for a test and return its root. */
export function tempTree(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-visualiser-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

export const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
