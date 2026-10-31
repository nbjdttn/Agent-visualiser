/**
 * Helpers shared by the server and the phone app. Nothing here may import
 * Node built-ins: this code also runs in the browser.
 */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Calendar day index of a timestamp in the local time zone. */
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

/** Parse a timestamp given as ISO text, epoch seconds or epoch milliseconds. */
export function parseTs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value < 1e12 ? value * 1000 : value);
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

/** Normalise a folder path into a stable key: forward slashes, no trailing slash. */
export function normalizeFolder(p: string): string {
  let out = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
  if (out.length > 1 && out.endsWith('/') && !/^[a-z]:\/$/.test(out)) out = out.slice(0, -1);
  return out;
}

let homeNorm: string | undefined;

/** Tell the path helpers where the home directory is (the server knows; the browser doesn't). */
export function setHomeDir(home: string) {
  homeNorm = normalizeFolder(home);
}

// Typical home folders on macOS, Linux and Windows, for logs imported from another machine.
const GENERIC_HOME = /^(\/Users\/[^/]+|\/home\/[^/]+|[a-z]:\/users\/[^/]+)(?=\/|$)/i;

/** Shorten the home directory to ~ for display. */
export function displayPath(p: string): string {
  const n = normalizeFolder(p);
  if (homeNorm && (n === homeNorm || n.startsWith(homeNorm + '/'))) return '~' + n.slice(homeNorm.length);
  return n.replace(GENERIC_HOME, '~');
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function folderName(p: string): string {
  const shown = displayPath(p);
  if (shown === '~') return '~ (home)';
  return basename(shown);
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

export function clampText(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1).trimEnd() + '…' : oneLine;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
