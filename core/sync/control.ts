import { fromB64u, toB64u } from './envelope';

/**
 * Work mode from the phone: a tiny encrypted message channel between the
 * phone and the Mac's gentle-mode helper.
 *
 * The Mac makes a random topic name and a 256-bit key, and sends both to the
 * phone inside its (end-to-end encrypted) usage update. Messages then go
 * through a public relay (ntfy.sh by default, or your own ntfy server),
 * sealed with AES-256-GCM using that key and bound to the topic. The relay
 * only ever sees ciphertext, and nobody without the key can send a command.
 *
 * Only WebCrypto is used, so the same code runs in Node 20+ and in Safari.
 */

export const DEFAULT_RELAY = 'https://ntfy.sh';

/** auto: follow the keyboard and mouse. work: keep agent jobs slowed. full: never slow them. */
export type GentleMode = 'auto' | 'work' | 'full';
export const GENTLE_MODES: GentleMode[] = ['auto', 'work', 'full'];

export interface ControlInfo {
  relay: string;
  topic: string;
  /** AES-256 key, base64url. */
  key: string;
}

/** Phone → Mac: switch mode. */
export interface SetMessage {
  t: 'set';
  mode: GentleMode;
  at: number;
  /** The sending device's key id. */
  by?: string;
  /** Random, so two identical requests never look the same. */
  n: string;
}

/** Phone → Mac: please send your state now (the app was just opened). */
export interface PingMessage {
  t: 'ping';
  at: number;
  n: string;
}

/** How agent jobs are held back while you're at the Mac. */
export type GentleHow = 'share' | 'slow' | 'pause';

export interface CpuInfo {
  cores: number;
  /** Cores' worth the agents' jobs are using now. */
  agents: number;
  /** Cores kept free for you right now (0 at full speed). */
  free: number;
  /** Cores' worth everything on the Mac is using, agents included. */
  busy?: number;
}

export interface MemInfo {
  /** Bytes in use (apps, wired and compressed, as Activity Monitor counts it). */
  used: number;
  total: number;
  /** macOS memory pressure. */
  pressure?: 'normal' | 'warn' | 'critical';
  /** Bytes swapped out to disk. */
  swap?: number;
}

/** Mac → phone: what the Mac is doing now. */
export interface StateMessage {
  t: 'state';
  mode: GentleMode;
  /** Someone is at the Mac (or work mode says so). */
  here: boolean;
  /** Why: input, media (a video or call keeps the screen awake), work, full, away. */
  reason: string;
  /** Agent jobs currently held back. */
  held: number;
  how: GentleHow;
  /** gentle while you're here (or in work mode), full when the agents have the whole Mac. */
  live?: 'gentle' | 'full';
  cpu?: CpuInfo;
  /** GPU utilisation, percent. */
  gpu?: number;
  mem?: MemInfo;
  at: number;
  n: string;
}

export type ControlMessage = SetMessage | PingMessage | StateMessage;

const PREFIX = 'av1.';

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Encryption is not available here (WebCrypto needs a secure https page)');
  return s;
};

const utf8 = (s: string) => new TextEncoder().encode(s);

function random(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function nonce(): string {
  return toB64u(random(9));
}

/** A fresh topic (unguessable, 24 characters) and key. */
export function newControlInfo(relay = DEFAULT_RELAY): ControlInfo {
  return { relay: relay.replace(/\/+$/, ''), topic: `av-${toB64u(random(15))}`, key: toB64u(random(32)) };
}

export function isControlInfo(x: unknown): x is ControlInfo {
  const c = x as ControlInfo;
  // https only, except a relay on this computer (for testing your own ntfy server).
  const relayOk = typeof c?.relay === 'string' && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$))/.test(c.relay);
  return !!c && relayOk && typeof c.topic === 'string' && /^[\w-]{8,64}$/.test(c.topic) && typeof c.key === 'string';
}

async function aesKey(info: ControlInfo): Promise<CryptoKey> {
  const raw = fromB64u(info.key);
  if (raw.length !== 32) throw new Error('Bad control key');
  return subtle().importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seal a message as `av1.<iv>.<ciphertext>` (base64url), bound to the topic. */
export async function sealControl(info: ControlInfo, msg: ControlMessage): Promise<string> {
  const iv = random(12);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(info.topic) }, await aesKey(info), utf8(JSON.stringify(msg))),
  );
  return `${PREFIX}${toB64u(iv)}.${toB64u(ct)}`;
}

/** Open a sealed message; null if it isn't one, was tampered with, or uses another key or topic. */
export async function openControl(info: ControlInfo, text: string): Promise<ControlMessage | null> {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  const [iv, ct] = text.slice(PREFIX.length).split('.');
  if (!iv || !ct) return null;
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(fromB64u(iv)), additionalData: utf8(info.topic) },
      await aesKey(info),
      new Uint8Array(fromB64u(ct)),
    );
    const msg = JSON.parse(new TextDecoder().decode(plain)) as ControlMessage;
    if (msg?.t === 'set' && GENTLE_MODES.includes(msg.mode) && Number.isFinite(msg.at)) return msg;
    if (msg?.t === 'state' && GENTLE_MODES.includes(msg.mode) && Number.isFinite(msg.at)) return msg;
    if (msg?.t === 'ping' && Number.isFinite(msg.at)) return msg;
    return null;
  } catch {
    return null;
  }
}

export const topicUrl = (info: ControlInfo) => `${info.relay}/${info.topic}`;

/** One line of ntfy's JSON stream (`/<topic>/json`). */
export interface RelayEvent {
  id: string;
  time: number;
  event: string;
  message?: string;
}

export function parseRelayLines(text: string): RelayEvent[] {
  const out: RelayEvent[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as RelayEvent;
      if (e && typeof e.event === 'string') out.push(e);
    } catch {
      // a partial or foreign line
    }
  }
  return out;
}

/** The newest state message in a relay poll, if any. */
export async function latestState(info: ControlInfo, events: RelayEvent[]): Promise<StateMessage | null> {
  let best: StateMessage | null = null;
  for (const e of events) {
    if (e.event !== 'message' || !e.message) continue;
    const m = await openControl(info, e.message);
    if (m?.t === 'state' && (!best || m.at > best.at)) best = m;
  }
  return best;
}
