import { DAY_MS } from './time';

export function compact(n: number, digits = 1): string {
  const a = Math.abs(n);
  if (a >= 1e12) return trim((n / 1e12).toFixed(digits)) + 'T';
  if (a >= 1e9) return trim((n / 1e9).toFixed(a >= 1e11 ? 0 : digits)) + 'B';
  if (a >= 1e6) return trim((n / 1e6).toFixed(a >= 1e8 ? 0 : digits)) + 'M';
  if (a >= 1e4) return trim((n / 1e3).toFixed(a >= 1e5 ? 0 : digits)) + 'K';
  return Math.round(n).toLocaleString('en-US');
}

function trim(s: string) {
  return s.replace(/\.0+$/, '');
}

export function full(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function usd(n: number, opts: { compact?: boolean } = {}): string {
  if (n === 0) return '$0';
  const a = Math.abs(n);
  if (a < 0.01) return '<$0.01';
  if (opts.compact && a >= 10_000) return '$' + compact(n);
  if (a >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (a >= 100) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

export function pct(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '–';
  return (n * 100).toFixed(digits) + '%';
}

export function signedPct(n: number): string {
  if (!Number.isFinite(n)) return 'new';
  const v = Math.abs(n) >= 10 ? Math.round(n * 100) : Math.round(n * 1000) / 10;
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(v) + '%';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format a calendar day index (UTC-based, see shared/types FactTuple). */
export function dayLabel(day: number, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const d = new Date(day * DAY_MS);
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const wd = opts.weekday ? `${WEEKDAYS[d.getUTCDay()]}, ` : '';
  return wd + base + (opts.year ? `, ${d.getUTCFullYear()}` : '');
}

export function monthLabel(day: number, withYear = true): string {
  const d = new Date(day * DAY_MS);
  return MONTHS[d.getUTCMonth()] + (withYear ? ` ${d.getUTCFullYear()}` : '');
}

export function shortMonth(day: number): string {
  return MONTHS[new Date(day * DAY_MS).getUTCMonth()];
}

export function rangeLabel(from: number, to: number): string {
  const a = new Date(from * DAY_MS);
  const b = new Date(to * DAY_MS);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  if (from === to) return dayLabel(from, { year: true });
  return `${dayLabel(from, { year: !sameYear })} – ${dayLabel(to, { year: true })}`;
}

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function relative(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return 'just now';
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.round(mo / 12)} y ago`;
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export function until(ts: number, now = Date.now()): string {
  return duration(ts - now);
}

/** Compact countdown: 45m, 3h 20m, 2d 6h. */
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function hourLabel(h: number): string {
  if (h === 0) return '12 am';
  if (h === 12) return '12 pm';
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

export { MONTHS, WEEKDAYS };
