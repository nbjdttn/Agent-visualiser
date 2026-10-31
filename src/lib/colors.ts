import type { Provider, SourceId } from '../../shared/types';

/** Providers own two hues everywhere in the app. */
export const PROVIDER_COLOR: Record<Provider, string> = {
  anthropic: 'var(--anthropic)',
  openai: 'var(--openai)',
};

/** The six remaining categorical hues, in their validated order. */
export const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
export const OTHER_COLOR = 'var(--other)';

export function slotColor(rank: number): string {
  return rank >= 0 && rank < SLOTS.length ? SLOTS[rank] : OTHER_COLOR;
}

export const SOURCE_COLOR: Record<SourceId, string> = {
  'claude-code': SLOTS[0],
  codex: SLOTS[1],
  'claude-ai': SLOTS[2],
  chatgpt: SLOTS[3],
  'anthropic-api': SLOTS[4],
  'openai-api': SLOTS[5],
};

/** Stacked bottom to top in slot order, so neighbours are always validated pairs. */
export const TOKEN_TYPES = [
  { key: 'cacheRead', label: 'Cache read', color: SLOTS[0] },
  { key: 'cacheWrite', label: 'Cache write', color: SLOTS[1] },
  { key: 'input', label: 'Input', color: SLOTS[2] },
  { key: 'output', label: 'Output', color: SLOTS[3] },
] as const;

/** Sequential blue ramp for heatmaps: index 0 is "no activity". */
export const SEQ = ['var(--seq-0)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)'];

/** Text that sits inside a filled mark: near-black on yellow, white elsewhere. */
export function inkOn(color: string): string {
  return color === SLOTS[3] ? '#0b0b0b' : '#ffffff';
}
