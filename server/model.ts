import type { CodexLimits, ProjectKind, Provider, SourceId } from '../shared/types.js';

/**
 * One unit of usage before aggregation: a single model response for agent
 * logs, or a daily bucket for organisation APIs.
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
  tools?: string[];
  cost?: number;
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
