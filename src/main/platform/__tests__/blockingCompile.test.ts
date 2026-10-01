import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GHOSTERY_CACHE_FORMAT,
  cacheDigest,
  matchesCacheDigest,
  resetGhosteryCacheWarnings,
  writeGhosteryCache,
  type GhosteryCacheTarget
} from '../blockingCompile'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zenium-blocking-cache-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function targetIn(cacheDir: string, fingerprint = 'a:1:1'): GhosteryCacheTarget {
  return {
    bin: join(cacheDir, 'engine.bin'),
    meta: join(cacheDir, 'engine.json'),
    documents: join(cacheDir, 'documents.txt'),
    fingerprint,
    version: 'v1'
  }
}

const tempOf = (path: string): string => `${path}.${process.pid}.tmp`
const temps = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'))

describe('the cache digest', () => {
  it('names a file by its byte length and SHA-1, and accepts nothing else for it', () => {
    const data = new Uint8Array([1, 2, 3, 4])
    const digest = cacheDigest(data)
    expect(digest).toEqual({ bytes: 4, sha1: createHash('sha1').update(data).digest('hex') })
    expect(matchesCacheDigest(data, digest)).toBe(true)
    // A prefix, a different byte, an extra byte: not the file.
    expect(matchesCacheDigest(data.subarray(0, 3), digest)).toBe(false)
    expect(matchesCacheDigest(new Uint8Array([1, 2, 3, 5]), digest)).toBe(false)
    expect(matchesCacheDigest(new Uint8Array([1, 2, 3, 4, 0]), digest)).toBe(false)
    expect(matchesCacheDigest(new Uint8Array(0), cacheDigest(new Uint8Array(0)))).toBe(true)
    // Metadata without a well-formed digest never matches, whatever the file holds.
    expect(matchesCacheDigest(data, undefined)).toBe(false)
    expect(matchesCacheDigest(data, null)).toBe(false)
    expect(matchesCacheDigest(data, {})).toBe(false)
    expect(matchesCacheDigest(data, { bytes: 4 })).toBe(false)
    expect(matchesCacheDigest(data, { sha1: digest.sha1 })).toBe(false)
    expect(matchesCacheDigest(data, { bytes: '4', sha1: digest.sha1 })).toBe(false)
    expect(matchesCacheDigest(data, { bytes: 4, sha1: digest.sha1.toUpperCase() })).toBe(false)
    expect(matchesCacheDigest(data, { bytes: 4, sha1: digest.sha1.slice(1) })).toBe(false)
  })
})

describe('writeGhosteryCache', () => {
  it('writes the three files whole or not at all, the metadata last and naming the other two', () => {
    const cacheDir = join(tempDir(), 'cache')
    const target = targetIn(cacheDir)
    const engine = new Uint8Array([7, 7, 7])
    expect(writeGhosteryCache(target, engine, '||a.example^$all\n||b.example^$document')).toBe(true)
    expect(Buffer.from(readFileSync(target.bin))).toEqual(Buffer.from(engine))
    expect(readFileSync(target.documents, 'utf8')).toBe('||a.example^$all\n||b.example^$document')
    expect(JSON.parse(readFileSync(target.meta, 'utf8'))).toEqual({
      format: GHOSTERY_CACHE_FORMAT,
      fingerprint: 'a:1:1',
      version: 'v1',
      engine: cacheDigest(engine),
      documents: cacheDigest(readFileSync(target.documents))
    })
    expect(temps(cacheDir)).toEqual([])
  })

  it('renames each file into place from its own temp file: an occupied temp path fails that write, leaves the file as it was, and no later file is written', () => {
    resetGhosteryCacheWarnings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cacheDir = join(tempDir(), 'cache')
    const target = targetIn(cacheDir)
    expect(writeGhosteryCache(target, new Uint8Array([1]), 'one')).toBe(true)
    const firstMeta = readFileSync(target.meta, 'utf8')

    // `documents.txt`'s temp path taken: the engine's bytes landed (its rename came first), the
    // documents and the metadata are the old ones – a loader of the old fingerprint finds the
    // engine's digest off and recompiles rather than pairing new bytes with old filters.
    mkdirSync(tempOf(target.documents))
    expect(
      writeGhosteryCache({ ...target, fingerprint: 'b:2:2' }, new Uint8Array([2]), 'two')
    ).toBe(false)
    expect(Buffer.from(readFileSync(target.bin))).toEqual(Buffer.from([2]))
    expect(readFileSync(target.documents, 'utf8')).toBe('one')
    expect(readFileSync(target.meta, 'utf8')).toBe(firstMeta)
    expect(temps(cacheDir)).toEqual([`documents.txt.${process.pid}.tmp`])
    rmSync(tempOf(target.documents), { recursive: true })

    // The metadata's temp path taken: both files are new, the metadata (last) is still the
    // old one, naming the old files' digests – neither new file matches it.
    mkdirSync(tempOf(target.meta))
    expect(
      writeGhosteryCache({ ...target, fingerprint: 'c:3:3' }, new Uint8Array([3]), 'three')
    ).toBe(false)
    expect(Buffer.from(readFileSync(target.bin))).toEqual(Buffer.from([3]))
    expect(readFileSync(target.documents, 'utf8')).toBe('three')
    expect(readFileSync(target.meta, 'utf8')).toBe(firstMeta)
    const old = JSON.parse(firstMeta) as { engine: unknown; documents: unknown }
    expect(matchesCacheDigest(readFileSync(target.bin), old.engine)).toBe(false)
    expect(matchesCacheDigest(readFileSync(target.documents), old.documents)).toBe(false)
    rmSync(tempOf(target.meta), { recursive: true })

    // `engine.bin`'s temp path taken: nothing is touched.
    mkdirSync(tempOf(target.bin))
    expect(
      writeGhosteryCache({ ...target, fingerprint: 'd:4:4' }, new Uint8Array([4]), 'four')
    ).toBe(false)
    expect(Buffer.from(readFileSync(target.bin))).toEqual(Buffer.from([3]))
    expect(readFileSync(target.documents, 'utf8')).toBe('three')
    expect(readFileSync(target.meta, 'utf8')).toBe(firstMeta)
    rmSync(tempOf(target.bin), { recursive: true })

    // Three failures on the one cache path: logged once.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toBe('[zenium] filter engine cache not written')

    // A failed write leaves no temp file of its own behind.
    writeFileSync(join(cacheDir, 'blocker'), '')
    const other = {
      ...target,
      documents: join(cacheDir, 'blocker', 'documents.txt'),
      fingerprint: 'e:5:5'
    }
    expect(writeGhosteryCache(other, new Uint8Array([5]), 'five')).toBe(false)
    expect(temps(cacheDir)).toEqual([])
  })
})
