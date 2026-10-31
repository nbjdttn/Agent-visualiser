import type { PricingStatus, Provider } from '../shared/types';
import snapshot from './pricing-snapshot.json';

/**
 * Estimates cost from token counts using public per-token prices.
 *
 * Prices come from LiteLLM's community-maintained price list. A snapshot is
 * bundled (core/pricing-snapshot.json); the server refreshes it daily. All
 * prices are USD per token.
 */

export interface PriceTier {
  /** Applies when the prompt is larger than this many tokens. */
  above: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

export interface PriceEntry {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  tiers?: PriceTier[];
  provider?: Provider;
}

export type PriceTable = Record<string, PriceEntry>;

export interface CostInput {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** All cache-write tokens, 5-minute and 1-hour together. */
  cacheWrite: number;
  /** The 1-hour share of cacheWrite. */
  cacheWrite1h?: number;
  speed?: string;
  geo?: string;
  batch?: boolean;
  webSearch?: number;
  /** Daily aggregates can't be tiered by prompt size, so they use base prices. */
  aggregated?: boolean;
}

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const BASE_FIELDS = {
  input_cost_per_token: 'input',
  output_cost_per_token: 'output',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'cacheWrite',
  cache_creation_input_token_cost_above_1hr: 'cacheWrite1h',
} as const;

type BaseField = keyof typeof BASE_FIELDS;

/** Reduce LiteLLM's big price file to the Anthropic and OpenAI models we need. */
export function compactLiteLLM(raw: Record<string, unknown>): PriceTable {
  const out: PriceTable = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || key.includes('/')) continue;
    const v = value as Record<string, unknown>;
    const provider = v.litellm_provider;
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'text-completion-openai') continue;
    const mode = v.mode;
    if (mode && !['chat', 'responses', 'completion', 'embedding'].includes(String(mode))) continue;
    const input = v.input_cost_per_token;
    if (typeof input !== 'number') continue;
    const entry: PriceEntry = {
      input,
      output: typeof v.output_cost_per_token === 'number' ? v.output_cost_per_token : 0,
      provider: provider === 'anthropic' ? 'anthropic' : 'openai',
    };
    const tiers = new Map<number, PriceTier>();
    for (const [field, fieldValue] of Object.entries(v)) {
      if (typeof fieldValue !== 'number') continue;
      if (field in BASE_FIELDS) {
        if (field !== 'input_cost_per_token' && field !== 'output_cost_per_token') {
          entry[BASE_FIELDS[field as BaseField]] = fieldValue;
        }
        continue;
      }
      const m = /^(.*)_above_(\d+)k_tokens$/.exec(field);
      if (!m || !(m[1] in BASE_FIELDS)) continue;
      const above = Number(m[2]) * 1000;
      const tier = tiers.get(above) ?? { above };
      tier[BASE_FIELDS[m[1] as BaseField]] = fieldValue;
      tiers.set(above, tier);
    }
    if (tiers.size) entry.tiers = [...tiers.values()].sort((a, b) => a.above - b.above);
    out[key] = entry;
  }
  return out;
}

/**
 * Retired Claude models that LiteLLM no longer lists under the anthropic
 * provider. Prices from Anthropic's pricing page (USD per million tokens).
 */
const LEGACY_PER_MTOK: Record<string, [number, number, number, number, number]> = {
  // [input, output, 5m cache write, 1h cache write, cache read]
  'claude-opus-4-1': [15, 75, 18.75, 30, 1.5],
  'claude-opus-4': [15, 75, 18.75, 30, 1.5],
  'claude-sonnet-4': [3, 15, 3.75, 6, 0.3],
  'claude-3-7-sonnet': [3, 15, 3.75, 6, 0.3],
  'claude-3-5-sonnet': [3, 15, 3.75, 6, 0.3],
  'claude-3-5-haiku': [0.8, 4, 1, 1.6, 0.08],
  'claude-3-opus': [15, 75, 18.75, 30, 1.5],
  'claude-3-haiku': [0.25, 1.25, 0.3, 0.5, 0.03],
};

export function legacyEntries(): PriceTable {
  const out: PriceTable = {};
  for (const [key, [i, o, cw, cw1h, cr]] of Object.entries(LEGACY_PER_MTOK)) {
    out[key] = {
      input: i / 1e6,
      output: o / 1e6,
      cacheWrite: cw / 1e6,
      cacheWrite1h: cw1h / 1e6,
      cacheRead: cr / 1e6,
      provider: 'anthropic',
    };
  }
  // Sonnet 4 charged more for prompts over 200K tokens (1M context beta).
  out['claude-sonnet-4'].tiers = [
    { above: 200_000, input: 6 / 1e6, output: 22.5 / 1e6, cacheWrite: 7.5 / 1e6, cacheWrite1h: 12 / 1e6, cacheRead: 0.6 / 1e6 },
  ];
  return out;
}

/** ChatGPT's internal model slugs, mapped to the API models they correspond to. */
export function chatModelAlias(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('text-davinci-002-render')) return 'gpt-3.5-turbo';
  if (/^gpt-4-(gizmo|plugins|browsing|code-interpreter|mobile|dalle)/.test(m)) return 'gpt-4';
  if (m === 'gpt-4-5' || m.startsWith('gpt-4-5-')) return 'gpt-4.5-preview';
  // gpt-5-1 -> gpt-5.1, gpt-5-5-thinking -> gpt-5.5-thinking (single-digit minor versions only)
  const v = /^gpt-(\d)-(\d)(?!\d)(.*)$/.exec(m);
  if (v) return `gpt-${v[1]}.${v[2]}${v[3]}`;
  return m;
}

/** Fast mode multiplier over standard pricing, per Anthropic's pricing page. */
function fastMultiplier(model: string): number {
  if (model.includes('opus-4-6')) return 6;
  return 2;
}

export function providerOfModel(model: string, fallback: Provider): Provider {
  const m = model.toLowerCase();
  if (m.includes('claude') || m.startsWith('anthropic')) return 'anthropic';
  if (/^(gpt|o\d|chatgpt|codex|text-embedding|text-davinci|davinci|babbage|computer-use|omni)/.test(m)) return 'openai';
  return fallback;
}

interface Snapshot {
  updatedAt?: number;
  models: PriceTable;
}

export class Pricing {
  private table: PriceTable = {};
  private memo = new Map<string, string | null>();
  private unpriced = new Set<string>();
  status: PricingStatus = { source: 'bundled', unpriced: [] };

  constructor(table?: PriceTable) {
    if (table) this.setTable(table, 'bundled');
    else {
      const snap = snapshot as Snapshot;
      this.setTable(snap.models, 'bundled', snap.updatedAt);
    }
  }

  setTable(table: PriceTable, source: PricingStatus['source'], updatedAt?: number) {
    this.table = { ...legacyEntries(), ...table };
    this.memo.clear();
    this.unpriced.clear();
    this.status = { source, updatedAt, unpriced: [] };
  }

  /** Resolve a model name to a price-table key, tolerating dates, prefixes and suffixes. */
  resolve(model: string): string | undefined {
    const cached = this.memo.get(model);
    if (cached !== undefined) return cached ?? undefined;
    const found = this.resolveUncached(model);
    this.memo.set(model, found ?? null);
    return found;
  }

  private resolveUncached(model: string): string | undefined {
    if (this.table[model]) return model;
    let m = model.toLowerCase().trim();
    m = m.replace(/\[[^\]]*\]$/, ''); // claude-sonnet-4-5[1m]
    m = m.replace(/^(?:[a-z]{2,6}\.)?anthropic[./]/, '').replace(/^openai\//, '');
    m = m.replace('@', '-').replace(/-v\d+(?::\d+)?$/, '');
    m = chatModelAlias(m);
    if (this.table[m]) return m;
    const noDate = m.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
    if (this.table[noDate]) return noDate;
    // Longest known model name that prefixes this one, e.g. gpt-5.3-codex-high -> gpt-5.3-codex.
    let best: string | undefined;
    for (const key of Object.keys(this.table)) {
      if ((noDate === key || noDate.startsWith(key + '-')) && (!best || key.length > best.length)) best = key;
    }
    return best;
  }

  entry(model: string): PriceEntry | undefined {
    const key = this.resolve(model);
    return key ? this.table[key] : undefined;
  }

  /** Estimated USD cost. Returns 0 for models without a known price. */
  cost(model: string, u: CostInput): number {
    const p = this.entry(model);
    if (!p) {
      if (model && model !== 'unknown') this.unpriced.add(model);
      return 0;
    }
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    let tier: PriceTier | undefined;
    if (!u.aggregated && p.tiers) {
      for (const t of p.tiers) if (prompt > t.above) tier = t;
    }
    const pIn = tier?.input ?? p.input;
    const pOut = tier?.output ?? p.output;
    const pRead = tier?.cacheRead ?? p.cacheRead ?? pIn * 0.1;
    const pWrite = tier?.cacheWrite ?? p.cacheWrite ?? pIn * 1.25;
    const pWrite1h = tier?.cacheWrite1h ?? p.cacheWrite1h ?? pIn * 2;
    const write1h = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
    let cost =
      u.input * pIn +
      u.output * pOut +
      u.cacheRead * pRead +
      (u.cacheWrite - write1h) * pWrite +
      write1h * pWrite1h;
    if (u.speed === 'fast') cost *= fastMultiplier(model);
    if (u.geo === 'us') cost *= 1.1;
    if (u.batch) cost *= 0.5;
    if (u.webSearch) cost += u.webSearch * 0.01;
    return cost;
  }

  /** Price per million tokens, for display. */
  perMillion(model: string): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined {
    const p = this.entry(model);
    if (!p) return undefined;
    const r = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1e6 * 10000) / 10000);
    return { input: r(p.input)!, output: r(p.output)!, cacheRead: r(p.cacheRead), cacheWrite: r(p.cacheWrite) };
  }

  unpricedModels(): string[] {
    return [...this.unpriced].sort();
  }
}
