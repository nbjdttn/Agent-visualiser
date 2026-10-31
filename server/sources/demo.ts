import type { CodexLimits, SourceId, SourceStatus } from '../../shared/types.js';
import { newSessionMeta, type ProjectHint, type RawEvent, type SessionMeta, type SourceSnapshot } from '../model.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, displayPath, folderName, homeJoin, normalizeFolder } from '../util.js';

/**
 * Generates a realistic, deterministic usage history so the dashboard has
 * something to show before any real data is connected (or with --demo).
 * Two sessions are "in progress" and keep ticking while the server runs.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoProject {
  rel: string;
  weight: number;
  claudeShare: number;
  from: number;
  to: number;
  repo?: string;
  branches: string[];
  titles: string[];
}

const PROJECTS: DemoProject[] = [
  {
    rel: 'code/atlas-api',
    weight: 1.4,
    claudeShare: 0.62,
    from: 178,
    to: 0,
    repo: 'github.com/demo-lab/atlas-api',
    branches: ['main', 'feat/rate-limits', 'fix/token-refresh', 'chore/deps'],
    titles: [
      'Add rate limiting to the public endpoints',
      'Fix flaky token refresh test',
      'Migrate search to Postgres full-text',
      'Write OpenAPI docs for v2 routes',
      'Investigate slow /reports query',
      'Add retry with backoff to webhook sender',
    ],
  },
  {
    rel: 'code/nebula-web',
    weight: 1.05,
    claudeShare: 0.48,
    from: 165,
    to: 4,
    repo: 'github.com/demo-lab/nebula-web',
    branches: ['main', 'feat/dark-mode', 'feat/onboarding'],
    titles: [
      'Build onboarding checklist component',
      'Dark mode for settings pages',
      'Fix hydration warning on dashboard',
      'Replace chart library with custom SVG',
      'Accessibility pass on forms',
    ],
  },
  {
    rel: 'research/thesis-nlp',
    weight: 1.0,
    claudeShare: 0.34,
    from: 180,
    to: 0,
    repo: 'github.com/demo-lab/thesis-nlp',
    branches: ['main', 'exp/contrastive', 'exp/distill'],
    titles: [
      'Speed up the evaluation harness',
      'Add contrastive loss ablation',
      'Plot attention entropy per layer',
      'Refactor data loaders for streaming',
      'Reproduce baseline numbers from the paper',
    ],
  },
  {
    rel: 'teaching/ml-course-2026',
    weight: 0.85,
    claudeShare: 0.72,
    from: 125,
    to: 0,
    branches: ['main'],
    titles: [
      'Draft week 6 lab on transformers',
      'Write autograder tests for assignment 3',
      'Turn lecture notes into Jupyter exercises',
      'Generate quiz questions on regularisation',
      'Fix broken links in course site',
    ],
  },
  {
    rel: 'research/paper-2026-icml',
    weight: 0.9,
    claudeShare: 0.55,
    from: 80,
    to: 22,
    branches: ['main', 'camera-ready'],
    titles: [
      'Tighten related work section',
      'Regenerate figures with new colour palette',
      'Check proofs in appendix B',
      'Rebuttal: extra experiments table',
    ],
  },
  {
    rel: 'code/grading-toolkit',
    weight: 0.6,
    claudeShare: 0.4,
    from: 95,
    to: 18,
    repo: 'github.com/demo-lab/grading-toolkit',
    branches: ['main', 'feat/plagiarism-report'],
    titles: ['Export grades to CSV for the registry', 'Plagiarism similarity report', 'Batch-feedback templates'],
  },
  {
    rel: 'code/lab-website',
    weight: 0.35,
    claudeShare: 0.82,
    from: 150,
    to: 55,
    branches: ['main'],
    titles: ['Add publications page', 'Migrate site to Astro', 'Team profiles grid'],
  },
  {
    rel: 'code/agent-visualiser',
    weight: 1.7,
    claudeShare: 0.78,
    from: 5,
    to: 0,
    repo: 'github.com/nbjdttn/Agent-visualiser',
    branches: ['main', 'claude/ai-usage-dashboard'],
    titles: ['Unified AI usage dashboard', 'Parse Codex rollout files', 'Calendar heatmap polish', 'Live agents panel'],
  },
  {
    rel: 'code/dotfiles',
    weight: 0.15,
    claudeShare: 0.5,
    from: 180,
    to: 0,
    branches: ['main'],
    titles: ['Tidy zsh config', 'Set up new laptop'],
  },
];

const CLAUDE_TOOLS: [string, number][] = [
  ['Read', 30],
  ['Bash', 24],
  ['Edit', 20],
  ['Grep', 8],
  ['Glob', 5],
  ['Write', 4],
  ['TodoWrite', 3],
  ['Task', 2],
  ['WebFetch', 1.5],
  ['WebSearch', 1],
  ['mcp__github__create_pull_request', 0.6],
];

const CODEX_TOOLS: [string, number][] = [
  ['shell', 55],
  ['apply_patch', 25],
  ['update_plan', 10],
  ['web_search', 5],
  ['view_image', 3],
  ['mcp__github__get_issue', 2],
];

export class DemoSource {
  private rand: () => number;
  private memo?: SourceSnapshot;
  private events: RawEvent[] = [];
  private sessions = new Map<string, SessionMeta>();
  private projects = new Map<string, ProjectHint>();
  private live: { key: string; source: SourceId; projectKey: string; model: string; ctx: number }[] = [];
  private lastTick = 0;
  private limits!: CodexLimits;

  constructor(private now = Date.now(), seed = 20261031) {
    this.rand = mulberry32(seed);
    this.generate();
  }

  // --- random helpers -------------------------------------------------------
  private r(a = 0, b = 1) {
    return a + (b - a) * this.rand();
  }
  private int(a: number, b: number) {
    return Math.floor(this.r(a, b + 1));
  }
  private gauss(mean = 0, sd = 1) {
    const u = 1 - this.rand();
    const v = this.rand();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  private poisson(lambda: number) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.rand();
    } while (p > L);
    return k - 1;
  }
  private weighted<T>(items: [T, number][]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let x = this.r(0, total);
    for (const [item, w] of items) {
      x -= w;
      if (x <= 0) return item;
    }
    return items[items.length - 1][0];
  }

  private claudeModel(daysAgo: number, sub: boolean): string {
    if (sub) return daysAgo > 70 ? 'claude-haiku-4-5' : 'claude-haiku-5-5';
    if (daysAgo > 120) return this.rand() < 0.68 ? 'claude-opus-4-8' : 'claude-sonnet-4-6';
    if (daysAgo > 55) return this.rand() < 0.6 ? 'claude-opus-5' : 'claude-sonnet-5';
    return this.rand() < 0.66 ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
  }

  private codexModel(daysAgo: number): string {
    if (daysAgo > 100) return 'gpt-5.3-codex';
    if (daysAgo > 38) return 'gpt-5.5';
    return this.rand() < 0.62 ? 'gpt-6.1-sol' : 'gpt-5.5';
  }

  private projectKey(p: DemoProject) {
    return `dir:${normalizeFolder(homeJoin(...p.rel.split('/')))}`;
  }

  private addProjectHints() {
    for (const p of PROJECTS) {
      const key = this.projectKey(p);
      const folder = key.slice(4);
      this.projects.set(key, {
        key,
        kind: 'folder',
        name: folderName(folder),
        path: displayPath(folder),
        repo: p.repo,
        branches: new Set(p.branches),
      });
    }
    const api: [string, ProjectHint['kind'], string, 'anthropic' | 'openai'][] = [
      ['anthropic-ws:wrkspc_research', 'anthropic-workspace', 'Research pipeline', 'anthropic'],
      ['anthropic-ws:default', 'anthropic-workspace', 'Default workspace', 'anthropic'],
      ['openai-proj:proj_course_bot', 'openai-project', 'Course assistant bot', 'openai'],
      ['openai-proj:proj_autograder', 'openai-project', 'Auto-grader', 'openai'],
      ['openai-proj:default', 'openai-project', 'Default project', 'openai'],
    ];
    for (const [key, kind, name, provider] of api) this.projects.set(key, { key, kind, name, provider });
  }

  /** Generate one agent session and its responses. */
  private session(
    source: 'claude-code' | 'codex',
    p: DemoProject,
    start: number,
    minutes: number,
    opts: { title?: string; model?: string; until?: number; live?: boolean } = {},
  ) {
    const daysAgo = (this.now - start) / DAY_MS;
    const id = `demo-${source}-${Math.floor(start / 1000).toString(36)}-${this.int(100, 999)}`;
    const key = `${source}:${id}`;
    const projectKey = this.projectKey(p);
    const meta = newSessionMeta(key, id, source, projectKey, start);
    meta.cwd = projectKey.slice(4);
    meta.title = opts.title ?? p.titles[this.int(0, p.titles.length - 1)];
    meta.titleRank = 3;
    meta.branch = p.branches[this.int(0, p.branches.length - 1)];
    meta.repo = p.repo;
    meta.entrypoint = source === 'claude-code' ? this.weighted([['cli', 70], ['vscode', 22], ['desktop', 8]]) : 'codex_cli_rs';
    meta.version = source === 'claude-code' ? `2.1.${Math.max(120, 316 - Math.floor(daysAgo * 1.1))}` : `0.${Math.max(60, 98 - Math.floor(daysAgo / 6))}.0`;
    const model = opts.model ?? (source === 'claude-code' ? this.claudeModel(daysAgo, false) : this.codexModel(daysAgo));
    const end = Math.min(start + minutes * MINUTE_MS, opts.until ?? this.now - 30_000);
    const perMinute = source === 'claude-code' ? this.r(0.7, 1.9) : this.r(0.35, 0.9);
    const requests = Math.max(2, Math.round(minutes * perMinute));
    let ctx = source === 'claude-code' ? this.r(18_000, 32_000) : this.r(12_000, 20_000);
    const compactAt = this.r(170_000, 280_000);
    let t = start;
    const step = (end - start) / requests;
    let last = start;
    for (let i = 0; i < requests; i++) {
      t = start + step * i + this.r(0, step * 0.8);
      if (t > end) break;
      last = t;
      if (source === 'claude-code') {
        const ev = this.claudeEvent(key, projectKey, model, t, ctx, daysAgo, false);
        ctx += this.r(1_500, 6_500);
        if (ctx > compactAt) ctx = this.r(28_000, 40_000);
        if (ev.tools?.includes('Task')) {
          const subModel = this.claudeModel(daysAgo, true);
          let subCtx = this.r(9_000, 16_000);
          const n = this.int(3, 10);
          for (let j = 0; j < n; j++) {
            this.claudeEvent(key, projectKey, subModel, t + (j + 1) * this.r(4_000, 12_000), subCtx, daysAgo, true);
            subCtx += this.r(1_000, 4_000);
          }
        }
      } else {
        this.codexEvent(key, projectKey, model, t, ctx, i === 0);
        ctx += this.r(2_000, 8_500);
        if (ctx > compactAt) ctx = this.r(22_000, 30_000);
      }
      if (this.rand() < 1 / 8 || i === 0) meta.promptIds.add(`${key}:${i}`);
    }
    meta.lastTs = last;
    meta.lastWrite = last;
    this.sessions.set(key, meta);
    if (opts.live) this.live.push({ key, source, projectKey, model, ctx });
  }

  private claudeEvent(
    sessionKey: string,
    projectKey: string,
    model: string,
    ts: number,
    ctx: number,
    daysAgo: number,
    sidechain: boolean,
  ): RawEvent {
    const cacheRead = Math.round(ctx * this.r(0.9, 0.985));
    const cacheWrite = Math.round(ctx - cacheRead + this.r(200, 3_200));
    const output = Math.round(Math.min(9_000, Math.max(30, Math.exp(this.gauss(6.0, 0.9)))));
    const tools: string[] = [];
    const nTools = this.weighted([[0, 18], [1, 62], [2, 16], [3, 4]]);
    for (let k = 0; k < nTools; k++) tools.push(this.weighted(CLAUDE_TOOLS));
    const ev: RawEvent = {
      key: `demo:${sessionKey}:${ts}:${this.int(0, 1e9)}`,
      ts,
      source: 'claude-code',
      model,
      projectKey,
      sessionKey,
      input: this.int(1, 14),
      output,
      cacheRead,
      cacheWrite,
      cacheWrite1h: daysAgo < 100 && !sidechain ? cacheWrite : 0,
      reasoning: Math.round(output * this.r(0.15, 0.6)),
      requests: 1,
      sidechain,
      tools: tools.length ? tools : undefined,
    };
    this.events.push(ev);
    return ev;
  }

  private codexEvent(sessionKey: string, projectKey: string, model: string, ts: number, ctx: number, first: boolean) {
    const cached = first ? 0 : Math.round(ctx * this.r(0.72, 0.95));
    const output = Math.round(Math.min(12_000, Math.max(80, Math.exp(this.gauss(6.7, 0.8)))));
    const tools: string[] = [];
    const nTools = this.weighted([[0, 10], [1, 55], [2, 25], [3, 10]]);
    for (let k = 0; k < nTools; k++) tools.push(this.weighted(CODEX_TOOLS));
    this.events.push({
      key: `demo:${sessionKey}:${ts}:${this.int(0, 1e9)}`,
      ts,
      source: 'codex',
      model,
      projectKey,
      sessionKey,
      input: Math.round(ctx) - cached,
      output,
      cacheRead: cached,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: Math.round(output * this.r(0.3, 0.7)),
      requests: 1,
      tools: tools.length ? tools : undefined,
    });
  }

  private apiDay(
    source: 'anthropic-api' | 'openai-api',
    projectKey: string,
    model: string,
    day: number,
    scale: number,
    shape: { cacheShare: number; outRatio: number; perRequest: number; batch?: boolean },
  ) {
    if (scale <= 0) return;
    const promptTokens = Math.round(scale * this.r(0.75, 1.25));
    const cacheRead = Math.round(promptTokens * shape.cacheShare);
    const cacheWrite = source === 'anthropic-api' ? Math.round(promptTokens * 0.04) : 0;
    this.events.push({
      key: '',
      ts: day * DAY_MS,
      source,
      model,
      projectKey,
      input: promptTokens - cacheRead - cacheWrite,
      output: Math.round(promptTokens * shape.outRatio * this.r(0.8, 1.2)),
      cacheRead,
      cacheWrite,
      cacheWrite1h: 0,
      reasoning: 0,
      requests: source === 'openai-api' ? Math.max(1, Math.round(promptTokens / shape.perRequest)) : 0,
      batch: shape.batch,
      daily: true,
    });
  }

  private generate() {
    this.addProjectHints();
    const today = new Date(this.now);
    today.setHours(0, 0, 0, 0);

    for (let d = 180; d >= 0; d--) {
      const date = new Date(today);
      date.setDate(today.getDate() - d);
      const dow = date.getDay();
      const weekday = dow === 0 ? 0.35 : dow === 6 ? 0.45 : 1;
      const growth = 0.42 + 0.58 * Math.pow(1 - d / 180, 1.3);
      const away = d >= 95 && d <= 101 ? 0.12 : 1; // a quiet conference week
      const lambda = 3.4 * weekday * growth * away;
      const n = this.poisson(lambda);
      for (let i = 0; i < n; i++) {
        const active = PROJECTS.filter((p) => d <= p.from && d >= p.to);
        if (!active.length) continue;
        const p = this.weighted(active.map((x) => [x, x.weight] as [DemoProject, number]));
        const source = this.rand() < p.claudeShare ? 'claude-code' : 'codex';
        const hour = this.weighted<number>([
          [this.gauss(10.5, 1.2), 30],
          [this.gauss(15, 1.6), 36],
          [this.gauss(21.5, 1.1), 24],
          [this.r(0, 24), 10],
        ]);
        const start = date.getTime() + Math.min(23.8, Math.max(0, hour)) * HOUR_MS;
        if (start > this.now - 2 * HOUR_MS) continue;
        const minutes = Math.min(240, Math.max(5, 6 + Math.exp(this.gauss(3.35, 0.7))));
        this.session(source, p, start, minutes);
      }

      // Organisation API usage (daily buckets, UTC days).
      const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
      const term = d <= 120 ? 1 : 0;
      const lectureDay = dow === 2 || dow === 4 ? 1.8 : 1;
      this.apiDay('anthropic-api', 'anthropic-ws:wrkspc_research', 'claude-sonnet-5-5', day, d < 60 ? 5.2e6 * weekday * growth : 0, {
        cacheShare: 0.62,
        outRatio: 0.06,
        perRequest: 9_000,
        batch: dow === 0,
      });
      this.apiDay('anthropic-api', 'anthropic-ws:wrkspc_research', d < 60 ? 'claude-haiku-5-5' : 'claude-haiku-4-5', day, 2.4e6 * weekday * growth, {
        cacheShare: 0.4,
        outRatio: 0.09,
        perRequest: 3_000,
      });
      this.apiDay('anthropic-api', 'anthropic-ws:default', d < 60 ? 'claude-opus-5-5' : 'claude-opus-5', day, this.rand() < 0.5 ? 0.6e6 * weekday : 0, {
        cacheShare: 0.3,
        outRatio: 0.12,
        perRequest: 12_000,
      });
      this.apiDay('openai-api', 'openai-proj:proj_course_bot', 'gpt-5.4-mini', day, 1.5e6 * term * weekday * lectureDay, {
        cacheShare: 0.55,
        outRatio: 0.18,
        perRequest: 2_400,
      });
      this.apiDay('openai-api', 'openai-proj:proj_course_bot', 'text-embedding-3-small', day, 0.9e6 * term * weekday, {
        cacheShare: 0,
        outRatio: 0,
        perRequest: 800,
      });
      this.apiDay('openai-api', 'openai-proj:proj_autograder', 'o4-mini', day, d <= 95 && d >= 18 ? 0.8e6 * weekday : 0, {
        cacheShare: 0.35,
        outRatio: 0.35,
        perRequest: 5_000,
        batch: true,
      });
      this.apiDay('openai-api', 'openai-proj:default', 'gpt-5.5', day, this.rand() < 0.35 ? 0.4e6 : 0, {
        cacheShare: 0.2,
        outRatio: 0.2,
        perRequest: 6_000,
      });
    }

    // Sessions happening right now, plus one that just went idle.
    const byRel = (rel: string) => PROJECTS.find((p) => p.rel === rel)!;
    this.session('claude-code', byRel('code/agent-visualiser'), this.now - 38 * MINUTE_MS, 60, {
      title: 'Unified AI usage dashboard',
      model: 'claude-opus-5-5',
      until: this.now - 20_000,
      live: true,
    });
    this.session('codex', byRel('research/thesis-nlp'), this.now - 24 * MINUTE_MS, 60, {
      title: 'Speed up the evaluation harness',
      model: 'gpt-6.1-sol',
      until: this.now - 55_000,
      live: true,
    });
    this.session('claude-code', byRel('teaching/ml-course-2026'), this.now - 52 * MINUTE_MS, 43, {
      title: 'Draft week 6 lab on transformers',
      model: 'claude-sonnet-5-5',
    });

    this.limits = {
      primary: { usedPercent: 37, windowMinutes: 300, resetsAt: this.now + 2 * HOUR_MS + 14 * MINUTE_MS },
      secondary: { usedPercent: 22, windowMinutes: 10_080, resetsAt: this.now + 3 * DAY_MS + 6 * HOUR_MS },
      planType: 'pro',
      updatedAt: this.now - 55_000,
    };
    this.events.sort((a, b) => a.ts - b.ts);
    this.lastTick = this.now;
  }

  /** Keep the live sessions working while the server runs. Returns true when data changed. */
  tick(now = Date.now()): boolean {
    if (now - this.lastTick < 12_000) return false;
    const steps = Math.min(4, Math.floor((now - this.lastTick) / 12_000));
    for (const s of this.live) {
      for (let k = 0; k < steps; k++) {
        const ts = now - (steps - k - 1) * 12_000 - this.r(0, 4_000);
        if (s.source === 'claude-code') this.claudeEvent(s.key, s.projectKey, s.model, ts, s.ctx, 0, false);
        else this.codexEvent(s.key, s.projectKey, s.model, ts, s.ctx, false);
        s.ctx += this.r(1_500, 5_000);
        if (s.ctx > 220_000) s.ctx = 30_000;
      }
      const meta = this.sessions.get(s.key);
      if (meta) {
        meta.lastTs = now;
        meta.lastWrite = now;
      }
    }
    if (this.limits.primary) this.limits.primary.usedPercent = Math.min(99, this.limits.primary.usedPercent + 0.2 * steps);
    this.limits.updatedAt = now;
    this.lastTick = now;
    this.memo = undefined;
    return true;
  }

  snapshot(): SourceSnapshot {
    if (!this.memo) {
      this.memo = {
        events: this.events,
        sessions: this.sessions,
        projects: this.projects,
        codexLimits: { ...this.limits },
      };
    }
    return this.memo;
  }

  status(): SourceStatus[] {
    const count = (id: SourceId) => this.events.filter((e) => e.source === id).length;
    const sessionsOf = (id: SourceId) => [...this.sessions.values()].filter((s) => s.source === id).length;
    return [
      {
        id: 'claude-code',
        label: 'Claude Code',
        provider: 'anthropic',
        kind: 'agent',
        connected: true,
        summary: `Demo: ${sessionsOf('claude-code')} generated sessions`,
        events: count('claude-code'),
      },
      {
        id: 'codex',
        label: 'Codex CLI',
        provider: 'openai',
        kind: 'agent',
        connected: true,
        summary: `Demo: ${sessionsOf('codex')} generated sessions`,
        events: count('codex'),
      },
      {
        id: 'anthropic-api',
        label: 'Anthropic API',
        provider: 'anthropic',
        kind: 'api',
        connected: true,
        summary: 'Demo: 2 generated workspaces',
        events: count('anthropic-api'),
      },
      {
        id: 'openai-api',
        label: 'OpenAI API',
        provider: 'openai',
        kind: 'api',
        connected: true,
        summary: 'Demo: 3 generated projects',
        events: count('openai-api'),
      },
    ];
  }
}
