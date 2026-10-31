/**
 * Starting and replacing this repository's macOS background jobs (LaunchAgents).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const launchctl = (...args: string[]) => pexec('launchctl', args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const guiDomain = () => `gui/${process.getuid?.() ?? 501}`;

/** Whether launchd has the job loaded. */
export function isLoaded(label: string): Promise<boolean> {
  return launchctl('print', `${guiDomain()}/${label}`).then(
    () => true,
    () => false,
  );
}

/**
 * Load the plist on disk as `label`, replacing a job that is already running.
 * `bootout` returns before launchd has finished removing the old job, so a
 * `bootstrap` straight after it can fail, and the old `load -w` fallback then
 * reports success without loading anything. So: wait for the old job to go,
 * retry the bootstrap a few times, and throw unless the job is really loaded.
 */
export async function reloadAgent(label: string, plist: string): Promise<void> {
  const domain = guiDomain();
  await launchctl('bootout', `${domain}/${label}`).catch(() => undefined);
  for (let i = 0; i < 50 && (await isLoaded(label)); i++) await sleep(200);
  let lastError = '';
  for (let i = 0; i < 5 && !(await isLoaded(label)); i++) {
    if (i) await sleep(1_000);
    await launchctl('bootstrap', domain, plist).catch((err: { stderr?: string; message?: string }) => {
      lastError = String(err.stderr || err.message || err).trim();
    });
  }
  if (!(await isLoaded(label))) throw new Error(`launchd did not start ${label}${lastError ? ` (${lastError})` : ''}`);
}
