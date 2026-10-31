import type { CodexLimits, ProjectKind, Provider, SourceId } from '../shared/types';

/**
 * One unit of usage before aggregation: a single model response for agent
 * logs and chat exports, or a daily bucket for organisation APIs.
 */
export interface RawEvent {
  /** Dedupe key; the same response can appear in several log files. Empty = no dedupe. */
  key: string;
  ts: number;
  source: SourceId;
  model: string;
  projectKey: string;
  sessionKey?: string;
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  /** Reasoning/thinking tokens, a subset of output. */
  reasoning: number;
  requests: number;
  webSearch?: number;
  speed?: string;
  geo?: string;
  batch?: boolean;
  sidechain?: boolean;
  /** True for API buckets that cover a whole UTC day. */
  daily?: boolean;
  /** True when token counts were estimated from text rather than reported. */
  estimated?: boolean;
  tools?: string[];
  cost?: number;
  /**
   * An hourly roll-up from automatic updates: several responses summed, with
   * the cost already worked out where the responses were logged.
   */
  rollup?: boolean;
}

export interface SessionMeta {
  key: string;
  id: string;
  source: SourceId;
  projectKey: string;
  cwd?: string;
  title?: string;
  /** 3 = AI-written title, 2 = explicit summary, 1 = first prompt, 0 = none */
  titleRank: number;
  branch?: string;
  entrypoint?: string;
  version?: string;
  repo?: string;
  promptIds: Set<string>;
  firstTs: number;
  lastTs: number;
  /** Last time the session's log file was written. */
  lastWrite: number;
}

export interface ProjectHint {
  key: string;
  kind: ProjectKind;
  name: string;
  path?: string;
  provider?: Provider;
  repo?: string;
  branches?: Set<string>;
}

export interface SourceSnapshot {
  events: RawEvent[];
  sessions: Map<string, SessionMeta>;
  projects: Map<string, ProjectHint>;
  codexLimits?: CodexLimits;
}

export function newSessionMeta(key: string, id: string, source: SourceId, projectKey: string, ts: number): SessionMeta {
  return { key, id, source, projectKey, titleRank: 0, promptIds: new Set(), firstTs: ts, lastTs: ts, lastWrite: ts };
}

/** Fold one partial session record into another (several files can describe one session). */
export function mergeSession(into: SessionMeta, from: SessionMeta) {
  into.firstTs = Math.min(into.firstTs, from.firstTs);
  into.lastTs = Math.max(into.lastTs, from.lastTs);
  into.lastWrite = Math.max(into.lastWrite, from.lastWrite);
  if (from.titleRank > into.titleRank && from.title) {
    into.title = from.title;
    into.titleRank = from.titleRank;
  }
  if (!into.cwd && from.cwd) {
    into.cwd = from.cwd;
    into.projectKey = from.projectKey;
  }
  into.branch = from.branch ?? into.branch;
  into.entrypoint = into.entrypoint ?? from.entrypoint;
  into.version = from.version ?? into.version;
  into.repo = into.repo ?? from.repo;
  for (const id of from.promptIds) into.promptIds.add(id);
}

export function cloneSession(s: SessionMeta): SessionMeta {
  return { ...s, promptIds: new Set(s.promptIds) };
}

// ---------------------------------------------------------------------------
// Plain-JSON form of a snapshot, for saving imports to disk or IndexedDB.
// ---------------------------------------------------------------------------

export interface StoredSession extends Omit<SessionMeta, 'promptIds'> {
  prompts: number;
}

export interface StoredProject extends Omit<ProjectHint, 'branches'> {
  branches?: string[];
}

export interface StoredSnapshot {
  events: RawEvent[];
  sessions: StoredSession[];
  projects: StoredProject[];
  codexLimits?: CodexLimits;
}

export function serializeSnapshot(s: SourceSnapshot): StoredSnapshot {
  return {
    events: s.events.map(({ cost, ...e }) => (e.rollup ? { ...e, cost } : e)),
    sessions: [...s.sessions.values()].map(({ promptIds, ...rest }) => ({ ...rest, prompts: promptIds.size })),
    projects: [...s.projects.values()].map(({ branches, ...rest }) => ({ ...rest, branches: branches ? [...branches] : undefined })),
    codexLimits: s.codexLimits,
  };
}

export function deserializeSnapshot(s: StoredSnapshot): SourceSnapshot {
  return {
    events: s.events.map((e) => ({ ...e })),
    sessions: new Map(
      s.sessions.map(({ prompts, ...rest }) => [
        rest.key,
        { ...rest, promptIds: new Set(Array.from({ length: prompts }, (_, i) => String(i))) },
      ]),
    ),
    projects: new Map(s.projects.map(({ branches, ...rest }) => [rest.key, { ...rest, branches: branches ? new Set(branches) : undefined }])),
    codexLimits: s.codexLimits,
  };
}
