import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProjectRoots } from './sources/claudeCode.js';
import { codexRoots } from './sources/codex.js';

export interface Config {
  port: number;
  host: string;
  claudeRoots: string[];
  codexRoots: string[];
  anthropicAdminKey?: string;
  openaiAdminKey?: string;
  apiLookbackDays: number;
  apiRefreshMs: number;
  scanIntervalMs: number;
  pricingOffline: boolean;
  demo: 'on' | 'off' | 'auto';
  cacheDir: string;
  staticDir: string;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // Older Node without loadEnvFile: parse KEY=VALUE lines ourselves.
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const truthy = (v?: string) => v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
const falsy = (v?: string) => v !== undefined && ['0', 'false', 'no', 'off'].includes(v.toLowerCase());

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  loadDotEnv();
  const env = process.env;
  const demoFlag = argv.includes('--demo');
  const cacheBase = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return {
    port: Number(env.PORT) || 4777,
    host: env.HOST || '127.0.0.1',
    claudeRoots: claudeProjectRoots(env.CLAUDE_CONFIG_DIR),
    codexRoots: codexRoots(env.CODEX_HOME),
    anthropicAdminKey: env.ANTHROPIC_ADMIN_KEY?.trim() || undefined,
    openaiAdminKey: env.OPENAI_ADMIN_KEY?.trim() || undefined,
    apiLookbackDays: Math.min(400, Math.max(7, Number(env.API_LOOKBACK_DAYS) || 90)),
    apiRefreshMs: 30 * 60_000,
    scanIntervalMs: 8_000,
    pricingOffline: truthy(env.PRICING_OFFLINE),
    demo: demoFlag || truthy(env.DEMO) ? 'on' : falsy(env.DEMO) ? 'off' : 'auto',
    cacheDir: env.AGENT_VISUALISER_CACHE || path.join(cacheBase, 'agent-visualiser'),
    staticDir: path.join(root, 'dist'),
  };
}
