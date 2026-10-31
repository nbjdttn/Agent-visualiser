import {
  SOURCE_IDS,
  SOURCE_META,
  type Dataset,
  type FactTuple,
  type ModelInfo,
  type ProjectInfo,
  type SessionInfo,
  type SourceId,
  type SourceStatus,
} from '../shared/types';
import type { ProjectHint, RawEvent, SessionMeta, SourceSnapshot } from './model';
import { chatModelAlias, providerOfModel, type Pricing } from './pricing';
import { displayPath, folderName, localDayIndex, localHour, round6, utcDayIndex } from './util';

export interface Built {
  dataset: Dataset;
  events: RawEvent[];
  agentEvents: RawEvent[];
  eventsBySession: Map<string, RawEvent[]>;
  sessions: Map<string, SessionMeta>;
  projectIndex: Map<string, number>;
  modelIndex: Map<string, number>;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const SPECIAL_NAMES: Record<string, string> = {
  'claude-chat': 'Claude chat',
  chatgpt: 'ChatGPT',
  auto: 'ChatGPT auto',
  'gpt-3.5-turbo': 'GPT-3.5',
};

/** Human-friendly model names: claude-opus-5-5 -> Opus 5.5, gpt-5.3-codex -> GPT-5.3 Codex. */
export function prettyModel(id: string): string {
  if (SPECIAL_NAMES[id]) return SPECIAL_NAMES[id];
  const aliased = chatModelAlias(id);
  if (SPECIAL_NAMES[aliased]) return SPECIAL_NAMES[aliased];
  const m = aliased.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const c = /^claude-(?:(\d+)(?:-(\d+))?-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d+))?)?(.*)$/.exec(m);
  if (c) {
    const version = c[1] ? (c[2] ? `${c[1]}.${c[2]}` : c[1]) : c[4] ? (c[5] ? `${c[4]}.${c[5]}` : c[4]) : '';
    const rest = c[6] ? c[6].replace(/-/g, ' ').trim() : '';
    return [cap(c[3]), version, rest].filter(Boolean).join(' ');
  }
  if (/^gpt-/.test(m)) {
    const [head, ...rest] = m.slice(4).split('-');
    const words = rest.map((w) => (['mini', 'nano'].includes(w) ? w : w === 'pro' ? 'Pro' : cap(w)));
    return [`GPT-${head}`, ...words].join(' ');
  }
  return id;
}

/** A readable name for a session that never got a title: where and when it ran. */
export function fallbackTitle(project: ProjectInfo | undefined, start: number, subagent: boolean): string {
  const where = project && project.key !== 'dir:unknown' ? project.name : 'Session';
  const when = new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${subagent ? 'Sub-agents · ' : ''}${where} · ${when}`;
}

export const tokensOf = (e: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  e.input + e.output + e.cacheRead + e.cacheWrite;

export function buildDataset(args: {
  snapshots: SourceSnapshot[];
  pricing: Pricing;
  statuses: SourceStatus[];
  demo: boolean;
  version: number;
}): Built {
  const { snapshots, pricing } = args;
  const sourceIndex = new Map<SourceId, number>(SOURCE_IDS.map((s, i) => [s, i]));

  // 1. Price every event and collect everything in one list.
  const events: RawEvent[] = [];
  const sessions = new Map<string, SessionMeta>();
  const hints = new Map<string, ProjectHint>();
  // The same response can arrive twice (e.g. logs on disk and an import of
  // the same logs), so events with a key are counted once.
  const seen = new Set<string>();
  for (const snap of snapshots) {
    for (const e of snap.events) {
      if (e.key) {
        if (seen.has(e.key)) continue;
        seen.add(e.key);
      }
      if (!e.rollup) e.cost = pricing.cost(e.model, { ...e, aggregated: e.daily });
      events.push(e);
    }
    for (const [k, s] of snap.sessions) sessions.set(k, s);
    for (const [k, h] of snap.projects) {
      const prev = hints.get(k);
      if (!prev) hints.set(k, { ...h, branches: new Set(h.branches ?? []) });
      else {
        prev.repo ??= h.repo;
        for (const b of h.branches ?? []) prev.branches!.add(b);
      }
    }
  }

  // 2. Rank models and projects by all-time tokens so their colours stay put.
  const modelTotals = new Map<string, { tokens: number; source: SourceId }>();
  const projectTotals = new Map<string, number>();
  for (const e of events) {
    const t = tokensOf(e);
    const m = modelTotals.get(e.model);
    if (m) m.tokens += t;
    else modelTotals.set(e.model, { tokens: t, source: e.source });
    projectTotals.set(e.projectKey, (projectTotals.get(e.projectKey) ?? 0) + t);
  }
  const modelIds = [...modelTotals.keys()].sort((a, b) => modelTotals.get(b)!.tokens - modelTotals.get(a)!.tokens);
  const models: ModelInfo[] = modelIds.map((id, rank) => {
    const price = pricing.perMillion(id);
    return {
      id,
      label: prettyModel(id),
      provider: providerOfModel(id, SOURCE_META[modelTotals.get(id)!.source].provider),
      rank,
      priced: Boolean(price),
      price,
    };
  });
  const modelIndex = new Map(modelIds.map((id, i) => [id, i]));

  const projectKeys = [...projectTotals.keys()].sort((a, b) => projectTotals.get(b)! - projectTotals.get(a)!);
  const projects: ProjectInfo[] = projectKeys.map((key, rank) => {
    const h = hints.get(key);
    if (h) {
      return {
        key,
        name: h.name,
        path: h.path,
        kind: h.kind,
        provider: h.provider,
        repo: h.repo,
        branches: h.branches?.size ? [...h.branches].slice(0, 12) : undefined,
        rank,
      };
    }
    if (key === 'dir:unknown') return { key, name: 'Unknown folder', kind: 'folder', rank };
    if (key.startsWith('dir:')) {
      const folder = key.slice(4);
      return { key, name: folderName(folder), path: displayPath(folder), kind: 'folder', rank };
    }
    return { key, name: key.replace(/^[^:]+:/, ''), kind: 'folder', rank };
  });
  const projectIndex = new Map(projectKeys.map((k, i) => [k, i]));

  // 3. Aggregate facts by day, hour, source, model and project.
  const facts = new Map<string, FactTuple>();
  const eventsBySession = new Map<string, RawEvent[]>();
  const agentEvents: RawEvent[] = [];
  for (const e of events) {
    const day = e.daily ? utcDayIndex(e.ts) : localDayIndex(e.ts);
    const hour = e.daily ? -1 : localHour(e.ts);
    const src = sourceIndex.get(e.source)!;
    const model = modelIndex.get(e.model)!;
    const proj = projectIndex.get(e.projectKey)!;
    const k = `${day}|${hour}|${src}|${model}|${proj}`;
    let f = facts.get(k);
    if (!f) {
      f = [day, hour, src, model, proj, 0, 0, 0, 0, 0, 0, 0];
      facts.set(k, f);
    }
    f[5] += e.input;
    f[6] += e.output;
    f[7] += e.cacheRead;
    f[8] += e.cacheWrite;
    f[9] += e.reasoning;
    f[10] += e.requests;
    f[11] += e.cost ?? 0;
    if (e.sessionKey) {
      let list = eventsBySession.get(e.sessionKey);
      if (!list) eventsBySession.set(e.sessionKey, (list = []));
      list.push(e);
    }
    if (!e.daily) agentEvents.push(e);
  }
  for (const f of facts.values()) f[11] = round6(f[11]);
  agentEvents.sort((a, b) => a.ts - b.ts);

  // 4. Sessions with their totals.
  const sessionList: SessionInfo[] = [];
  for (const [key, list] of eventsBySession) {
    const meta = sessions.get(key);
    list.sort((a, b) => a.ts - b.ts);
    const first = list[0];
    const s: SessionInfo = {
      key,
      id: meta?.id ?? key.split(':').slice(1).join(':'),
      src: sourceIndex.get(first.source)!,
      proj: projectIndex.get(meta?.projectKey ?? first.projectKey) ?? projectIndex.get(first.projectKey)!,
      title: meta?.title || fallbackTitle(projects[projectIndex.get(meta?.projectKey ?? first.projectKey) ?? projectIndex.get(first.projectKey)!], Math.min(meta?.firstTs ?? first.ts, first.ts), list.every((e) => e.sidechain)),
      start: Math.min(meta?.firstTs ?? first.ts, first.ts),
      end: Math.max(meta?.lastTs ?? 0, list[list.length - 1].ts),
      models: [],
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      requests: 0,
      cost: 0,
      tools: [],
      subagentTokens: 0,
      prompts: meta?.promptIds.size ?? 0,
      branch: meta?.branch,
      entrypoint: meta?.entrypoint,
      version: meta?.version,
    };
    const modelSet = new Map<number, number>();
    const tools = new Map<string, number>();
    for (const e of list) {
      s.input += e.input;
      s.output += e.output;
      s.cacheRead += e.cacheRead;
      s.cacheWrite += e.cacheWrite;
      s.reasoning += e.reasoning;
      s.requests += e.requests;
      s.cost += e.cost ?? 0;
      if (e.estimated) s.estimated = true;
      const t = tokensOf(e);
      if (e.sidechain) s.subagentTokens += t;
      const mi = modelIndex.get(e.model)!;
      modelSet.set(mi, (modelSet.get(mi) ?? 0) + t);
      for (const tool of e.tools ?? []) tools.set(tool, (tools.get(tool) ?? 0) + 1);
    }
    s.cost = round6(s.cost);
    s.models = [...modelSet.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    s.tools = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    sessionList.push(s);
  }
  sessionList.sort((a, b) => b.start - a.start);

  const dataset: Dataset = {
    version: args.version,
    generatedAt: Date.now(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    demo: args.demo,
    sources: args.statuses,
    sourceIds: SOURCE_IDS,
    models,
    projects,
    facts: [...facts.values()],
    sessions: sessionList,
    pricing: { ...pricing.status, unpriced: pricing.unpricedModels() },
  };
  return { dataset, events, agentEvents, eventsBySession, sessions, projectIndex, modelIndex };
}
