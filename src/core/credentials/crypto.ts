/**
 * Primitives the vault is built from, on Web Crypto so the same code runs in Electron's main
 * process (Node's `globalThis.crypto`) and inside the Android chrome WebView.
 */

export const DATA_KEY_BYTES = 32
export const GCM_NONCE_BYTES = 12

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('Web Crypto is not available in this runtime')
  return c.subtle
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function newDataKey(): Uint8Array {
  return randomBytes(DATA_KEY_BYTES)
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Error('malformed base64')
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Copy into a fresh ArrayBuffer-backed view (Web Crypto rejects views over shared buffers). */
function plain(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

async function importGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== DATA_KEY_BYTES) throw new Error('AES-256 needs a 32-byte key')
  return subtle().importKey('raw', plain(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export interface SealedBox {
  /** Base64 96-bit nonce, unique per encryption. */
  nonce: string
  /** Base64 ciphertext with the 128-bit GCM tag appended. */
  data: string
}

/** AES-256-GCM with `aad` authenticated but not encrypted (the vault binds each entry to its id). */
export async function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string
): Promise<SealedBox> {
  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cryptoKey = await importGcmKey(key)
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv: plain(nonce), additionalData: plain(utf8(aad)), tagLength: 128 },
    cryptoKey,
    plain(plaintext)
  )
  return { nonce: toBase64(nonce), data: toBase64(new Uint8Array(data)) }
}

/** Rejects (with `OperationError`) when the key, the nonce, the data or the aad do not match. */
export async function open(key: Uint8Array, box: SealedBox, aad: string): Promise<Uint8Array> {
  const nonce = fromBase64(box.nonce)
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error('malformed nonce')
  const cryptoKey = await importGcmKey(key)
  const data = await subtle().decrypt(
    { name: 'AES-GCM', iv: plain(nonce), additionalData: plain(utf8(aad)), tagLength: 128 },
    cryptoKey,
    plain(fromBase64(box.data))
  )
  return new Uint8Array(data)
}

export async function sealJson(key: Uint8Array, value: unknown, aad: string): Promise<SealedBox> {
  return seal(key, utf8(JSON.stringify(value)), aad)
}

export async function openJson<T>(key: Uint8Array, box: SealedBox, aad: string): Promise<T> {
  return JSON.parse(fromUtf8(await open(key, box, aad))) as T
}

export async function sha1Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-1', plain(utf8(text)))))
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', plain(utf8(text)))))
}

/** Compare two byte strings without leaking where they differ. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Uniform random integer in `[0, max)` by rejection sampling (no modulo bias). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) throw new Error('randomInt needs a positive bound')
  if (max === 1) return 0
  const limit = Math.floor(0x100000000 / max) * max
  const buf = new Uint32Array(1)
  for (;;) {
    globalThis.crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % max
  }
}

export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const t = items[i]
    items[i] = items[j]
    items[j] = t
  }
  return items
}
