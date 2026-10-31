import type { CodexLimits, SourceId, SourceStatus } from '../../shared/types';
import { newSessionMeta, type ProjectHint, type RawEvent, type SessionMeta, type SourceSnapshot, type StoredProject, type StoredSession } from '../model';
import type { Pricing } from '../pricing';
import { HOUR_MS, parseTs } from '../util';

/**
 * What automatic updates carry. A computer sends hourly roll-ups of its
 * Claude Code and Codex logs; the cloud collector sends the running totals of
 * Claude Code cloud sessions. Both are sealed with ./envelope before they are
 * published.
 */

export const SYNC_BRANCH = 'usage-data';
export const INDEX_FILE = 'index.json';
export const CLOUD_FILE = 'cloud.json';
export const DEVICES_DIR = 'devices';

export type SyncKind = 'computer' | 'cloud';

export interface SyncIndexEntry {
  kind: SyncKind;
  updatedAt: number;
  /** Device ids the file is encrypted for. */
  recipients: string[];
}

/** index.json: the only unencrypted file, so the phone knows what changed. */
export interface SyncIndex {
  v: 1;
  files: Record<string, SyncIndexEntry>;
}

export const computerFile = (id: string) => `computer-${id}.json`;

// ---------------------------------------------------------------------------
// Computer payloads: hourly roll-ups of agent logs
// ---------------------------------------------------------------------------

/**
 * A SourceSnapshot with its events summed per hour, session, model and
 * project, and their cost already worked out (per response, so long-prompt
 * prices still apply). Strings are stored once and referenced by index.
 *
 * Row: [hour, source, model, project, session (-1 = none), input, output,
 *       cacheRead, cacheWrite, cacheWrite1h, reasoning, requests,
 *       cost in micro-dollars, flags, ...tool, count pairs]
 */
export interface Rollup {
  strings: string[];
  rows: number[][];
  sessions: StoredSession[];
  projects: StoredProject[];
  codexLimits?: CodexLimits;
}

const SIDECHAIN = 1;
const ESTIMATED = 2;
const DAILY = 4;
const TOOLS_AT = 14;

export interface ComputerPayload {
  v: 1;
  kind: 'computer';
  /** The computer's name, e.g. "Tim's MacBook Pro". */
  name: string;
  generatedAt: number;
  rollup: Rollup;
  statuses: SourceStatus[];
}

export function rollupSnapshots(snapshots: SourceSnapshot[], pricing: Pricing): Rollup {
  const strings: string[] = [];
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let i = ids.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      ids.set(s, i);
    }
    return i;
  };

  const groups = new Map<string, { row: number[]; tools: Map<number, number> }>();
  const seen = new Set<string>();
  const sessions = new Map<string, StoredSession>();
  const projects = new Map<string, StoredProject>();
  let codexLimits: CodexLimits | undefined;

  for (const snap of snapshots) {
    for (const e of snap.events) {
      if (e.key) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
      }
      const cost = e.rollup ? (e.cost ?? 0) : pricing.cost(e.model, { ...e, aggregated: e.daily });
      const hour = Math.floor(e.ts / HOUR_MS);
      const flags = (e.sidechain ? SIDECHAIN : 0) | (e.estimated ? ESTIMATED : 0) | (e.daily ? DAILY : 0);
      const src = intern(e.source);
      const model = intern(e.model);
      const proj = intern(e.projectKey);
      const sess = e.sessionKey ? intern(e.sessionKey) : -1;
      const k = `${hour}|${src}|${model}|${proj}|${sess}|${flags}`;
      let g = groups.get(k);
      if (!g) {
        g = { row: [hour, src, model, proj, sess, 0, 0, 0, 0, 0, 0, 0, 0, flags], tools: new Map() };
        groups.set(k, g);
      }
      const r = g.row;
      r[5] += e.input;
      r[6] += e.output;
      r[7] += e.cacheRead;
      r[8] += e.cacheWrite;
      r[9] += e.cacheWrite1h;
      r[10] += e.reasoning;
      r[11] += e.requests;
      r[12] += cost;
      for (const t of e.tools ?? []) {
        const ti = intern(t);
        g.tools.set(ti, (g.tools.get(ti) ?? 0) + 1);
      }
    }
    for (const s of snap.sessions.values()) {
      const { promptIds, ...rest } = s;
      sessions.set(s.key, { ...rest, prompts: promptIds.size });
    }
    for (const p of snap.projects.values()) {
      const prev = projects.get(p.key);
      const branches = new Set([...(prev?.branches ?? []), ...(p.branches ?? [])]);
      const { branches: _b, ...rest } = p;
      projects.set(p.key, { ...(prev ?? {}), ...rest, repo: prev?.repo ?? p.repo, branches: branches.size ? [...branches] : undefined });
    }
    if (snap.codexLimits && (!codexLimits || snap.codexLimits.updatedAt > codexLimits.updatedAt)) codexLimits = snap.codexLimits;
  }

  const rows = [...groups.values()]
    .map(({ row, tools }) => {
      row[12] = Math.round(row[12] * 1e6);
      for (const [ti, n] of [...tools.entries()].sort((a, b) => b[1] - a[1])) row.push(ti, n);
      return row;
    })
    .sort((a, b) => a[0] - b[0] || a[4] - b[4]);
  return { strings, rows, sessions: [...sessions.values()], projects: [...projects.values()], codexLimits };
}

export function expandRollup(r: Rollup): SourceSnapshot {
  const str = (i: number) => r.strings[i] ?? 'unknown';
  const events: RawEvent[] = r.rows.map((row) => {
    const tools: string[] = [];
    for (let i = TOOLS_AT; i + 1 < row.length; i += 2) for (let n = 0; n < row[i + 1]; n++) tools.push(str(row[i]));
    const flags = row[13] ?? 0;
    return {
      key: '',
      ts: row[0] * HOUR_MS,
      source: str(row[1]) as SourceId,
      model: str(row[2]),
      projectKey: str(row[3]),
      sessionKey: row[4] >= 0 ? str(row[4]) : undefined,
      input: row[5],
      output: row[6],
      cacheRead: row[7],
      cacheWrite: row[8],
      cacheWrite1h: row[9],
      reasoning: row[10],
      requests: row[11],
      cost: row[12] / 1e6,
      rollup: true,
      sidechain: flags & SIDECHAIN ? true : undefined,
      estimated: flags & ESTIMATED ? true : undefined,
      daily: flags & DAILY ? true : undefined,
      tools: tools.length ? tools : undefined,
    };
  });
  return {
    events,
    sessions: new Map(
      r.sessions.map(({ prompts, ...rest }) => [
        rest.key,
        { ...rest, promptIds: new Set(Array.from({ length: prompts }, (_, i) => String(i))) } as SessionMeta,
      ]),
    ),
    projects: new Map(r.projects.map(({ branches, ...rest }) => [rest.key, { ...rest, branches: branches ? new Set(branches) : undefined }])),
    codexLimits: r.codexLimits,
  };
}

// ---------------------------------------------------------------------------
// Cloud payloads: Claude Code sessions that ran in Anthropic's cloud
// ---------------------------------------------------------------------------

export interface CloudSessionRecord {
  id: string;
  title?: string;
  created: number;
  updated: number;
  /** Where it was started from: ios, web, ... */
  origin?: string;
  model?: string;
  /** owner/name of the GitHub repository it worked in. */
  repo?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD, as Claude Code reports it. */
  cost: number;
}

/** A Claude plan window as last reported to Claude Code (five-hour, seven-day...). */
export interface ClaudeWindow {
  type: string;
  status: string;
  resetsAt?: number;
  overage?: boolean;
  seenAt: number;
}

export interface CloudPayload {
  v: 1;
  kind: 'cloud';
  name: string;
  generatedAt: number;
  sessions: CloudSessionRecord[];
  limits: ClaudeWindow[];
}

export type SyncPayload = ComputerPayload | CloudPayload;

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};
const count = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v.replace(/[_,\s]/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Accept owner/name, a github.com URL or a git URL. */
export function repoName(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Turn what the scheduled collector wrote into a payload. It is lenient about
 * names (input or input_tokens, created or created_at, ISO text or epoch...)
 * and refuses anything that doesn't look like usage.
 */
export function cloudPayloadFrom(input: unknown, now = Date.now()): CloudPayload {
  const root = (Array.isArray(input) ? { sessions: input } : input) as Record<string, unknown>;
  const list = Array.isArray(root?.sessions) ? (root.sessions as Record<string, unknown>[]) : undefined;
  if (!list) throw new Error('Expected {"sessions": [...]}');
  const sessions: CloudSessionRecord[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const usage = (pick(raw, 'usage') ?? {}) as Record<string, unknown>;
    const id = text(pick(raw, 'id', 'session_id'));
    const created = parseTs(pick(raw, 'created', 'created_at', 'start'));
    const updated = parseTs(pick(raw, 'updated', 'updated_at', 'end')) ?? created;
    if (!id || !created || !updated) throw new Error(`A session is missing its id or times: ${JSON.stringify(raw).slice(0, 120)}`);
    const rec: CloudSessionRecord = {
      id,
      title: text(pick(raw, 'title')),
      created: Math.min(created, updated),
      updated: Math.max(created, updated),
      origin: text(pick(raw, 'origin')),
      model: text(pick(raw, 'model', 'configured_model')),
      repo: repoName(pick(raw, 'repo', 'repository')),
      input: count(pick(raw, 'input', 'input_tokens') ?? usage.input_tokens),
      output: count(pick(raw, 'output', 'output_tokens') ?? usage.output_tokens),
      cacheRead: count(pick(raw, 'cacheRead', 'cache_read', 'cache_read_tokens') ?? usage.cache_read_tokens),
      cacheWrite: count(pick(raw, 'cacheWrite', 'cache_write', 'cache_write_tokens') ?? usage.cache_write_tokens),
      cost: count(pick(raw, 'cost', 'cost_usd') ?? usage.cost_usd),
    };
    if (rec.input + rec.output + rec.cacheRead + rec.cacheWrite === 0) continue;
    sessions.push(rec);
  }
  const limits: ClaudeWindow[] = [];
  for (const raw of Array.isArray(root.limits) ? (root.limits as Record<string, unknown>[]) : []) {
    const type = text(pick(raw, 'type', 'rateLimitType'));
    const status = text(pick(raw, 'status'));
    if (!type || !status) continue;
    limits.push({
      type,
      status,
      resetsAt: parseTs(pick(raw, 'resetsAt', 'resets_at')),
      overage: Boolean(pick(raw, 'overage', 'isUsingOverage')),
      seenAt: parseTs(pick(raw, 'seenAt', 'seen_at')) ?? now,
    });
  }
  return { v: 1, kind: 'cloud', name: 'Claude Code cloud sessions', generatedAt: parseTs(root.collectedAt) ?? now, sessions, limits };
}

/** One reading of a session's running totals: [updated, input, output, cacheRead, cacheWrite, cost]. */
export type CloudReading = [number, number, number, number, number, number];

/** What the phone remembers about a cloud session: its latest details and every total it has seen. */
export interface CloudSessionHistory {
  record: CloudSessionRecord;
  readings: CloudReading[];
}

export type CloudHistory = Record<string, CloudSessionHistory>;

const MAX_READINGS = 400;

/**
 * Add a payload to what the phone already knows. Totals only grow, so each new
 * reading tells how much was used since the previous one; that is what lets a
 * session that runs over several days be split by day.
 */
export function mergeCloudPayload(history: CloudHistory, payload: CloudPayload): CloudHistory {
  const next: CloudHistory = { ...history };
  for (const rec of payload.sessions) {
    const reading: CloudReading = [rec.updated, rec.input, rec.output, rec.cacheRead, rec.cacheWrite, rec.cost];
    const prev = next[rec.id];
    if (!prev) {
      next[rec.id] = { record: rec, readings: [reading] };
      continue;
    }
    const last = prev.readings[prev.readings.length - 1];
    if (rec.updated < last[0]) continue;
    const changed = reading.some((v, i) => i > 0 && v !== last[i]);
    let readings = prev.readings;
    if (changed) {
      const shrank = reading.some((v, i) => i > 0 && v < last[i]);
      readings = shrank ? [reading] : [...prev.readings, reading].slice(-MAX_READINGS);
    }
    next[rec.id] = { record: rec, readings };
  }
  return next;
}

const MAX_SPREAD_MS = 45 * 24 * HOUR_MS;

/** Split totals over the hours between start and end, in proportion to the time in each hour. */
function spread(start: number, end: number, totals: number[]): { hour: number; values: number[] }[] {
  const s = Math.max(start, end - MAX_SPREAD_MS);
  const first = Math.floor(s / HOUR_MS);
  const last = Math.floor(Math.max(s, end) / HOUR_MS);
  const weights: number[] = [];
  for (let h = first; h <= last; h++) {
    const from = Math.max(s, h * HOUR_MS);
    const to = Math.min(end, (h + 1) * HOUR_MS);
    weights.push(Math.max(0, to - from));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const share = sum > 0 ? weights.map((w) => w / sum) : weights.map((_, i) => (i === weights.length - 1 ? 1 : 0));
  // Whole tokens: largest-remainder rounding keeps the totals exact. Cost (last value) stays fractional.
  const out = share.map((_, i) => ({ hour: first + i, values: totals.map(() => 0) }));
  totals.forEach((total, j) => {
    if (j === totals.length - 1) {
      share.forEach((w, i) => (out[i].values[j] = total * w));
      return;
    }
    const exact = share.map((w) => total * w);
    const floors = exact.map(Math.floor);
    let left = total - floors.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) {
      if (left <= 0) break;
      floors[i] += 1;
      left -= 1;
    }
    floors.forEach((v, i) => (out[i].values[j] = v));
  });
  return out.filter((b) => b.values.some((v) => v > 0));
}

export function cloudProjectKey(repo?: string): string {
  return repo ? `repo:${repo.toLowerCase()}` : 'repo:none';
}

/** Turn the remembered cloud sessions into usage events, one per session and hour. */
export function cloudSnapshot(history: CloudHistory): SourceSnapshot {
  const events: RawEvent[] = [];
  const sessions = new Map<string, SessionMeta>();
  const projects = new Map<string, ProjectHint>();
  for (const { record: r, readings } of Object.values(history)) {
    const projectKey = cloudProjectKey(r.repo);
    if (!projects.has(projectKey)) {
      projects.set(
        projectKey,
        r.repo
          ? { key: projectKey, kind: 'repo', name: r.repo.split('/').pop() ?? r.repo, path: r.repo, repo: `github.com/${r.repo}`, provider: 'anthropic' }
          : { key: projectKey, kind: 'repo', name: 'No repository', provider: 'anthropic' },
      );
    }
    const sessionKey = `claude-code:${r.id}`;
    const meta = newSessionMeta(sessionKey, r.id, 'claude-code', projectKey, r.created);
    meta.title = r.title;
    meta.titleRank = r.title ? 3 : 0;
    meta.lastTs = r.updated;
    meta.lastWrite = r.updated;
    meta.entrypoint = r.origin ? `cloud (${r.origin})` : 'cloud';
    meta.repo = r.repo ? `github.com/${r.repo}` : undefined;
    sessions.set(sessionKey, meta);

    let prev = [0, 0, 0, 0, 0];
    readings.forEach((reading, i) => {
      const start = i === 0 ? r.created : Math.max(r.created, readings[i - 1][0]);
      const end = Math.max(start, reading[0]);
      const delta = reading.slice(1).map((v, j) => Math.max(0, v - prev[j]));
      prev = reading.slice(1);
      for (const b of spread(start, end, delta)) {
        const [input, output, cacheRead, cacheWrite, cost] = b.values;
        events.push({
          key: '',
          ts: b.hour * HOUR_MS,
          source: 'claude-code',
          model: r.model || 'unknown',
          projectKey,
          sessionKey,
          input,
          output,
          cacheRead,
          cacheWrite,
          cacheWrite1h: 0,
          reasoning: 0,
          requests: 0,
          cost,
          rollup: true,
        });
      }
    });
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, sessions, projects };
}

// ---------------------------------------------------------------------------
// The computer's archive: everything it has sent, so usage stays on the phone
// after Claude Code or Codex delete old logs (Claude Code keeps 30 days by default).
// ---------------------------------------------------------------------------

/** Bump when the way logs are read changes, so the archive is rebuilt from the logs. */
export const ARCHIVE_VERSION = 2;

export interface RollupArchive {
  v: number;
  /** Rollup rows with names instead of string indexes, keyed by hour/source/model/project/session/flags. */
  rows: Record<string, (string | number)[]>;
  sessions: Record<string, StoredSession>;
  projects: Record<string, StoredProject>;
}

export const emptyArchive = (): RollupArchive => ({ v: ARCHIVE_VERSION, rows: {}, sessions: {}, projects: {} });

const rowTokens = (r: (string | number)[]) => Number(r[5]) + Number(r[6]) + Number(r[7]) + Number(r[8]);

/**
 * Fold a fresh rollup into the archive. A row only grows while its logs are
 * written and shrinks or vanishes when logs are deleted, so the larger
 * version of each row wins and rows missing from the logs are kept.
 */
export function mergeIntoArchive(archive: RollupArchive, r: Rollup): RollupArchive {
  const name = (i: number) => r.strings[i] ?? 'unknown';
  for (const row of r.rows) {
    const named: (string | number)[] = [row[0], name(row[1]), name(row[2]), name(row[3]), row[4] >= 0 ? name(row[4]) : '', ...row.slice(5, TOOLS_AT)];
    for (let i = TOOLS_AT; i + 1 < row.length; i += 2) named.push(name(row[i]), row[i + 1]);
    const key = `${named[0]}|${named[1]}|${named[2]}|${named[3]}|${named[4]}|${row[13]}`;
    const prev = archive.rows[key];
    if (!prev || rowTokens(named) >= rowTokens(prev)) archive.rows[key] = named;
  }
  for (const s of r.sessions) {
    const prev = archive.sessions[s.key];
    archive.sessions[s.key] = prev && prev.lastTs > s.lastTs ? { ...s, ...prev, prompts: Math.max(prev.prompts, s.prompts) } : { ...s, prompts: Math.max(prev?.prompts ?? 0, s.prompts) };
  }
  for (const p of r.projects) {
    const prev = archive.projects[p.key];
    const branches = new Set([...(prev?.branches ?? []), ...(p.branches ?? [])]);
    archive.projects[p.key] = { ...(prev ?? {}), ...p, repo: p.repo ?? prev?.repo, branches: branches.size ? [...branches].slice(0, 40) : undefined };
  }
  return archive;
}

/** Turn the archive back into a rollup to send. */
export function rollupFromArchive(a: RollupArchive, codexLimits?: CodexLimits): Rollup {
  const strings: string[] = [];
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let i = ids.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      ids.set(s, i);
    }
    return i;
  };
  const rows = Object.values(a.rows)
    .map((n) => {
      const row: number[] = [Number(n[0]), intern(String(n[1])), intern(String(n[2])), intern(String(n[3])), n[4] ? intern(String(n[4])) : -1];
      for (let i = 5; i < TOOLS_AT; i++) row.push(Number(n[i]));
      for (let i = TOOLS_AT; i + 1 < n.length; i += 2) row.push(intern(String(n[i])), Number(n[i + 1]));
      return row;
    })
    .sort((x, y) => x[0] - y[0] || x[4] - y[4]);
  return { strings, rows, sessions: Object.values(a.sessions), projects: Object.values(a.projects), codexLimits };
}
