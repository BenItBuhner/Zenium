/**
 * Firefox's `mozlz4` container (`bookmarkbackups/*.jsonlz4`, `sessionstore`): an 8-byte magic
 * `mozLz40\0`, the decompressed size as a little-endian 32-bit integer, then one raw LZ4 block.
 * The block decoder below is the whole of LZ4's block format (tokens of literal length and
 * match length, 2-byte match offsets, 4-byte minimum match), enough for what Firefox writes.
 */

const MAGIC = 'mozLz40\0'

export function isMozLz4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false
  return true
}

export function decodeMozLz4(bytes: Uint8Array): string {
  if (!isMozLz4(bytes)) throw new Error('Not a mozlz4 file.')
  const size = (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)) >>> 0
  const block = decodeLz4Block(bytes.subarray(12), size)
  return new TextDecoder().decode(block)
}

/** Decode one LZ4 block into exactly `outputSize` bytes; throws on a malformed stream. */
export function decodeLz4Block(src: Uint8Array, outputSize: number): Uint8Array {
  const out = new Uint8Array(outputSize)
  let s = 0
  let d = 0
  const end = src.length
  const fail = (): never => {
    throw new Error('The LZ4 block is malformed.')
  }
  while (s < end) {
    const token = src[s++]
    let literals = token >> 4
    if (literals === 15) {
      let b: number
      do {
        if (s >= end) fail()
        b = src[s++]
        literals += b
      } while (b === 255)
    }
    if (s + literals > end || d + literals > outputSize) fail()
    out.set(src.subarray(s, s + literals), d)
    s += literals
    d += literals
    // The last sequence carries literals only.
    if (s >= end) break
    if (s + 2 > end) fail()
    const offset = src[s] | (src[s + 1] << 8)
    s += 2
    if (offset === 0 || offset > d) fail()
    let match = token & 0xf
    if (match === 15) {
      let b: number
      do {
        if (s >= end) fail()
        b = src[s++]
        match += b
      } while (b === 255)
    }
    match += 4
    if (d + match > outputSize) fail()
    // Overlapping copies are the point of small offsets: byte by byte, forwards.
    let from = d - offset
    for (let i = 0; i < match; i++) out[d++] = out[from++]
  }
  if (d !== outputSize) fail()
  return out
}
