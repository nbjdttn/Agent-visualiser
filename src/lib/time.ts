export const DAY_MS = 86_400_000;

/** Calendar day index of a timestamp in the browser's time zone. */
export function dayIndex(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

export function todayIndex(): number {
  return dayIndex(Date.now());
}

/** 0 = Monday … 6 = Sunday */
export function weekdayMon(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

export function weekStart(day: number): number {
  return day - weekdayMon(day);
}

export function monthStart(day: number): number {
  const d = new Date(day * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY_MS;
}

export function yearStart(day: number): number {
  return Date.UTC(new Date(day * DAY_MS).getUTCFullYear(), 0, 1) / DAY_MS;
}

export function addMonths(day: number, n: number): number {
  const d = new Date(day * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / DAY_MS;
}

export function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function fromIsoDate(s: string): number | undefined {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t / DAY_MS;
}
