import { describe, expect, it } from 'vitest';
import { compactLiteLLM, Pricing, providerOfModel } from '../server/pricing';

const pricing = new Pricing();
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('model name resolution', () => {
  it('finds models despite dates, prefixes and suffixes', () => {
    expect(pricing.resolve('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(pricing.resolve('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(pricing.resolve('claude-sonnet-4-5[1m]')).toBe('claude-sonnet-4-5');
    expect(pricing.resolve('anthropic/claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(pricing.resolve('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
    expect(pricing.resolve('gpt-5.3-codex-high')).toBe('gpt-5.3-codex');
    expect(pricing.resolve('totally-unknown-model')).toBeUndefined();
  });

  it('tells providers apart', () => {
    expect(providerOfModel('claude-opus-5-5', 'openai')).toBe('anthropic');
    expect(providerOfModel('gpt-6.1-sol', 'anthropic')).toBe('openai');
    expect(providerOfModel('o4-mini', 'anthropic')).toBe('openai');
    expect(providerOfModel('qwen3-coder', 'openai')).toBe('openai');
  });
});

describe('cost', () => {
  it('prices Opus 5.5 with 1-hour cache writes', () => {
    // $4 in, $20 out, $8 1h write, $0.20 read per million tokens
    const c = pricing.cost('claude-opus-5-5', {
      input: 134,
      output: 168_082,
      cacheRead: 15_923_781,
      cacheWrite: 322_610,
      cacheWrite1h: 322_610,
    });
    close(c, (134 * 4 + 168_082 * 20 + 15_923_781 * 0.2 + 322_610 * 8) / 1e6);
  });

  it('applies the long-prompt tier per request, but not to daily aggregates', () => {
    const big = { input: 150_000, output: 1_000, cacheRead: 0, cacheWrite: 0 };
    close(pricing.cost('claude-haiku-5-5', big), (150_000 * 0.5 + 1_000 * 2.5) / 1e6);
    close(pricing.cost('claude-haiku-5-5', { ...big, aggregated: true }), (150_000 * 0.1 + 1_000 * 0.5) / 1e6);
  });

  it('applies batch, fast mode, US-only inference and web search', () => {
    const base = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    close(pricing.cost('claude-opus-5-5', { ...base, batch: true }), 2);
    close(pricing.cost('claude-opus-5-5', { ...base, speed: 'fast' }), 8);
    close(pricing.cost('claude-opus-5-5', { ...base, geo: 'us' }), 4.4);
    close(pricing.cost('claude-opus-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 3 }), 0.03);
  });

  it('prices OpenAI cached input at the cached rate', () => {
    // gpt-5.3-codex: $1.75 in, $0.175 cached, $14 out
    const c = pricing.cost('gpt-5.3-codex', { input: 5_000, cacheRead: 19_000, output: 600, cacheWrite: 0 });
    close(c, (5_000 * 1.75 + 19_000 * 0.175 + 600 * 14) / 1e6);
  });

  it('returns 0 and remembers unpriced models', () => {
    const p = new Pricing();
    expect(p.cost('mystery-model-9', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(p.unpricedModels()).toContain('mystery-model-9');
  });
});

describe('compactLiteLLM', () => {
  it('keeps Anthropic/OpenAI chat models and their tiers', () => {
    const table = compactLiteLLM({
      'claude-x': {
        litellm_provider: 'anthropic',
        mode: 'chat',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
        cache_read_input_token_cost: 1e-7,
        cache_creation_input_token_cost: 1.25e-6,
        cache_creation_input_token_cost_above_1hr: 2e-6,
        input_cost_per_token_above_200k_tokens: 2e-6,
        cache_creation_input_token_cost_above_1hr_above_200k_tokens: 4e-6,
        input_cost_per_token_batches: 5e-7,
      },
      'bedrock/claude-x': { litellm_provider: 'bedrock', input_cost_per_token: 1 },
      'dall-e-3': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 1 },
    });
    expect(Object.keys(table)).toEqual(['claude-x']);
    expect(table['claude-x']).toMatchObject({ input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6, cacheWrite1h: 2e-6 });
    expect(table['claude-x'].tiers).toEqual([{ above: 200_000, input: 2e-6, cacheWrite1h: 4e-6 }]);
  });
});
