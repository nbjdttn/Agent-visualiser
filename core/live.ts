import type {
  ActiveSession,
  BlockStatus,
  CodexLimits,
  Dataset,
  LiveStatus,
  Provider,
  SourceId,
  UsageBlock,
} from '../shared/types';
import { prettyModel, tokensOf, type Built } from './aggregate';
import type { RawEvent } from './model';
import { HOUR_MS, MINUTE_MS, localDayIndex, utcDayIndex } from './util';

const WORKING_MS = 3 * MINUTE_MS;
const IDLE_MS = 20 * MINUTE_MS;
const BLOCK_MS = 5 * HOUR_MS;

/**
 * Group usage into 5-hour blocks, the window subscription plans meter
 * against: a block starts at the hour of the first message and lasts five
 * hours; the next message after it ends starts a new block.
 */
export function computeBlocks(events: RawEvent[], now: number): BlockStatus {
  const blocks: (UsageBlock & { first: number; models: string[]; modelSet: Set<string> })[] = [];
  let cur: (typeof blocks)[number] | undefined;
  for (const e of events) {
    if (!cur || e.ts >= cur.end) {
      const start = Math.floor(e.ts / HOUR_MS) * HOUR_MS;
      cur = {
        start,
        end: start + BLOCK_MS,
        first: e.ts,
        lastActivity: e.ts,
        tokens: 0,
        cost: 0,
        requests: 0,
        models: [],
        modelSet: new Set(),
        active: false,
      };
      blocks.push(cur);
    }
    cur.tokens += tokensOf(e);
    cur.cost += e.cost ?? 0;
    cur.requests += e.requests;
    cur.lastActivity = e.ts;
    cur.modelSet.add(e.model);
  }
  const clean = blocks.map(({ first: _first, modelSet, ...b }) => ({
    ...b,
    models: [...modelSet].map(prettyModel),
    active: now >= b.start && now < b.end,
  }));
  // The reference is the busiest *earlier* window, so the current one can be compared with it.
  const maxTokens = clean.reduce((m, b) => (b.active ? m : Math.max(m, b.tokens)), 0);
  const last = blocks.at(-1);
  const status: BlockStatus = { maxTokens, recent: clean.slice(-12) };
  if (last && now < last.end) {
    const b = clean.at(-1)!;
    const elapsedMin = Math.max(1, (last.lastActivity - last.first) / MINUTE_MS);
    const burnTokensPerMin = b.tokens / elapsedMin;
    const burnCostPerHour = (b.cost / elapsedMin) * 60;
    const remainingMin = Math.max(0, (b.end - now) / MINUTE_MS);
    // Only project forward while the block is being actively used.
    const activeNow = now - last.lastActivity < 15 * MINUTE_MS;
    status.current = {
      ...b,
      burnTokensPerMin,
      burnCostPerHour,
      projectedTokens: b.tokens + (activeNow ? burnTokensPerMin * remainingMin : 0),
      projectedCost: b.cost + (activeNow ? (burnCostPerHour / 60) * remainingMin : 0),
    };
  }
  return status;
}

export function computeLive(args: {
  built: Built;
  now: number;
  version: number;
  demo: boolean;
  scanning: boolean;
  codexLimits?: CodexLimits;
}): LiveStatus {
  const { built, now } = args;
  const ds: Dataset = built.dataset;

  // Active sessions: anything written to in the last 20 minutes.
  const active: ActiveSession[] = [];
  for (const [key, meta] of built.sessions) {
    if (meta.source !== 'claude-code' && meta.source !== 'codex') continue;
    const lastActivity = Math.max(meta.lastWrite, meta.lastTs);
    if (now - lastActivity > IDLE_MS || lastActivity > now + MINUTE_MS) continue;
    const list = built.eventsBySession.get(key) ?? [];
    if (!list.length) continue;
    const perMinute = new Array<number>(30).fill(0);
    let tokensLastHour = 0;
    let costLastHour = 0;
    let requestsLastHour = 0;
    let tokens = 0;
    let cost = 0;
    for (const e of list) {
      const t = tokensOf(e);
      tokens += t;
      cost += e.cost ?? 0;
      const age = now - e.ts;
      if (age <= HOUR_MS && age >= -MINUTE_MS) {
        tokensLastHour += t;
        costLastHour += e.cost ?? 0;
        requestsLastHour += e.requests;
      }
      const idx = Math.floor(age / MINUTE_MS);
      if (idx >= 0 && idx < 30) perMinute[29 - idx] += t;
    }
    const lastEvent = list[list.length - 1];
    const pIdx = built.projectIndex.get(meta.projectKey);
    const project = pIdx !== undefined ? ds.projects[pIdx] : undefined;
    active.push({
      key,
      source: meta.source as SourceId,
      project: project?.name ?? 'Unknown folder',
      projectKey: meta.projectKey,
      path: project?.path,
      title: meta.title || project?.name || 'Untitled session',
      model: lastEvent.model,
      modelLabel: prettyModel(lastEvent.model),
      start: meta.firstTs,
      lastActivity,
      perMinute,
      tokensLastHour,
      costLastHour,
      requestsLastHour,
      tokens,
      cost,
      state: now - lastActivity <= WORKING_MS ? 'working' : 'idle',
    });
  }
  active.sort((a, b) => (a.state === b.state ? b.lastActivity - a.lastActivity : a.state === 'working' ? -1 : 1));

  const bySource = (src: SourceId) => built.agentEvents.filter((e) => e.source === src);

  // Today's totals per provider, from local-day facts plus today's UTC API bucket.
  const today: LiveStatus['today'] = {
    anthropic: { tokens: 0, cost: 0, requests: 0 },
    openai: { tokens: 0, cost: 0, requests: 0 },
  };
  const localToday = localDayIndex(now);
  const utcToday = utcDayIndex(now);
  for (const f of ds.facts) {
    const isDaily = f[1] === -1;
    if (f[0] !== (isDaily ? utcToday : localToday)) continue;
    const provider: Provider = ds.models[f[3]].provider;
    today[provider].tokens += f[5] + f[6] + f[7] + f[8];
    today[provider].cost += f[11];
    today[provider].requests += f[10];
  }

  return {
    now,
    version: args.version,
    demo: args.demo,
    scanning: args.scanning,
    active,
    claudeBlocks: computeBlocks(bySource('claude-code'), now),
    codexBlocks: computeBlocks(bySource('codex'), now),
    codexLimits: args.codexLimits,
    today,
  };
}
