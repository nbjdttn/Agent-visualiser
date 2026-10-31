/**
 * Types shared by the server (which builds the dataset) and the web app
 * (which slices it). Everything the dashboard shows comes from one Dataset.
 */

export type Provider = 'anthropic' | 'openai';

export type SourceId = 'claude-code' | 'codex' | 'claude-ai' | 'chatgpt' | 'anthropic-api' | 'openai-api';

export const SOURCE_IDS: SourceId[] = ['claude-code', 'codex', 'claude-ai', 'chatgpt', 'anthropic-api', 'openai-api'];

export type SourceKind = 'agent' | 'chat' | 'api';

export interface SourceMeta {
  label: string;
  short: string;
  provider: Provider;
  kind: SourceKind;
  description: string;
}

export const SOURCE_META: Record<SourceId, SourceMeta> = {
  'claude-code': {
    label: 'Claude Code',
    short: 'Claude Code',
    provider: 'anthropic',
    kind: 'agent',
    description: 'Local session logs written by the Claude Code CLI, IDE and desktop apps.',
  },
  codex: {
    label: 'Codex CLI',
    short: 'Codex',
    provider: 'openai',
    kind: 'agent',
    description: 'Local session logs written by the OpenAI Codex CLI and IDE extension.',
  },
  'claude-ai': {
    label: 'claude.ai chats',
    short: 'claude.ai',
    provider: 'anthropic',
    kind: 'chat',
    description: 'Your Claude chat history, from the data export in claude.ai settings. Tokens are estimated.',
  },
  chatgpt: {
    label: 'ChatGPT chats',
    short: 'ChatGPT',
    provider: 'openai',
    kind: 'chat',
    description: 'Your ChatGPT chat history, from the data export in ChatGPT settings. Tokens are estimated.',
  },
  'anthropic-api': {
    label: 'Anthropic API',
    short: 'Anthropic API',
    provider: 'anthropic',
    kind: 'api',
    description: 'Organisation usage from the Anthropic Admin API, by model and workspace.',
  },
  'openai-api': {
    label: 'OpenAI API',
    short: 'OpenAI API',
    provider: 'openai',
    kind: 'api',
    description: 'Organisation usage from the OpenAI Admin API, by model and project.',
  },
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
};

/**
 * One aggregated row of usage. Kept as a tuple to keep the payload small.
 *
 * day   - calendar day index: Date.UTC(y, m, d) / 86_400_000 of the local date
 * hour  - local hour 0-23, or -1 when the source only reports whole days
 * src   - index into Dataset.sources
 * model - index into Dataset.models
 * proj  - index into Dataset.projects
 * Token counts never overlap: input is uncached input only, cacheRead and
 * cacheWrite are counted separately, and output includes reasoning tokens.
 */
export type FactTuple = [
  day: number,
  hour: number,
  src: number,
  model: number,
  proj: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning: number,
  requests: number,
  cost: number,
];

export interface ModelInfo {
  id: string;
  label: string;
  provider: Provider;
  /** Global rank by all-time tokens (0 = most used). Drives stable colours. */
  rank: number;
  priced: boolean;
  /** USD per million tokens, when known. */
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/**
 * folder: where an agent ran on a computer; repo: the GitHub repository a
 * Claude Code cloud session worked in; openai-project / anthropic-workspace:
 * API groupings; chat-project: a ChatGPT project, custom GPT or Claude
 * project; chats: everything else in a chat export.
 */
export type ProjectKind = 'folder' | 'repo' | 'openai-project' | 'anthropic-workspace' | 'chat-project' | 'chats';

export interface ProjectInfo {
  key: string;
  name: string;
  /** Folder path with the home directory shortened to ~ */
  path?: string;
  kind: ProjectKind;
  provider?: Provider;
  repo?: string;
  branches?: string[];
  rank: number;
}

export interface SessionInfo {
  key: string;
  id: string;
  src: number;
  proj: number;
  title: string;
  start: number;
  end: number;
  models: number[];
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  cost: number;
  /** Most used tools, [name, count], sorted by count. */
  tools: [string, number][];
  /** Tokens spent by sub-agents (Claude Code Task tool, Codex spawned agents). */
  subagentTokens: number;
  /** Token counts were estimated from text (chat exports), not reported by the API. */
  estimated?: boolean;
  prompts: number;
  branch?: string;
  entrypoint?: string;
  version?: string;
}

export interface SourceStatus {
  id: SourceId;
  label: string;
  provider: Provider;
  kind: SourceKind;
  /** Found data or a key for this source. */
  connected: boolean;
  /** Short human summary, e.g. "214 sessions in 1,204 files". */
  summary: string;
  paths?: string[];
  files?: number;
  events?: number;
  lastEventAt?: number;
  updatedAt?: number;
  error?: string;
  hint?: string;
}

/** One imported file (a chat export or a batch of agent logs). */
export interface ImportInfo {
  id: string;
  source: SourceId;
  fileName: string;
  importedAt: number;
  conversations: number;
  replies: number;
  tokens: number;
  from?: number;
  to?: number;
}

export interface PricingStatus {
  source: 'litellm' | 'litellm-cache' | 'bundled';
  updatedAt?: number;
  unpriced: string[];
}

export interface Dataset {
  version: number;
  generatedAt: number;
  timezone: string;
  demo: boolean;
  sources: SourceStatus[];
  sourceIds: SourceId[];
  models: ModelInfo[];
  projects: ProjectInfo[];
  facts: FactTuple[];
  sessions: SessionInfo[];
  pricing: PricingStatus;
}

export interface ActiveSession {
  key: string;
  source: SourceId;
  project: string;
  projectKey: string;
  path?: string;
  title: string;
  model: string;
  modelLabel: string;
  start: number;
  lastActivity: number;
  /** Tokens per minute for the last 30 minutes, oldest first. */
  perMinute: number[];
  tokensLastHour: number;
  costLastHour: number;
  requestsLastHour: number;
  tokens: number;
  cost: number;
  state: 'working' | 'idle';
}

export interface UsageBlock {
  start: number;
  end: number;
  lastActivity: number;
  tokens: number;
  cost: number;
  requests: number;
  models: string[];
  active: boolean;
}

export interface BlockStatus {
  current?: UsageBlock & {
    burnTokensPerMin: number;
    burnCostPerHour: number;
    projectedTokens: number;
    projectedCost: number;
  };
  /** The largest earlier 5-hour block (0 if none), a reference point for "how busy". */
  maxTokens: number;
  recent: UsageBlock[];
}

export interface RateLimitWindowStatus {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexLimits {
  primary?: RateLimitWindowStatus;
  secondary?: RateLimitWindowStatus;
  planType?: string;
  updatedAt: number;
}

export interface LiveStatus {
  now: number;
  version: number;
  demo: boolean;
  scanning: boolean;
  active: ActiveSession[];
  claudeBlocks: BlockStatus;
  codexBlocks: BlockStatus;
  codexLimits?: CodexLimits;
  today: Record<Provider, { tokens: number; cost: number; requests: number }>;
}

export interface SessionEvent {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  sidechain: boolean;
  tools: string[];
}

export interface SessionDetail {
  key: string;
  events: SessionEvent[];
  /** Events are hourly totals (automatic updates), not single requests. */
  hourly?: boolean;
}
