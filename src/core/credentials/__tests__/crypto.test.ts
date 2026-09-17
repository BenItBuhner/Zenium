import { describe, expect, it } from 'vitest'
import {
  bytesEqual,
  fromBase64,
  fromUtf8,
  newDataKey,
  open,
  openJson,
  randomInt,
  seal,
  sealJson,
  sha1Hex,
  sha256Hex,
  shuffle,
  toBase64,
  toHex,
  utf8
} from '../crypto'
import { corruptBase64 } from './fakes'

describe('vault primitives', () => {
  it('seals and opens under the same key and additional data', async () => {
    const key = newDataKey()
    const box = await seal(key, utf8('hunter2'), 'vault:entry:1')
    expect(fromBase64(box.nonce)).toHaveLength(12)
    // 7 bytes of plaintext plus the 16-byte tag.
    expect(fromBase64(box.data)).toHaveLength(7 + 16)
    expect(fromUtf8(await open(key, box, 'vault:entry:1'))).toBe('hunter2')
  })

  it('never reuses a nonce and never leaks the plaintext', async () => {
    const key = newDataKey()
    const a = await seal(key, utf8('same text'), 'aad')
    const b = await seal(key, utf8('same text'), 'aad')
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.data).not.toBe(b.data)
    expect(atob(a.data)).not.toContain('same text')
  })

  it('rejects another key, other additional data, and tampering', async () => {
    const key = newDataKey()
    const box = await seal(key, utf8('payload'), 'vault:entry:1')
    await expect(open(newDataKey(), box, 'vault:entry:1')).rejects.toThrow()
    await expect(open(key, box, 'vault:entry:2')).rejects.toThrow()
    await expect(
      open(key, { ...box, data: corruptBase64(box.data) }, 'vault:entry:1')
    ).rejects.toThrow()
    await expect(
      open(key, { ...box, nonce: corruptBase64(box.nonce) }, 'vault:entry:1')
    ).rejects.toThrow()
    await expect(open(key, { ...box, nonce: 'AAAA' }, 'vault:entry:1')).rejects.toThrow(
      'malformed nonce'
    )
    await expect(open(key, { ...box, data: 'not base64!' }, 'vault:entry:1')).rejects.toThrow(
      'malformed base64'
    )
  })

  it('refuses keys that are not 256 bits', async () => {
    await expect(seal(new Uint8Array(16), utf8('x'), 'aad')).rejects.toThrow('32-byte key')
  })

  it('round-trips JSON', async () => {
    const key = newDataKey()
    const value = { username: 'ada', password: 'p@ss "quoted"', tags: ['a', 'b'], n: 3 }
    const box = await sealJson(key, value, 'json')
    expect(await openJson(key, box, 'json')).toEqual(value)
  })

  it('base64 and hex helpers round-trip and validate', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
    expect(toHex(bytes)).toBe('000102fafbfcfdfeff')
    expect(fromBase64('')).toEqual(new Uint8Array())
    expect(() => fromBase64('abc')).toThrow('malformed base64')
    expect(() => fromBase64('ab*d')).toThrow('malformed base64')
    // Large inputs go through the chunked encoder.
    const big = new Uint8Array(70_000)
    for (let i = 0; i < big.length; i += 0x10000)
      crypto.getRandomValues(big.subarray(i, i + 0x10000))
    expect(fromBase64(toBase64(big))).toEqual(big)
  })

  it('hashes with known vectors', async () => {
    expect(await sha1Hex('password')).toBe('5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8')
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('compares bytes in constant shape', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('draws uniform integers inside the bound', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 2_000; i++) {
      const n = randomInt(7)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(7)
      seen.add(n)
    }
    expect(seen.size).toBe(7)
    expect(randomInt(1)).toBe(0)
    expect(() => randomInt(0)).toThrow()
    expect(() => randomInt(2.5)).toThrow()
  })

  it('shuffles in place keeping every element', () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    const shuffled = shuffle([...items])
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items)
    expect(shuffled).not.toEqual(items)
  })
})
