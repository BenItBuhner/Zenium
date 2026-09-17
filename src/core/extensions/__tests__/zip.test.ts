import { describe, expect, it } from 'vitest'
import { utf8Decode, utf8Encode } from '../bytes'
import { ZipError, crc32, inflateRaw, normalizeZipPath, readZip } from '../zip'
import { buildZip } from './helpers'

async function expectZipError(promise: Promise<unknown>, code: ZipError['code']): Promise<void> {
  let caught: unknown = null
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ZipError)
  expect((caught as ZipError).code).toBe(code)
}

describe('crc32', () => {
  it('matches the reference values', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
    expect(crc32(utf8Encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(utf8Encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })

  it('can be chained', () => {
    const whole = utf8Encode('hello world')
    const partial = crc32(whole.subarray(0, 5))
    expect(crc32(whole.subarray(5), partial)).toBe(crc32(whole))
  })
})

describe('readZip', () => {
  it('reads stored and deflated entries, directories and UTF-8 names', async () => {
    const big = new Uint8Array(100_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff
    const zip = buildZip([
      { name: 'manifest.json', data: '{"a":1}', method: 8 },
      { name: 'icons/', data: undefined },
      { name: 'icons/icon.png', data: new Uint8Array([1, 2, 3]), method: 0 },
      { name: '_locales/de/messages.json', data: '{"grüße":{"message":"Grüße"}}' },
      { name: 'data/big.bin', data: big, method: 8 },
      { name: 'empty.txt', data: '' }
    ])
    const archive = await readZip(zip)
    expect(archive.directories).toEqual(['icons/'])
    expect(archive.entries.map((e) => e.path)).toEqual([
      'manifest.json',
      'icons/icon.png',
      '_locales/de/messages.json',
      'data/big.bin',
      'empty.txt'
    ])
    expect(archive.totalSize).toBe(
      7 + 3 + utf8Encode('{"grüße":{"message":"Grüße"}}').length + big.length
    )
    expect(archive.get('manifest.json')?.method).toBe(8)
    expect(archive.get('icons/icon.png')?.method).toBe(0)
    expect(utf8Decode(await archive.get('manifest.json')!.bytes())).toBe('{"a":1}')
    expect(await archive.get('icons/icon.png')!.bytes()).toEqual(new Uint8Array([1, 2, 3]))
    expect(await archive.get('data/big.bin')!.bytes()).toEqual(big)
    expect((await archive.get('empty.txt')!.bytes()).length).toBe(0)
    expect(JSON.parse(utf8Decode(await archive.get('_locales/de/messages.json')!.bytes()))).toEqual(
      {
        grüße: { message: 'Grüße' }
      }
    )
  })

  it('handles an archive comment and tolerates trailing padding', async () => {
    const commented = buildZip([{ name: 'a.txt', data: 'a' }], { comment: 'hello there' })
    expect((await readZip(commented)).entries).toHaveLength(1)
    const padded = buildZip([{ name: 'a.txt', data: 'a' }], { trailing: new Uint8Array(64) })
    expect(utf8Decode(await (await readZip(padded)).get('a.txt')!.bytes())).toBe('a')
  })

  it('fails the CRC check for corrupted content', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'correct content', crc: 0x12345678 }])
    const archive = await readZip(zip)
    await expectZipError(archive.get('a.txt')!.bytes(), 'bad-crc')
    const stored = buildZip([{ name: 'b.txt', data: 'stored', method: 0 }])
    stored[30 + 5] ^= 0xff // flip a byte of the stored data (after the 30-byte local header + name)
    await expectZipError((await readZip(stored)).get('b.txt')!.bytes(), 'bad-crc')
  })

  it('rejects entries whose inflated size disagrees with the declaration', async () => {
    const tooSmall = buildZip([{ name: 'a.txt', data: 'twenty bytes of text', declaredSize: 5 }])
    await expectZipError((await readZip(tooSmall)).get('a.txt')!.bytes(), 'size-mismatch')
    const tooBig = buildZip([{ name: 'a.txt', data: 'short', declaredSize: 500 }])
    await expectZipError((await readZip(tooBig)).get('a.txt')!.bytes(), 'size-mismatch')
    const storedMismatch = buildZip([{ name: 'a.txt', data: 'abc', method: 0, declaredSize: 4 }])
    await expectZipError((await readZip(storedMismatch)).get('a.txt')!.bytes(), 'size-mismatch')
  })

  it('rejects garbage deflate streams', async () => {
    await expectZipError(inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 10), 'inflate-failed')
  })

  it('rejects path traversal and absolute paths, normalising backslashes', async () => {
    for (const name of [
      '../evil.js',
      'a/../../evil.js',
      '/etc/passwd',
      'C:\\Windows\\x',
      'a\\..\\b'
    ]) {
      await expectZipError(readZip(buildZip([{ name, data: 'x' }])), 'path-traversal')
    }
    for (const name of ['a//b', './a', 'a/./b', 'bad\u0000name']) {
      await expectZipError(readZip(buildZip([{ name, data: 'x' }])), 'bad-name')
    }
    const archive = await readZip(buildZip([{ name: 'dir\\file.txt', data: 'x' }]))
    expect(archive.entries[0].path).toBe('dir/file.txt')
  })

  it('reports duplicate entries, including case-insensitive clashes', async () => {
    await expectZipError(
      readZip(
        buildZip([
          { name: 'a.txt', data: '1' },
          { name: 'A.TXT', data: '2' }
        ])
      ),
      'duplicate-entry'
    )
  })

  it('rejects zip64 archives with a clear error', async () => {
    await expectZipError(
      readZip(buildZip([{ name: 'a', data: 'a' }], { zip64Count: true })),
      'zip64-unsupported'
    )
    await expectZipError(
      readZip(buildZip([{ name: 'a', data: 'a' }], { zip64Locator: true })),
      'zip64-unsupported'
    )
  })

  it('rejects encrypted entries and unsupported compression methods', async () => {
    await expectZipError(readZip(buildZip([{ name: 'a', data: 'a', flags: 0x0801 }])), 'encrypted')
    await expectZipError(
      readZip(buildZip([{ name: 'a', data: 'a', rawMethod: 12 }])),
      'unsupported-method'
    )
  })

  it('enforces entry-count and size limits', async () => {
    const zip = buildZip([
      { name: 'a', data: 'aaaa' },
      { name: 'b', data: 'bbbb' }
    ])
    await expectZipError(readZip(zip, { maxEntries: 1 }), 'too-many-entries')
    await expectZipError(readZip(zip, { maxTotalSize: 6 }), 'too-large')
    await expectZipError(readZip(zip, { maxEntrySize: 3 }), 'too-large')
    expect((await readZip(zip, { maxTotalSize: 8 })).entries).toHaveLength(2)
  })

  it('rejects things that are not zips', async () => {
    await expectZipError(readZip(new Uint8Array(10)), 'not-a-zip')
    await expectZipError(
      readZip(utf8Encode('definitely not a zip archive at all, sorry')),
      'not-a-zip'
    )
    const zip = buildZip([{ name: 'a', data: 'a' }])
    zip[0] = 0x00 // break the local header signature
    await expectZipError((await readZip(zip)).get('a')!.bytes(), 'bad-local-header')
  })
})

describe('normalizeZipPath', () => {
  it('keeps directory markers and strips nothing else', () => {
    expect(normalizeZipPath('a/b/')).toBe('a/b/')
    expect(normalizeZipPath('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(() => normalizeZipPath('')).toThrow(ZipError)
    expect(() => normalizeZipPath('D:file')).toThrow(/drive-letter/)
  })
})
