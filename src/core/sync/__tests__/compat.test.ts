import { describe, expect, it } from 'vitest'
import type {
  BookmarkNode,
  Boost,
  KeyBinding,
  ReadingListEntry,
  Settings,
  SyncScope
} from '../../../shared/types'
import type { Model } from '../../model'
import { decryptJson, deriveKey, encryptJson } from '../crypto'
import {
  DEVICE_LOCAL_SETTINGS,
  SETTINGS_RECORD_ID,
  collectLocal,
  defaultScope,
  diffLocal,
  fullScope,
  hashData,
  inScope,
  metaFromRemote,
  newestByRecord,
  settingsKeyTime,
  winningRemote,
  type MetaMap,
  type RecordType,
  type SyncRecord
} from '../records'
import { sha1Hex } from '../sha1'
import { parseDeviceFile, serializeDeviceFile } from '../transport'
import legacy from './fixtures/legacy-device-file.json'
import golden from './fixtures/golden-sources.json'

/**
 * Format compatibility pins for the move of the engine from src/main/sync (Electron only,
 * node:crypto) to src/core/sync (Web Crypto + scrypt-js, both hosts). Both fixtures were written
 * by the pre-move code at 04bb7748; a folder set up by that build must keep working unchanged.
 *
 * One difference to that build's payload is meant: the settings record carries none of the
 * device-local keys (`DEVICE_LOCAL_SETTINGS` – `sidebarExpandOnHover` joined `onboardingDone`
 * in W5-F3), and the old build's record carries `sidebarExpandOnHover`. The record pins below
 * expect the golden settings record without those keys and nothing else changed; the fixtures
 * stay as the old build wrote them (the device file is its encryption, not re-made here).
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
const unhex = (text: string): Uint8Array =>
  new Uint8Array(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

describe('device files written before the move', () => {
  it('derive the same key from the passphrase with scrypt-js as node:crypto did', async () => {
    // `keyHex` was produced by node's scryptSync in the pre-move engine; scrypt-js must agree
    // bit for bit (`main/sync/__tests__/crossHost.test.ts` re-derives it with node live).
    const key = await deriveKey(legacyFixture.passphrase, legacyFixture.salt)
    expect(hex(key)).toBe(legacyFixture.keyHex)
  }, 60_000)

  it('decrypt over Web Crypto to the exact payload the old engine encrypted', async () => {
    const key = unhex(legacyFixture.keyHex)
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

/**
 * The golden payload as this build writes it: the old build's settings record without the
 * device-local keys, every other record and every other key as it was (`JSON.stringify` of
 * the parsed fixture is the fixture, so the deletions are the only difference).
 */
function goldenAsWritten(): { plaintext: string; settingsHash: string } {
  const payload = JSON.parse(goldenFixture.plaintext) as { v: 1; records: SyncRecord[] }
  const settings = payload.records.find((r) => r.type === 'settings')!.data as Record<
    string,
    unknown
  >
  // The old build's record carries the key the pin now drops: the difference is real.
  expect(settings).toHaveProperty('sidebarExpandOnHover')
  expect(settings).not.toHaveProperty('onboardingDone')
  for (const key of DEVICE_LOCAL_SETTINGS) delete settings[key]
  return { plaintext: JSON.stringify(payload), settingsHash: hashData(settings) }
}

describe('the moved engine on a fixed record set', () => {
  const sources = {
    model: goldenFixture.model,
    settings: goldenFixture.settings,
    shortcutOverrides: goldenFixture.shortcutOverrides,
    bookmarks: goldenFixture.bookmarks,
    boosts: goldenFixture.boosts
  }

  it('writes byte-identical payload JSON for the pre-move scope, the device-local keys apart', () => {
    const local = collectLocal(sources, goldenFixture.scope)
    const diff = diffLocal({}, local, goldenFixture.now)
    expect(JSON.stringify({ v: 1, records: diff.records })).toBe(goldenAsWritten().plaintext)
  })

  it('hashes every record as the old engine did (sha1 of the key-sorted JSON)', () => {
    const local = collectLocal(sources, goldenFixture.scope)
    const hashes: Record<string, string> = {}
    for (const [id, { data }] of local) hashes[id] = hashData(data)
    const { settingsHash } = goldenAsWritten()
    expect(hashes).toEqual({ ...goldenFixture.hashes, settings: settingsHash })
    expect(diffLocal({}, local, goldenFixture.now).meta).toEqual({
      ...goldenFixture.meta,
      settings: { ...goldenFixture.meta.settings, hash: settingsHash }
    })
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

  it('keeps the reading list out of a pre-move scope object, and its record type out of the pinned payload (services pass 11, ID-48)', () => {
    // The golden scope predates `readingList` as it predates `passwords`: it says nothing for
    // the type, so a device holding a reading list publishes no entry under it and the payload
    // is the pinned bytes still. With the toggle on (this build's default) the same sources
    // publish the entries – as `reading-list-entry` records – and nothing else changes.
    expect(goldenFixture.scope).not.toHaveProperty('readingList')
    expect(defaultScope().readingList).toBe(true)
    const readingList: ReadingListEntry[] = [
      {
        id: 'rl_1',
        url: 'https://later.example/',
        title: 'Later',
        addedAt: 100,
        updatedAt: 100,
        favicon: 'data:image/png;base64,AA=='
      }
    ]
    const local = collectLocal({ ...sources, readingList }, goldenFixture.scope)
    expect([...local.values()].some((r) => r.type === 'reading-list-entry')).toBe(false)
    const diff = diffLocal({}, local, goldenFixture.now)
    expect(JSON.stringify({ v: 1, records: diff.records })).toBe(goldenAsWritten().plaintext)

    const withList = collectLocal(
      { ...sources, readingList },
      { ...goldenFixture.scope, readingList: true }
    )
    expect(withList.size).toBe(local.size + 1)
    expect(withList.get('rl_1')).toEqual({
      type: 'reading-list-entry',
      data: {
        id: 'rl_1',
        url: 'https://later.example/',
        title: 'Later',
        addedAt: 100,
        updatedAt: 100
      }
    })
    withList.delete('rl_1')
    expect(
      JSON.stringify({ v: 1, records: diffLocal({}, withList, goldenFixture.now).records })
    ).toBe(goldenAsWritten().plaintext)
  })
})

/**
 * The wire is additive: a record type a build does not know goes through its file format, parser
 * and cipher intact and then falls out of every scope – `inScope` names no case for it, so the
 * round's filter drops it, a declined merge tombstones nothing for it, and it is never applied
 * nor written to the metadata (it wins again next round and is dropped again). That is what
 * `reading-list-entry` is to every build before this one, and what the next type will be to
 * this build: an old device on the folder keeps syncing everything it knows, with no error.
 */
describe('the wire across builds: a record type the build does not know', () => {
  const sources = {
    model: goldenFixture.model,
    settings: goldenFixture.settings,
    shortcutOverrides: goldenFixture.shortcutOverrides,
    bookmarks: goldenFixture.bookmarks,
    boosts: goldenFixture.boosts
  }

  it('comes through the format and the cipher intact and is dropped by the round, not an error', async () => {
    const stranger: SyncRecord = {
      id: 'future_1',
      type: 'future-type' as RecordType,
      data: { anything: true, nested: [1, { two: 2 }], text: 'a later build wrote this' },
      modified: goldenFixture.now + 10,
      deleted: false
    }
    const strangerGone: SyncRecord = {
      id: 'future_2',
      type: 'future-type' as RecordType,
      data: null,
      modified: goldenFixture.now + 10,
      deleted: true
    }
    // This device's copy of the golden set, at its first diff.
    const local = collectLocal(sources, goldenFixture.scope)
    const mine = diffLocal({}, local, goldenFixture.now)

    // The peer's file: the golden records, the stranger among them.
    const key = unhex(legacyFixture.keyHex)
    const theirs = [...mine.records, stranger, strangerGone]
    const file = {
      deviceId: 'peer',
      deviceName: 'Phone (a later build)',
      updatedAt: goldenFixture.now + 10,
      envelope: await encryptJson(key, legacyFixture.salt, { v: 1, records: theirs })
    }
    const parsed = parseDeviceFile(serializeDeviceFile(file))
    expect(parsed).toBeTruthy()
    const payload = await decryptJson<{ v: 1; records: SyncRecord[] }>(key, parsed!.envelope)
    expect(payload.records).toEqual(theirs)

    // The round as the engine runs it (`SyncEngine.run`): newest copy per record, the winners
    // against this device's metadata, then the scope filter. The stranger is a winner (this
    // device holds no copy) and is out of every scope, the pre-move one and the full one alike.
    const remote = newestByRecord([payload.records])
    expect(remote.get('future_1')).toEqual(stranger)
    const winners = winningRemote(mine.meta, remote)
    expect(winners).toEqual([stranger])
    for (const scope of [goldenFixture.scope, defaultScope(), fullScope()]) {
      expect(inScope(stranger, scope)).toBeFalsy()
      expect(inScope(strangerGone, scope)).toBeFalsy()
      expect(winners.filter((r) => inScope(r, scope))).toEqual([])
    }
    // Nothing applied, nothing written to the metadata: the next round finds the same and does
    // the same. A merge declined (`confirmMerge(false)`) tombstones the remote-only records it
    // knows and skips the ones it does not: `r.type === 'credential' || !inScope(r, scope)`.
    expect(metaFromRemote(winners.filter((r) => inScope(r, fullScope())))).toEqual({})
    const declined = [...remote.values()].filter(
      (r) => !local.has(r.id) && !r.deleted && r.type !== 'credential' && inScope(r, fullScope())
    )
    expect(declined).toEqual([])

    // The metadata this device keeps is its own records' and nothing of the stranger's, so the
    // pinned bytes are what it writes back to the folder.
    expect(Object.keys(mine.meta)).not.toContain('future_1')
    expect(JSON.stringify({ v: 1, records: mine.records })).toBe(goldenAsWritten().plaintext)
  })
})

/**
 * Per-key merge of the settings record (`SyncRecord.keys`, `RecordMeta.keys`) is additive: the
 * per-key times sit outside `data`, `hashData(data)` is the same function of the same data, and
 * every pin above stands untouched. What this build makes of an old build's record, and an old
 * build of this build's, is pinned here on the same fixtures – the mixed folder of an upgrade
 * window, where a phone still on the previous build shares the folder with an upgraded desktop.
 *
 * "The build before" is the release before per-key merge: it already writes the settings record
 * without the device-local keys (`goldenAsWritten`), and its metadata is the first-diff pin with
 * that record's hash (`preBuildMeta`). The legacy device file is older still (it carries
 * `sidebarExpandOnHover`) and stands for any record without `keys`.
 */
describe('the settings record across builds: per-key merge and the builds before it', () => {
  type Json = Record<string, unknown>
  const sources = {
    model: goldenFixture.model,
    settings: goldenFixture.settings,
    shortcutOverrides: goldenFixture.shortcutOverrides,
    bookmarks: goldenFixture.bookmarks,
    boosts: goldenFixture.boosts
  }
  const settingsOf = (records: SyncRecord[]): SyncRecord =>
    records.find((r) => r.id === SETTINGS_RECORD_ID)!

  /** The metadata the build before per-key merge holds for the golden sources (its first diff). */
  function preBuildMeta(): MetaMap {
    const { settingsHash } = goldenAsWritten()
    return {
      ...goldenFixture.meta,
      [SETTINGS_RECORD_ID]: { ...goldenFixture.meta[SETTINGS_RECORD_ID]!, hash: settingsHash }
    }
  }

  /**
   * `winningRemote` as the build before per-key merge had it (`records.ts` at e45bddfe5, the
   * P0 #502): one copy per record, strictly newer wins, ties and identical content skipped.
   * An old build reads a record with `keys` through this – `keys` is a field it never looks at.
   */
  function oldWinningRemote(local: MetaMap, remote: Map<string, SyncRecord>): SyncRecord[] {
    const winners: SyncRecord[] = []
    for (const r of remote.values()) {
      const mine = local[r.id]
      if (!mine) {
        if (!r.deleted) winners.push(r)
        continue
      }
      if (r.modified <= mine.modified) continue
      if (!r.deleted && !mine.deleted && hashData(r.data) === mine.hash) continue
      if (r.deleted && mine.deleted) continue
      winners.push(r)
    }
    return winners
  }

  /** This build's per-key entry for the golden settings, migrated from the build before's meta. */
  function perKeyMeta(): MetaMap {
    const local = collectLocal(sources, goldenFixture.scope)
    const migrated = diffLocal(preBuildMeta(), local, goldenFixture.now, { stamp: null })
    expect(migrated.changed).toBe(false)
    return migrated.meta
  }

  it("the pinned first diff is untouched by per-key merge: no `keys` on the record or in the meta; the next diff's entry has every key at 0 and the same hash", () => {
    const local = collectLocal(sources, goldenFixture.scope)
    const first = diffLocal({}, local, goldenFixture.now)
    expect(settingsOf(first.records)).not.toHaveProperty('keys')
    expect(first.meta[SETTINGS_RECORD_ID]).toEqual(preBuildMeta()[SETTINGS_RECORD_ID])
    const entry = perKeyMeta()[SETTINGS_RECORD_ID]!
    expect(entry.hash).toBe(goldenAsWritten().settingsHash)
    expect(entry.modified).toBe(0)
    expect(Object.keys(entry.keys!).sort()).toEqual(
      Object.keys(settingsOf(first.records).data as Json).sort()
    )
    expect(Object.values(entry.keys!).every((k) => k.modified === 0)).toBe(true)
  })

  it("a record from a build before per-key merge (the legacy device file's) names no `keys`: every key is read at its `modified`, and a newer one lands as the whole record it is", async () => {
    const key = unhex(legacyFixture.keyHex)
    const payload = await decryptJson<{ v: 1; records: SyncRecord[] }>(
      key,
      legacyFixture.deviceFile.envelope
    )
    const legacy = settingsOf(payload.records)
    expect(legacy).not.toHaveProperty('keys')
    for (const k of Object.keys(legacy.data as Json)) {
      expect(settingsKeyTime(legacy, k)).toBe(legacy.modified)
    }
    // The old build's peer edits two settings later (its record whole at that time, as it
    // always was). Against a metadata from before – this device not yet upgraded – the record
    // wins whole, the same object.
    const edited: SyncRecord = {
      ...legacy,
      modified: goldenFixture.now,
      data: { ...(legacy.data as Json), colorScheme: 'dark', sidebarWidth: 333 }
    }
    const remote = new Map([[SETTINGS_RECORD_ID, edited]])
    expect(winningRemote(preBuildMeta(), remote)).toEqual([edited])
    expect(winningRemote(preBuildMeta(), remote)[0]).toBe(edited)
    // Against this build's per-key entry, every key of it is weighed at that time: the two that
    // differ win, the rest have nothing to add – landing them yields the peer's record exactly.
    // The device-local key the old build still sends (`sidebarExpandOnHover`, which this device
    // holds no entry for) is never a peer's to win.
    expect(edited.data).toHaveProperty('sidebarExpandOnHover')
    const won = winningRemote(perKeyMeta(), remote)
    expect(won).toHaveLength(1)
    expect(won[0]!.data).toEqual({ colorScheme: 'dark', sidebarWidth: 333 })
    expect(won[0]!.modified).toBe(goldenFixture.now)
    expect(won[0]).not.toHaveProperty('keys')
    expect({ ...goldenFixture.settings, ...(won[0]!.data as Json) }).toEqual(
      expect.objectContaining(edited.data as Json)
    )
    // A key this device edited later than the old build's record keeps its own value; the
    // old build's other key still lands. Whole, the record would have lost or won both.
    const mine = perKeyMeta()
    const entry = mine[SETTINGS_RECORD_ID]!
    entry.keys!.colorScheme = { hash: hashData('light'), modified: goldenFixture.now + 1 }
    entry.modified = goldenFixture.now + 1
    const later = winningRemote(mine, remote)
    expect(later[0]!.data).toEqual({ sidebarWidth: 333 })
  })

  it("a record this build writes, `keys` and all, goes through the unchanged file format, parser and cipher with `keys` intact and `hashData(data)` the pinned hash; the old build's rule takes it whole when newer", async () => {
    // This device edited its colour scheme at 5 once per-key entries existed, then set it back
    // by hand: the data is the golden data again, the key's time is not the others'.
    const mine = perKeyMeta()
    const entry = mine[SETTINGS_RECORD_ID]!
    entry.keys!.colorScheme = { hash: hashData(goldenFixture.settings.colorScheme), modified: 5 }
    entry.modified = 5
    const local = collectLocal(sources, goldenFixture.scope)
    const diff = diffLocal(mine, local, goldenFixture.now, { stamp: null })
    const record = settingsOf(diff.records)
    expect(record.modified).toBe(5)
    expect(record.keys).toBeDefined()
    expect(Object.keys(record.keys!)).toHaveLength(Object.keys(record.data as Json).length - 1)
    expect(Object.values(record.keys!).every((t) => t === 0)).toBe(true)
    const { settingsHash } = goldenAsWritten()
    expect(hashData(record.data)).toBe(settingsHash)
    expect(JSON.stringify(record.data)).toBe(
      JSON.stringify(settingsOf(diffLocal({}, local, goldenFixture.now).records).data)
    )

    // The device file as the engine writes it, read back as any device – old or new – reads it.
    const key = unhex(legacyFixture.keyHex)
    const file = {
      deviceId: legacyFixture.deviceFile.deviceId,
      deviceName: 'Desk (Linux)',
      updatedAt: goldenFixture.now,
      envelope: await encryptJson(key, legacyFixture.salt, { v: 1, records: diff.records })
    }
    const parsed = parseDeviceFile(serializeDeviceFile(file))
    expect(parsed).toBeTruthy()
    const payload = await decryptJson<{ v: 1; records: SyncRecord[] }>(key, parsed!.envelope)
    expect(payload.records).toEqual(diff.records)
    expect(settingsOf(payload.records).keys).toEqual(record.keys)

    // The old build's rule over what came through: the record whole, `keys` unread. Newer than
    // its copy, it takes it; no newer, or the same content, it skips it – as it always did.
    const oldBuild = (modified: number, hash = 'as-the-old-build-wrote-it'): MetaMap => ({
      [SETTINGS_RECORD_ID]: { type: 'settings', hash, modified, deleted: false }
    })
    const remote = new Map([[SETTINGS_RECORD_ID, settingsOf(payload.records)]])
    expect(oldWinningRemote(oldBuild(3), remote)).toEqual([settingsOf(payload.records)])
    expect(oldWinningRemote(oldBuild(5), remote)).toEqual([])
    expect(oldWinningRemote(oldBuild(3, settingsHash), remote)).toEqual([])
    // What it then applies is `data` whole (its `applyRemote` spreads it) and what it writes to
    // its metadata is `hashData(data)` – the pinned hash, `keys` being no part of it.
    expect(hashData(oldWinningRemote(oldBuild(3), remote)[0]!.data)).toBe(settingsHash)
  })
})

describe('sha1 (pure TypeScript, synchronous)', () => {
  it('matches the known vectors and Web Crypto on arbitrary text', async () => {
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
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
      expect(sha1Hex(text)).toBe(hex(new Uint8Array(digest)))
    }
  })
})
