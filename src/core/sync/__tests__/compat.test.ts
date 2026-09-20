import { scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BookmarkNode, Boost, KeyBinding, Settings, SyncScope } from '../../../shared/types'
import type { Model } from '../../model'
import { fromBase64, toBase64 } from '../../credentials/crypto'
import { SCRYPT_PARAMS, decryptJson, deriveKey, passphraseBytes } from '../crypto'
import { collectLocal, diffLocal, hashData, type MetaMap, type SyncRecord } from '../records'
import { sha1Hex } from '../sha1'
import { parseDeviceFile, serializeDeviceFile } from '../transport'
import legacy from './fixtures/legacy-device-file.json'
import golden from './fixtures/golden-sources.json'

/**
 * Format compatibility pins for the move of the engine from src/main/sync (Electron only,
 * node:crypto) to src/core/sync (Web Crypto + scrypt-js, both hosts). Both fixtures were written
 * by the pre-move code at 04bb7748; a folder set up by that build must keep working unchanged.
 */

interface LegacyFixture {
  passphrase: string
  salt: string
  keyHex: string
  now: number
  deviceFile: {
    deviceId: string
    deviceName: string
    updatedAt: number
    envelope: { v: 1; salt: string; iv: string; tag: string; ciphertext: string }
  }
  plaintext: string
}

interface GoldenFixture {
  now: number
  scope: SyncScope
  settings: Settings
  shortcutOverrides: Record<string, KeyBinding | null>
  model: Model
  bookmarks: BookmarkNode[]
  boosts: Boost[]
  plaintext: string
  hashes: Record<string, string>
  meta: MetaMap
}

const legacyFixture = legacy as unknown as LegacyFixture
const goldenFixture = golden as unknown as GoldenFixture

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('device files written before the move', () => {
  it('derive the same key from the passphrase with scrypt-js as node:crypto did', async () => {
    const key = await deriveKey(legacyFixture.passphrase, legacyFixture.salt)
    expect(hex(key)).toBe(legacyFixture.keyHex)
    // And node itself still agrees with the recorded key (the fixture is not stale).
    const node = scryptSync(
      passphraseBytes(legacyFixture.passphrase),
      fromBase64(legacyFixture.salt),
      SCRYPT_PARAMS.dkLen,
      {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2
      }
    )
    expect(hex(new Uint8Array(node))).toBe(legacyFixture.keyHex)
  }, 60_000)

  it('decrypt over Web Crypto to the exact payload the old engine encrypted', async () => {
    const key = fromBase64(toBase64(Buffer.from(legacyFixture.keyHex, 'hex')))
    const payload = await decryptJson<{ v: 1; records: SyncRecord[] }>(
      key,
      legacyFixture.deviceFile.envelope
    )
    expect(JSON.stringify(payload)).toBe(legacyFixture.plaintext)
    expect(payload.v).toBe(1)
    expect(payload.records.map((r) => r.type)).toContain('settings')
  })

  it('parse and re-serialise through the transport helpers without loss', () => {
    const text = JSON.stringify(legacyFixture.deviceFile)
    const parsed = parseDeviceFile(text)
    expect(parsed).toEqual(legacyFixture.deviceFile)
    expect(JSON.parse(serializeDeviceFile(parsed!))).toEqual(legacyFixture.deviceFile)
  })
})

describe('the moved engine on a fixed record set', () => {
  const sources = {
    model: goldenFixture.model,
    settings: goldenFixture.settings,
    shortcutOverrides: goldenFixture.shortcutOverrides,
    bookmarks: goldenFixture.bookmarks,
    boosts: goldenFixture.boosts
  }

  it('writes byte-identical payload JSON for the pre-move scope', () => {
    const local = collectLocal(sources, goldenFixture.scope)
    const diff = diffLocal({}, local, goldenFixture.now)
    expect(JSON.stringify({ v: 1, records: diff.records })).toBe(goldenFixture.plaintext)
  })

  it('hashes every record as the old engine did (sha1 of the key-sorted JSON)', () => {
    const local = collectLocal(sources, goldenFixture.scope)
    const hashes: Record<string, string> = {}
    for (const [id, { data }] of local) hashes[id] = hashData(data)
    expect(hashes).toEqual(goldenFixture.hashes)
    expect(diffLocal({}, local, goldenFixture.now).meta).toEqual(goldenFixture.meta)
  })

  it('matches the payload the legacy device file carried', () => {
    // The same fixture data went through both builds: the plaintext the pre-move engine
    // encrypted is the plaintext the moved engine reproduces.
    expect(goldenFixture.plaintext).toBe(legacyFixture.plaintext)
  })

  it('keeps the passwords scope out of a pre-move scope object (nothing new is collected)', () => {
    // A scope persisted by the old build lacks `passwords`; collecting with it must yield the
    // same set as before, with no credential records (the vault is not in the fixture).
    const local = collectLocal(sources, goldenFixture.scope)
    expect([...local.values()].some((r) => r.type === 'credential')).toBe(false)
    expect(local.size).toBe(Object.keys(goldenFixture.hashes).length)
  })
})

describe('sha1 (pure TypeScript, synchronous)', () => {
  it('matches the known vectors and node:crypto on arbitrary text', async () => {
    const { createHash } = await import('node:crypto')
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12'
    )
    for (const text of [
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'a'.repeat(1000),
      '💼 émoji and ünïcode ✓',
      JSON.stringify(goldenFixture.settings)
    ]) {
      expect(sha1Hex(text)).toBe(createHash('sha1').update(text, 'utf8').digest('hex'))
    }
  })
})
