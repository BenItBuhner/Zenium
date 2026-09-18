// Node's SHA-256 is the reference the core's own implementation is checked against.
// eslint-disable-next-line no-restricted-imports
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PREFIX_BYTES,
  PrefixTable,
  base64ToBytes,
  bytesToBase64,
  hostExpressions,
  prefixOf
} from '../prefixes'

describe('hostExpressions', () => {
  it('walks from the host down to its registrable domain, never to the public suffix', () => {
    expect(hostExpressions('a.b.example.com')).toEqual([
      'a.b.example.com',
      'b.example.com',
      'example.com'
    ])
    expect(hostExpressions('example.com')).toEqual(['example.com'])
    expect(hostExpressions('www.example.co.uk')).toEqual(['www.example.co.uk', 'example.co.uk'])
    expect(hostExpressions('Deep.Sub.Example.ORG.')).toEqual([
      'deep.sub.example.org',
      'sub.example.org',
      'example.org'
    ])
  })

  it('keeps IP literals and single labels as they are', () => {
    expect(hostExpressions('192.0.2.7')).toEqual(['192.0.2.7'])
    expect(hostExpressions('intranet')).toEqual(['intranet'])
    expect(hostExpressions('')).toEqual([])
  })
})

describe('prefixOf', () => {
  it('is the first eight bytes of the SHA-256, big-endian', () => {
    const digest = createHash('sha256').update('example.com').digest()
    const expected = digest.readBigUInt64BE(0)
    expect(prefixOf('example.com')).toBe(expected)
    expect(PREFIX_BYTES).toBe(8)
  })
})

describe('PrefixTable', () => {
  const hosts = ['evil.example', 'phish.example.net', 'malware.test', 'evil.example']

  it('builds a sorted, deduplicated table and answers host lookups by expression', () => {
    const table = PrefixTable.fromHosts(hosts)
    expect(table.size).toBe(3)
    expect(table.has(prefixOf('evil.example'))).toBe(true)
    expect(table.has(prefixOf('good.example'))).toBe(false)
    expect(table.matchHost('evil.example')).toBe('evil.example')
    expect(table.matchHost('login.evil.example')).toBe('evil.example')
    expect(table.matchHost('cdn.phish.example.net')).toBe('phish.example.net')
    expect(table.matchHost('example.net')).toBeNull()
    expect(table.matchHost('notevil.example')).toBeNull()
    expect(PrefixTable.empty().matchHost('evil.example')).toBeNull()
  })

  it('round-trips through bytes and base64, dropping a trailing partial prefix', () => {
    const table = PrefixTable.fromHosts(hosts)
    const bytes = table.toBytes()
    expect(bytes.length).toBe(3 * PREFIX_BYTES)
    expect(PrefixTable.fromBytes(bytes).toBase64()).toBe(table.toBase64())
    const again = PrefixTable.fromBase64(table.toBase64())
    expect(again.size).toBe(3)
    expect(again.matchHost('malware.test')).toBe('malware.test')
    const ragged = new Uint8Array(bytes.length + 3)
    ragged.set(bytes)
    expect(PrefixTable.fromBytes(ragged).size).toBe(3)
    expect(PrefixTable.fromBase64('not base64!!').size).toBe(0)
  })

  it('sorts prefixes given in any order so the binary search finds them all', () => {
    const many = Array.from({ length: 500 }, (_, i) => `host-${i}.example`)
    const table = PrefixTable.fromHosts(many.slice().reverse())
    for (const host of many) expect(table.matchHost(host)).toBe(host)
    const bytes = table.toBytes()
    const shuffled = new Uint8Array(bytes.length)
    for (let i = 0; i < table.size; i++) {
      const from = ((i * 37) % table.size) * PREFIX_BYTES
      shuffled.set(bytes.subarray(from, from + PREFIX_BYTES), i * PREFIX_BYTES)
    }
    const rebuilt = PrefixTable.fromBytes(shuffled)
    expect(rebuilt.size).toBe(table.size)
    expect(rebuilt.toBase64()).toBe(table.toBase64())
  })

  it('builds in chunks with the same result', async () => {
    const many = Array.from({ length: 9000 }, (_, i) => `h${i}.example.org`)
    const chunked = await PrefixTable.fromHostsChunked(many, 4000)
    expect(chunked.size).toBe(many.length)
    expect(chunked.toBase64()).toBe(PrefixTable.fromHosts(many).toBase64())
  })

  it('base64 helpers handle large inputs and whitespace', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i & 0xff)
    const text = bytesToBase64(bytes)
    expect(base64ToBytes(text)).toEqual(bytes)
    expect(base64ToBytes(text.replace(/(.{76})/g, '$1\n'))).toEqual(bytes)
  })
})
