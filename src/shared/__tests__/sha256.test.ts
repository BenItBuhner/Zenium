// Node's SHA-256 is the reference the shared implementation is checked against.
// eslint-disable-next-line no-restricted-imports
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256, sha256Hex, toHex } from '../sha256'

function reference(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * The frame-owner protocol's pinned vector (`frame-owner-protocol-interface.md` §2.5): the
 * nonce's 32 hex characters immediately followed by the address, no separator, UTF-8, the
 * digest as lowercase hex. Android's Kotlin test pins the same literal; the two halves pair
 * on it.
 */
const PROTOCOL_NONCE = '0123456789abcdef0123456789abcdef'
const PROTOCOL_URL = 'https://example.com/a.png'
const PROTOCOL_HASH = '5008d908d5e08c6645f6aa651b540491afe63dde85ea320e6774c2808abbd885'

describe('sha256 (shared)', () => {
  it('reproduces the FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    // The 56-byte message: two blocks once padded.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
    // The 112-byte message.
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'
      )
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1')
    // One million 'a's (FIPS 180-4's long message).
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
    )
  })

  it('pins the frame-owner protocol vector', () => {
    expect(sha256Hex(PROTOCOL_NONCE + PROTOCOL_URL)).toBe(PROTOCOL_HASH)
    // The same bytes handed in encoded, as the frame's answerer hands them (a `TextEncoder` of its own).
    expect(sha256Hex(new TextEncoder().encode(PROTOCOL_NONCE + PROTOCOL_URL))).toBe(PROTOCOL_HASH)
    expect(reference(PROTOCOL_NONCE + PROTOCOL_URL)).toBe(PROTOCOL_HASH)
  })

  it('agrees with Node on random inputs across every block boundary', () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097]) {
      const bytes = randomBytes(length)
      expect(toHex(sha256(new Uint8Array(bytes)))).toBe(reference(bytes))
    }
    for (let i = 0; i < 64; i++) {
      const bytes = randomBytes(randomInt(0, 2048))
      expect(sha256Hex(new Uint8Array(bytes))).toBe(reference(bytes))
    }
  })

  it('agrees with Node on a 1 MB input', () => {
    const bytes = new Uint8Array(randomBytes(1024 * 1024))
    expect(sha256Hex(bytes)).toBe(reference(bytes))
  })

  it('encodes a string as UTF-8 before hashing', () => {
    const unicode = 'zenium.例え.テスト/ünïcode — 🙂'
    expect(sha256Hex(unicode)).toBe(reference(unicode))
    // A string and its encoding hash alike.
    expect(sha256Hex(unicode)).toBe(sha256Hex(new TextEncoder().encode(unicode)))
  })

  it('renders hex lowercase, two characters a byte', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})
