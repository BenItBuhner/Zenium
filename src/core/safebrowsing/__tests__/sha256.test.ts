// Node's SHA-256 is the reference the core's own implementation is checked against.
// eslint-disable-next-line no-restricted-imports
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256, toHex } from '../sha256'

function reference(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

describe('sha256', () => {
  it('matches the published vectors', () => {
    expect(toHex(sha256(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(toHex(sha256('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(toHex(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
  })

  it('agrees with Node across block boundaries and non-ASCII input', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
      const text = 'x'.repeat(length)
      expect(toHex(sha256(text))).toBe(reference(text))
    }
    const unicode = 'zenium.例え.テスト/ünïcode'
    expect(toHex(sha256(unicode))).toBe(reference(unicode))
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) & 0xff)
    expect(toHex(sha256(bytes))).toBe(reference(bytes))
  })
})
