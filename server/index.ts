import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { displayPath } from '../core/util.js';

const config = loadConfig();
const store = new Store(config);
const started = Date.now();

await store.init();
const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
const app = createApp(store, { staticDir: config.staticDir, allowedHosts: localOnly ? [] : [config.host] });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  Agent Visualiser  http://${shownHost}:${info.port}  (ready in ${Date.now() - started} ms)`);
  console.log(`  Claude Code logs  ${config.claudeRoots.map(displayPath).join(', ')}`);
  console.log(`  Codex logs        ${config.codexRoots.map(displayPath).join(', ')}`);
  console.log(
    `  Anthropic API     ${config.anthropicAdminKey ? 'key set' : 'not connected'}    OpenAI API  ${config.openaiAdminKey ? 'key set' : 'not connected'}`,
  );
  if (store.isDemo) {
    console.log(`  Showing demo data${config.demo === 'on' ? ' (--demo)' : ' because no usage was found yet'}.`);
  }
  if (!localOnly) console.log('  Warning: listening beyond localhost, so anyone who can reach this address can see your usage.');
  console.log('');
});
