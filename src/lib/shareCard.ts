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
  providers: (ShareCardRow & { share: string })[];
  chart: {
    title: string;
    /** One entry per bar: the value of each series, bottom to top. */
    bars: number[][];
    colors: string[];
    first: string;
    last: string;
    peak?: string;
  };
  list?: { title: string; rows: ShareCardRow[] };
}

const W = 1080;
const P = 72;
const FONT = '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export async function renderShareCard(d: ShareCardData): Promise<Blob> {
  await fontsReady();
  const c = {
    surface: cssVar('--surface', '#ffffff'),
    text: cssVar('--text', '#0b0b0b'),
    text2: cssVar('--text-2', '#52514e'),
    muted: cssVar('--muted', '#898781'),
    grid: cssVar('--grid', '#e8e7e1'),
    track: cssVar('--surface-2', '#f3f2ee'),
    anthropic: cssVar('--anthropic', '#eb6834'),
    openai: cssVar('--openai', '#1baf7a'),
  };

  const bigH = d.cost ? 222 : 150;
  const splitH = d.providers.length ? 92 : 0;
  const chartH = 376;
  const listH = d.list?.rows.length ? 56 + 60 + d.list.rows.length * 96 : 0;
  const H = 80 + 92 + 72 + bigH + (splitH ? 60 + splitH : 0) + 64 + chartH + listH + 48 + 44 + 72;

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

  let y = 80;

  // Header: app icon, title, period.
  drawLogo(ctx, P, y, 92);
  setFont(ctx, 700, 50);
  ctx.fillStyle = c.text;
  ctx.fillText(fit(ctx, d.title, W - P * 2 - 120), P + 120, y + 42);
  setFont(ctx, 500, 31);
  ctx.fillStyle = c.muted;
  ctx.fillText(fit(ctx, d.subtitle, W - P * 2 - 120), P + 120, y + 84);
  y += 92 + 72;

  // The big numbers.
  setFont(ctx, 750, 172);
  ctx.fillStyle = c.text;
  ctx.fillText(d.tokens, P - 6, y + 130);
  const numW = ctx.measureText(d.tokens).width;
  setFont(ctx, 600, 46);
  ctx.fillStyle = c.muted;
  ctx.fillText('tokens', P + numW + 14, y + 130);
  if (d.cost) {
    setFont(ctx, 700, 62);
    ctx.fillStyle = c.text;
    ctx.fillText(d.cost, P, y + 208);
    const costW = ctx.measureText(d.cost).width;
    setFont(ctx, 500, 36);
    ctx.fillStyle = c.muted;
    ctx.fillText('at API prices', P + costW + 18, y + 208);
  }
  y += bigH;

  // Claude / OpenAI split.
  if (d.providers.length) {
    y += 60;
    const total = d.providers.reduce((a, p) => a + p.value, 0) || 1;
    const gap = 6;
    const full = W - P * 2 - gap * (d.providers.length - 1);
    let x = P;
    for (const p of d.providers) {
      const w = Math.max(14, (full * p.value) / total);
      ctx.fillStyle = resolve(p.color);
      roundRect(ctx, x, y, Math.min(w, W - P - x), 30, 15);
      ctx.fill();
      x += w + gap;
    }
    x = P;
    for (const p of d.providers) {
      ctx.fillStyle = resolve(p.color);
      ctx.beginPath();
      ctx.arc(x + 10, y + 30 + 37, 10, 0, Math.PI * 2);
      ctx.fill();
      x += 32;
      setFont(ctx, 500, 34);
      ctx.fillStyle = c.text2;
      ctx.fillText(p.label, x, y + 30 + 49);
      x += ctx.measureText(p.label).width + 14;
      setFont(ctx, 700, 34);
      ctx.fillStyle = c.text;
      ctx.fillText(p.display, x, y + 30 + 49);
      x += ctx.measureText(p.display).width + 12;
      setFont(ctx, 500, 30);
      ctx.fillStyle = c.muted;
      ctx.fillText(p.share, x, y + 30 + 49);
      x += ctx.measureText(p.share).width + 44;
    }
    y += splitH;
  }

  // Bars over time.
  y += 64;
  setFont(ctx, 650, 34);
  ctx.fillStyle = c.text;
  ctx.fillText(d.chart.title, P, y + 30);
  const plotTop = y + 60;
  const plotH = 260;
  const base = plotTop + plotH;
  const n = d.chart.bars.length;
  const totals = d.chart.bars.map((b) => b.reduce((a, v) => a + v, 0));
  const max = Math.max(0, ...totals);
  const slot = (W - P * 2) / Math.max(1, n);
  const bw = Math.min(64, Math.max(3, slot * 0.72));
  const scale = max > 0 ? (plotH - 44) / max : 0;
  const colors = d.chart.colors.map(resolve);
  let peakAt = -1;
  d.chart.bars.forEach((parts, i) => {
    const h = totals[i] * scale;
    if (h <= 0) return;
    if (totals[i] === max && peakAt < 0) peakAt = i;
    const x = P + i * slot + (slot - bw) / 2;
    const top = base - Math.max(3, h);
    ctx.save();
    roundTop(ctx, x, top, bw, base - top, Math.min(9, bw / 2));
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
  ctx.fillRect(P, base, W - P * 2, 2);
  if (d.chart.peak && peakAt >= 0) {
    setFont(ctx, 650, 27);
    ctx.fillStyle = c.text2;
    const label = d.chart.peak;
    const lw = ctx.measureText(label).width;
    const cx = P + peakAt * slot + slot / 2;
    const lx = Math.max(P, Math.min(W - P - lw, cx - lw / 2));
    ctx.fillText(label, lx, base - max * scale - 14);
  }
  setFont(ctx, 500, 28);
  ctx.fillStyle = c.muted;
  ctx.textAlign = 'left';
  ctx.fillText(d.chart.first, P, base + 46);
  ctx.textAlign = 'right';
  ctx.fillText(d.chart.last, W - P, base + 46);
  ctx.textAlign = 'left';
  y += chartH;

  // What it went on.
  if (d.list?.rows.length) {
    y += 56;
    setFont(ctx, 650, 34);
    ctx.fillStyle = c.text;
    ctx.fillText(d.list.title, P, y + 30);
    y += 60;
    const maxV = Math.max(...d.list.rows.map((r) => r.value)) || 1;
    for (const r of d.list.rows) {
      const color = resolve(r.color);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(P + 10, y + 22, 10, 0, Math.PI * 2);
      ctx.fill();
      setFont(ctx, 700, 36);
      const vw = ctx.measureText(r.display).width;
      ctx.fillStyle = c.text;
      ctx.textAlign = 'right';
      ctx.fillText(r.display, W - P, y + 34);
      ctx.textAlign = 'left';
      setFont(ctx, 500, 36);
      ctx.fillText(fit(ctx, r.label, W - P * 2 - 32 - vw - 28), P + 32, y + 34);
      ctx.fillStyle = c.track;
      roundRect(ctx, P, y + 54, W - P * 2, 14, 7);
      ctx.fill();
      ctx.fillStyle = color;
      roundRect(ctx, P, y + 54, Math.max(14, ((W - P * 2) * r.value) / maxV), 14, 7);
      ctx.fill();
      y += 96;
    }
  }

  // Footer.
  y += 48;
  drawLogo(ctx, P, y, 44);
  setFont(ctx, 600, 30);
  ctx.fillStyle = c.text2;
  ctx.fillText('Agent Visualiser', P + 60, y + 32);

  return new Promise((resolveBlob, reject) => canvas.toBlob((b) => (b ? resolveBlob(b) : reject(new Error('Could not make the picture'))), 'image/png'));
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
