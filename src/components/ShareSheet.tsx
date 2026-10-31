import { Download, Link2, Share, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PROVIDER_LABEL, type Provider } from '../../shared/types';
import { OTHER_COLOR, PROVIDER_COLOR, slotColor } from '../lib/colors';
import {
  applyFilters,
  autoGranularity,
  buildSeries,
  groupBy,
  isUnknownModel,
  isUnknownProject,
  presetLabel,
  rangeRanks,
  sum,
  type Data,
  type Filters,
  type Range,
} from '../lib/data';
import { compact, pct, rangeLabel, usd } from '../lib/format';
import type { Route } from '../lib/router';
import { renderShareCard, type ShareCardData, type ShareCardRow } from '../lib/shareCard';
import { useData, useFilters } from '../lib/store';

const PROVIDERS: Provider[] = ['anthropic', 'openai'];

/** What goes on the picture: the period and filters on screen, and the project when viewing one. */
function cardData(data: Data, filters: Filters, range: Range, projectKey: string | null, names: boolean): ShareCardData {
  const f = projectKey ? { ...filters, project: projectKey } : filters;
  const facts = applyFilters(data, f, range);
  const t = sum(facts);

  const byProvider = groupBy(facts, (x) => x.provider);
  const total = t.tokens || 1;
  const providers = PROVIDERS.filter((p) => (byProvider.get(p)?.tokens ?? 0) > 0).map((p) => {
    const v = byProvider.get(p)!.tokens;
    return { label: PROVIDER_LABEL[p], value: v, display: compact(v), share: pct(v / total), color: PROVIDER_COLOR[p] };
  });

  let chart: ShareCardData['chart'];
  if (range.days === 1) {
    const hours = Array.from({ length: 24 }, () => PROVIDERS.map(() => 0));
    for (const x of facts) if (x.hour >= 0) hours[x.hour][PROVIDERS.indexOf(x.provider)] += x.tokens;
    const peak = Math.max(...hours.map((h) => h[0] + h[1]));
    chart = { title: 'Hour by hour', bars: hours, colors: PROVIDERS.map((p) => PROVIDER_COLOR[p]), first: '12 AM', last: '11 PM', peak: peak ? compact(peak) : undefined };
  } else {
    const gran = autoGranularity(range);
    const { series, buckets } = buildSeries(data, facts, range, gran, 'provider', 'tokens');
    const active = new Set(facts.filter((x) => x.tokens > 0).map((x) => x.day)).size;
    const peak = Math.max(0, ...buckets.map((b) => b.total));
    chart = {
      title: gran === 'day' ? `${active} of ${range.days} days active` : gran === 'week' ? 'Week by week' : 'Month by month',
      bars: buckets.map((b) => b.values),
      colors: series.map((s) => s.color),
      first: buckets[0]?.short ?? '',
      last: buckets.at(-1)?.short ?? '',
      peak: peak ? compact(peak) : undefined,
    };
  }

  const top = (key: 'proj' | 'model'): ShareCardRow[] => {
    const ranks = rangeRanks(data, range, key);
    return [...groupBy(facts, (x) => x[key]).entries()]
      .filter(([i]) => (key === 'proj' ? !isUnknownProject(data.projects[i]) : !isUnknownModel(data.models[i])))
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 3)
      .map(([i, v]) => {
        const rank = ranks.get(i) ?? Infinity;
        return {
          label: key === 'proj' ? data.projects[i].name : data.models[i].label,
          value: v.tokens,
          display: compact(v.tokens),
          color: rank < 6 ? slotColor(rank) : OTHER_COLOR,
        };
      });
  };
  const showProjects = !projectKey && names;
  const rows = top(showProjects ? 'proj' : 'model');

  const projectName = projectKey ? data.projects[data.projectByKey.get(projectKey) ?? -1]?.name : undefined;
  const who = filters.provider === 'anthropic' ? 'Claude' : filters.provider === 'openai' ? 'OpenAI' : 'AI';
  const dates = rangeLabel(range.from, range.to);
  const preset = presetLabel(filters);
  return {
    title: projectName ?? `My ${who} usage`,
    subtitle: preset === 'Custom range' ? dates : `${preset} · ${dates}`,
    tokens: compact(t.tokens),
    cost: t.cost > 0 ? usd(t.cost) : undefined,
    providers,
    chart,
    list: rows.length ? { title: showProjects ? 'Top projects' : 'Top models', rows } : undefined,
  };
}

/** Share a picture of your usage (or the app's link) through the phone's share sheet. */
export function ShareSheet({ route, onClose }: { route: Route; onClose: () => void }) {
  const { data } = useData();
  const { filters, range } = useFilters();
  const projectKey = route.page === 'project' ? route.key : null;
  const [names, setNames] = useState(true);
  const [picture, setPicture] = useState<{ url: string; file: File } | null>(null);
  const [failed, setFailed] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const card = useMemo(() => (data ? cardData(data, filters, range, projectKey, names) : null), [data, filters, range, projectKey, names]);

  useEffect(() => {
    if (!card) return;
    let url: string | null = null;
    let cancelled = false;
    setFailed(false);
    renderShareCard(card)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        const name = `ai-usage-${new Date().toISOString().slice(0, 10)}.png`;
        setPicture({ url, file: new File([blob], name, { type: 'image/png' }) });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [card]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const canShareFile = !!picture && typeof navigator.canShare === 'function' && navigator.canShare({ files: [picture.file] });
  const canShare = typeof navigator.share === 'function';
  const appUrl = `${location.origin}${location.pathname}`;

  const save = () => {
    if (!picture) return;
    const a = document.createElement('a');
    a.href = picture.url;
    a.download = picture.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const sharePicture = async () => {
    if (!picture) return;
    if (!canShareFile) return save();
    try {
      await navigator.share({ files: [picture.file], title: card?.title });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') save();
    }
  };
  const shareLink = async () => {
    if (canShare) {
      try {
        await navigator.share({ title: 'Agent Visualiser', text: 'See where your AI tokens go', url: appUrl });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(appUrl);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      // Nothing else to try.
    }
  };

  const bigButton = 'inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-[15px] text-[17px] font-semibold transition-opacity disabled:opacity-50 lg:h-11 lg:text-[15px]';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center" role="dialog" aria-modal="true" aria-label="Share">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div
        className="sheet-up relative w-full max-w-[460px] rounded-t-[26px] border border-line bg-page px-4 pt-2.5 shadow-[var(--shadow-pop)] lg:rounded-[22px] lg:pt-4"
        style={{ paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto mb-2 h-[5px] w-10 rounded-full bg-[var(--border-strong)] lg:hidden" aria-hidden />
        <div className="flex items-center justify-between">
          <h2 className="text-[21px] font-bold tracking-[-0.01em] text-ink">Share</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-ink-2 hover:text-ink"
            aria-label="Close"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        <div className="mt-3 flex h-[min(50vh,520px)] items-center justify-center">
          {picture ? (
            <img src={picture.url} alt="A picture of your AI usage" className="h-full w-auto max-w-full rounded-[18px] border border-line object-contain shadow-[var(--shadow)]" />
          ) : failed ? (
            <p className="text-[15px] text-muted">Couldn't make the picture on this device.</p>
          ) : (
            <div className="aspect-[2/3] h-full animate-pulse rounded-[18px] bg-surface-2" />
          )}
        </div>

        {!projectKey && (
          <button
            type="button"
            role="switch"
            aria-checked={names}
            onClick={() => setNames((v) => !v)}
            className="mt-4 flex w-full items-center justify-between gap-3 rounded-[15px] border border-line bg-surface px-4 py-3 text-left"
          >
            <span>
              <span className="block text-[16px] font-medium text-ink">Show project names</span>
              <span className="block text-[13.5px] text-muted">{names ? 'Your top 3 projects are on the picture' : 'Your top 3 models instead'}</span>
            </span>
            <span className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${names ? 'bg-[var(--good)]' : 'bg-[var(--border-strong)]'}`} aria-hidden>
              <span className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-transform ${names ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
            </span>
          </button>
        )}

        <div className="mt-4 grid gap-2.5">
          <button type="button" onClick={sharePicture} disabled={!picture} className={`${bigButton} bg-ink text-page`}>
            {canShareFile ? <Share size={19} aria-hidden /> : <Download size={19} aria-hidden />}
            {canShareFile ? 'Share picture' : 'Save picture'}
          </button>
          <button type="button" onClick={shareLink} className={`${bigButton} border border-line bg-surface text-ink`}>
            <Link2 size={19} aria-hidden />
            {linkCopied ? 'Link copied' : canShare ? 'Share app link' : 'Copy app link'}
          </button>
        </div>
      </div>
    </div>
  );
}
