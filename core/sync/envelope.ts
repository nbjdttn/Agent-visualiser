import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

/**
 * End-to-end encryption for automatic updates.
 *
 * Usage numbers are published to a branch of a public GitHub repository, so
 * they are sealed for the registered devices only:
 *
 *   - every device (a phone) holds an ECDH P-256 key pair; the private key
 *     never leaves it, the public key is listed in the branch's devices/ folder;
 *   - each update is gzip-compressed JSON encrypted with a fresh AES-256-GCM
 *     content key;
 *   - the content key is wrapped for each device with a key derived (HKDF-SHA-256)
 *     from ECDH between a one-off sender key and the device's public key.
 *
 * Only WebCrypto is used, so the same code runs in Node 20+ and in Safari.
 */

export const ENVELOPE_ALG = 'ECDH-ES+HKDF-SHA256+A256GCM';
export const DEVICE_CODE_PREFIX = 'avsync1.';
const INFO = 'agent-visualiser sync v1';

export interface Envelope {
  v: 1;
  alg: typeof ENVELOPE_ALG;
  /** The sender's one-off public key (raw P-256 point, base64url). */
  epk: string;
  /** The content key, wrapped once per device. */
  recipients: { kid: string; iv: string; key: string }[];
  iv: string;
  ct: string;
}

/** A device as listed in the branch's devices/ folder. */
export interface DevicePublic {
  kid: string;
  publicKey: string;
  name?: string;
  added?: string;
}

/** A device's own key pair, as kept on the device. */
export interface DeviceKey {
  kid: string;
  publicKey: string;
  privateKey: CryptoKey;
}

export class NotForThisDevice extends Error {
  constructor() {
    super('This update was not encrypted for this device');
    this.name = 'NotForThisDevice';
  }
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Encryption is not available here (WebCrypto needs a secure https page)');
  return s;
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const AAD = utf8(INFO);

function random(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** WebCrypto wants bytes backed by a plain ArrayBuffer. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

const CHUNK = 0x8000;

export function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode and check a device public key: an uncompressed P-256 point (65 bytes, starting 0x04). */
export function publicKeyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const raw = fromB64u(publicKey.trim());
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Not a device key');
  return raw;
}

/** A short, stable id for a device key: the first 96 bits of its SHA-256. */
export async function kidOf(publicKey: string): Promise<string> {
  const hash = new Uint8Array(await subtle().digest('SHA-256', publicKeyBytes(publicKey)));
  return toB64u(hash.subarray(0, 12));
}

/** The text a person copies from the phone to register it. */
export function deviceCode(publicKey: string): string {
  return DEVICE_CODE_PREFIX + publicKey;
}

/** Read a device code (tolerating spaces and line breaks from copy and paste). */
export async function parseDeviceCode(code: string, name?: string): Promise<DevicePublic> {
  const compact = code.replace(/\s+/g, '');
  const at = compact.indexOf(DEVICE_CODE_PREFIX);
  if (at < 0) throw new Error(`A device code starts with "${DEVICE_CODE_PREFIX}"`);
  // A P-256 public key is 65 bytes: exactly 87 base64url characters.
  const publicKey = compact.slice(at + DEVICE_CODE_PREFIX.length, at + DEVICE_CODE_PREFIX.length + 87);
  publicKeyBytes(publicKey);
  return { kid: await kidOf(publicKey), publicKey, name: name?.trim() || undefined, added: new Date().toISOString().slice(0, 10) };
}

export async function generateDeviceKey(extractable = false): Promise<DeviceKey> {
  const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = toB64u(new Uint8Array(await subtle().exportKey('raw', pair.publicKey)));
  return { kid: await kidOf(publicKey), publicKey, privateKey: pair.privateKey };
}

async function wrappingKey(shared: ArrayBuffer, epkRaw: Uint8Array<ArrayBuffer>, kid: string, usage: KeyUsage): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: epkRaw, info: utf8(`${INFO} ${kid}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** Encrypt bytes for every device in the list. */
export async function seal(plain: Uint8Array, devices: DevicePublic[]): Promise<Envelope> {
  if (!devices.length) throw new Error('No devices to encrypt for');
  const s = subtle();
  const eph = (await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const epkRaw = new Uint8Array(await s.exportKey('raw', eph.publicKey));
  const cekRaw = random(32);
  const cek = await s.importKey('raw', cekRaw, 'AES-GCM', false, ['encrypt']);
  const iv = random(12);
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, cek, own(plain)));

  const recipients: Envelope['recipients'] = [];
  const done = new Set<string>();
  for (const device of devices) {
    const kid = await kidOf(device.publicKey);
    if (done.has(kid)) continue;
    done.add(kid);
    const pub = await s.importKey('raw', publicKeyBytes(device.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await s.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
    const kek = await wrappingKey(shared, epkRaw, kid, 'encrypt');
    const wiv = random(12);
    const wrapped = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: wiv }, kek, cekRaw));
    recipients.push({ kid, iv: toB64u(wiv), key: toB64u(wrapped) });
  }
  return { v: 1, alg: ENVELOPE_ALG, epk: toB64u(epkRaw), recipients, iv: toB64u(iv), ct: toB64u(ct) };
}

export function isEnvelope(value: unknown): value is Envelope {
  const e = value as Envelope;
  return Boolean(e && e.v === 1 && e.alg === ENVELOPE_ALG && typeof e.epk === 'string' && Array.isArray(e.recipients) && typeof e.ct === 'string');
}

/** Decrypt an envelope with this device's key. Throws NotForThisDevice if it wasn't sealed for it. */
export async function open(envelope: Envelope, device: { kid: string; privateKey: CryptoKey }): Promise<Uint8Array> {
  if (!isEnvelope(envelope)) throw new Error('Unsupported update format');
  const r = envelope.recipients.find((x) => x.kid === device.kid);
  if (!r) throw new NotForThisDevice();
  const s = subtle();
  const epkRaw = fromB64u(envelope.epk);
  const epk = await s.importKey('raw', epkRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await s.deriveBits({ name: 'ECDH', public: epk }, device.privateKey, 256);
  const kek = await wrappingKey(shared, epkRaw, device.kid, 'decrypt');
  const cekRaw = await s.decrypt({ name: 'AES-GCM', iv: fromB64u(r.iv) }, kek, fromB64u(r.key));
  const cek = await s.importKey('raw', cekRaw, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv: fromB64u(envelope.iv), additionalData: AAD }, cek, fromB64u(envelope.ct)));
}

/** gzip + seal a JSON value. */
export async function sealJson(value: unknown, devices: DevicePublic[]): Promise<Envelope> {
  return seal(gzipSync(strToU8(JSON.stringify(value)), { level: 9, mtime: 0 }), devices);
}

/** open + gunzip a JSON value. */
export async function openJson<T>(envelope: Envelope, device: { kid: string; privateKey: CryptoKey }): Promise<T> {
  return JSON.parse(strFromU8(gunzipSync(await open(envelope, device)))) as T;
}
