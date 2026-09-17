/**
 * Byte helpers shared by the extension-install core. Web platform APIs only: this file runs in
 * Electron's main process (Node 22) and inside the Android chrome WebView.
 */

const HEX = '0123456789abcdef'

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    out += HEX[b >> 4] + HEX[b & 0x0f]
  }
  return out
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error('Invalid hexadecimal string')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * WebCrypto accepts any typed-array view, but TypeScript's `BufferSource` excludes views over a
 * `SharedArrayBuffer`. Views over a plain ArrayBuffer pass through untouched (no copy, even for a
 * multi-megabyte archive); shared memory is copied first.
 */
export function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const shared =
    typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
  if (!shared) return bytes as Uint8Array<ArrayBuffer>
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', asBufferSource(bytes))
  return new Uint8Array(digest)
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf8LenientDecoder = new TextDecoder('utf-8')

export function utf8Encode(text: string): Uint8Array {
  return utf8Encoder.encode(text)
}

/** Strict decoding; throws on malformed UTF-8. */
export function utf8Decode(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes)
}

/** Lenient decoding for text a server sent us (replacement characters instead of throwing). */
export function utf8DecodeLenient(bytes: Uint8Array): string {
  return utf8LenientDecoder.decode(bytes)
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return btoa(binary)
}

export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '')
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Chrome's extension-ID alphabet: each nibble of the first 16 bytes of a SHA-256 digest becomes a
 * letter in a..p, giving the familiar 32-letter IDs.
 */
export function idFromDigestPrefix(digestPrefix: Uint8Array): string {
  let id = ''
  for (let i = 0; i < 16; i++) {
    const b = digestPrefix[i]
    id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0x0f))
  }
  return id
}

/** `crx_file::id_util::GenerateId`: SHA-256 of the SPKI public key, first 16 bytes, a..p alphabet. */
export async function extensionIdFromPublicKey(spki: Uint8Array): Promise<string> {
  return idFromDigestPrefix(await sha256(spki))
}

/** Chrome's unpacked-extension IDs hash an arbitrary seed (the install path) the same way. */
export async function extensionIdFromSeed(seed: string | Uint8Array): Promise<string> {
  const bytes = typeof seed === 'string' ? utf8Encode(seed) : seed
  return idFromDigestPrefix(await sha256(bytes))
}
