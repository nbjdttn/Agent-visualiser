import { SOURCE_META, type ImportInfo, type SourceId, type SourceStatus } from '../shared/types';
import type { ImportResult } from './importer';

/** Book-keeping for imported files, shared by the server and the phone app. */

export function importInfo(result: ImportResult, fileName: string, now = Date.now()): ImportInfo {
  return {
    id: `${result.source}-${now.toString(36)}`,
    source: result.source,
    fileName,
    importedAt: now,
    conversations: result.summary.conversations,
    replies: result.summary.replies,
    tokens: result.summary.tokens,
    from: result.summary.from,
    to: result.summary.to,
  };
}

const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function importedSourceStatus(source: SourceId, info: ImportInfo | undefined): SourceStatus {
  const meta = SOURCE_META[source];
  const noun = meta.kind === 'chat' ? 'conversations' : 'sessions';
  return {
    id: source,
    label: meta.label,
    provider: meta.provider,
    kind: meta.kind,
    connected: Boolean(info && info.replies > 0),
    summary: info
      ? `${info.conversations.toLocaleString('en-US')} ${noun}${info.from && info.to ? `, ${fmtDate(info.from)} – ${fmtDate(info.to)}` : ''}`
      : 'Not imported yet',
    events: info?.replies,
    lastEventAt: info?.to,
    updatedAt: info?.importedAt,
  };
}
