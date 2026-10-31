import type { Dataset, LiveStatus, SessionDetail, SourceStatus } from '../shared/types.js';
import { buildDataset, type Built } from './aggregate.js';
import type { Config } from './config.js';
import { computeLive } from './live.js';
import type { SourceSnapshot } from './model.js';
import { Pricing } from './pricing.js';
import { ApiUsageSource } from './sources/apis.js';
import { ClaudeCodeSource } from './sources/claudeCode.js';
import { CodexSource } from './sources/codex.js';
import { DemoSource } from './sources/demo.js';

/**
 * Owns every data source, re-scans them on demand and keeps the built
 * dataset. `version` increases whenever the dataset changes, so the web app
 * knows when to re-fetch.
 */
export class Store {
  version = 0;
  private built?: Built;
  private readonly pricing = new Pricing();
  private readonly claude: ClaudeCodeSource;
  private readonly codex: CodexSource;
  private readonly apis: ApiUsageSource[];
  private demoSource?: DemoSource;
  private scanPromise?: Promise<void>;
  private lastScan = 0;
  private scanning = false;

  constructor(private readonly config: Config) {
    this.claude = new ClaudeCodeSource(config.claudeRoots);
    this.codex = new CodexSource(config.codexRoots);
    this.apis = [
      new ApiUsageSource({
        id: 'anthropic-api',
        key: config.anthropicAdminKey,
        lookbackDays: config.apiLookbackDays,
        cacheDir: config.cacheDir,
        refreshMs: config.apiRefreshMs,
      }),
      new ApiUsageSource({
        id: 'openai-api',
        key: config.openaiAdminKey,
        lookbackDays: config.apiLookbackDays,
        cacheDir: config.cacheDir,
        refreshMs: config.apiRefreshMs,
      }),
    ];
  }

  /** First load: scan local logs, then fetch prices and API usage in the background. */
  async init(): Promise<void> {
    await this.scan(true);
    void this.pricing.refresh(this.config.cacheDir, this.config.pricingOffline).then((ok) => ok && this.rebuild());
    void this.refreshApis(true);
  }

  get isDemo(): boolean {
    if (this.config.demo === 'on') return true;
    if (this.config.demo === 'off') return false;
    return this.realSnapshots().every((s) => s.events.length === 0);
  }

  private realSnapshots(): SourceSnapshot[] {
    return [this.claude.snapshot(), this.codex.snapshot(), ...this.apis.map((a) => a.snapshot())];
  }

  /** Re-scan local logs if the scan interval has passed. Concurrent callers share one scan. */
  scan(force = false): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    if (!force && Date.now() - this.lastScan < this.config.scanIntervalMs) return Promise.resolve();
    this.scanning = true;
    this.scanPromise = (async () => {
      try {
        const [a, b] = await Promise.all([this.claude.scan(), this.codex.scan()]);
        this.lastScan = Date.now();
        if (a || b || !this.built) this.rebuild();
      } finally {
        this.scanning = false;
        this.scanPromise = undefined;
      }
    })();
    return this.scanPromise;
  }

  async refreshApis(force = false): Promise<void> {
    const results = await Promise.all(this.apis.map((a) => a.refresh(force)));
    if (results.some(Boolean)) this.rebuild();
  }

  private rebuild() {
    const demo = this.isDemo;
    let snapshots: SourceSnapshot[];
    let statuses: SourceStatus[];
    if (demo) {
      this.demoSource ??= new DemoSource();
      snapshots = [this.demoSource.snapshot()];
      statuses = this.demoSource.status();
    } else {
      snapshots = this.realSnapshots();
      statuses = [this.claude.status(), this.codex.status(), ...this.apis.map((a) => a.status())];
    }
    this.version += 1;
    this.built = buildDataset({ snapshots, pricing: this.pricing, statuses, demo, version: this.version });
  }

  private ensureBuilt(): Built {
    if (!this.built) this.rebuild();
    return this.built!;
  }

  async dataset(): Promise<Dataset> {
    await this.scan();
    return this.ensureBuilt().dataset;
  }

  async live(): Promise<LiveStatus> {
    await this.scan();
    void this.refreshApis();
    if (this.built?.dataset.demo && this.demoSource?.tick()) this.rebuild();
    const built = this.ensureBuilt();
    const limits = built.dataset.demo ? this.demoSource?.snapshot().codexLimits : this.codex.snapshot().codexLimits;
    return computeLive({
      built,
      now: Date.now(),
      version: this.version,
      demo: built.dataset.demo,
      scanning: this.scanning,
      codexLimits: limits,
    });
  }

  session(key: string): SessionDetail | undefined {
    const list = this.ensureBuilt().eventsBySession.get(key);
    if (!list) return undefined;
    return {
      key,
      events: list.map((e) => ({
        ts: e.ts,
        model: e.model,
        input: e.input,
        output: e.output,
        cacheRead: e.cacheRead,
        cacheWrite: e.cacheWrite,
        reasoning: e.reasoning,
        cost: e.cost ?? 0,
        sidechain: Boolean(e.sidechain),
        tools: e.tools ?? [],
      })),
    };
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.scan(true), this.refreshApis(true)]);
    this.rebuild();
  }
}
