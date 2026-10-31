/// <reference lib="webworker" />
import { importBytes } from '../../core/importer';
import { importInfo } from '../../core/imports';
import { serializeSnapshot } from '../../core/model';
import type { DeviceImport, WorkerMessage } from './device';

/** Parses an export or log file off the main thread (big exports can take a few seconds). */

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const { file } = e.data;
  try {
    post({ type: 'progress', stage: 'Reading the file' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const results = await importBytes(file.name, bytes, (stage) => post({ type: 'progress', stage }));
    const now = Date.now();
    const imports: DeviceImport[] = results.map((r, i) => ({
      info: importInfo(r, file.name, now + i),
      snapshot: serializeSnapshot(r.snapshot),
    }));
    post({ type: 'done', imports });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
