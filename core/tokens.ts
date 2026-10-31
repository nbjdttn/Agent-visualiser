/**
 * Rough token counts for text whose real counts were never recorded (chat
 * exports). English and code average about four characters per token; Chinese,
 * Japanese and Korean characters are closer to one token each. Good enough to
 * compare days, models and projects, not to reproduce a bill.
 */

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/g;

export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Typical cost of one image in a prompt, in tokens. */
export const IMAGE_TOKENS = 800;
