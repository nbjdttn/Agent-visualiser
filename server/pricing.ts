import fs from 'node:fs';
import path from 'node:path';
import { compactLiteLLM, LITELLM_URL, type Pricing, type PriceTable } from '../core/pricing.js';

/**
 * Refresh prices from LiteLLM, caching the compact table on disk for a day.
 * Never throws: on any failure the current table stays in place.
 */
export async function refreshPricing(
  pricing: Pricing,
  cacheDir: string,
  offline: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cacheFile = path.join(cacheDir, 'litellm-prices.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { updatedAt: number; models: PriceTable };
    if (offline || Date.now() - cached.updatedAt < 24 * 3600_000) {
      pricing.setTable(cached.models, 'litellm-cache', cached.updatedAt);
      return true;
    }
  } catch {
    // no cache yet
  }
  if (offline) return false;
  try {
    const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const models = compactLiteLLM((await res.json()) as Record<string, unknown>);
    if (Object.keys(models).length < 20) return false;
    const updatedAt = Date.now();
    pricing.setTable(models, 'litellm', updatedAt);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ updatedAt, models }));
    return true;
  } catch {
    return false;
  }
}
