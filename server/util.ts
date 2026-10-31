import os from 'node:os';
import path from 'node:path';
import { setHomeDir } from '../core/util.js';

// Server-only helpers. Everything that also runs in the browser lives in core/util.ts.

setHomeDir(os.homedir());

export function homeJoin(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
