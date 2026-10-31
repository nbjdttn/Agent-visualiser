/**
 * A picture of your usage to send to someone: drawn on a canvas in the
 * current theme's colours, 1080 px wide, returned as a PNG.
 */

export interface ShareCardRow {
  label: string;
  value: number;
  display: string;
  color: string;
}

export interface ShareCardData {
  title: string;
  subtitle: string;
  tokens: string;
  cost?: string;
  /** e.g. "↑ 23% vs the previous 30 days" */
  change?: string;
  providers: (ShareCardRow & { share: string; cost?: string })[];
  chart: {
    title: string;
    /** One entry per bar: the value of each series, bottom to top. */
    bars: number[][];
    colors: string[];
    first: string;
    last: string;
    peak?: string;
  };
  /** Up to three small facts, e.g. sessions, per day, busiest day. */
  stats: { label: string; value: string; sub?: string }[];
  /** Tokens by hour of day (24 entries, one value per series). */
  hours?: { bars: number[][]; colors: string[] };
  /** One list (full width) or two (side by side). */
  lists: { title: string; rows: ShareCardRow[] }[];
}

const W = 1080;
const P = 72;
const INNER = W - P * 2;
const FONT = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

interface Theme {
  surface: string;
  text: string;
  text2: string;
  muted: string;
  grid: string;
  tile: string;
  anthropic: string;
  openai: string;
}

export async function renderShareCard(d: ShareCardData): Promise<Blob> {
  await fontsReady();
  const c: Theme = {
    surface: cssVar('--surface', '#ffffff'),
    text: cssVar('--text', '#0b0b0b'),
    text2: cssVar('--text-2', '#52514e'),
    muted: cssVar('--muted', '#898781'),
    grid: cssVar('--grid', '#e8e7e1'),
    tile: cssVar('--surface-2', '#f3f2ee'),
    anthropic: cssVar('--anthropic', '#eb6834'),
    openai: cssVar('--openai', '#1baf7a'),
  };

  // Sections, top to bottom: [height, draw]. Heights are fixed so the canvas can be sized first.
  const sections: [number, (ctx: CanvasRenderingContext2D, y: number) => void][] = [];
  const gap = (h: number) => sections.push([h, () => undefined]);

  sections.push([92, (ctx, y) => header(ctx, c, d, y)]);
  gap(60);
  const bigH = 150 + (d.cost ? 78 : 0) + (d.change ? 58 : 0);
  sections.push([bigH, (ctx, y) => bigNumbers(ctx, c, d, y)]);
  if (d.providers.length) {
    gap(56);
    sections.push([224, (ctx, y) => providerTiles(ctx, c, d, y)]);
  }
  gap(60);
  sections.push([354, (ctx, y) => barChart(ctx, c, d.chart, y)]);
  if (d.stats.length) {
    gap(52);
    sections.push([168, (ctx, y) => statTiles(ctx, c, d.stats, y)]);
  }
  if (d.hours) {
    gap(56);
    const hours = d.hours;
    sections.push([228, (ctx, y) => hourChart(ctx, c, hours, y)]);
  }
  const lists = d.lists.filter((l) => l.rows.length);
  if (lists.length) {
    gap(56);
    const rows = Math.max(...lists.map((l) => l.rows.length));
    const rowH = lists.length > 1 ? 84 : 96;
    sections.push([58 + rows * rowH, (ctx, y) => listSection(ctx, c, lists, y, rowH)]);
  }
  gap(48);
  sections.push([44, (ctx, y) => footer(ctx, c, y)]);

  const top = 80;
  const H = top + sections.reduce((a, [h]) => a + h, 0) + 72;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');

  // Background: the card surface with the same soft glows as the summary card.
  ctx.fillStyle = c.surface;
  ctx.fillRect(0, 0, W, H);
  glow(ctx, 0, 0, W * 1.15, c.anthropic, 0.13, H);
  glow(ctx, W, H, W * 1.05, c.openai, 0.11, H);

  let y = top;
  for (const [h, draw] of sections) {
    draw(ctx, y);
    y += h;
  }

  return new Promise((resolveBlob, reject) => canvas.toBlob((b) => (b ? resolveBlob(b) : reject(new Error('Could not make the picture'))), 'image/png'));
}

function header(ctx: CanvasRenderingContext2D, c: Theme, d: ShareCardData, y: number) {
  drawLogo(ctx, P, y, 92);
  setFont(ctx, 700, 50);
  ctx.fillStyle = c.text;
  ctx.fillText(fit(ctx, d.title, INNER - 120), P + 120, y + 42);
  setFont(ctx, 500, 31);
  ctx.fillStyle = c.muted;
  ctx.fillText(fit(ctx, d.subtitle, INNER - 120), P + 120, y + 84);
}

function bigNumbers(ctx: CanvasRenderingContext2D, c: Theme, d: ShareCardData, y: number) {
  setFont(ctx, 750, 172);
  ctx.fillStyle = c.text;
  ctx.fillText(d.tokens, P - 6, y + 130);
  const numW = ctx.measureText(d.tokens).width;
  setFont(ctx, 600, 46);
  ctx.fillStyle = c.muted;
  ctx.fillText('tokens', P + numW + 14, y + 130);
  let line = y + 130;
  if (d.cost) {
    line += 78;
    setFont(ctx, 700, 62);
    ctx.fillStyle = c.text;
    ctx.fillText(d.cost, P, line);
    const costW = ctx.measureText(d.cost).width;
    setFont(ctx, 500, 36);
    ctx.fillStyle = c.muted;
    ctx.fillText('at API prices', P + costW + 18, line);
  }
  if (d.change) {
    line += 58;
    setFont(ctx, 600, 33);
    ctx.fillStyle = c.text2;
    ctx.fillText(d.change, P, line);
  }
}

/** A thin split bar, then one tile per provider: tokens, cost and share. */
function providerTiles(ctx: CanvasRenderingContext2D, c: Theme, d: ShareCardData, y: number) {
  const total = d.providers.reduce((a, p) => a + p.value, 0) || 1;
  const gap = 6;
  const full = INNER - gap * (d.providers.length - 1);
  let x = P;
  for (const p of d.providers) {
    const w = Math.max(14, (full * p.value) / total);
    ctx.fillStyle = resolve(p.color);
    roundRect(ctx, x, y, Math.min(w, W - P - x), 26, 13);
    ctx.fill();
    x += w + gap;
  }

  const n = d.providers.length;
  const tileGap = 24;
  const tileW = (INNER - tileGap * (n - 1)) / n;
  const ty = y + 26 + 20;
  d.providers.forEach((p, i) => {
    const tx = P + i * (tileW + tileGap);
    ctx.fillStyle = c.tile;
    roundRect(ctx, tx, ty, tileW, 178, 30);
    ctx.fill();
    ctx.fillStyle = resolve(p.color);
    ctx.beginPath();
    ctx.arc(tx + 38, ty + 44, 10, 0, Math.PI * 2);
    ctx.fill();
    setFont(ctx, 600, 32);
    ctx.fillStyle = c.text2;
    ctx.fillText(p.label, tx + 60, ty + 55);
    setFont(ctx, 750, 64);
    ctx.fillStyle = c.text;
    ctx.fillText(fit(ctx, p.display, tileW - 56), tx + 28, ty + 126);
    setFont(ctx, 500, 30);
    ctx.fillStyle = c.muted;
    ctx.fillText(fit(ctx, p.cost ? `${p.cost} · ${p.share}` : p.share, tileW - 56), tx + 28, ty + 160);
  });
}

function barChart(ctx: CanvasRenderingContext2D, c: Theme, chart: ShareCardData['chart'], y: number) {
  setFont(ctx, 650, 34);
  ctx.fillStyle = c.text;
  ctx.fillText(chart.title, P, y + 30);
  const plotH = 240;
  const base = y + 58 + plotH;
  const peak = stackedBars(ctx, c, chart.bars, chart.colors, base, plotH - 44, 64, 9);
  if (chart.peak && peak) {
    setFont(ctx, 650, 27);
    ctx.fillStyle = c.text2;
    const lw = ctx.measureText(chart.peak).width;
    const lx = Math.max(P, Math.min(W - P - lw, peak.x - lw / 2));
    ctx.fillText(chart.peak, lx, peak.top - 14);
  }
  setFont(ctx, 500, 28);
  ctx.fillStyle = c.muted;
  ctx.fillText(chart.first, P, base + 46);
  ctx.textAlign = 'right';
  ctx.fillText(chart.last, W - P, base + 46);
  ctx.textAlign = 'left';
}

function statTiles(ctx: CanvasRenderingContext2D, c: Theme, stats: ShareCardData['stats'], y: number) {
  const n = stats.length;
  const tileGap = 24;
  const tileW = (INNER - tileGap * (n - 1)) / n;
  stats.forEach((s, i) => {
    const tx = P + i * (tileW + tileGap);
    ctx.fillStyle = c.tile;
    roundRect(ctx, tx, y, tileW, 168, 28);
    ctx.fill();
    setFont(ctx, 600, 27);
    ctx.fillStyle = c.muted;
    ctx.fillText(fit(ctx, s.label, tileW - 52), tx + 26, y + 48);
    let size = 54;
    setFont(ctx, 750, size);
    while (size > 34 && ctx.measureText(s.value).width > tileW - 52) setFont(ctx, 750, (size -= 2));
    ctx.fillStyle = c.text;
    ctx.fillText(s.value, tx + 26, y + 112);
    if (s.sub) {
      setFont(ctx, 500, 26);
      ctx.fillStyle = c.muted;
      ctx.fillText(fit(ctx, s.sub, tileW - 52), tx + 26, y + 148);
    }
  });
}

function hourChart(ctx: CanvasRenderingContext2D, c: Theme, hours: NonNullable<ShareCardData['hours']>, y: number) {
  setFont(ctx, 650, 34);
  ctx.fillStyle = c.text;
  ctx.fillText('When you work', P, y + 30);
  const plotH = 120;
  const base = y + 58 + plotH;
  stackedBars(ctx, c, hours.bars, hours.colors, base, plotH, 30, 7);
  setFont(ctx, 500, 27);
  ctx.fillStyle = c.muted;
  const slot = INNER / 24;
  for (const [h, label] of [
    [0, '12 AM'],
    [6, '6 AM'],
    [12, '12 PM'],
    [18, '6 PM'],
  ] as const) {
    ctx.fillText(label, P + h * slot + (h === 0 ? 0 : slot / 2 - ctx.measureText(label).width / 2), base + 44);
  }
}

/** Stacked bars on one baseline; returns where the tallest one ends (for a label). */
function stackedBars(
  ctx: CanvasRenderingContext2D,
  c: Theme,
  bars: number[][],
  colorList: string[],
  base: number,
  maxH: number,
  maxW: number,
  radius: number,
): { x: number; top: number } | undefined {
  const n = bars.length;
  const totals = bars.map((b) => b.reduce((a, v) => a + v, 0));
  const max = Math.max(0, ...totals);
  const slot = INNER / Math.max(1, n);
  const bw = Math.min(maxW, Math.max(3, slot * 0.72));
  const scale = max > 0 ? maxH / max : 0;
  const colors = colorList.map(resolve);
  let peak: { x: number; top: number } | undefined;
  bars.forEach((parts, i) => {
    const h = totals[i] * scale;
    if (h <= 0) return;
    const x = P + i * slot + (slot - bw) / 2;
    const top = base - Math.max(3, h);
    if (totals[i] === max && !peak) peak = { x: x + bw / 2, top };
    ctx.save();
    roundTop(ctx, x, top, bw, base - top, Math.min(radius, bw / 2));
    ctx.clip();
    let yy = base;
    parts.forEach((v, k) => {
      const ph = v * scale;
      if (ph <= 0) return;
      ctx.fillStyle = colors[k] ?? c.muted;
      ctx.fillRect(x, yy - ph, bw, ph);
      if (yy < base) {
        ctx.fillStyle = c.surface;
        ctx.fillRect(x, yy - 1.5, bw, 3);
      }
      yy -= ph;
    });
    ctx.restore();
  });
  ctx.fillStyle = c.grid;
  ctx.fillRect(P, base, INNER, 2);
  return peak;
}

function listSection(ctx: CanvasRenderingContext2D, c: Theme, lists: ShareCardData['lists'], y: number, rowH: number) {
  const two = lists.length > 1;
  const colGap = 48;
  const colW = two ? (INNER - colGap) / 2 : INNER;
  const nameSize = two ? 30 : 36;
  lists.slice(0, 2).forEach((list, col) => {
    const x0 = P + col * (colW + colGap);
    setFont(ctx, 650, 34);
    ctx.fillStyle = c.text;
    ctx.fillText(list.title, x0, y + 30);
    const maxV = Math.max(...list.rows.map((r) => r.value)) || 1;
    list.rows.forEach((r, i) => {
      const ry = y + 58 + i * rowH;
      const color = resolve(r.color);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x0 + 9, ry + (two ? 20 : 22), two ? 8 : 10, 0, Math.PI * 2);
      ctx.fill();
      setFont(ctx, 700, nameSize);
      const vw = ctx.measureText(r.display).width;
      ctx.fillStyle = c.text;
      ctx.textAlign = 'right';
      ctx.fillText(r.display, x0 + colW, ry + (two ? 31 : 34));
      ctx.textAlign = 'left';
      setFont(ctx, 500, nameSize);
      ctx.fillText(fit(ctx, r.label, colW - 28 - vw - 18), x0 + 28, ry + (two ? 31 : 34));
      const by = ry + (two ? 46 : 54);
      const bh = two ? 12 : 14;
      ctx.fillStyle = c.tile;
      roundRect(ctx, x0, by, colW, bh, bh / 2);
      ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, x0, by, Math.max(bh, (colW * r.value) / maxV), bh, bh / 2);
      ctx.fill();
    });
  });
}

function footer(ctx: CanvasRenderingContext2D, c: Theme, y: number) {
  drawLogo(ctx, P, y, 44);
  setFont(ctx, 600, 30);
  ctx.fillStyle = c.text2;
  ctx.fillText('Agent Visualiser', P + 60, y + 32);
}

async function fontsReady() {
  try {
    await Promise.all([400, 500, 600, 650, 700, 750].map((w) => document.fonts.load(`${w} 40px "Inter Variable"`)));
  } catch {
    // Falls back to the system font.
  }
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** `var(--x)` → the colour it stands for right now (canvas can't read CSS variables). */
function resolve(color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  return m ? cssVar(m[1], '#898781') : color;
}

function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    const v = parseInt(h.slice(0, 6), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (m) {
    const [r, g, b] = m[1].split(/[\s,/]+/);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number, h: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, withAlpha(color, a));
  g.addColorStop(0.65, withAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, h);
}

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

/** The text, shortened with an ellipsis until it fits. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A bar with rounded top corners and a square foot. */
function roundTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** The app icon (same geometry as the header logo), drawn at `size` px. */
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  const s = size / 32;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  const bg = ctx.createLinearGradient(0, 0, 32, 32);
  bg.addColorStop(0, '#2a2733');
  bg.addColorStop(1, '#0c0b10');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, 32, 32, 7.2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  for (const r of [9.94, 6]) {
    ctx.beginPath();
    ctx.arc(16, 16, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const arc = (r: number, degrees: number, from: string, to: string) => {
    const g = ctx.createLinearGradient(0, 0, 32, 32);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.arc(16, 16, r, -Math.PI / 2, -Math.PI / 2 + (degrees * Math.PI) / 180);
    ctx.stroke();
  };
  arc(9.94, 284, '#ffa36c', '#e2582b');
  arc(6, 212, '#5ff0b4', '#11a37f');
  const k = 0.42;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(16, 13.4);
  ctx.bezierCurveTo(16 + k, 16 - k, 16 + k, 16 - k, 18.6, 16);
  ctx.bezierCurveTo(16 + k, 16 + k, 16 + k, 16 + k, 16, 18.6);
  ctx.bezierCurveTo(16 - k, 16 + k, 16 - k, 16 + k, 13.4, 16);
  ctx.bezierCurveTo(16 - k, 16 - k, 16 - k, 16 - k, 16, 13.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
