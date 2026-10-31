import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Store } from './store.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function createApp(store: Store, opts: { staticDir?: string; allowedHosts?: string[] } = {}) {
  const app = new Hono();
  const allowed = new Set([...LOCAL_HOSTS, ...(opts.allowedHosts ?? [])]);

  // The API exposes local folder names and prompts, so refuse requests whose
  // Host header isn't this machine. This blocks DNS-rebinding attacks from
  // web pages you visit.
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host && !allowed.has(host)) return c.text('Forbidden host', 403);
    await next();
  });

  // State-changing calls need a custom header. Browsers won't send one
  // cross-site without a CORS preflight (which this server never approves),
  // so other web pages can't trigger refreshes.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-agent-visualiser') !== '1') {
      return c.json({ error: 'Missing x-agent-visualiser header' }, 403);
    }
    await next();
  });

  app.use('/api/*', compress());
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: store.version }));
  app.get('/api/dataset', async (c) => c.json(await store.dataset()));
  app.get('/api/live', async (c) => c.json(await store.live()));
  app.get('/api/session/:key', (c) => {
    const detail = store.session(decodeURIComponent(c.req.param('key')));
    return detail ? c.json(detail) : c.json({ error: 'Session not found' }, 404);
  });
  app.post('/api/refresh', async (c) => {
    await store.refreshAll();
    return c.json({ ok: true, version: store.version });
  });

  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    const root = path.relative(process.cwd(), staticDir) || '.';
    const indexHtml = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.html(indexHtml)));
  } else {
    app.get('/', (c) =>
      c.text('Agent Visualiser API is running. Start the web app with `npm run dev`, or build it with `npm run build`.'),
    );
  }
  return app;
}
