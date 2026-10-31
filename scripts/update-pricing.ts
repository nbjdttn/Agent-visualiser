/**
 * Refresh the bundled price snapshot (core/pricing-snapshot.json) from
 * LiteLLM's public price list. The app also refreshes prices at runtime;
 * this snapshot is only the offline fallback.
 *
 *   npx tsx scripts/update-pricing.ts            # download the latest list
 *   npx tsx scripts/update-pricing.ts file.json  # use a file you downloaded
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LITELLM_URL, compactLiteLLM } from '../core/pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'core', 'pricing-snapshot.json');

async function main() {
  const local = process.argv[2];
  const raw = local
    ? JSON.parse(fs.readFileSync(local, 'utf8'))
    : await (await fetch(LITELLM_URL)).json();
  const models = compactLiteLLM(raw as Record<string, unknown>);
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(out, JSON.stringify({ updatedAt: Date.now(), source: LITELLM_URL, models: sorted }, null, 1) + '\n');
  console.log(`Wrote ${Object.keys(sorted).length} model prices to ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
