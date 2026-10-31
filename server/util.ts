import os from 'node:os';
import path from 'node:path';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Calendar day index of a timestamp in the server's local time zone. */
export function localDayIndex(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

export function localHour(ts: number): number {
  return new Date(ts).getHours();
}

/** Calendar day index of a UTC timestamp (used for API buckets reported in UTC days). */
export function utcDayIndex(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

export function dayIndexToISO(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function parseTs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const HOME = os.homedir();

/** Normalise a folder path into a stable key: forward slashes, no trailing slash. */
export function normalizeFolder(p: string): string {
  let out = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
  if (out.length > 1 && out.endsWith('/') && !/^[a-z]:\/$/.test(out)) out = out.slice(0, -1);
  return out;
}

const HOME_NORM = normalizeFolder(HOME);

/** Shorten the home directory to ~ for display. */
export function displayPath(p: string): string {
  const n = normalizeFolder(p);
  if (n === HOME_NORM) return '~';
  if (n.startsWith(HOME_NORM + '/')) return '~' + n.slice(HOME_NORM.length);
  return n;
}

export function folderName(p: string): string {
  const n = normalizeFolder(p);
  if (n === HOME_NORM) return '~ (home)';
  const base = n.split('/').filter(Boolean).pop();
  return base ?? n;
}

/**
 * Claude Code stores each project under a directory named after its path with
 * separators replaced by dashes. The mapping is lossy, so this is only a
 * fallback for files that never recorded a cwd.
 */
export function decodeClaudeProjectDir(dirName: string): string {
  if (/^[A-Za-z]--/.test(dirName)) return `${dirName[0]}:/${dirName.slice(3).replace(/-/g, '/')}`;
  return dirName.replace(/-/g, '/');
}

export function homeJoin(...parts: string[]): string {
  return path.join(HOME, ...parts);
}

export function clampText(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1).trimEnd() + '…' : oneLine;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Run async work over items with a concurrency limit. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
