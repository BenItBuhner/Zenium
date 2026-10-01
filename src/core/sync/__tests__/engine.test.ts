import { afterEach, describe, expect, it } from 'vitest'
import type {
  ExtensionInfo,
  ExtensionSource,
  Mod,
  ReadingListEntry,
  Settings
} from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import type { Browser } from '../../browser'
import { NoExtensions } from '../../hostDefaults'
import type { SyncedExtensionChange } from '../../platform'
import { DEFAULT_READER_PREFERENCES, type ReaderPreferences } from '../../../shared/reader'
import { READING_LIST_CAP, compareReadAge, isUnread } from '../../../shared/readingList'
import { encryptJson } from '../crypto'
import { FOLDER_LOST_MESSAGE } from '../engine'
import {
  SETTINGS_RECORD_ID,
  hashData,
  readExtensionData,
  settingsKeyTime,
  type ExtensionSyncSource,
  type MetaMap,
  type RecordType,
  type SyncRecord,
  type SyncedExtensionData
} from '../records'
import {
  README_NAME,
  SYNC_DIR_NAME,
  deviceFileName,
  isDeviceFileName,
  parseDeviceFile,
  serializeDeviceFile
} from '../transport'
import {
  type Device,
  device,
  folderFiles,
  folderKey,
  memoryIo,
  published,
  publishedAll,
  setup,
  teardown,
  unlockVault
} from './harness'

afterEach(teardown)

describe('two engines on one folder', () => {
  it('replicates bookmarks, spaces, settings and credentials both ways, last writer wins', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)

    // A has data before it ever syncs.
    const bm = a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })!
    const login = a.browser.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'first-secret'
    })
    const passkey = a.browser.passwords.store.addPasskey({
      rpId: 'example.com',
      rpName: 'Example',
      userName: 'ada',
      userDisplayName: 'Ada',
      credentialId: 'cred-1',
      origin: 'https://example.com'
    })
    a.browser.state.settings.colorScheme = 'dark'

    await setup(a)
    expect(a.toasts).toEqual([])
    expect(a.engine.status().enabled).toBe(true)
    expect(a.engine.status().pendingMerge).toBe(false)
    expect(a.engine.status().folderName).toBe('drive')
    // The folder holds the README and A's file; nothing readable without the key.
    const files = folderFiles('/drive')
    expect(files.get(README_NAME)).toContain('Zenium')
    expect([...files.keys()].filter(isDeviceFileName)).toHaveLength(1)
    for (const text of files.values()) {
      expect(text).not.toContain('first-secret')
      expect(text).not.toContain('zenium.app')
    }
    const aRecords = await published(a)
    expect(aRecords.map((r) => r.type)).toContain('credential')
    expect(aRecords.find((r) => r.id === login.id)?.data).toMatchObject({
      kind: 'login',
      username: 'ada',
      password: 'first-secret'
    })
    expect(aRecords.find((r) => r.id === passkey.id)?.data).toMatchObject({
      kind: 'passkey',
      rpId: 'example.com',
      credentialId: 'cred-1'
    })
    expect(aRecords.find((r) => r.id === bm.id)?.type).toBe('bookmark')

    // B joins: the passphrase must open A's file and the first sync asks how to merge.
    await setup(b)
    expect(b.toasts).toEqual([])
    expect(b.engine.status().pendingMerge).toBe(true)
    expect(b.browser.passwords.list()).toHaveLength(0)
    await b.engine.confirmMerge(true)
    expect(b.engine.status().pendingMerge).toBe(false)
    expect(b.engine.status().lastError).toBeNull()

    // B now holds A's data, ids and secrets intact.
    expect(b.browser.bookmarks.get(bm.id)?.url).toBe('https://zenium.app/')
    expect(b.browser.state.settings.colorScheme).toBe('dark')
    const bLogin = b.browser.passwords.store.get(login.id)
    expect(bLogin).toMatchObject({ username: 'ada', password: 'first-secret' })
    expect(b.browser.passwords.store.listPasskeys().map((p) => p.id)).toEqual([passkey.id])
    expect(b.engine.status().devices.map((d) => d.name)).toEqual(['Desk (Linux)'])

    // A's sign-in check flagged the login and the user ignored the warning, and A wrote a note:
    // both travel (additive fields), so B neither warns again nor loses the note.
    a.browser.passwords.update(login.id, { notes: 'shared with the team' })
    a.browser.passwords.store.recordLeak(
      login.id,
      { breached: 5, leakWarnedAt: 1_000, leakIgnoredAt: 1_500 },
      1_000
    )
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(b.browser.passwords.store.get(login.id)).toMatchObject({
      notes: 'shared with the team',
      breached: 5,
      checkedAt: 1_000,
      leakWarnedAt: 1_000,
      leakIgnoredAt: 1_500
    })

    // B edits the login later; A takes the newer copy, whose memory the new value reset.
    await new Promise((r) => setTimeout(r, 5))
    b.browser.passwords.update(login.id, { password: 'second-secret' })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.get(login.id)).toMatchObject({
      password: 'second-secret',
      notes: 'shared with the team',
      breached: null,
      checkedAt: null,
      leakWarnedAt: null,
      leakIgnoredAt: null
    })
    expect(a.engine.status().devices.map((d) => d.name)).toEqual(['Pixel 9'])

    // A deletes it; the tombstone reaches B.
    a.browser.passwords.remove(login.id)
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(b.browser.passwords.store.get(login.id)).toBeNull()
    expect(b.browser.passwords.store.listPasskeys()).toHaveLength(1)
  }, 30_000)

  it('turning Passwords off stops sending and receiving them without deleting anything', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const login = a.browser.passwords.add({
      url: 'https://example.com/',
      username: 'ada',
      password: 'pw'
    })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.passwords.store.get(login.id)).not.toBeNull()

    // A turns the type off: its file no longer carries the login, and no tombstone either.
    a.engine.setScope({ passwords: false })
    await a.engine.syncNow()
    const aRecords = await published(a)
    expect(aRecords.some((r) => r.type === 'credential')).toBe(false)
    await b.engine.syncNow()
    expect(b.browser.passwords.store.get(login.id)).not.toBeNull()

    // B adds one meanwhile; A, with the type off, does not receive it.
    const other = b.browser.passwords.add({
      url: 'https://other.example/',
      username: 'bob',
      password: 'pw2'
    })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.get(other.id)).toBeNull()

    // Back on: A publishes again and picks up B's entry.
    a.engine.setScope({ passwords: true })
    await a.engine.syncNow()
    expect(a.browser.passwords.store.get(other.id)).not.toBeNull()
    expect((await published(a)).filter((r) => r.type === 'credential')).toHaveLength(2)
  }, 30_000)

  it('a locked vault holds credential records instead of tombstoning or applying them', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const login = a.browser.passwords.add({
      url: 'https://example.com/',
      username: 'ada',
      password: 'pw'
    })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.passwords.store.get(login.id)).not.toBeNull()

    a.browser.passwords.lock()
    await a.engine.syncNow()
    expect(a.engine.status().lastError).toBeNull()
    // Locked: A neither publishes nor tombstones its logins.
    const aRecords = await published(a)
    expect(aRecords.some((r) => r.type === 'credential')).toBe(false)
    await b.engine.syncNow()
    expect(b.browser.passwords.store.get(login.id)).not.toBeNull()

    // B adds an entry; A is locked and cannot apply it yet – it lands once the vault opens.
    const other = b.browser.passwords.add({
      url: 'https://other.example/',
      username: 'bob',
      password: 'pw2'
    })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.status().locked).toBe(true)
    expect((await a.browser.passwords.unlock()).status).toBe('ok')
    expect(a.browser.passwords.store.get(other.id)).toBeNull()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.get(other.id)?.username).toBe('bob')
    expect(a.browser.passwords.store.get(login.id)).not.toBeNull()
  }, 30_000)

  it('"keep this device\'s data" never deletes the other device\'s logins', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const aLogin = a.browser.passwords.add({
      url: 'https://a.example/',
      username: 'ada',
      password: 'pw'
    })
    a.browser.bookmarks.create({ title: 'A only', url: 'https://a-only.example/' })
    await setup(a)
    const bLogin = b.browser.passwords.add({
      url: 'https://b.example/',
      username: 'bob',
      password: 'pw'
    })
    await setup(b)
    await b.engine.confirmMerge(false)
    await a.engine.syncNow()
    // Bookmarks: B's decision won, A's bookmark went (the merge question is about that data).
    expect(a.browser.state.bookmarks.some((n) => n.url === 'https://a-only.example/')).toBe(false)
    // Passwords merge by entry regardless: both logins exist on both devices.
    expect(a.browser.passwords.store.get(aLogin.id)).not.toBeNull()
    expect(a.browser.passwords.store.get(bLogin.id)).not.toBeNull()
    await b.engine.syncNow()
    expect(b.browser.passwords.store.get(aLogin.id)).not.toBeNull()
    expect(b.browser.passwords.store.get(bLogin.id)).not.toBeNull()
  }, 30_000)

  it('refuses a wrong passphrase against an existing folder', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b, '/drive', 'not the same passphrase')
    expect(b.toasts).toEqual(['That passphrase does not match the data in this folder.'])
    expect(b.engine.status().enabled).toBe(false)
  }, 30_000)

  it('announces what each device is in its file, in the clear, and reads the kind off the others’ (services pass 4)', async () => {
    const a = device('Desk (Linux)', { kind: 'desktop' })
    const b = device('Pixel 9', { kind: 'phone' })
    const c = device('Old build')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await setup(c)
    await c.engine.confirmMerge(true)
    await a.engine.syncNow()
    await b.engine.syncNow()

    // The kind is in the announcement (readable without the key, like the name), not the envelope.
    const files = [...folderFiles('/drive')].filter(([name]) => isDeviceFileName(name))
    const parsed = files.map(([, text]) => parseDeviceFile(text)!)
    expect(parsed.map((f) => [f.deviceName, f.kind]).sort()).toEqual([
      ['Desk (Linux)', 'desktop'],
      ['Old build', undefined],
      ['Pixel 9', 'phone']
    ])
    expect(files.find(([, text]) => text.includes('Old build'))![1]).not.toContain('"kind"')

    // Each device's list of the others carries the kind where it was announced.
    const rows = (d: Device): Array<[string, string | undefined]> =>
      d.engine
        .status()
        .devices.map((row) => [row.name, row.kind] as [string, string | undefined])
        .sort()
    expect(rows(a)).toEqual([
      ['Old build', undefined],
      ['Pixel 9', 'phone']
    ])
    expect(rows(b)).toEqual([
      ['Desk (Linux)', 'desktop'],
      ['Old build', undefined]
    ])
    expect(rows(c)).toEqual([
      ['Desk (Linux)', 'desktop'],
      ['Pixel 9', 'phone']
    ])
    // The list survives a restart of the engine with the kind on it.
    b.engine.flushSync()
    const again = device('Pixel 9', { kind: 'phone', io: b.io })
    expect(rows(again)).toEqual(rows(b))

    // A file naming a kind this build does not know reads as no kind.
    expect(
      parseDeviceFile(
        JSON.stringify({ ...JSON.parse(files[0][1]), deviceId: 'x', kind: 'wearable' })
      )?.kind
    ).toBeUndefined()
  }, 30_000)

  it('reports a lost folder in the status and recovers when the user points at it again', async () => {
    const a = device('Desk (Linux)')
    await setup(a)
    expect(a.engine.status().folderLost).toBe(false)
    const transport = a.transports.at(-1)!
    transport.lost = true
    await a.engine.syncNow()
    expect(a.engine.status().folderLost).toBe(true)
    expect(a.engine.status().lastError).toBe(FOLDER_LOST_MESSAGE)
    expect(a.engine.status().enabled).toBe(true)

    // Pointing at a folder that belongs to another passphrase is refused; the same key's folder
    // (here: the moved copy) is taken and the status clears.
    const foreign = device('Stranger')
    await setup(foreign, '/foreign', 'a different passphrase')
    await a.engine.setFolder('/foreign', a.win)
    expect(a.toasts.at(-1)).toContain('different passphrase')
    expect(a.engine.status().folderLost).toBe(true)

    for (const [name, text] of folderFiles('/drive')) folderFiles('/moved').set(name, text)
    await a.engine.setFolder('/moved', a.win)
    expect(a.engine.status().folderLost).toBe(false)
    expect(a.engine.status().lastError).toBeNull()
    expect(a.engine.status().folder).toBe('/moved')
    expect(a.engine.status().folderName).toBe('moved')
    expect([...folderFiles('/moved').keys()].filter(isDeviceFileName)).toHaveLength(1)
  }, 30_000)

  it("disconnecting with the wipe removes this device's file only", async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect([...folderFiles('/drive').keys()].filter(isDeviceFileName)).toHaveLength(2)
    b.engine.disconnect(true)
    await new Promise((r) => setTimeout(r, 0))
    const left = [...folderFiles('/drive').keys()].filter(isDeviceFileName)
    expect(left).toHaveLength(1)
    expect(left[0]).toContain(a.engine.status().deviceId)
    expect(b.engine.status()).toMatchObject({ enabled: false, folder: null, folderName: null })
    expect(SYNC_DIR_NAME).toBe('zenium-sync')
  }, 30_000)
})

describe('a build that adds a settings key', () => {
  /**
   * The settings record is one record, merged whole, last writer wins: `diffLocal` stamps it
   * `modified = now` whenever its hash changed since the last sync, and a peer's copy older than
   * that loses. A build that put a new key into EVERY device's record – a default written in
   * `collectLocal`, say – would change every record's hash at once, so each device's first sync
   * after the upgrade would publish a whole-record settings edit no one made, reverting any
   * peer's settings change (on any key) that the device had not yet pulled. The record must
   * carry the settings as they are: an untouched device's record is the previous build's record.
   */
  it("a device's first sync after upgrading does not overwrite a peer's settings change it had not pulled", async () => {
    // The desktop and the phone in sync on the build before the Change Menu; neither has
    // touched the phone menu, so neither's settings hold `menuOrder`.
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await a.engine.syncNow()
    expect(a.browser.state.settings.colorScheme).toBe('system')
    expect(b.browser.state.settings.colorScheme).toBe('system')
    expect('menuOrder' in a.browser.state.settings).toBe(false)

    // The desktop is closed. Its profile and sync state are as that build left them: its
    // settings record was the settings as they stood – no `menuOrder` key, whatever this build
    // sends – and the sync metadata names that record's hash.
    a.browser.flushSync()
    const closed = { ...a.io.files }
    const record = (await published(a)).find((r) => r.id === SETTINGS_RECORD_ID)!
    const { menuOrder: _added, ...asThePreviousBuildWrote } = record.data as Record<string, unknown>
    void _added
    const persisted = JSON.parse(closed['sync.json']!) as { meta: MetaMap }
    const before = persisted.meta[SETTINGS_RECORD_ID]!
    persisted.meta[SETTINGS_RECORD_ID] = { ...before, hash: hashData(asThePreviousBuildWrote) }
    closed['sync.json'] = JSON.stringify(persisted)
    a.engine.disconnect(false)

    // An evening's change on the phone while the desktop is closed: a setting on another key.
    await new Promise((r) => setTimeout(r, 5))
    b.browser.state.settings.colorScheme = 'dark'
    await b.engine.syncNow()
    const theirs = (await published(b)).find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(theirs.data).toMatchObject({ colorScheme: 'dark' })

    // The desktop launches into the upgrade and syncs for the first time on this build. The
    // phone's change is what it had not pulled; it must land, not be beaten by a manufactured
    // edit of the desktop's own record.
    const io = memoryIo()
    Object.assign(io.files, closed)
    const upgraded = device('Desk (Linux)', { io })
    expect(upgraded.engine.status().deviceId).toBe(a.engine.status().deviceId)
    await upgraded.engine.syncNow()
    expect(upgraded.engine.status().lastError).toBeNull()
    expect(upgraded.browser.state.settings.colorScheme).toBe('dark')
    // What the desktop publishes is the phone's record with the phone's timestamp – its own
    // record was not an edit – and the phone's next sync keeps its change.
    const mine = (await published(upgraded)).find((r) => r.id === SETTINGS_RECORD_ID)!
    expect(mine.modified).toBe(theirs.modified)
    expect(hashData(mine.data)).toBe(hashData(theirs.data))
    await b.engine.syncNow()
    expect(b.browser.state.settings.colorScheme).toBe('dark')
    // The reason, stated: this build's record for an untouched device IS the previous build's.
    expect(hashData(record.data)).toBe(hashData(asThePreviousBuildWrote))
  }, 30_000)
})

/**
 * The settings record is one record, merged whole, last writer wins. The settings object is
 * `{ ...DEFAULT_SETTINGS, ...persisted }` run through the sanitisers at load, and `collectLocal`
 * spreads it whole into the record: a build that adds a default, changes what a sanitiser
 * normalises to, or migrates a key at boot changes EVERY device's record – content and hash –
 * with no edit by anyone. The engine used to stamp any record whose hash differed from the last
 * sync's metadata `modified = now`, in the round as much as in the state subscriber, so each
 * device's first sync on the new build published a whole-record settings edit no one made, which
 * beat any peer's settings change the device had not pulled yet (an evening's phone changes while
 * the desktop was closed) and reverted it on the peer's next round.
 *
 * The rule: an edit is stamped where it is MADE (`onLocalChange`, at the commit that carries it),
 * never where it is NOTICED (`run()`). The boot seed adopts a build's hashes without a stamp.
 */
type Files = Record<string, string>

/** Lets the deferred state broadcast (`onLocalChange`) run, and moves the clock by a few ms. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

/** Close the device: its profile and sync state as this build leaves them on disk. */
function close(d: Device): Files {
  d.browser.flushSync()
  const files = { ...d.io.files }
  d.engine.disconnect(false)
  return files
}

/** Launch a device again on the files a closed one left (and its keystore, when it has a vault). */
function reopen(name: string, files: Files, keys?: Device['keys']): Device {
  const io = memoryIo()
  Object.assign(io.files, files)
  return device(name, { io, ...(keys ? { keys } : {}) })
}

describe('an edit is stamped where it is made, not where it is noticed', () => {
  type Json = Record<string, unknown>

  async function settingsRecord(d: Device): Promise<SyncRecord> {
    const record = (await published(d)).find((r) => r.id === SETTINGS_RECORD_ID)
    expect(record).toBeDefined()
    return record!
  }

  /**
   * Leave a closed device's files as the previous build left them: its settings edited in
   * `state.json`, and its sync metadata naming the hash of the settings record as that build
   * wrote it (`recordAsWritten`) – one hash for the whole record, no per-key entries, as every
   * build before this one kept it.
   */
  function asPreviousBuild(
    files: Files,
    edit: (settings: Json) => void,
    recordAsWritten: Json
  ): void {
    const state = JSON.parse(files['state.json']!) as { settings: Json }
    edit(state.settings)
    files['state.json'] = JSON.stringify(state)
    const sync = JSON.parse(files['sync.json']!) as { meta: MetaMap }
    const { keys: _perKey, ...before } = sync.meta[SETTINGS_RECORD_ID]!
    void _perKey
    sync.meta[SETTINGS_RECORD_ID] = { ...before, hash: hashData(recordAsWritten) }
    files['sync.json'] = JSON.stringify(sync)
  }

  interface Cause {
    name: string
    /**
     * Set the closed device's files up as the previous build left them, given the settings
     * record this build wrote for it; returns the undo of any change made to the build itself.
     */
    upgrade: (files: Files, record: Json) => (() => void) | undefined
    /** Keys this build puts on every record, which the peer's record lacks: at 0, never an edit. */
    carries?: Json
  }

  const causes: Cause[] = [
    {
      name: "a new default (a key the previous build's record lacked, spread onto the settings at load)",
      upgrade: (files, record) => {
        const { searchEngineId: _absent, ...asWritten } = record
        void _absent
        asPreviousBuild(
          files,
          (s) => {
            delete s.searchEngineId
          },
          asWritten
        )
        return undefined
      }
    },
    {
      name: 'a new default (DEFAULT_SETTINGS gains a key in this build)',
      upgrade: (files, record) => {
        asPreviousBuild(files, () => undefined, record)
        const defaults = DEFAULT_SETTINGS as unknown as Json
        defaults.releaseAddedKey = 'on'
        return () => {
          delete defaults.releaseAddedKey
        }
      },
      carries: { releaseAddedKey: 'on' }
    },
    {
      name: "a sanitiser's new normal form (resources.memoryPercent clamped to 100 at load)",
      upgrade: (files, record) => {
        const resources = { ...(record.resources as Json), memoryPercent: 150 }
        asPreviousBuild(
          files,
          (s) => {
            s.resources = { ...(s.resources as Json), memoryPercent: 150 }
          },
          { ...record, resources }
        )
        return undefined
      }
    },
    {
      name: "a boot migration (the phone's frozen newTabPhone folded into newTab)",
      upgrade: (files, record) => {
        const newTabPhone = {
          wallpaper: 'image',
          pinned: [{ url: 'https://zen.example/', title: 'Zen' }]
        }
        asPreviousBuild(
          files,
          (s) => {
            s.newTabPhone = newTabPhone
          },
          { ...record, newTabPhone }
        )
        return undefined
      }
    },
    {
      name: 'a renamed key (the 0.4.x restoreSession switch folded into startup at boot; this build publishes startup alone, the mirror retired)',
      upgrade: (files, record) => {
        // The previous build's record: the switch (on, as the untouched default reads), no
        // `startup`; this build's record holds the key it folded and no switch.
        const { startup: _folded, ...rest } = record
        void _folded
        expect(record).not.toHaveProperty('restoreSession')
        const asWritten = { ...rest, restoreSession: true }
        asPreviousBuild(
          files,
          (s) => {
            delete s.startup
            s.restoreSession = true
          },
          asWritten
        )
        return undefined
      }
    }
  ]

  const edits: Array<{
    name: string
    /** The top-level settings key the edit sits under: the item the merge weighs. */
    key: keyof Settings
    patch: (s: Settings) => Partial<Settings>
    read: (s: Settings) => unknown
  }> = [
    {
      name: 'colorScheme',
      key: 'colorScheme',
      patch: () => ({ colorScheme: 'dark' }),
      read: (s) => s.colorScheme
    },
    {
      name: 'resources.memoryPercent',
      key: 'resources',
      patch: (s) => ({ resources: { ...s.resources, memoryPercent: 42 } }),
      read: (s) => s.resources.memoryPercent
    }
  ]

  describe.each(causes)('$name', (cause) => {
    it.each(edits)(
      "the device's first sync on the new build takes the peer's unpulled edit of $name instead of reverting it",
      async ({ key, patch, read }) => {
        // The desktop and the phone in sync on the previous build, the settings untouched.
        const a = device('Desk (Linux)')
        const b = device('Pixel 9')
        await setup(a)
        await setup(b)
        await b.engine.confirmMerge(true)
        await a.engine.syncNow()
        const record = (await settingsRecord(a)).data as Json
        const untouched = read(a.browser.state.settings)
        expect(read(b.browser.state.settings)).toEqual(untouched)

        // The desktop is closed; its profile and sync state are as the previous build left them.
        const closed = close(a)
        const restore = cause.upgrade(closed, record)
        try {
          // An evening's change on the phone while the desktop is closed: made through the
          // state, stamped by the phone's subscriber at that moment.
          await settle()
          b.browser.updateSettings(patch(b.browser.state.settings), b.win)
          await settle()
          await b.engine.syncNow()
          const theirs = await settingsRecord(b)
          expect(read(theirs.data as Settings)).not.toEqual(untouched)
          expect(theirs.modified).toBeGreaterThan(0)

          // The desktop launches into the upgrade and syncs for the first time on this build.
          // The phone's change is what it had not pulled: it lands, not beaten by an edit of the
          // desktop's own record that no one made.
          await settle()
          const launched = Date.now()
          const upgraded = reopen('Desk (Linux)', closed)
          expect(upgraded.engine.status().deviceId).toBe(a.engine.status().deviceId)
          await upgraded.engine.syncNow()
          expect(upgraded.engine.status().lastError).toBeNull()
          expect(read(upgraded.browser.state.settings)).toEqual(read(theirs.data as Settings))
          // What the desktop publishes carries the phone's edit at the PHONE's timestamp – never
          // at its own launch – and that key alone sits at the record's time. Every other key is
          // where the untouched profile had it, 0: this build's own form of an unedited key (a
          // default it added, a clamp, a fold) is not an edit, so it is never pushed as one; nor
          // is it reverted by the phone's key of the same age, which says nothing newer.
          const mine = await settingsRecord(upgraded)
          expect(mine.modified).toBe(theirs.modified)
          expect(mine.modified).toBeLessThan(launched)
          expect(read(mine.data as Settings)).toEqual(read(theirs.data as Settings))
          expect(mine.keys?.[key]).toBeUndefined()
          for (const other of Object.keys(mine.data as Json).filter((k) => k !== key)) {
            expect(mine.keys?.[other]).toBe(0)
          }
          for (const [carried, value] of Object.entries(cause.carries ?? {})) {
            expect((mine.data as Json)[carried]).toEqual(value)
          }
          // The phone's next round keeps its change, and has nothing newer to take.
          await b.engine.syncNow()
          expect(read(b.browser.state.settings)).toEqual(read(theirs.data as Settings))
          expect((await settingsRecord(b)).modified).toBe(theirs.modified)
        } finally {
          restore?.()
        }
      },
      30_000
    )
  })

  it("the seed at start adopts the build's hash for a record and keeps its timestamp, before any state event or round", async () => {
    const a = device('Desk (Linux)')
    await setup(a)
    a.browser.updateSettings({ colorScheme: 'dark' }, a.win)
    await settle()
    await a.engine.syncNow()
    const stamped = await settingsRecord(a)
    expect(stamped.modified).toBeGreaterThan(0)

    // The previous build's record lacked a key this build's load puts on the settings.
    const closed = close(a)
    const { searchEngineId: _absent, ...asWritten } = stamped.data as Json
    void _absent
    asPreviousBuild(
      closed,
      (s) => {
        delete s.searchEngineId
      },
      asWritten
    )
    expect(hashData(asWritten)).not.toBe(hashData(stamped.data))

    // At start the metadata names this build's record, at the timestamp of the last real edit.
    const upgraded = reopen('Desk (Linux)', closed)
    upgraded.engine.flushSync()
    const meta = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta[
      SETTINGS_RECORD_ID
    ]!
    expect(meta.modified).toBe(stamped.modified)
    expect(meta.hash).toBe(hashData(stamped.data))
    // The round publishes the record as this build holds it, at that timestamp.
    await upgraded.engine.syncNow()
    const mine = await settingsRecord(upgraded)
    expect(mine.modified).toBe(stamped.modified)
    expect(hashData(mine.data)).toBe(hashData(stamped.data))
  }, 30_000)

  it("a bookmark's data: favicon leaving its record at the upgrade (services pass 11's wire rule) is the build's change: the seed adopts the hash, the upgrade publishes the node without the icon at its OLD modified", async () => {
    const DATA_ICON = 'data:image/png;base64,iVBORw0KGgo='
    const a = device('Desk (Linux)')
    await setup(a)
    const node = a.browser.bookmarks.create({
      title: 'Docs',
      url: 'https://docs.example/',
      favicon: DATA_ICON,
      parentId: '1'
    })!
    await settle()
    await a.engine.syncNow()
    // A real edit, stamped by the subscriber: the record's time from here on.
    await settle()
    a.browser.bookmarks.update(node.id, { title: 'The docs' })
    await settle()
    await a.engine.syncNow()
    const stamped = (await published(a)).find((r) => r.id === node.id)!
    expect(stamped.modified).toBeGreaterThan(0)
    expect(stamped.data).not.toHaveProperty('favicon')
    expect(a.browser.bookmarks.tree.get(node.id)?.favicon).toBe(DATA_ICON)

    // The previous build's metadata named the record WITH the icon's bytes, as it wrote it.
    const closed = close(a)
    const asWritten = { ...(stamped.data as Record<string, unknown>), favicon: DATA_ICON }
    const sync = JSON.parse(closed['sync.json']!) as { meta: MetaMap }
    expect(sync.meta[node.id]!.hash).toBe(hashData(stamped.data))
    sync.meta[node.id] = { ...sync.meta[node.id]!, hash: hashData(asWritten) }
    closed['sync.json'] = JSON.stringify(sync)

    // At start the seed adopts this build's record – the node without the icon – at the edit's
    // time; the round publishes it so, never at the launch.
    await settle()
    const launched = Date.now()
    const upgraded = reopen('Desk (Linux)', closed)
    upgraded.engine.flushSync()
    const seeded = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta[node.id]!
    expect(seeded.hash).toBe(hashData(stamped.data))
    expect(seeded.modified).toBe(stamped.modified)
    await upgraded.engine.syncNow()
    const mine = (await published(upgraded)).find((r) => r.id === node.id)!
    expect(mine.modified).toBe(stamped.modified)
    expect(mine.modified).toBeLessThan(launched)
    expect(mine.data).not.toHaveProperty('favicon')
    // The icon itself stays with the device.
    expect(upgraded.browser.bookmarks.tree.get(node.id)?.favicon).toBe(DATA_ICON)
  }, 30_000)

  it("LWW intact: an edit made on the upgraded device after its restart, through the state, beats the peer's older edit", async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await a.engine.syncNow()
    const record = (await settingsRecord(a)).data as Json
    const closed = close(a)
    causes[0].upgrade(closed, record)

    await settle()
    b.browser.updateSettings({ colorScheme: 'dark' }, b.win)
    await settle()
    await b.engine.syncNow()
    const theirs = await settingsRecord(b)

    const upgraded = reopen('Desk (Linux)', closed)
    await upgraded.engine.syncNow()
    expect(upgraded.browser.state.settings.colorScheme).toBe('dark')
    // A real edit here, later than the phone's: the subscriber stamps it, and it wins.
    await settle()
    upgraded.browser.updateSettings({ colorScheme: 'light' }, upgraded.win)
    await settle()
    await upgraded.engine.syncNow()
    const mine = await settingsRecord(upgraded)
    expect(mine.modified).toBeGreaterThan(theirs.modified)
    await b.engine.syncNow()
    expect(b.browser.state.settings.colorScheme).toBe('light')
  }, 30_000)

  it('LWW intact: a fresh device never beats a record that already exists in the folder', async () => {
    // A device that sets sync up on an empty folder publishes what it holds at `modified = 0`:
    // nothing it has was edited under sync, so a peer's copy, whenever made, wins over it.
    const a = device('Desk (Linux)')
    a.browser.updateSettings({ colorScheme: 'light' }, a.win)
    await settle()
    await setup(a)
    expect((await settingsRecord(a)).modified).toBe(0)

    // A device joining a folder with data adopts the folder's copy of every record it also
    // holds (`confirmMerge`), whatever it changed before joining.
    const b = device('Pixel 9')
    b.browser.updateSettings({ colorScheme: 'dark' }, b.win)
    await settle()
    await setup(b)
    expect(b.engine.status().pendingMerge).toBe(true)
    await b.engine.confirmMerge(true)
    expect(b.browser.state.settings.colorScheme).toBe('light')
    expect((await settingsRecord(b)).modified).toBe(0)

    // A real edit on either device, stamped when made, beats the record at 0 everywhere.
    await settle()
    b.browser.updateSettings({ colorScheme: 'dark' }, b.win)
    await settle()
    await b.engine.syncNow()
    const theirs = await settingsRecord(b)
    expect(theirs.modified).toBeGreaterThan(0)
    await a.engine.syncNow()
    expect(a.browser.state.settings.colorScheme).toBe('dark')
    expect((await settingsRecord(a)).modified).toBe(theirs.modified)
  }, 30_000)

  it("no ping-pong: a device that normalises a peer's value differently re-publishes at the peer's timestamp, and the peer's next round skips it", async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await a.engine.syncNow()

    // The phone's build keeps a minimum font size this build's sanitiser does not offer (1–5 px
    // read as 6): set through the state, stamped on the phone.
    await settle()
    b.browser.state.settings.fonts = { ...b.browser.state.settings.fonts, minimumSize: 3 }
    b.browser.state.commit()
    await settle()
    await b.engine.syncNow()
    const theirs = await settingsRecord(b)
    expect((theirs.data as Settings).fonts.minimumSize).toBe(3)

    // The desktop applies the record and holds its own normal form of it. What it publishes is
    // that form at the PHONE's timestamp: a normalisation is not an edit.
    await a.engine.syncNow()
    expect(a.browser.state.settings.fonts.minimumSize).toBe(6)
    const mine = await settingsRecord(a)
    expect((mine.data as Settings).fonts.minimumSize).toBe(6)
    expect(mine.modified).toBe(theirs.modified)
    expect(hashData(mine.data)).not.toBe(hashData(theirs.data))

    // The phone skips a record no newer than its own; neither device bounces the other's form.
    await b.engine.syncNow()
    expect(b.browser.state.settings.fonts.minimumSize).toBe(3)
    expect((await settingsRecord(b)).modified).toBe(theirs.modified)
    await a.engine.syncNow()
    expect(a.browser.state.settings.fonts.minimumSize).toBe(6)
    expect((await settingsRecord(a)).modified).toBe(theirs.modified)
  }, 30_000)

  it('run() never stamps: a change the round notices with no state event keeps its modified – an edit is stamped where it is made, by the subscriber', async () => {
    const a = device('Desk (Linux)')
    await setup(a)
    a.browser.updateSettings({ colorScheme: 'dark' }, a.win)
    await settle()
    await a.engine.syncNow()
    const stamped = (await settingsRecord(a)).modified
    expect(stamped).toBeGreaterThan(0)

    // The sources change under the engine with no commit – nothing was made through the state.
    // The change is made after the last broadcast the round waits for and before its diff: from
    // a listener behind the engine's own, which that broadcast (the round's status) runs after
    // `onLocalChange` has looked. The round publishes the content and keeps the timestamp. Were
    // `run()` to stamp what it notices, a build's change to every device's record would again
    // beat the peers' real edits, and this would read `> stamped`.
    await settle()
    const unsubscribe = a.browser.state.subscribe(() => {
      a.browser.state.settings.colorScheme = 'light'
      unsubscribe()
    })
    await a.engine.syncNow()
    const noticed = await settingsRecord(a)
    expect((noticed.data as Settings).colorScheme).toBe('light')
    expect(noticed.modified).toBe(stamped)

    // The same change made through the state is an edit, and the subscriber stamps it – even
    // when the round starts in the same tick as the commit: the broadcast is delivered before
    // the round reads the local set.
    await settle()
    a.browser.updateSettings({ colorScheme: 'system' }, a.win)
    await a.engine.syncNow()
    const edited = await settingsRecord(a)
    expect((edited.data as Settings).colorScheme).toBe('system')
    expect(edited.modified).toBeGreaterThan(stamped)
  }, 30_000)

  it("the vault opens after start: its records get the seed at the first unlock, and the peer's unpulled password change lands instead of being reverted", async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const login = a.browser.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'first-secret'
    })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.passwords.store.get(login.id)).toMatchObject({ password: 'first-secret' })
    const record = (await published(a)).find((r) => r.id === login.id)
    expect(record).toBeDefined()

    // The desktop is closed. The previous build put no `notes` on a login's record (this build
    // puts '' on every login at collect, ID-34): its sync metadata names the hash of the record
    // as that build wrote it. (ID-31's breach fields dodged this by hand – each present only when
    // set, "so a login without one hashes exactly as it always did"; the seed covers the key a
    // future build does not think to.)
    const closed = close(a)
    const { notes: _notes, ...asWritten } = record!.data as Json
    void _notes
    expect(hashData(asWritten)).not.toBe(hashData(record!.data))
    const sync = JSON.parse(closed['sync.json']!) as { meta: MetaMap }
    sync.meta[login.id] = { ...sync.meta[login.id]!, hash: hashData(asWritten) }
    closed['sync.json'] = JSON.stringify(sync)

    // The phone changes the password while the desktop is closed: stamped there, then.
    await settle()
    b.browser.passwords.update(login.id, { password: 'second-secret' })
    await settle()
    await b.engine.syncNow()
    const theirs = (await published(b)).find((r) => r.id === login.id)!
    expect(theirs.data).toMatchObject({ password: 'second-secret' })
    expect(theirs.modified).toBeGreaterThan(0)

    // The desktop launches: the engine starts with the vault locked, and the OS-protected vault
    // opens silently a moment later (`passwords.start()`). The first broadcast that finds it
    // open seeds its records – the build's shape is adopted at the timestamp of the last real
    // edit, not stamped now – so the round takes the phone's change instead of beating it.
    await settle()
    const launched = Date.now()
    const upgraded = reopen('Desk (Linux)', closed, a.keys)
    expect(upgraded.browser.passwords.status().locked).toBe(true)
    await upgraded.browser.passwords.whenSettled()
    expect(upgraded.browser.passwords.status().locked).toBe(false)
    await settle()
    await upgraded.engine.syncNow()
    expect(upgraded.engine.status().lastError).toBeNull()
    expect(upgraded.browser.passwords.store.get(login.id)).toMatchObject({
      password: 'second-secret'
    })
    const mine = (await published(upgraded)).find((r) => r.id === login.id)!
    expect(mine.modified).toBe(theirs.modified)
    expect(mine.modified).toBeLessThan(launched)
    expect(hashData(mine.data)).toBe(hashData(theirs.data))
    await b.engine.syncNow()
    expect(b.browser.passwords.store.get(login.id)).toMatchObject({ password: 'second-secret' })
    expect((await published(b)).find((r) => r.id === login.id)!.modified).toBe(theirs.modified)
  }, 30_000)
})

/**
 * The settings record merges per key, as Chrome Sync treats each preference as its own item
 * (`SyncRecord.keys`, `diffSettings`, `winningSettings`): two devices editing DIFFERENT settings
 * while apart both keep their edits; the same setting edited on both is the later edit's, a tie
 * the local copy's; `searchEngines`+`searchEngineId` and `newTab`+`newTabPhone` are one item
 * each. The record's `modified` is its newest key's, and its `keys` map on the wire names only
 * the keys that are older, outside `data`: a record from before per-key merge (no `keys`) reads
 * as every key at its `modified`, and an old build reads a record with `keys` as the whole
 * record it always was (`compat.test.ts` pins both).
 */
describe('the settings record merges per key, as Chrome Sync treats preferences', () => {
  type Json = Record<string, unknown>

  /** Lets the deferred state broadcast (`onLocalChange`) run, and moves the clock by a few ms. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

  const settingsOf = (d: Device): Settings => d.browser.state.settings

  async function settingsRecord(d: Device): Promise<SyncRecord> {
    const record = (await published(d)).find((r) => r.id === SETTINGS_RECORD_ID)
    expect(record).toBeDefined()
    return record!
  }

  /** Devices set up on one folder, in sync, the settings untouched. */
  async function inSync(...names: string[]): Promise<Device[]> {
    const all = names.map((name) => device(name))
    await setup(all[0]!)
    for (const d of all.slice(1)) {
      await setup(d)
      await d.engine.confirmMerge(true)
    }
    for (const d of all) await d.engine.syncNow()
    return all
  }

  it("two devices editing different settings while apart both keep their edits, each key at its own edit's time", async () => {
    const [a, b] = (await inSync('Desk (Linux)', 'Pixel 9')) as [Device, Device]
    // Apart: the desktop picks a colour scheme; later the phone adds an engine and makes it the
    // default (two commits, the pair stamped at the second).
    await settle()
    a.browser.updateSettings({ colorScheme: 'dark' }, a.win)
    await settle()
    const kagi = b.browser.searchEngines.add('Kagi', 'https://kagi.com/search?q=%s', b.win)
    await settle()
    b.browser.updateSettings({ searchEngineId: kagi }, b.win)
    await settle()
    expect(settingsOf(b).searchEngineId).toBe(kagi)

    // The desktop syncs, then the phone, then the desktop again. Merged whole, last writer
    // wins, the phone's later record replaced the desktop's, colour scheme and all.
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    for (const d of [a, b]) {
      expect(settingsOf(d).colorScheme).toBe('dark')
      expect(settingsOf(d).searchEngineId).toBe(kagi)
      expect(settingsOf(d).searchEngines?.map((e) => e.id)).toContain(kagi)
    }
    // Both publish the same record: the colour scheme at the desktop's edit, the engine and
    // the default at the phone's, the record at the newest of them.
    const mine = await settingsRecord(a)
    const theirs = await settingsRecord(b)
    expect(hashData(mine.data)).toBe(hashData(theirs.data))
    const scheme = settingsKeyTime(mine, 'colorScheme')
    const engines = settingsKeyTime(mine, 'searchEngines')
    expect(scheme).toBeGreaterThan(0)
    expect(engines).toBeGreaterThan(scheme)
    expect(settingsKeyTime(mine, 'searchEngineId')).toBe(engines)
    expect(mine.modified).toBe(engines)
    expect(theirs.modified).toBe(engines)
    for (const key of ['colorScheme', 'searchEngines', 'searchEngineId']) {
      expect(settingsKeyTime(theirs, key)).toBe(settingsKeyTime(mine, key))
    }
    // A key no one edited sits where the untouched profile had it, older than both edits.
    expect(settingsKeyTime(mine, 'fonts')).toBeLessThan(scheme)
    expect(mine.keys).toHaveProperty('fonts')
    expect(mine.keys).not.toHaveProperty('searchEngines')
    // Another round each finds nothing newer.
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(await settingsRecord(a)).toEqual(mine)
    expect(await settingsRecord(b)).toEqual(theirs)
  }, 30_000)

  it("the same setting edited on both while apart is the later edit's, and the earlier device's other edit stands", async () => {
    const [a, b] = (await inSync('Desk (Linux)', 'Pixel 9')) as [Device, Device]
    await settle()
    a.browser.updateSettings({ colorScheme: 'dark', sidebarWidth: 300 }, a.win)
    await settle()
    b.browser.updateSettings({ colorScheme: 'light' }, b.win)
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    for (const d of [a, b]) {
      expect(settingsOf(d).colorScheme).toBe('light')
      expect(settingsOf(d).sidebarWidth).toBe(300)
    }
    const mine = await settingsRecord(a)
    const theirs = await settingsRecord(b)
    expect(hashData(mine.data)).toBe(hashData(theirs.data))
    expect(settingsKeyTime(mine, 'colorScheme')).toBe(theirs.modified)
    expect(settingsKeyTime(mine, 'sidebarWidth')).toBeLessThan(theirs.modified)
    expect(settingsKeyTime(theirs, 'sidebarWidth')).toBe(settingsKeyTime(mine, 'sidebarWidth'))
    expect(mine.modified).toBe(theirs.modified)
  }, 30_000)

  it('three devices: a Reset made while one is away reaches it when it returns, its own edit made meanwhile reaches the others, and all three converge', async () => {
    const [a, b, c] = (await inSync('Desk (Linux)', 'Pixel 9', 'MacBook')) as [
      Device,
      Device,
      Device
    ]
    // A saved menu order, on every device.
    await settle()
    a.browser.updateSettings({ menuOrder: ['row.settings', 'row.newTab'] }, a.win)
    await settle()
    for (const d of [a, b, c]) await d.engine.syncNow()
    for (const d of [a, b, c])
      expect(settingsOf(d).menuOrder).toEqual(['row.settings', 'row.newTab'])

    // The laptop goes away. The phone resets the menu – the empty list, stored and sent – and
    // the desktop takes it.
    await settle()
    b.browser.updateSettings({ menuOrder: [] }, b.win)
    await settle()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(settingsOf(a).menuOrder).toEqual([])
    const reset = await settingsRecord(b)

    // Away, the laptop picks a colour scheme; back, its round takes the reset and keeps its own.
    await settle()
    c.browser.updateSettings({ colorScheme: 'dark' }, c.win)
    await settle()
    await c.engine.syncNow()
    expect(settingsOf(c).menuOrder).toEqual([])
    expect(settingsOf(c).colorScheme).toBe('dark')
    const scheme = (await settingsRecord(c)).modified
    expect(scheme).toBeGreaterThan(reset.modified)

    await a.engine.syncNow()
    await b.engine.syncNow()
    const records = await Promise.all([a, b, c].map(settingsRecord))
    for (const [i, d] of [a, b, c].entries()) {
      expect(settingsOf(d).menuOrder).toEqual([])
      expect(settingsOf(d).colorScheme).toBe('dark')
      const r = records[i]!
      expect(hashData(r.data)).toBe(hashData(records[0]!.data))
      expect(settingsKeyTime(r, 'menuOrder')).toBe(reset.modified)
      expect(settingsKeyTime(r, 'colorScheme')).toBe(scheme)
      expect(r.modified).toBe(scheme)
    }
  }, 30_000)

  it("a third device reads every device's keys out of the folder: a key only an away device's file carries lands, though another device's record is newer", async () => {
    const [a, b, c] = (await inSync('Desk (Linux)', 'Pixel 9', 'MacBook')) as [
      Device,
      Device,
      Device
    ]
    // Apart, the phone's edit first, the desktop's later. Both come back at once: each reads the
    // folder before the other has written, so each file carries its own device's edit alone.
    await settle()
    b.browser.updateSettings({ colorScheme: 'dark' }, b.win)
    await settle()
    a.browser.updateSettings({ sidebarWidth: 300 }, a.win)
    await settle()
    await Promise.all([a.engine.syncNow(), b.engine.syncNow()])
    const desk = await settingsRecord(a)
    const phone = await settingsRecord(b)
    expect((desk.data as Settings).colorScheme).not.toBe('dark')
    expect((phone.data as Settings).sidebarWidth).not.toBe(300)
    expect(desk.modified).toBeGreaterThan(phone.modified)

    // The laptop's round: the desktop's record is the newer one, and the phone's colour scheme
    // lands too – one record per id, newest wins, would have read the desktop's file alone.
    await c.engine.syncNow()
    expect(settingsOf(c).sidebarWidth).toBe(300)
    expect(settingsOf(c).colorScheme).toBe('dark')
    const laptop = await settingsRecord(c)
    expect(settingsKeyTime(laptop, 'colorScheme')).toBe(phone.modified)
    expect(settingsKeyTime(laptop, 'sidebarWidth')).toBe(desk.modified)
    expect(laptop.modified).toBe(desk.modified)
    // And the two take each other's at their next round.
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(settingsOf(a).colorScheme).toBe('dark')
    expect(settingsOf(b).sidebarWidth).toBe(300)
    expect(hashData((await settingsRecord(b)).data)).toBe(hashData(laptop.data))
  }, 30_000)

  it('searchEngines and searchEngineId are one item: an edit of either stamps both, and a peer takes or keeps the pair whole', async () => {
    const [a, b] = (await inSync('Desk (Linux)', 'Pixel 9')) as [Device, Device]
    // The desktop adds an engine, then makes it the default: the phone takes list and default
    // together, both at the time of the second edit.
    await settle()
    const kagi = a.browser.searchEngines.add('Kagi', 'https://kagi.com/search?q=%s', a.win)
    await settle()
    a.browser.updateSettings({ searchEngineId: kagi }, a.win)
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(settingsOf(b).searchEngineId).toBe(kagi)
    const first = await settingsRecord(b)
    expect(settingsKeyTime(first, 'searchEngines')).toBe(first.modified)
    expect(settingsKeyTime(first, 'searchEngineId')).toBe(first.modified)

    // Apart: the desktop renames its engine (the list); later the phone puts the default back on
    // the shipped engine (the id). The pair is the later edit's on both devices – the phone's
    // list, the rename undone, and the phone's default. Key by key, the desktop's renamed list
    // would stand beside the phone's default: a list and a default no device ever held together
    // (a default naming an engine only the other key carries).
    await settle()
    a.browser.searchEngines.update(
      kagi,
      { name: 'Kagi Search', searchUrl: 'https://kagi.com/search?q=%s', keyword: '' },
      a.win
    )
    await settle()
    expect(settingsOf(a).searchEngines?.find((e) => e.id === kagi)?.name).toBe('Kagi Search')
    b.browser.updateSettings({ searchEngineId: DEFAULT_SETTINGS.searchEngineId }, b.win)
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    for (const d of [a, b]) {
      expect(settingsOf(d).searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)
      expect(settingsOf(d).searchEngines?.find((e) => e.id === kagi)?.name).toBe('Kagi')
    }
    const mine = await settingsRecord(a)
    const theirs = await settingsRecord(b)
    expect(hashData(mine.data)).toBe(hashData(theirs.data))
    expect(settingsKeyTime(mine, 'searchEngines')).toBe(theirs.modified)
    expect(settingsKeyTime(mine, 'searchEngineId')).toBe(theirs.modified)
    expect(mine.modified).toBe(theirs.modified)
  }, 30_000)

  it("a peer's reader preferences from an older build land completed through the sanitiser and re-publish at the PEER's time: the peer ties and keeps its own, nothing bounces, and a later edit on either side wins normally", async () => {
    const [a, b] = (await inSync('Desk (Linux)', 'Pixel 9')) as [Device, Device]
    // The phone runs a build before two of the fields existed: its object holds the fields the
    // defaults hold minus two (an older build's, before and after the next field is added), and
    // the user picks a size and a font there – an edit stamped at its commit (`onLocalChange`).
    const {
      letterSpacing: _letterSpacing,
      syllables: _syllables,
      ...older
    } = DEFAULT_READER_PREFERENCES
    void _letterSpacing
    void _syllables
    const phonesOwn = { ...older, fontSize: 14, font: 'mono' as const }
    const completed = { ...DEFAULT_READER_PREFERENCES, fontSize: 14, font: 'mono' as const }
    await settle()
    settingsOf(b).reader = phonesOwn as ReaderPreferences
    b.browser.state.commit()
    await settle()
    await b.engine.syncNow()
    const phone = await settingsRecord(b)
    const edit = settingsKeyTime(phone, 'reader')
    expect(edit).toBeGreaterThan(0)
    expect((phone.data as Settings).reader).toEqual(phonesOwn)

    // The desktop's round: the phone's key is newer and differs, so it wins and lands through
    // the sanitiser – the two fields it lacks at the defaults. The re-snapshot after the apply
    // (`stamp: null`) sees the key's hash moved – the completed object is not the phone's – and
    // KEEPS the phone's time: the key was noticed, not made here (`diffSettings`, `stamp ?? kept`).
    await a.engine.syncNow()
    expect(settingsOf(a).reader).toEqual(completed)
    expect(a.browser.reader.preferences()).toEqual(completed)
    const desk = await settingsRecord(a)
    expect((desk.data as Settings).reader).toEqual(completed)
    expect(settingsKeyTime(desk, 'reader')).toBe(edit)
    // The metadata's entry for the key: this device's own hash (the completed object's) at the
    // PHONE's time – the whole of the argument in one entry.
    a.engine.flushSync()
    const entry = (JSON.parse(a.io.files['sync.json']!) as { meta: MetaMap }).meta[
      SETTINGS_RECORD_ID
    ]!.keys!.reader!
    expect(entry).toEqual({ hash: hashData(completed), modified: edit })
    // The state broadcast the apply deferred finds the key's hash already its own: no stamp.
    await settle()
    await a.engine.syncNow()
    expect(await settingsRecord(a)).toEqual(desk)

    // The phone's round: the desktop's copy of the key carries the phone's own time – a tie, and
    // ties keep the local – so the phone keeps its shorter object and its record stands. Another
    // round each: nothing bounces between the two builds' normal forms.
    await b.engine.syncNow()
    expect(settingsOf(b).reader).toEqual(phonesOwn)
    expect(await settingsRecord(b)).toEqual(phone)
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(await settingsRecord(a)).toEqual(desk)
    expect(await settingsRecord(b)).toEqual(phone)

    // A later real edit on the desktop – stamped at its commit, newer than the phone's – wins
    // there: the phone takes the desktop's object at the desktop's time.
    await settle()
    a.browser.reader.setPreferences({ theme: 'sepia' })
    await settle()
    await a.engine.syncNow()
    const desktopEdit = settingsKeyTime(await settingsRecord(a), 'reader')
    expect(desktopEdit).toBeGreaterThan(edit)
    await b.engine.syncNow()
    expect(settingsOf(b).reader).toEqual({ ...completed, theme: 'sepia' })
    expect(settingsKeyTime(await settingsRecord(b), 'reader')).toBe(desktopEdit)

    // And a later edit on the phone wins on the desktop the same way.
    await settle()
    b.browser.reader.setPreferences({ width: 'wide' })
    await settle()
    await b.engine.syncNow()
    const phoneEdit = settingsKeyTime(await settingsRecord(b), 'reader')
    expect(phoneEdit).toBeGreaterThan(desktopEdit)
    await a.engine.syncNow()
    expect(settingsOf(a).reader).toEqual({ ...completed, theme: 'sepia', width: 'wide' })
    expect(settingsKeyTime(await settingsRecord(a), 'reader')).toBe(phoneEdit)
  }, 30_000)

  it("a metadata from before per-key merge gains its per-key entries at the boot seed – every key at the record's time, the record's time and hash untouched – and nothing goes out for it", async () => {
    const a = device('Desk (Linux)')
    await setup(a)
    a.browser.updateSettings({ colorScheme: 'dark' }, a.win)
    await settle()
    await a.engine.syncNow()
    const stamped = await settingsRecord(a)
    expect(stamped.modified).toBeGreaterThan(0)

    // The device closed; its metadata as every build before this one kept it: one hash and one
    // time for the record, no per-key entries.
    a.browser.flushSync()
    const files = { ...a.io.files }
    a.engine.disconnect(false)
    const sync = JSON.parse(files['sync.json']!) as { meta: MetaMap }
    const { keys: _perKey, ...legacy } = sync.meta[SETTINGS_RECORD_ID]!
    void _perKey
    sync.meta[SETTINGS_RECORD_ID] = legacy
    files['sync.json'] = JSON.stringify(sync)
    const folderBefore = new Map(folderFiles('/drive'))

    // At start the entry names every key of the record at the record's time – nothing finer is
    // known – with its value's hash; the record's own time and hash stand.
    const io = memoryIo()
    Object.assign(io.files, files)
    const upgraded = device('Desk (Linux)', { io })
    upgraded.engine.flushSync()
    const meta = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta[
      SETTINGS_RECORD_ID
    ]!
    expect(meta.modified).toBe(legacy.modified)
    expect(meta.hash).toBe(legacy.hash)
    expect(Object.keys(meta.keys ?? {}).sort()).toEqual(Object.keys(stamped.data as Json).sort())
    for (const [key, entry] of Object.entries(meta.keys ?? {})) {
      expect(entry.modified).toBe(stamped.modified)
      expect(entry.hash).toBe(hashData((stamped.data as Json)[key]))
    }
    // Nothing went out for the migration: the folder is as the closed device left it, and the
    // round publishes the record as before – the same content, the same time, no key older.
    expect(folderFiles('/drive')).toEqual(folderBefore)
    await upgraded.engine.syncNow()
    const mine = await settingsRecord(upgraded)
    expect(hashData(mine.data)).toBe(hashData(stamped.data))
    expect(mine.modified).toBe(stamped.modified)
    expect(mine.keys).toBeUndefined()
  }, 30_000)
})

/**
 * The reading list across two devices (services pass 11, item 3; ID-48): one `reading-list-entry`
 * record per entry, every field but `favicon`; the engine's `modified` the clock (an edit stamped
 * at its commit), tombstones from an entry's absence, the URL dedupe's loser tombstoned at the
 * round that took it out, no stamp for the entries a profile held before the type existed.
 */
describe('the reading list across two devices', () => {
  const readingRecords = async (d: Device): Promise<SyncRecord[]> =>
    (await published(d)).filter((r) => r.type === 'reading-list-entry')

  const ids = (d: Device): string[] => d.browser.state.readingList.map((e) => e.id).sort()

  it('replicates the list both ways without favicons, last writer by the stamp; a removal lands as a tombstone', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const one = a.browser.readingList.add('https://one.example/', 'One', 'data:fav-one')!
    const two = a.browser.readingList.add('https://two.example/', 'Two', 'data:fav-two')!
    expect(one.favicon).toBe('data:fav-one')

    await setup(a)
    expect(a.engine.status().scope.readingList).toBe(true)
    // The record as it goes over the wire: the entry's fields but the favicon, in the normal
    // form's order, `modified` 0 for a record first seen (no one edited it since it was known).
    const aRecords = await readingRecords(a)
    expect(aRecords.map((r) => r.id).sort()).toEqual([one.id, two.id].sort())
    const oneRecord = aRecords.find((r) => r.id === one.id)!
    expect(oneRecord).toEqual({
      id: one.id,
      type: 'reading-list-entry',
      data: {
        id: one.id,
        url: 'https://one.example/',
        title: 'One',
        addedAt: one.addedAt,
        updatedAt: one.updatedAt
      },
      modified: 0,
      deleted: false
    })
    expect(Object.keys(oneRecord.data as object)).toEqual([
      'id',
      'url',
      'title',
      'addedAt',
      'updatedAt'
    ])
    for (const text of folderFiles('/drive').values()) expect(text).not.toContain('fav-one')

    // The phone joins and takes the list: the entries whole, no favicon (the phone resolves its own).
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(ids(b)).toEqual(ids(a))
    expect(b.browser.readingList.get(one.id)).toEqual({
      id: one.id,
      url: 'https://one.example/',
      title: 'One',
      addedAt: one.addedAt,
      updatedAt: one.updatedAt
    })
    expect(b.browser.readingList.unreadCount).toBe(2)

    // Read on the phone: the edit is stamped at its commit and lands on the desktop, favicon kept.
    await settle()
    expect(b.browser.readingList.setRead(one.id, true)).toBe(true)
    await settle()
    await b.engine.syncNow()
    const theirs = (await readingRecords(b)).find((r) => r.id === one.id)!
    expect(theirs.modified).toBeGreaterThan(0)
    expect((theirs.data as ReadingListEntry).readAt).toBeDefined()
    await a.engine.syncNow()
    expect(a.browser.readingList.get(one.id)).toMatchObject({
      readAt: (theirs.data as ReadingListEntry).readAt,
      favicon: 'data:fav-one'
    })
    expect(a.browser.readingList.unreadCount).toBe(1)

    // Both flip the same entry apart: the later stamp wins on both, whichever device made it.
    await settle()
    expect(a.browser.readingList.setRead(one.id, false)).toBe(true)
    await settle()
    expect(b.browser.readingList.setRead(one.id, false)).toBe(true)
    await settle()
    expect(b.browser.readingList.setRead(one.id, true)).toBe(true)
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.readingList.get(one.id)?.readAt).toBeDefined()
    expect(b.browser.readingList.get(one.id)?.readAt).toBe(
      a.browser.readingList.get(one.id)?.readAt
    )
    const aStamp = (await readingRecords(a)).find((r) => r.id === one.id)!.modified
    const bStamp = (await readingRecords(b)).find((r) => r.id === one.id)!.modified
    expect(aStamp).toBe(bStamp)

    // The desktop removes an entry: a tombstone at the removal's time, and the phone drops it.
    await settle()
    expect(a.browser.readingList.remove(two.id)).toBe(true)
    await settle()
    await a.engine.syncNow()
    const gone = (await readingRecords(a)).find((r) => r.id === two.id)!
    expect(gone).toMatchObject({ deleted: true, data: null })
    expect(gone.modified).toBeGreaterThan(0)
    await b.engine.syncNow()
    expect(b.browser.readingList.get(two.id)).toBeNull()
    expect(ids(a)).toEqual([one.id])
    expect(ids(b)).toEqual([one.id])
  }, 30_000)

  it('the same page saved on both devices apart converges on one entry – the later addedAt – with the loser tombstoned at the round that took it out, in both directions', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)

    // Apart: the desktop saves the page first, the phone a moment later (the later addedAt).
    const mine = a.browser.readingList.add('https://same.example/', 'Same (desk)', 'data:fav')!
    await settle()
    const theirs = b.browser.readingList.add('https://same.example/', 'Same (phone)')!
    expect(theirs.addedAt).toBeGreaterThan(mine.addedAt)
    await settle()
    await a.engine.syncNow()
    // A record first seen goes out at 0, as every type's does (no one edited it since it was
    // known); the dedupe reads no timestamp of the engine's, only the entries' `addedAt`.
    const mineStamp = (await readingRecords(a)).find((r) => r.id === mine.id)!.modified
    expect(mineStamp).toBe(0)

    // The phone's round: the desktop's entry arrives, loses the dedupe to the phone's own and
    // never lands; the re-snapshot finds the record it was handed vanished and tombstones it now.
    await b.engine.syncNow()
    expect(ids(b)).toEqual([theirs.id])
    const bRecords = await readingRecords(b)
    const loser = bRecords.find((r) => r.id === mine.id)!
    expect(loser).toMatchObject({ deleted: true })
    expect(loser.modified).toBeGreaterThan(mineStamp)
    expect(bRecords.find((r) => r.id === theirs.id)).toMatchObject({ deleted: false })

    // The desktop's round: the tombstone takes its entry, the phone's lands – one entry per URL.
    await a.engine.syncNow()
    expect(ids(a)).toEqual([theirs.id])
    expect(a.browser.readingList.findByUrl('https://same.example/')).toEqual({
      id: theirs.id,
      url: 'https://same.example/',
      title: 'Same (phone)',
      addedAt: theirs.addedAt,
      updatedAt: theirs.updatedAt
    })
    await b.engine.syncNow()
    expect(ids(b)).toEqual([theirs.id])

    // The other direction: the phone saves first, the desktop later; the phone's own entry goes
    // out of its list when the desktop's arrives – its tombstone follows, the survivor's stamp is
    // the desktop's, unchanged.
    await settle()
    const early = b.browser.readingList.add('https://other.example/', 'Other (phone)')!
    await settle()
    const late = a.browser.readingList.add('https://other.example/', 'Other (desk)')!
    expect(late.addedAt).toBeGreaterThan(early.addedAt)
    await settle()
    await a.engine.syncNow()
    const lateStamp = (await readingRecords(a)).find((r) => r.id === late.id)!.modified
    await b.engine.syncNow()
    expect(ids(b)).toEqual([theirs.id, late.id].sort())
    const afterB = await readingRecords(b)
    expect(afterB.find((r) => r.id === early.id)).toMatchObject({ deleted: true })
    expect(afterB.find((r) => r.id === late.id)!.modified).toBe(lateStamp)
    await a.engine.syncNow()
    expect(ids(a)).toEqual([theirs.id, late.id].sort())
    expect((await readingRecords(a)).find((r) => r.id === late.id)!.modified).toBe(lateStamp)
    // Steady state: another round each changes nothing.
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(ids(a)).toEqual(ids(b))
    expect(a.browser.readingList.findByUrl('https://other.example/')?.id).toBe(late.id)
  }, 30_000)

  it("the entries a profile held before the type existed go out at modified 0 at the first sync on the new build – never at the launch – so a peer's edit of them wins", async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await a.engine.syncNow()

    // The desktop is closed; the previous build (the reading list without its sync type) left a
    // list in the profile and a sync state that knows nothing of it – no metadata for the
    // entries, no `readingList` in the scope object.
    const closed = close(a)
    const held: ReadingListEntry[] = [
      {
        id: 'rl_before_1',
        url: 'https://before.example/1',
        title: 'Before 1',
        addedAt: 1_000,
        updatedAt: 1_000,
        favicon: 'data:fav-before'
      },
      {
        id: 'rl_before_2',
        url: 'https://before.example/2',
        title: 'Before 2',
        addedAt: 2_000,
        updatedAt: 2_500,
        readAt: 2_500
      }
    ]
    const state = JSON.parse(closed['state.json']!) as { readingList?: ReadingListEntry[] }
    expect(state.readingList ?? []).toEqual([])
    state.readingList = held
    closed['state.json'] = JSON.stringify(state)
    const sync = JSON.parse(closed['sync.json']!) as {
      meta: MetaMap
      scope: Record<string, boolean>
    }
    delete sync.scope.readingList
    expect(Object.values(sync.meta).some((m) => m.type === 'reading-list-entry')).toBe(false)
    closed['sync.json'] = JSON.stringify(sync)

    // The desktop launches into the build: the scope completes to the default (on), the seed at
    // start writes nothing for the entries (it has no entry to adopt a hash into), and the first
    // round publishes them at 0 – the timestamp of a record no one edited since it was known.
    await settle()
    const launched = Date.now()
    const upgraded = reopen('Desk (Linux)', closed)
    expect(upgraded.engine.status().scope.readingList).toBe(true)
    upgraded.engine.flushSync()
    const seeded = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta
    expect(seeded.rl_before_1).toBeUndefined()
    expect(seeded.rl_before_2).toBeUndefined()
    await upgraded.engine.syncNow()
    expect(upgraded.engine.status().lastError).toBeNull()
    const records = await readingRecords(upgraded)
    expect(records.map((r) => r.id).sort()).toEqual(['rl_before_1', 'rl_before_2'])
    for (const r of records) {
      expect(r.modified).toBe(0)
      expect(r.modified).toBeLessThan(launched)
      expect(r.data).not.toHaveProperty('favicon')
    }
    expect(records.find((r) => r.id === 'rl_before_2')!.data).toEqual({
      id: 'rl_before_2',
      url: 'https://before.example/2',
      title: 'Before 2',
      addedAt: 2_000,
      updatedAt: 2_500,
      readAt: 2_500
    })
    upgraded.engine.flushSync()
    const meta = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta
    expect(meta.rl_before_1?.modified).toBe(0)
    expect(meta.rl_before_2?.modified).toBe(0)

    // The phone takes them, then edits one: its stamp is a real time, and it wins on the desktop.
    await b.engine.syncNow()
    expect(ids(b)).toEqual(['rl_before_1', 'rl_before_2'])
    await settle()
    expect(b.browser.readingList.setRead('rl_before_1', true)).toBe(true)
    await settle()
    await b.engine.syncNow()
    await upgraded.engine.syncNow()
    expect(upgraded.browser.readingList.get('rl_before_1')).toMatchObject({
      readAt: expect.any(Number),
      favicon: 'data:fav-before'
    })
    expect(upgraded.browser.readingList.unreadCount).toBe(0)
  }, 30_000)

  it('turning the reading list off stops sending and receiving it without deleting anything, on either device', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const kept = a.browser.readingList.add('https://kept.example/', 'Kept')!
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.readingList.get(kept.id)).not.toBeNull()

    // The desktop turns the type off: its file carries no entry and no tombstone either.
    a.engine.setScope({ readingList: false })
    expect(a.engine.status().scope.readingList).toBe(false)
    await a.engine.syncNow()
    expect(await readingRecords(a)).toEqual([])
    await b.engine.syncNow()
    expect(b.browser.readingList.get(kept.id)).not.toBeNull()
    expect(a.browser.readingList.get(kept.id)).not.toBeNull()

    // The phone saves a page and removes the shared one meanwhile; the desktop, with the type
    // off, takes neither the page nor the removal.
    await settle()
    const theirs = b.browser.readingList.add('https://phone.example/', 'Phone')!
    expect(b.browser.readingList.remove(kept.id)).toBe(true)
    await settle()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.readingList.get(theirs.id)).toBeNull()
    expect(a.browser.readingList.get(kept.id)).not.toBeNull()

    // Back on: the desktop publishes again and catches up – the page lands, the removal too.
    a.engine.setScope({ readingList: true })
    await a.engine.syncNow()
    expect(a.browser.readingList.get(theirs.id)).not.toBeNull()
    expect(a.browser.readingList.get(kept.id)).toBeNull()
    expect((await readingRecords(a)).filter((r) => !r.deleted).map((r) => r.id)).toEqual([
      theirs.id
    ])
  }, 30_000)

  /**
   * The cap under sync (services pass 11, item 4; the root's ruling, the mechanism agreed with
   * desktop): `READING_LIST_CAP` bounds the READ half of the fleet's union alone – the oldest by
   * `readAt` go, a tie by the id, the same on every device – and an unread entry is never
   * trimmed, so no sync round ever deletes a page the user has not read.
   */
  const tombstoned = async (d: Device): Promise<string[]> =>
    (await readingRecords(d))
      .filter((r) => r.deleted)
      .map((r) => r.id)
      .sort()
  const unreadIds = (d: Device): string[] =>
    d.browser.state.readingList
      .filter(isUnread)
      .map((e) => e.id)
      .sort()
  const readIds = (d: Device): string[] =>
    d.browser.state.readingList
      .filter((e) => !isUnread(e))
      .map((e) => e.id)
      .sort()

  it('2 × 600 unread: zero unread lost – both devices converge on all 1 200, no reading-list tombstone in either file, a further round changes nothing', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const mine: string[] = []
    const theirs: string[] = []
    for (let i = 1; i <= 600; i++) {
      mine.push(a.browser.readingList.add(`https://desk.example/${i}`, `Desk ${i}`)!.id)
      theirs.push(b.browser.readingList.add(`https://phone.example/${i}`, `Phone ${i}`)!.id)
    }
    const all = [...mine, ...theirs].sort()
    expect(all).toHaveLength(2 * 600)
    expect(2 * 600).toBeGreaterThan(READING_LIST_CAP)

    // The phone joins the desktop's folder and merges: the union runs over the old cap, and
    // nothing goes – every one of the 1 200 is unread.
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(ids(b)).toEqual(all)
    expect(b.browser.readingList.unreadCount).toBe(1200)
    await a.engine.syncNow()
    expect(ids(a)).toEqual(all)
    expect(a.browser.readingList.unreadCount).toBe(1200)
    await b.engine.syncNow()
    expect(ids(b)).toEqual(all)

    // No reading-list tombstone in either device's file: nothing was deleted anywhere.
    expect(await tombstoned(a)).toEqual([])
    expect(await tombstoned(b)).toEqual([])
    expect((await readingRecords(a)).map((r) => r.id).sort()).toEqual(all)
    expect((await readingRecords(b)).map((r) => r.id).sort()).toEqual(all)

    // A further round each changes nothing: the same 1 200, the same records.
    const aBefore = await readingRecords(a)
    const bBefore = await readingRecords(b)
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(ids(a)).toEqual(all)
    expect(ids(b)).toEqual(all)
    expect(a.browser.readingList.unreadCount).toBe(1200)
    expect(b.browser.readingList.unreadCount).toBe(1200)
    expect(await readingRecords(a)).toEqual(aBefore)
    expect(await readingRecords(b)).toEqual(bBefore)
    expect(await tombstoned(a)).toEqual([])
    expect(await tombstoned(b)).toEqual([])
  }, 60_000)

  it('1 200 read + 100 unread: 1 000 read, the oldest readAt gone, every unread kept – the same set on both, tombstones for exactly those 200', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    // 600 read pages on each device (their `readAt`s interleave: each service's clock is its
    // own, strictly increasing) and 50 unread on each – 1 200 read + 100 unread across the two.
    const readOn = (d: Device, host: string): ReadingListEntry[] => {
      const out: ReadingListEntry[] = []
      for (let i = 1; i <= 600; i++) {
        const e = d.browser.readingList.add(`https://${host}/${i}`, `${host} ${i}`)!
        expect(d.browser.readingList.setRead(e.id, true)).toBe(true)
        out.push(d.browser.readingList.get(e.id)!)
      }
      return out
    }
    const aRead = readOn(a, 'desk.example')
    const bRead = readOn(b, 'phone.example')
    const aUnread = Array.from(
      { length: 50 },
      (_, i) => a.browser.readingList.add(`https://desk-later.example/${i}`, `Later ${i}`)!.id
    )
    const bUnread = Array.from(
      { length: 50 },
      (_, i) => b.browser.readingList.add(`https://phone-later.example/${i}`, `Later ${i}`)!.id
    )
    const everyUnread = [...aUnread, ...bUnread].sort()
    // The 200 the cap must take: the earliest `readAt` across BOTH devices' read entries, a tie
    // by the id – the shared trim's order, computed here on the union before any sync.
    const byAge = [...aRead, ...bRead].sort(compareReadAge)
    const expectedGone = byAge
      .slice(0, 200)
      .map((e) => e.id)
      .sort()
    const expectedRead = byAge
      .slice(200)
      .map((e) => e.id)
      .sort()
    expect(expectedRead).toHaveLength(READING_LIST_CAP)

    // The phone merges the desktop's list: 1 200 read land on it, the 200 oldest by `readAt` go
    // and its round tombstones them; the desktop takes the tombstones and the phone's entries.
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(readIds(b)).toEqual(expectedRead)
    expect(unreadIds(b)).toEqual(everyUnread)
    await a.engine.syncNow()
    expect(readIds(a)).toEqual(expectedRead)
    expect(unreadIds(a)).toEqual(everyUnread)
    await b.engine.syncNow()
    await a.engine.syncNow()

    // Converged: 1 000 read + 100 unread on both, the same set by id; the 200 gone are the
    // oldest by `readAt`; every unread entry kept.
    expect(ids(a)).toEqual(ids(b))
    expect(readIds(a)).toEqual(expectedRead)
    expect(readIds(b)).toEqual(expectedRead)
    expect(unreadIds(a)).toEqual(everyUnread)
    expect(unreadIds(b)).toEqual(everyUnread)
    expect(a.browser.state.readingList).toHaveLength(READING_LIST_CAP + 100)
    expect(b.browser.state.readingList).toHaveLength(READING_LIST_CAP + 100)
    for (const id of expectedGone) {
      expect(a.browser.readingList.get(id)).toBeNull()
      expect(b.browser.readingList.get(id)).toBeNull()
    }
    // Tombstones for exactly those 200 and nothing else: the phone's file, which made the trim,
    // carries all 200; the desktop's carries those of the 200 it held – its own read entries the
    // phone's tombstones took out (a tombstone for an id a device never held is no winner there,
    // `winningRemote`, so it is not echoed). The two files' tombstones together are the 200, and
    // no other id is tombstoned anywhere; a live record for every survivor.
    const aOwn = new Set(aRead.map((e) => e.id))
    expect(await tombstoned(b)).toEqual(expectedGone)
    expect(await tombstoned(a)).toEqual(expectedGone.filter((id) => aOwn.has(id)))
    expect([...new Set([...(await tombstoned(a)), ...(await tombstoned(b))])].sort()).toEqual(
      expectedGone
    )
    for (const d of [a, b]) {
      const live = (await readingRecords(d))
        .filter((r) => !r.deleted)
        .map((r) => r.id)
        .sort()
      expect(live).toEqual([...expectedRead, ...everyUnread].sort())
    }
    // Steady state: another round each changes nothing.
    const aTombs = await tombstoned(a)
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(ids(a)).toEqual(ids(b))
    expect(readIds(a)).toEqual(expectedRead)
    expect(unreadIds(a)).toEqual(everyUnread)
    expect(await tombstoned(a)).toEqual(aTombs)
    expect(await tombstoned(b)).toEqual(expectedGone)
  }, 60_000)
})

/**
 * The Mods across two devices (services pass 15, ID-43): one `mod` record per Mod, every field
 * but `id`; the engine's `modified` the clock (an edit stamped at its commit, the Mod's own
 * `updatedAt` information), tombstones from a Mod's absence, the type's toggle freezing rather
 * than deleting, and no stamp for the Mods a profile held before the type existed.
 */
describe('the Mods across two devices', () => {
  const modRecords = async (d: Device): Promise<SyncRecord[]> =>
    (await published(d)).filter((r) => r.type === 'mod')

  const ids = (d: Device): string[] =>
    d.browser.mods
      .all()
      .map((m) => m.id)
      .sort()

  it('replicates the list both ways, last writer by the stamp; a removal lands as a tombstone', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const compact = a.browser.mods.add('Compact tabs', '.tab { padding: 2px; }')
    const rounded = a.browser.mods.add(
      'Rounded',
      '.sidebar { border-radius: 12px; }',
      'https://mods.example/rounded.css'
    )

    await setup(a)
    expect(a.engine.status().scope.mods).toBe(true)
    // The record as it goes over the wire: the Mod's fields but the id, in the normal form's
    // order, `modified` 0 for a record first seen (no one edited it since it was known).
    const aRecords = await modRecords(a)
    expect(aRecords.map((r) => r.id).sort()).toEqual([compact.id, rounded.id].sort())
    const compactRecord = aRecords.find((r) => r.id === compact.id)!
    expect(compactRecord).toEqual({
      id: compact.id,
      type: 'mod',
      data: {
        name: 'Compact tabs',
        source: null,
        css: '.tab { padding: 2px; }',
        enabled: true,
        updatedAt: compact.updatedAt
      },
      modified: 0,
      deleted: false
    })
    expect(Object.keys(compactRecord.data as object)).toEqual([
      'name',
      'source',
      'css',
      'enabled',
      'updatedAt'
    ])
    // Encrypted like everything else: no CSS in the clear in the folder.
    for (const text of folderFiles('/drive').values()) expect(text).not.toContain('padding: 2px')

    // The phone joins and takes the list whole, each Mod under the desktop's id.
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(ids(b)).toEqual(ids(a))
    expect(b.browser.mods.all().find((m) => m.id === compact.id)).toEqual(compact)
    expect(b.browser.mods.all().find((m) => m.id === rounded.id)).toEqual(rounded)

    // Turned off on the phone: the edit is stamped at its commit and lands on the desktop.
    await settle()
    b.browser.mods.update(compact.id, { enabled: false })
    await settle()
    await b.engine.syncNow()
    const theirs = (await modRecords(b)).find((r) => r.id === compact.id)!
    expect(theirs.modified).toBeGreaterThan(0)
    expect((theirs.data as Mod).enabled).toBe(false)
    await a.engine.syncNow()
    expect(a.browser.mods.all().find((m) => m.id === compact.id)).toMatchObject({
      enabled: false,
      updatedAt: (theirs.data as Mod).updatedAt
    })
    // The desktop's list keeps its order; the Mod changed in place.
    expect(a.browser.mods.all().map((m) => m.id)).toEqual([compact.id, rounded.id])

    // Both edit the same Mod apart: the later stamp wins on both, whichever device made it.
    await settle()
    a.browser.mods.update(compact.id, { css: '.tab { padding: 3px; }' })
    await settle()
    b.browser.mods.update(compact.id, { css: '.tab { padding: 4px; }' })
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.mods.all().find((m) => m.id === compact.id)!.css).toBe(
      '.tab { padding: 4px; }'
    )
    expect(b.browser.mods.all().find((m) => m.id === compact.id)!.css).toBe(
      '.tab { padding: 4px; }'
    )
    const aStamp = (await modRecords(a)).find((r) => r.id === compact.id)!.modified
    const bStamp = (await modRecords(b)).find((r) => r.id === compact.id)!.modified
    expect(aStamp).toBe(bStamp)

    // The desktop removes a Mod: a tombstone at the removal's time, and the phone drops it.
    await settle()
    a.browser.mods.remove(rounded.id)
    await settle()
    await a.engine.syncNow()
    const gone = (await modRecords(a)).find((r) => r.id === rounded.id)!
    expect(gone).toMatchObject({ deleted: true, data: null })
    expect(gone.modified).toBeGreaterThan(0)
    await b.engine.syncNow()
    expect(ids(a)).toEqual([compact.id])
    expect(ids(b)).toEqual([compact.id])

    // Steady state: another round each changes nothing – the landed Mod re-collects to the
    // received hash (the sanitiser is idempotent), so no device stamps what it merely holds.
    const before = [aStamp, (await modRecords(b)).find((r) => r.id === compact.id)!.modified]
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect((await modRecords(a)).find((r) => r.id === compact.id)!.modified).toBe(before[0])
    expect((await modRecords(b)).find((r) => r.id === compact.id)!.modified).toBe(before[1])
  }, 30_000)

  it("the Mods a profile held before the type existed go out at modified 0 at the first sync on the new build – never at the launch – so a peer's edit of them wins", async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await a.engine.syncNow()

    // The desktop is closed; the previous build (the Mods without their sync type) left a list
    // in `mods.json` and a sync state that knows nothing of it – no metadata for the Mods, no
    // `mods` in the scope object.
    const closed = close(a)
    const held: Mod[] = [
      {
        id: 'mod_before_1',
        name: 'Before 1',
        source: null,
        css: '.before-1 {}',
        enabled: true,
        updatedAt: 1_000
      },
      {
        id: 'mod_before_2',
        name: 'Before 2',
        source: 'before-2.css',
        css: '.before-2 {}',
        enabled: false,
        updatedAt: 2_000
      }
    ]
    expect(closed['mods.json']).toBeUndefined()
    closed['mods.json'] = JSON.stringify({ version: 1, mods: held })
    const sync = JSON.parse(closed['sync.json']!) as {
      meta: MetaMap
      scope: Record<string, boolean>
    }
    delete sync.scope.mods
    expect(Object.values(sync.meta).some((m) => m.type === 'mod')).toBe(false)
    closed['sync.json'] = JSON.stringify(sync)

    // The desktop launches into the build: `ModService` reads the list at construction as it
    // always did, the scope completes to the default (on), the seed at start writes nothing for
    // the Mods (it has no entry to adopt a hash into), and the first round publishes them at 0 –
    // the timestamp of a record no one edited since it was known.
    await settle()
    const launched = Date.now()
    const upgraded = reopen('Desk (Linux)', closed)
    expect(upgraded.browser.mods.all()).toEqual(held)
    expect(upgraded.engine.status().scope.mods).toBe(true)
    upgraded.engine.flushSync()
    const seeded = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta
    expect(seeded.mod_before_1).toBeUndefined()
    expect(seeded.mod_before_2).toBeUndefined()
    await upgraded.engine.syncNow()
    expect(upgraded.engine.status().lastError).toBeNull()
    const records = await modRecords(upgraded)
    expect(records.map((r) => r.id).sort()).toEqual(['mod_before_1', 'mod_before_2'])
    for (const r of records) {
      expect(r.modified).toBe(0)
      expect(r.modified).toBeLessThan(launched)
      expect(r.data).not.toHaveProperty('id')
    }
    expect(records.find((r) => r.id === 'mod_before_2')!.data).toEqual({
      name: 'Before 2',
      source: 'before-2.css',
      css: '.before-2 {}',
      enabled: false,
      updatedAt: 2_000
    })
    upgraded.engine.flushSync()
    const meta = (JSON.parse(upgraded.io.files['sync.json']!) as { meta: MetaMap }).meta
    expect(meta.mod_before_1?.modified).toBe(0)
    expect(meta.mod_before_2?.modified).toBe(0)

    // The phone takes them, then edits one: its stamp is a real time, and it wins on the desktop.
    await b.engine.syncNow()
    expect(ids(b)).toEqual(['mod_before_1', 'mod_before_2'])
    await settle()
    b.browser.mods.update('mod_before_2', { enabled: true })
    await settle()
    await b.engine.syncNow()
    await upgraded.engine.syncNow()
    expect(upgraded.browser.mods.all().find((m) => m.id === 'mod_before_2')).toMatchObject({
      enabled: true,
      updatedAt: expect.any(Number)
    })
    expect(upgraded.browser.mods.all().find((m) => m.id === 'mod_before_2')!.updatedAt).toBe(
      b.browser.mods.all().find((m) => m.id === 'mod_before_2')!.updatedAt
    )
  }, 30_000)

  it('turning the Mods off stops sending and receiving them without deleting anything, on either device', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    const kept = a.browser.mods.add('Kept', '.kept {}')
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(ids(b)).toEqual([kept.id])

    // The desktop turns the type off: its file carries no Mod and no tombstone either.
    a.engine.setScope({ mods: false })
    expect(a.engine.status().scope.mods).toBe(false)
    await a.engine.syncNow()
    expect(await modRecords(a)).toEqual([])
    await b.engine.syncNow()
    expect(ids(b)).toEqual([kept.id])
    expect(ids(a)).toEqual([kept.id])

    // The phone adds a Mod and removes the shared one meanwhile; the desktop, with the type
    // off, takes neither the Mod nor the removal.
    await settle()
    const theirs = b.browser.mods.add('Phone', '.phone {}')
    b.browser.mods.remove(kept.id)
    await settle()
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(ids(a)).toEqual([kept.id])

    // Back on: the desktop publishes again and catches up – the Mod lands, the removal too.
    a.engine.setScope({ mods: true })
    await a.engine.syncNow()
    expect(ids(a)).toEqual([theirs.id])
    expect((await modRecords(a)).filter((r) => !r.deleted).map((r) => r.id)).toEqual([theirs.id])
  }, 30_000)
})

/**
 * The vault's addresses and payment cards across two devices (services pass 16, ID-45; the
 * lead's ruling on #712): the real store on each side, the `address` records under the
 * `addresses` scope and the `payment-method` records under `paymentMethods`, each key gating
 * its own type and nothing else, the logins' rules, the folder's end-to-end envelope around them.
 */
describe('addresses and payment cards across two devices (ID-45)', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))
  const vaultRecords = async (d: Device, ...types: RecordType[]): Promise<SyncRecord[]> =>
    (await published(d)).filter((r) => types.includes(r.type))
  const address = {
    country: 'GB',
    name: 'Ada Lovelace',
    organization: '',
    streetAddress: '12 St James\u2019s Square',
    locality: 'London',
    region: '',
    postalCode: 'SW1Y 4JH',
    sortingCode: '',
    phone: '+44 20 7946 0958',
    email: 'ada@example.com'
  }
  const card = {
    number: '4111111111111111',
    expMonth: 12,
    expYear: 2031,
    name: 'Ada Lovelace',
    nickname: 'Work Visa'
  }

  it('replicates both types both ways with the ids kept, last writer wins per entry, a deletion lands as a tombstone', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const login = a.browser.passwords.add({
      url: 'https://example.com/login',
      username: 'ada',
      password: 'first-secret'
    })
    const aAddress = a.browser.passwords.store.addAddress(address)
    const aCard = a.browser.passwords.store.addCard(card)
    expect(aCard.number).toBe('4111111111111111')

    await setup(a)
    // Nothing of the entries is readable in the folder: the number, the name, the postcode.
    for (const text of folderFiles('/drive').values()) {
      expect(text).not.toContain('4111')
      expect(text).not.toContain('Lovelace')
      expect(text).not.toContain('SW1Y')
    }
    const aRecords = await vaultRecords(a, 'address', 'payment-method')
    expect(aRecords.map((r) => r.id).sort()).toEqual([aAddress.id, aCard.id].sort())
    expect(aRecords.find((r) => r.id === aAddress.id)).toEqual({
      id: aAddress.id,
      type: 'address',
      modified: 0,
      deleted: false,
      data: {
        ...address,
        createdAt: aAddress.createdAt,
        updatedAt: aAddress.updatedAt,
        lastUsedAt: null
      }
    })
    expect(aRecords.find((r) => r.id === aCard.id)).toEqual({
      id: aCard.id,
      type: 'payment-method',
      modified: 0,
      deleted: false,
      data: {
        ...card,
        createdAt: aCard.createdAt,
        updatedAt: aCard.updatedAt,
        lastUsedAt: null
      }
    })

    // B joins and merges: the same entries under the same ids, the login beside them.
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.engine.status().lastError).toBeNull()
    expect(b.browser.passwords.store.getAddress(aAddress.id)).toEqual(aAddress)
    expect(b.browser.passwords.store.getCard(aCard.id)).toEqual(aCard)
    expect(b.browser.passwords.store.get(login.id)?.password).toBe('first-secret')
    // The phone's list shows the card as its own: masked in the chrome, the number in the vault.
    expect(b.browser.autofill.listCards().map((c) => [c.id, c.last4, c.network])).toEqual([
      [aCard.id, '1111', 'visa']
    ])

    // B edits the card and uses the address later; A takes both under B's timestamps.
    await settle()
    const renamed = b.browser.passwords.store.updateCard(aCard.id, { nickname: 'Personal Visa' })!
    b.browser.passwords.store.markAddressUsed(aAddress.id, renamed.updatedAt)
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getCard(aCard.id)).toEqual(renamed)
    expect(a.browser.passwords.store.getAddress(aAddress.id)?.lastUsedAt).toBe(renamed.updatedAt)

    // A deletes the address; the tombstone reaches B, the card stays, the login too.
    await settle()
    a.browser.passwords.store.removeAddress(aAddress.id)
    await a.engine.syncNow()
    expect((await vaultRecords(a, 'address')).find((r) => r.id === aAddress.id)).toMatchObject({
      type: 'address',
      deleted: true,
      data: null
    })
    await b.engine.syncNow()
    expect(b.browser.passwords.store.getAddress(aAddress.id)).toBeNull()
    expect(b.browser.passwords.store.getCard(aCard.id)).toEqual(renamed)
    expect(b.browser.passwords.store.get(login.id)).not.toBeNull()
  }, 30_000)

  it('Addresses off and Payment methods on: the cards keep travelling both ways, the addresses stop without a deletion – and the reverse', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const login = a.browser.passwords.add({
      url: 'https://a.example/',
      username: 'ada',
      password: 'pw'
    })
    const aAddress = a.browser.passwords.store.addAddress(address)
    const aCard = a.browser.passwords.store.addCard(card)
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.passwords.store.getAddress(aAddress.id)).not.toBeNull()
    expect(b.browser.passwords.store.getCard(aCard.id)).not.toBeNull()

    // A turns Addresses off: no address in its file – and no tombstone either – while the card
    // and the login stay published; B keeps its copy of the address.
    a.engine.setScope({ addresses: false })
    expect(a.engine.status().scope).toMatchObject({ addresses: false, paymentMethods: true })
    await a.engine.syncNow()
    expect(await vaultRecords(a, 'address')).toEqual([])
    expect((await vaultRecords(a, 'payment-method')).map((r) => r.id)).toEqual([aCard.id])
    expect((await vaultRecords(a, 'credential')).map((r) => r.id)).toEqual([login.id])
    await b.engine.syncNow()
    expect(b.browser.passwords.store.getAddress(aAddress.id)).not.toBeNull()

    // B adds an address and a card meanwhile: A takes the card and not the address.
    const bAddress = b.browser.passwords.store.addAddress({ ...address, locality: 'Oxford' })
    const bCard = b.browser.passwords.store.addCard({ ...card, number: '5555555555554444' })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getAddress(bAddress.id)).toBeNull()
    expect(a.browser.passwords.store.getCard(bCard.id)?.number).toBe('5555555555554444')

    // The reverse: Addresses back on, Payment methods off. A publishes and takes the addresses,
    // its cards stay home without a tombstone, and B's new card does not reach it.
    a.engine.setScope({ addresses: true, paymentMethods: false })
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getAddress(bAddress.id)?.locality).toBe('Oxford')
    expect(
      (await vaultRecords(a, 'address'))
        .filter((r) => !r.deleted)
        .map((r) => r.id)
        .sort()
    ).toEqual([aAddress.id, bAddress.id].sort())
    expect(await vaultRecords(a, 'payment-method')).toEqual([])
    await b.engine.syncNow()
    expect(b.browser.passwords.store.getCard(aCard.id)).not.toBeNull()
    expect(b.browser.passwords.store.getCard(bCard.id)).not.toBeNull()
    const bCard2 = b.browser.passwords.store.addCard({ ...card, number: '378282246310005' })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getCard(bCard2.id)).toBeNull()

    // Both on again: A publishes both types and picks up the card it missed.
    a.engine.setScope({ paymentMethods: true })
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getCard(bCard2.id)?.number).toBe('378282246310005')
    expect(
      (await vaultRecords(a, 'payment-method'))
        .filter((r) => !r.deleted)
        .map((r) => r.id)
        .sort()
    ).toEqual([aCard.id, bCard.id, bCard2.id].sort())
  }, 30_000)

  it('Passwords off gates the logins alone: the addresses and the cards keep travelling', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    a.browser.passwords.add({ url: 'https://a.example/', username: 'ada', password: 'pw' })
    const aAddress = a.browser.passwords.store.addAddress(address)
    await setup(a)
    a.engine.setScope({ passwords: false })
    await a.engine.syncNow()
    expect(await vaultRecords(a, 'credential')).toEqual([])
    expect((await vaultRecords(a, 'address')).map((r) => r.id)).toEqual([aAddress.id])
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.passwords.store.getAddress(aAddress.id)).toEqual(aAddress)
    expect(b.browser.passwords.store.list()).toEqual([])
    const bCard = b.browser.passwords.store.addCard(card)
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getCard(bCard.id)).toEqual(bCard)
  }, 30_000)

  it('a locked vault holds the entries instead of tombstoning or applying them', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const aCard = a.browser.passwords.store.addCard(card)
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.passwords.store.getCard(aCard.id)).not.toBeNull()

    a.browser.passwords.lock()
    await a.engine.syncNow()
    expect(a.engine.status().lastError).toBeNull()
    expect(await vaultRecords(a, 'address', 'payment-method')).toEqual([])
    await b.engine.syncNow()
    expect(b.browser.passwords.store.getCard(aCard.id)).not.toBeNull()

    // B adds an address; A is locked and cannot apply it yet – it lands once the vault opens.
    const bAddress = b.browser.passwords.store.addAddress(address)
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect((await a.browser.passwords.unlock()).status).toBe('ok')
    expect(a.browser.passwords.store.getAddress(bAddress.id)).toBeNull()
    await a.engine.syncNow()
    expect(a.browser.passwords.store.getAddress(bAddress.id)).toEqual(bAddress)
    expect(a.browser.passwords.store.getCard(aCard.id)).not.toBeNull()
  }, 30_000)

  it('"keep this device\'s data" never deletes the other device\'s addresses or cards', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    await unlockVault(a)
    await unlockVault(b)
    const aAddress = a.browser.passwords.store.addAddress(address)
    a.browser.bookmarks.create({ title: 'A only', url: 'https://a-only.example/' })
    await setup(a)
    const bCard = b.browser.passwords.store.addCard(card)
    await setup(b)
    await b.engine.confirmMerge(false)
    await a.engine.syncNow()
    expect(a.browser.state.bookmarks.some((n) => n.url === 'https://a-only.example/')).toBe(false)
    // The vault merges by entry regardless: both entries exist on both devices.
    expect(a.browser.passwords.store.getAddress(aAddress.id)).not.toBeNull()
    expect(a.browser.passwords.store.getCard(bCard.id)).not.toBeNull()
    await b.engine.syncNow()
    expect(b.browser.passwords.store.getAddress(aAddress.id)).not.toBeNull()
    expect(b.browser.passwords.store.getCard(bCard.id)).not.toBeNull()
  }, 30_000)

  it('a peer on a later build: a record type this build does not know, a credential kind it does not read and a card it cannot read are skipped round after round and never tombstoned; the login, the address and the card beside them land', async () => {
    const a = device('Desk (Linux)')
    await unlockVault(a)
    a.browser.passwords.add({ url: 'https://a.example/', username: 'ada', password: 'pw' })
    await setup(a)

    // A peer on a later build writes its file under the folder's key: a type this build does
    // not know (what `address` and `payment-method` are to every build before this one), a
    // `credential` of a kind it does not read, a card without a number, and a login, an address
    // and a card it can land.
    const own = folderFiles('/drive').get(deviceFileName(a.engine.status().deviceId))!
    const salt = (JSON.parse(own) as { envelope: { salt: string } }).envelope.salt
    const key = await folderKey(salt)
    const later = Date.now() + 10
    const theirs: SyncRecord[] = [
      {
        id: 'iban_1',
        type: 'bank-account' as RecordType,
        modified: later,
        deleted: false,
        data: { iban: 'GB33BUKB20201555555555', nickname: 'Rent' }
      },
      {
        id: 'iban_gone',
        type: 'bank-account' as RecordType,
        modified: later,
        deleted: true,
        data: null
      },
      {
        id: 'totp_1',
        type: 'credential',
        modified: later,
        deleted: false,
        data: { kind: 'totp', origin: 'https://peer.example', secret: 'JBSWY3DPEHPK3PXP' }
      },
      {
        id: 'card_unreadable',
        type: 'payment-method',
        modified: later,
        deleted: false,
        data: { nickname: 'A card with no number' }
      },
      {
        id: 'address_peer',
        type: 'address',
        modified: later,
        deleted: false,
        data: { ...address, createdAt: 1, updatedAt: 1, lastUsedAt: null }
      },
      {
        id: 'card_peer',
        type: 'payment-method',
        modified: later,
        deleted: false,
        data: { ...card, createdAt: 1, updatedAt: 1, lastUsedAt: null }
      },
      {
        id: 'login_peer',
        type: 'credential',
        modified: later,
        deleted: false,
        data: {
          kind: 'login',
          origin: 'https://peer.example',
          url: 'https://peer.example/',
          username: 'bob',
          password: 'pw2',
          realm: null,
          notes: '',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null
        }
      }
    ]
    folderFiles('/drive').set(
      deviceFileName('peer-later-build'),
      serializeDeviceFile({
        deviceId: 'peer-later-build',
        deviceName: 'Phone (a later build)',
        updatedAt: later,
        envelope: await encryptJson(key, salt, { v: 1, records: theirs })
      })
    )

    for (let round = 0; round < 3; round++) {
      await a.engine.syncNow()
      expect(a.engine.status().lastError).toBeNull()
      expect(a.browser.passwords.store.get('login_peer')?.username).toBe('bob')
      expect(a.browser.passwords.store.getAddress('address_peer')?.postalCode).toBe('SW1Y 4JH')
      expect(a.browser.passwords.store.getCard('card_peer')?.number).toBe('4111111111111111')
      expect(a.browser.passwords.store.getCard('card_unreadable')).toBeNull()
      // Skipped: nothing in A's file for them – no copy, no tombstone – and nothing in its
      // metadata.
      const mine = await published(a)
      for (const id of ['iban_1', 'iban_gone', 'totp_1', 'card_unreadable']) {
        expect(
          mine.find((r) => r.id === id),
          id
        ).toBeUndefined()
      }
      expect(mine.find((r) => r.id === 'address_peer')).toMatchObject({
        type: 'address',
        deleted: false,
        modified: later
      })
      expect(mine.find((r) => r.id === 'card_peer')).toMatchObject({
        type: 'payment-method',
        deleted: false,
        modified: later
      })
      const meta = (a.engine as unknown as { data: { meta: MetaMap } }).data.meta
      for (const id of ['iban_1', 'iban_gone', 'totp_1', 'card_unreadable']) {
        expect(meta[id], id).toBeUndefined()
      }
    }
  }, 30_000)
})

const EXT_A = 'abcdefghijklmnopabcdefghijklmnop'
const EXT_B = 'ppppoooonnnnmmmmllllkkkkjjjjiiii'
const EXT_U = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const EXT_P = 'bhgcbgkfglbhjgdlchndpgjmgeeekaee'

/** What a test says of an extension it installs: the switches, their clocks, whether it waits for approval. */
interface ExtensionOpts {
  enabled?: boolean
  toolbarPinned?: boolean
  pendingApproval?: boolean
  enabledAt?: number
  toolbarPinnedAt?: number
  /** The registry's install time (`ExtensionRecord.installedAt`); the host's `add` stamps the device's time unless given. */
  installedAt?: number
}

function extensionInfo(
  id: string,
  source: ExtensionSource,
  opts: ExtensionOpts = {}
): ExtensionInfo {
  return {
    id,
    name: `Extension ${id.slice(0, 4)}`,
    version: '1.0.0',
    description: '',
    path: `/extensions/${id}`,
    enabled: opts.enabled ?? true,
    icon: null,
    popup: null,
    error: null,
    source,
    publisher: source === 'chrome-web-store' || source === 'edge-add-ons' ? source : null,
    updateUrl: null,
    installedAt: opts.installedAt ?? 1_000,
    updatedAt: opts.installedAt ?? 1_000,
    pinned: false,
    toolbarPinned: opts.toolbarPinned ?? false,
    ...(opts.enabledAt !== undefined ? { enabledAt: opts.enabledAt } : {}),
    ...(opts.toolbarPinnedAt !== undefined ? { toolbarPinnedAt: opts.toolbarPinnedAt } : {}),
    allowFileAccess: false,
    allowPrivate: false,
    allowUserScripts: false,
    manifestVersion: 3,
    permissions: [],
    hostPermissions: [],
    optionsPage: null,
    newTabPage: null,
    newTabOverride: false,
    warnings: [],
    pendingWarnings: null,
    ...(opts.pendingApproval ? { pendingApproval: true } : {}),
    updateState: 'unknown',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: null,
    errors: []
  }
}

/**
 * A host with store installs that publishes them and lands none – the phone's shape (Android's
 * `AndroidExtensions` installs from the stores, clocks the switches it flips and none other –
 * its install writes no clock but the registry's `installedAt`, the shared `newRecord`'s `now`,
 * which its `list()` projects and the record carries (round 5) – and has no
 * `applySyncedExtensions` and no `syncSources`: the engine reads its `list()`).
 */
class PublishingExtensions extends NoExtensions {
  readonly installed = new Map<string, ExtensionInfo>()

  constructor(protected readonly b: Browser) {
    super(b)
  }

  list(): ExtensionInfo[] {
    return [...this.installed.values()]
  }

  ids(): string[] {
    return [...this.installed.keys()].sort()
  }

  /** The user installs an extension here – from a store, or from a file or folder – at the device's time. */
  add(id: string, source: ExtensionSource, opts: ExtensionOpts = {}): void {
    this.installed.set(id, extensionInfo(id, source, { installedAt: Date.now(), ...opts }))
    this.b.state.commitVolatile()
  }

  /**
   * A change of the record: the user's flip of a switch is stamped with the device's time – its
   * clock for that switch (`AndroidExtensions.setEnabled` / `setToolbarPinned` on the phone,
   * `ExtensionService.switchEnabled` / `setToolbarPinned` on the desktop) – unless the patch
   * carries the clock (a synced record's) or the test says otherwise (`stamps` false: a build
   * from before the clocks).
   */
  set(id: string, patch: Partial<ExtensionInfo>, stamps = true): void {
    const have = this.installed.get(id)
    if (!have) return
    const next = { ...have, ...patch }
    if (stamps) {
      const now = Date.now()
      if (patch.enabled !== undefined && patch.enabled !== have.enabled && !('enabledAt' in patch))
        next.enabledAt = now
      if (
        patch.toolbarPinned !== undefined &&
        patch.toolbarPinned !== have.toolbarPinned &&
        !('toolbarPinnedAt' in patch)
      )
        next.toolbarPinnedAt = now
    }
    if (patch.pendingApproval === undefined && 'pendingApproval' in patch)
      delete next.pendingApproval
    this.installed.set(id, next)
    this.b.state.commitVolatile()
  }

  /** The user uninstalls an extension here – what the host's `remove` does, synchronous in this fake. */
  drop(id: string): void {
    if (this.installed.delete(id)) this.b.state.commitVolatile()
  }
}

/**
 * The desktop's shape: what the apply hands over is recorded and acted on as the desktop's
 * applier does (`ExtensionSyncApplier.mergeSwitches`) – a tombstone uninstalls; a record for a
 * present extension is merged SWITCH BY SWITCH, each taken when the record's clock for it is
 * not older than this device's (an equal value under a later clock adopts the clock alone;
 * never an enable while the landing waits for approval, and such a withheld enable is not
 * re-published on its own, though a later pin clock here still is – N2), nothing taken while
 * this device's clocks are the later ones → the record is re-committed so the engine publishes
 * this device's copy afresh; a record for an absent one
 * starts a download the test lands (`land`) or lets fail (nothing). An install here stamps both
 * clocks with the device's time, as `ExtensionService.installPackage` does; a user's flip
 * (`set`) stamps its switch. The install's time the record carries (round 5) is the one the
 * desktop's `syncSources()` projects: a landing's the time its record carried
 * (`ExtensionRecord.syncedInstalledAt`, held here in `synced`; 0 for none), an install made
 * here its own – and the merge adopts a later one from a peer's record, as `adoptInstalledAt`.
 */
class StoreExtensions extends PublishingExtensions {
  readonly applied: SyncedExtensionChange[][] = []
  /** The commits made to re-publish a record that landed nothing (`republish`). */
  republished: string[] = []
  /** `ExtensionRecord.syncedInstalledAt` by id: the install time a landing publishes in place of its own. */
  readonly synced = new Map<string, number>()

  add(id: string, source: ExtensionSource, opts: ExtensionOpts = {}): void {
    const now = Date.now()
    super.add(id, source, { installedAt: now, enabledAt: now, toolbarPinnedAt: now, ...opts })
  }

  set(id: string, patch: Partial<ExtensionInfo>, stamps = true): void {
    super.set(id, patch, stamps)
  }

  drop(id: string): void {
    this.synced.delete(id)
    super.drop(id)
  }

  /** The install time this copy publishes (`syncSources()`): the landing's record's, or its own. */
  publishedInstalledAt(id: string): number | undefined {
    const have = this.installed.get(id)
    return have ? (this.synced.get(id) ?? have.installedAt) : undefined
  }

  syncSources(): ExtensionSyncSource[] {
    return [...this.installed.values()].map((e) => ({
      id: e.id,
      source: e.source,
      enabled: e.enabled,
      toolbarPinned: e.toolbarPinned,
      installedAt: this.synced.get(e.id) ?? e.installedAt,
      ...(e.pendingApproval ? { pendingApproval: true } : {}),
      ...(e.enabledAt !== undefined ? { enabledAt: e.enabledAt } : {}),
      ...(e.toolbarPinnedAt !== undefined ? { toolbarPinnedAt: e.toolbarPinnedAt } : {})
    }))
  }

  applySyncedExtensions(changes: readonly SyncedExtensionChange[]): void {
    this.applied.push([...changes])
    this.act(changes)
  }

  /** What the desktop's applier does with the changes, once they run. */
  protected act(changes: readonly SyncedExtensionChange[]): void {
    for (const c of changes) {
      const have = this.installed.get(c.id)
      if (c.data === null) {
        this.drop(c.id)
        continue
      }
      if (!have) continue
      this.merge(have, c.data)
    }
  }

  private merge(have: ExtensionInfo, remote: SyncedExtensionData): void {
    const patch: Partial<ExtensionInfo> = {}
    // The install's time, merged like a clock (round 5): a later one on the record is adopted
    // as the time this copy publishes (`adoptInstalledAt`); an earlier one, or none, while this
    // copy publishes a later time re-publishes.
    const installedAt = this.synced.get(have.id) ?? have.installedAt
    const installFromRecord = remote.installedAt >= installedAt
    let adopted = false
    if (remote.installedAt > installedAt) {
      this.synced.set(have.id, remote.installedAt)
      adopted = true
    }
    const pinAt = have.toolbarPinnedAt ?? 0
    const pinFromRecord = remote.toolbarPinnedAt >= pinAt
    if (
      pinFromRecord &&
      (have.toolbarPinned !== remote.toolbarPinned || remote.toolbarPinnedAt > pinAt)
    ) {
      patch.toolbarPinned = remote.toolbarPinned
      patch.toolbarPinnedAt = remote.toolbarPinnedAt
    }
    const enabledAt = have.enabledAt ?? 0
    const enabledFromRecord = remote.enabledAt >= enabledAt
    // An enable withheld while the landing waits for approval is no early exit (N2): a pin
    // clock here later than the record's still re-publishes; the withheld enable alone does not.
    if (
      enabledFromRecord &&
      (have.enabled !== remote.enabled || remote.enabledAt > enabledAt) &&
      !(remote.enabled && have.pendingApproval)
    ) {
      patch.enabled = remote.enabled
      patch.enabledAt = remote.enabledAt
    }
    if (Object.keys(patch).length > 0) this.set(have.id, patch, false)
    else if (adopted) this.b.state.commitVolatile()
    else if (!pinFromRecord || !enabledFromRecord || !installFromRecord) {
      this.republished.push(have.id)
      this.b.state.commitVolatile()
    }
  }

  /**
   * The download landed: installed turned off, waiting for approval, pinned as the record says,
   * the switches' clocks the record's (none when the record carried none – a record first
   * seen, `modified` 0, as the desktop's `installPackage` keeps no clock of 0), its own
   * `installedAt` this device's time and the install time it publishes the record's
   * (`syncedInstalledAt`, 0 when the record carried none).
   */
  land(id: string): void {
    const change = this.applied.flat().findLast((c) => c.id === id && c.data !== null)!
    const data = change.data!
    this.synced.set(id, data.installedAt)
    this.add(id, data.store, {
      enabled: false,
      toolbarPinned: data.toolbarPinned,
      pendingApproval: true,
      enabledAt: data.enabledAt > 0 ? data.enabledAt : undefined,
      toolbarPinnedAt: data.toolbarPinnedAt > 0 ? data.toolbarPinnedAt : undefined
    })
  }

  /** The user approved the landing's permissions (the Extensions page's Enable): on, no longer pending, the enable's clock this device's time. */
  approve(id: string): void {
    this.set(id, { enabled: true, pendingApproval: undefined })
  }

  /** The batches so far, flattened to `id:state` lines with the device each came from. */
  log(): string[] {
    return this.applied.flat().map((c) => {
      const state = c.data
        ? `${c.data.store} ${c.data.enabled ? 'on' : 'off'} ${c.data.toolbarPinned ? 'pinned' : 'unpinned'}`
        : 'removed'
      return `${c.id.slice(0, 4)} ${state} from ${c.from ?? '?'}`
    })
  }
}

/**
 * The desktop's shape with the applier's schedule: what the apply hands over is IN FLIGHT –
 * recorded, the id reported to the engine (`syncedExtensionsInFlight`), acted on a later turn
 * of the loop (`commit`: on its own the next macrotask, as the real applier acts after the
 * startup hold, the attach and the id's busy work; or when the test says, `manual`). The
 * round's re-snapshot therefore never sees the applied state, and the commit that lands it is
 * the edit the engine stamps – the desktop's shape exactly.
 */
class InFlightExtensions extends StoreExtensions {
  private pending: SyncedExtensionChange[] = []
  private readonly flying = new Set<string>()
  /** The test lands the records itself (`commit`). */
  manual = false

  applySyncedExtensions(changes: readonly SyncedExtensionChange[]): void {
    this.applied.push([...changes])
    for (const c of changes) {
      this.pending.push(c)
      this.flying.add(c.id)
    }
    if (!this.manual) setTimeout(() => this.commit(), 0)
  }

  syncedExtensionsInFlight(): ReadonlySet<string> {
    return new Set(this.flying)
  }

  /** The applier's turn: the records land, the ids are done – before the commit's broadcast runs. */
  commit(): void {
    const changes = this.pending
    this.pending = []
    this.act(changes)
    this.flying.clear()
  }
}

/**
 * The desktop's shape whose reads count: `list()` – the manifest reads – and `syncSources()`,
 * the registry's projection. The chrome's snapshot reads `list()` at every broadcast
 * (`Browser.state.extras`); a test that forbids `list()` lets that read through (`uiReading`)
 * and fails any other – the engine's.
 */
class CountingExtensions extends StoreExtensions {
  listCalls = 0
  syncSourcesCalls = 0
  forbidList = false
  uiReading = false

  list(): ExtensionInfo[] {
    this.listCalls += 1
    if (this.forbidList && !this.uiReading)
      throw new Error('list() read a manifest for the sync engine')
    return super.list()
  }

  syncSources(): ExtensionSyncSource[] {
    this.syncSourcesCalls += 1
    return super.syncSources()
  }
}

const desktopExtensions = (browser: Browser): StoreExtensions => new StoreExtensions(browser)
const inFlightExtensions = (browser: Browser): InFlightExtensions => new InFlightExtensions(browser)
const countingExtensions = (browser: Browser): CountingExtensions => new CountingExtensions(browser)
const phoneExtensions = (browser: Browser): PublishingExtensions =>
  new PublishingExtensions(browser)
const hostOf = <T extends PublishingExtensions>(d: Device): T =>
  d.browser.extensions as unknown as T

/**
 * The extensions across two devices (services pass 16, ID-44): one `extension` record per store
 * install, the engine's `modified` the transport's clock and each switch's own clock the
 * merge's; a won record is a request to the host, whose install lands later, turned off and
 * waiting for approval – frozen in the metadata the while, never a tombstone; the approval is
 * the enable's write at its time, and the peer takes its clock alone; an uninstall is the
 * tombstone, and the tombstone names the device that made it.
 */
describe('the extensions across two devices', () => {
  const extensionRecords = async (d: Device): Promise<SyncRecord[]> =>
    (await published(d)).filter((r) => r.type === 'extension')

  it('replicates store installs both ways: a landing waits for approval frozen, not tombstoned; the approval travels as the enable’s clock; a switch flipped and an uninstall travel, the uninstall naming its device', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    A.add(EXT_A, 'chrome-web-store', { enabled: true, toolbarPinned: true })
    A.add(EXT_B, 'edge-add-ons', { enabled: false })
    A.add(EXT_U, 'unpacked')
    const installedAt = A.installed.get(EXT_A)!.enabledAt!
    expect(A.installed.get(EXT_A)!.installedAt).toBe(installedAt)

    await setup(a)
    expect(a.engine.status().scope.extensions).toBe(true)
    // The records as they go over the wire: the store, the two switches, each switch's clock
    // (the install's time here), the install's time (round 5), nothing else; the unpacked one
    // stays home; `modified` 0 for a record first seen.
    const aRecords = await extensionRecords(a)
    expect(aRecords.map((r) => r.id).sort()).toEqual([EXT_A, EXT_B].sort())
    expect(aRecords.find((r) => r.id === EXT_A)).toEqual({
      id: EXT_A,
      type: 'extension',
      data: {
        store: 'chrome-web-store',
        enabled: true,
        toolbarPinned: true,
        enabledAt: installedAt,
        toolbarPinnedAt: installedAt,
        installedAt
      },
      modified: 0,
      deleted: false
    })
    expect(aRecords.find((r) => r.id === EXT_B)!.data).toEqual({
      store: 'edge-add-ons',
      enabled: false,
      toolbarPinned: false,
      enabledAt: A.installed.get(EXT_B)!.enabledAt,
      toolbarPinnedAt: A.installed.get(EXT_B)!.toolbarPinnedAt,
      installedAt: A.installed.get(EXT_B)!.installedAt
    })
    // The wire, decrypted, device by device: the desktop's file alone so far, and the unpacked
    // one in nobody's – it stays home (the verifier's N1: the claim is made on the records, not
    // on the ciphertext, which contains no id whatever the engine did).
    const wire = await publishedAll()
    expect([...wire.keys()]).toEqual([a.engine.status().deviceId])
    for (const records of wire.values()) {
      expect(records.map((r) => r.id)).not.toContain(EXT_U)
      expect(
        records
          .filter((r) => r.type === 'extension')
          .map((r) => r.id)
          .sort()
      ).toEqual([EXT_A, EXT_B].sort())
    }

    // The laptop joins: both records are handed to its host, each naming the desktop; nothing is
    // installed yet (the store's download is the host's, later), and the laptop's own file
    // carries neither a record nor a tombstone for them – the entries are frozen.
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(B.log()).toEqual([
      `${EXT_A.slice(0, 4)} chrome-web-store on pinned from Desk (Linux)`,
      `${EXT_B.slice(0, 4)} edge-add-ons off unpinned from Desk (Linux)`
    ])
    expect(B.ids()).toEqual([])
    expect(b.engine.status().lastError).toBeNull()
    expect(await extensionRecords(b)).toEqual([])
    const bMeta = (): MetaMap => {
      b.engine.flushSync()
      return (JSON.parse(b.io.files['sync.json']!) as { meta: MetaMap }).meta
    }
    expect(bMeta()[EXT_A]).toMatchObject({ type: 'extension', modified: 0, deleted: false })
    expect(bMeta()[EXT_B]).toMatchObject({ type: 'extension', modified: 0, deleted: false })
    // The desktop's copies stand: no tombstone reached it, its list is as it was.
    await a.engine.syncNow()
    expect(A.ids()).toEqual([EXT_A, EXT_B, EXT_U].sort())
    expect(A.applied).toEqual([])

    // Every round hands the outstanding records to the host again (its back-off decides whether
    // it asks the store), still without a tombstone from the laptop.
    await b.engine.syncNow()
    expect(B.applied).toHaveLength(2)
    expect(B.applied[1]!.map((c) => c.id).sort()).toEqual([EXT_A, EXT_B].sort())
    expect(await extensionRecords(b)).toEqual([])

    // The first download lands: turned off, waiting for approval, pinned as the record said, the
    // switches' clocks the record's, its own install time the laptop's and the one it will
    // publish the desktop's (a landing is nobody's install). The laptop publishes nothing for it
    // still – a landing is not its state – and the desktop's copy stays on.
    B.land(EXT_A)
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      pendingApproval: true,
      toolbarPinned: true,
      source: 'chrome-web-store',
      enabledAt: installedAt,
      toolbarPinnedAt: installedAt
    })
    expect(B.installed.get(EXT_A)!.installedAt).toBeGreaterThan(installedAt)
    expect(B.publishedInstalledAt(EXT_A)).toBe(installedAt)
    await b.engine.syncNow()
    expect(await extensionRecords(b)).toEqual([])
    await a.engine.syncNow()
    expect(A.installed.get(EXT_A)!.enabled).toBe(true)
    expect(A.applied).toEqual([])
    // A round on the laptop asks for both still – a landing waiting for approval is outstanding
    // too – and the pending copy takes the record's switches but never an enable.
    await b.engine.syncNow()
    expect(
      B.applied
        .at(-1)!
        .map((c) => c.id)
        .sort()
    ).toEqual([EXT_A, EXT_B].sort())
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: false, pendingApproval: true })

    // Approved on the laptop: the approval is the enable's write, at the laptop's time – the
    // record carries the switch's clock and the round stamps the edit. The desktop, whose copy
    // is on already, takes the clock alone (`enabledAt`, nothing else changes) and holds the
    // same bytes from then on: the laptop's record, under the laptop's stamp.
    await settle()
    B.approve(EXT_A)
    await settle()
    await b.engine.syncNow()
    const approved = (await extensionRecords(b)).find((r) => r.id === EXT_A)!
    const approvedAt = B.installed.get(EXT_A)!.enabledAt!
    expect(approvedAt).toBeGreaterThan(installedAt)
    expect(approved).toEqual({
      id: EXT_A,
      type: 'extension',
      data: {
        store: 'chrome-web-store',
        enabled: true,
        toolbarPinned: true,
        enabledAt: approvedAt,
        toolbarPinnedAt: installedAt,
        installedAt
      },
      modified: expect.any(Number) as number,
      deleted: false
    })
    expect(approved.modified).toBeGreaterThan(0)
    await a.engine.syncNow()
    expect(A.log()).toEqual([`${EXT_A.slice(0, 4)} chrome-web-store on pinned from Work laptop`])
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: approvedAt })
    expect(A.republished).toEqual([])
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)).toEqual(approved)
    await settle()
    await a.engine.syncNow()
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)).toEqual(approved)

    // Turned off on the laptop: the edit is stamped at its commit and lands on the desktop,
    // through the host's own path, naming the laptop.
    await settle()
    B.set(EXT_A, { enabled: false })
    await settle()
    await b.engine.syncNow()
    const theirs = (await extensionRecords(b)).find((r) => r.id === EXT_A)!
    expect(theirs.modified).toBeGreaterThan(approved.modified)
    expect(theirs.data).toEqual({
      store: 'chrome-web-store',
      enabled: false,
      toolbarPinned: true,
      enabledAt: B.installed.get(EXT_A)!.enabledAt,
      toolbarPinnedAt: installedAt,
      installedAt
    })
    await a.engine.syncNow()
    expect(A.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} chrome-web-store off pinned from Work laptop`)
    expect(A.installed.get(EXT_A)!.enabled).toBe(false)
    // The desktop adopts the laptop's stamp for the record it now holds the same: steady state.
    await a.engine.syncNow()
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)!.modified).toBe(theirs.modified)
    await b.engine.syncNow()
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)!.modified).toBe(theirs.modified)
    expect(A.applied).toHaveLength(2)

    // Unpinned from the toolbar on the desktop: the pin travels the other way.
    await settle()
    A.set(EXT_A, { toolbarPinned: false })
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(B.installed.get(EXT_A)!.toolbarPinned).toBe(false)
    // The batch: the winner first, then the outstanding request for the one still to land.
    expect(B.applied.at(-1)!.map((c) => c.id)).toEqual([EXT_A, EXT_B])
    expect(B.log().at(-2)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store off unpinned from Desk (Linux)`
    )

    // The desktop uninstalls the one whose download never landed on the laptop: the tombstone
    // closes the laptop's entry – no further request for it – and installs nothing.
    await settle()
    A.drop(EXT_B)
    await settle()
    await a.engine.syncNow()
    const gone = (await extensionRecords(a)).find((r) => r.id === EXT_B)!
    expect(gone).toMatchObject({ deleted: true, data: null })
    expect(gone.modified).toBeGreaterThan(0)
    await b.engine.syncNow()
    expect(B.log().at(-1)).toBe(`${EXT_B.slice(0, 4)} removed from Desk (Linux)`)
    expect(bMeta()[EXT_B]).toMatchObject({ deleted: true })
    const requests = B.applied.length
    await b.engine.syncNow()
    expect(B.applied).toHaveLength(requests)
    expect(B.ids()).toEqual([EXT_A])

    // The laptop uninstalls the shared one: the desktop's host is told, with the device's name,
    // and takes it out (the toast with Undo is the desktop's, `syncedRemovalToast`).
    await settle()
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)).toMatchObject({
      deleted: true
    })
    await a.engine.syncNow()
    expect(A.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} removed from Work laptop`)
    expect(A.ids()).toEqual([EXT_U])
    // Steady state: nothing more is handed over, nothing stamped.
    const [aBatches, bBatches] = [A.applied.length, B.applied.length]
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(A.applied).toHaveLength(aBatches)
    expect(B.applied).toHaveLength(bBatches)
    expect((await extensionRecords(a)).every((r) => r.deleted)).toBe(true)
  }, 30_000)

  it('a download that fails tombstones nothing on the peer, and a landing removed before approval is a DECLINE (the lead’s ruling, round 4) – no tombstone, the peer keeps the extension, this device is not offered it again; the phone publishes its store installs and lands none', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const c = device('Pixel 9', { extensions: phoneExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    const C = hostOf<PublishingExtensions>(c)
    A.add(EXT_A, 'chrome-web-store', { enabled: true, toolbarPinned: true })
    C.add(EXT_P, 'chrome-web-store', { enabled: true })
    C.add(EXT_U, 'unpacked')

    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await setup(c)
    await c.engine.confirmMerge(true)
    // The phone publishes its store install and not its unpacked one; the desktop's record
    // reached it and was applied nowhere – no method, no error – and its file carries no
    // tombstone for it.
    expect(c.engine.status().lastError).toBeNull()
    expect(c.browser.extensions.applySyncedExtensions).toBeUndefined()
    expect((await extensionRecords(c)).map((r) => r.id)).toEqual([EXT_P])
    expect(C.ids()).toEqual([EXT_P, EXT_U].sort())
    // The desktop takes the phone's record: a request to its host, from the phone.
    await a.engine.syncNow()
    expect(A.log()).toEqual([`${EXT_P.slice(0, 4)} chrome-web-store on unpinned from Pixel 9`])
    expect(await extensionRecords(a)).toHaveLength(1)
    // The laptop's download of the desktop's extension fails (nothing lands): round after round
    // the laptop asks its host again and tombstones nothing; the desktop's copy stands.
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await a.engine.syncNow()
    }
    expect(B.ids()).toEqual([])
    expect(await extensionRecords(b)).toEqual([])
    expect(A.ids()).toEqual([EXT_A])
    expect(B.applied.length).toBeGreaterThan(3)
    expect(B.applied.every((batch) => batch.some((change) => change.id === EXT_A))).toBe(true)

    // The laptop's landing is removed before it was approved (the user uninstalls the pending
    // copy): that is the user's DECLINE of the synced extension on the laptop – the lead's
    // ruling – not an uninstall everywhere. Nothing goes out for the id: no record (a landing
    // is not the laptop's state) and no tombstone; the desktop keeps the extension, enabled.
    B.land(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect(await extensionRecords(b)).toEqual([])
    const bWire = async (): Promise<SyncRecord[]> =>
      ((await publishedAll()).get(b.engine.status().deviceId) ?? []).filter((r) => r.id === EXT_A)
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect(await bWire()).toEqual([])
    const requestsFor = (host: StoreExtensions, id: string): number =>
      host.applied.flat().filter((ch) => ch.id === id).length
    const aRequests = requestsFor(A, EXT_A)
    await a.engine.syncNow()
    expect(A.ids()).toEqual([EXT_A])
    expect(A.installed.get(EXT_A)!.enabled).toBe(true)
    expect(requestsFor(A, EXT_A)).toBe(aRequests)
    // The laptop is not offered the desktop's copy again: no further request for the id reaches
    // its host, round after round (the phone's, never landed, still does), and its wire stays
    // empty for the id.
    const bRequests = requestsFor(B, EXT_A)
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await a.engine.syncNow()
    }
    expect(requestsFor(B, EXT_A)).toBe(bRequests)
    expect(B.ids()).toEqual([])
    expect(await bWire()).toEqual([])
    // The phone's own copy: it holds none of the desktop's, and its store install stands
    // untouched by the rounds.
    await c.engine.syncNow()
    expect(C.ids()).toEqual([EXT_P, EXT_U].sort())
  }, 30_000)

  it('the decline, three devices (the lead’s ruling, round 4): B declines A’s landing → nothing for the id on B’s wire, A keeps it enabled, C still receives it, B is not re-offered next round; A uninstalls and re-installs later → B is offered again, once; an APPROVED extension removed on B tombstones, and A and C uninstall with the toast; the decline survives a relaunch', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const c = device('Studio', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    const C = hostOf<StoreExtensions>(c)
    const wireFor = async (d: Device, id: string): Promise<SyncRecord[]> =>
      ((await publishedAll()).get(d.engine.status().deviceId) ?? []).filter((r) => r.id === id)
    const declinedOf = (d: Device): Record<string, number> | undefined => {
      d.engine.flushSync()
      return (
        JSON.parse(d.io.files['sync.json']!) as { declinedExtensions?: Record<string, number> }
      ).declinedExtensions
    }
    A.add(EXT_A, 'chrome-web-store', { enabled: true, toolbarPinned: true })
    A.add(EXT_B, 'edge-add-ons', { enabled: true })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await setup(c)
    await c.engine.confirmMerge(true)
    // Both land on B and on C, off and pending; B approves the second (an approved extension,
    // for the tombstone below), C approves both.
    B.land(EXT_A)
    B.land(EXT_B)
    C.land(EXT_A)
    C.land(EXT_B)
    await settle()
    B.approve(EXT_B)
    C.approve(EXT_A)
    C.approve(EXT_B)
    await settle()
    await b.engine.syncNow()
    await c.engine.syncNow()
    await a.engine.syncNow()
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: false, pendingApproval: true })
    expect(B.installed.get(EXT_B)).toMatchObject({ enabled: true })
    expect(C.ids()).toEqual([EXT_A, EXT_B].sort())

    // B DECLINES A's landing: the pending copy is removed on B. Nothing for the id goes out
    // from B – the wire, decrypted, carries neither a record nor a tombstone for it – and the
    // decline is persisted with its time.
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect(await wireFor(b, EXT_A)).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: expect.any(Number) as number })
    const declinedAt = declinedOf(b)![EXT_A]!
    // A keeps the extension, enabled; C still receives it and keeps it.
    await a.engine.syncNow()
    await c.engine.syncNow()
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true })
    expect(C.installed.get(EXT_A)).toMatchObject({ enabled: true })
    // B is not re-offered next round, nor the ones after: no request for the id reaches its
    // host, and the id stays off its wire.
    const before = B.applied.flat().filter((ch) => ch.id === EXT_A).length
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await a.engine.syncNow()
      await c.engine.syncNow()
    }
    expect(B.applied.flat().filter((ch) => ch.id === EXT_A)).toHaveLength(before)
    expect(B.ids()).toEqual([EXT_B])
    expect(await wireFor(b, EXT_A)).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAt })

    // THE CRITERION (round 5). A turns the extension off, then unpins it: two clocked flips,
    // each stamping A's record anew – well after the decline – and each landing on C. B is NOT
    // re-offered across three rounds: a flip moves no install, and the record's `installedAt`
    // (A's install, before the decline) is all the decline reads. Nor does C's copy re-offer:
    // a landing publishes the install time its record carried, never its own.
    await settle()
    A.set(EXT_A, { enabled: false })
    await settle()
    await a.engine.syncNow()
    await c.engine.syncNow()
    await settle()
    A.set(EXT_A, { toolbarPinned: false })
    await settle()
    await a.engine.syncNow()
    const flipped = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(flipped.modified).toBeGreaterThan(declinedAt)
    const installedOnA = A.installed.get(EXT_A)!.installedAt
    expect(readExtensionData(EXT_A, flipped.data)!.installedAt).toBe(installedOnA)
    expect(installedOnA).toBeLessThanOrEqual(declinedAt)
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await c.engine.syncNow()
      await settle()
      await a.engine.syncNow()
      await settle()
    }
    expect(C.installed.get(EXT_A)).toMatchObject({ enabled: false, toolbarPinned: false })
    expect(C.publishedInstalledAt(EXT_A)).toBe(installedOnA)
    expect(C.installed.get(EXT_A)!.installedAt).toBeGreaterThan(installedOnA)
    expect(B.applied.flat().filter((ch) => ch.id === EXT_A)).toHaveLength(before)
    expect(B.ids()).toEqual([EXT_B])
    expect(await wireFor(b, EXT_A)).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAt })

    // A uninstalls it and installs it again later: a fresh install BY HAND, whose record carries
    // an `installedAt` after the decline – the one re-offer. The tombstone reaches B (nothing to
    // remove) and C (which uninstalls, with the toast).
    await settle()
    A.drop(EXT_A)
    await settle()
    await a.engine.syncNow()
    await b.engine.syncNow()
    await c.engine.syncNow()
    expect(C.ids()).toEqual([EXT_B])
    expect(C.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} removed from Desk (Linux)`)
    expect(B.ids()).toEqual([EXT_B])
    await settle()
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    await settle()
    await a.engine.syncNow()
    const fresh = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(fresh.deleted).toBe(false)
    expect(fresh.modified).toBeGreaterThan(declinedAt)
    expect(readExtensionData(EXT_A, fresh.data)!.installedAt).toBeGreaterThan(declinedAt)
    // B is offered it again – once: the request reaches its host, the decline is closed.
    await b.engine.syncNow()
    expect(B.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Desk (Linux)`
    )
    expect(declinedOf(b)).toBeUndefined()
    await c.engine.syncNow()
    expect(C.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Desk (Linux)`
    )

    // An APPROVED extension removed on B (the second, approved above) is an uninstall
    // everywhere, as before: the tombstone travels, A and C take it out and show the toast.
    await settle()
    B.drop(EXT_B)
    await settle()
    await b.engine.syncNow()
    expect(await wireFor(b, EXT_B)).toMatchObject([{ deleted: true, data: null }])
    // (C reads the folder before A re-emits the tombstone it takes, so the origin C names is
    // the laptop's, not a tie between two copies of one tombstone.)
    await c.engine.syncNow()
    await a.engine.syncNow()
    expect(A.ids()).toEqual([EXT_A])
    expect(C.ids()).toEqual([])
    expect(A.log().at(-1)).toBe(`${EXT_B.slice(0, 4)} removed from Work laptop`)
    // (C's batch: the round's outstanding request for the re-offered first extension, not
    // landed on C, then the tombstone – `applyRemote` lands a type's live records before its
    // tombstones.)
    expect(C.log().at(-1)).toBe(`${EXT_B.slice(0, 4)} removed from Work laptop`)
    expect(declinedOf(b)).toBeUndefined()

    // B declines the re-offered landing too – the decline stands again (once was the re-offer)
    // – and A pins the extension afterwards, stamping the record anew under the same install;
    // then B relaunches: the decline is persisted, so the relaunched laptop is offered neither
    // the desktop's copy nor its flip.
    B.land(EXT_A)
    await settle()
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect(declinedOf(b)).toEqual({ [EXT_A]: expect.any(Number) as number })
    const declinedAgainAt = declinedOf(b)![EXT_A]!
    expect(declinedAgainAt).toBeGreaterThan(declinedAt)
    await settle()
    A.set(EXT_A, { toolbarPinned: true })
    await settle()
    await a.engine.syncNow()
    const pinnedAfter = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(pinnedAfter.modified).toBeGreaterThan(declinedAgainAt)
    expect(readExtensionData(EXT_A, pinnedAfter.data)!.installedAt).toBeLessThanOrEqual(
      declinedAgainAt
    )
    const files = close(b)
    const io = memoryIo()
    Object.assign(io.files, files)
    const again = device('Work laptop', { io, extensions: desktopExtensions })
    const AGAIN = hostOf<StoreExtensions>(again)
    expect(again.engine.status().deviceId).toBe(b.engine.status().deviceId)
    for (let round = 0; round < 2; round += 1) {
      await again.engine.syncNow()
      await a.engine.syncNow()
    }
    expect(again.engine.status().lastError).toBeNull()
    expect(AGAIN.applied.flat().filter((ch) => ch.id === EXT_A)).toEqual([])
    expect(AGAIN.ids()).toEqual([])
    expect(await wireFor(again, EXT_A)).toEqual([])
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true, toolbarPinned: true })
    expect(declinedOf(again)).toEqual({ [EXT_A]: declinedAgainAt })
  }, 30_000)

  it('the re-offer criterion (round 5): a peer’s record WITHOUT `installedAt` – a build before the field – never re-offers a declined extension, however it is stamped, nor does the desktop’s copy that merged its switches; a record carrying an install AFTER the decline re-offers it, once', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    const declinedOf = (d: Device): Record<string, number> | undefined => {
      d.engine.flushSync()
      return (
        JSON.parse(d.io.files['sync.json']!) as { declinedExtensions?: Record<string, number> }
      ).declinedExtensions
    }
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    B.land(EXT_A)
    await settle()
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    const declinedAt = declinedOf(b)![EXT_A]!
    expect(declinedAt).toBeGreaterThanOrEqual(A.installed.get(EXT_A)!.installedAt)
    const before = B.applied.flat().filter((ch) => ch.id === EXT_A).length

    // A peer on a build before the field writes its file under the folder's key: the same
    // extension, its switches flipped and clocked well AFTER the decline, the record stamped
    // there too – and no `installedAt`, as such a build writes. Under round 4's reading the
    // stamp alone would have re-offered it.
    const own = folderFiles('/drive').get(deviceFileName(a.engine.status().deviceId))!
    const salt = (JSON.parse(own) as { envelope: { salt: string } }).envelope.salt
    const key = await folderKey(salt)
    const later = declinedAt + 1_000
    const olderBuild: SyncRecord = {
      id: EXT_A,
      type: 'extension',
      modified: later,
      deleted: false,
      data: {
        store: 'chrome-web-store',
        enabled: false,
        toolbarPinned: true,
        enabledAt: later,
        toolbarPinnedAt: later
      }
    }
    const peerFile = async (record: SyncRecord): Promise<void> => {
      folderFiles('/drive').set(
        deviceFileName('peer-older-build'),
        serializeDeviceFile({
          deviceId: 'peer-older-build',
          deviceName: 'Studio',
          updatedAt: record.modified,
          envelope: await encryptJson(key, salt, { v: 1, records: [record] })
        })
      )
    }
    await peerFile(olderBuild)
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await a.engine.syncNow()
      await settle()
      expect(b.engine.status().lastError, `round ${round}`).toBeNull()
    }
    // B: no request for the id reached its host, the decline stands with its time. A: the
    // peer's later switches landed, and its copy – re-published with A's own install time,
    // which is before the decline – re-offers nothing on B either.
    expect(B.applied.flat().filter((ch) => ch.id === EXT_A)).toHaveLength(before)
    expect(B.ids()).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAt })
    expect(A.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      toolbarPinned: true,
      enabledAt: later,
      toolbarPinnedAt: later
    })
    expect(A.publishedInstalledAt(EXT_A)).toBeLessThanOrEqual(declinedAt)

    // The peer, on a build with the field, installs the extension again by hand: its record
    // carries an `installedAt` after the decline (the peer's clock, in step with B's here; a
    // peer clock AHEAD of B's is the follow-ups' case below – the decline is stamped no earlier
    // than the install it declines, so the same record re-offers nothing there either). B is
    // offered it – once – and A adopts the later install as the time its copy publishes
    // (`adoptInstalledAt`), its own untouched.
    const reinstalledAt = Date.now()
    expect(reinstalledAt).toBeGreaterThan(declinedAt)
    const reinstalled: SyncRecord = {
      ...olderBuild,
      modified: later + 1_000,
      data: { ...(olderBuild.data as object), installedAt: reinstalledAt }
    }
    await peerFile(reinstalled)
    await b.engine.syncNow()
    expect(B.applied.flat().filter((ch) => ch.id === EXT_A)).toHaveLength(before + 1)
    expect(B.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} chrome-web-store off pinned from Studio`)
    expect(declinedOf(b)).toBeUndefined()
    const ownInstall = A.installed.get(EXT_A)!.installedAt
    await a.engine.syncNow()
    await settle()
    expect(A.publishedInstalledAt(EXT_A)).toBe(reinstalledAt)
    expect(A.installed.get(EXT_A)!.installedAt).toBe(ownInstall)
    // B lands it and declines once more: the same record, however many rounds, re-offers
    // nothing – once was the re-offer.
    B.land(EXT_A)
    await settle()
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    const declinedAgainAt = declinedOf(b)![EXT_A]!
    expect(declinedAgainAt).toBeGreaterThan(reinstalledAt)
    const after = B.applied.flat().filter((ch) => ch.id === EXT_A).length
    for (let round = 0; round < 3; round += 1) {
      await a.engine.syncNow()
      await b.engine.syncNow()
      await settle()
    }
    expect(B.applied.flat().filter((ch) => ch.id === EXT_A)).toHaveLength(after)
    expect(B.ids()).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAgainAt })
  }, 30_000)

  it('turning the Extensions off stops sending and receiving them without deleting anything, on either device; a merge declined uninstalls nothing on the peers', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    B.add(EXT_B, 'edge-add-ons', { enabled: true })
    await setup(a)
    await setup(b)
    // "Keep this device's data": the desktop's extension is not tombstoned by the laptop – it
    // is a request to the laptop's host like any other, and the laptop's own goes out.
    await b.engine.confirmMerge(false)
    expect(B.log()).toEqual([`${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Desk (Linux)`])
    await a.engine.syncNow()
    expect(A.ids()).toEqual([EXT_A])
    expect(A.log()).toEqual([`${EXT_B.slice(0, 4)} edge-add-ons on unpinned from Work laptop`])
    expect((await extensionRecords(b)).map((r) => [r.id, r.deleted])).toEqual([[EXT_B, false]])

    // The desktop turns the type off: its file carries no extension and no tombstone either.
    a.engine.setScope({ extensions: false })
    expect(a.engine.status().scope.extensions).toBe(false)
    await a.engine.syncNow()
    expect(await extensionRecords(a)).toEqual([])
    await b.engine.syncNow()
    expect(B.ids()).toEqual([EXT_B])
    expect(A.ids()).toEqual([EXT_A])

    // The laptop lands the desktop's extension, approves it, then turns it off, and uninstalls
    // its own meanwhile; the desktop, with the type off, takes none of it.
    B.land(EXT_A)
    await settle()
    B.approve(EXT_A)
    await settle()
    B.set(EXT_A, { enabled: false })
    B.drop(EXT_B)
    await settle()
    await b.engine.syncNow()
    const batches = A.applied.length
    await a.engine.syncNow()
    expect(A.applied).toHaveLength(batches)
    expect(A.installed.get(EXT_A)!.enabled).toBe(true)

    // Back on: the desktop publishes again and catches up – the switch lands, the removal too
    // (the laptop's extension never landed on the desktop: the tombstone closes the request).
    const linesBefore = A.log().length
    a.engine.setScope({ extensions: true })
    await a.engine.syncNow()
    expect(A.installed.get(EXT_A)!.enabled).toBe(false)
    expect(A.log().slice(linesBefore)).toEqual([
      `${EXT_A.slice(0, 4)} chrome-web-store off unpinned from Work laptop`,
      `${EXT_B.slice(0, 4)} removed from Work laptop`
    ])
    expect((await extensionRecords(a)).filter((r) => !r.deleted).map((r) => r.id)).toEqual([EXT_A])
  }, 30_000)
})

/**
 * The verifier's round on ID-44 (services pass 16, round 2): the switch-by-switch merge under
 * each switch's clock (condition 4), the ids in flight kept off the wire until their commit
 * (D1), an uninstall's tombstone surviving a quit before the push (D4 b), the collector reading
 * the registry's projection (D5), and the engine rule of #712 for an `extension` record this
 * build cannot read.
 */
describe('the extensions across devices – the verifier’s round', () => {
  const extensionRecords = async (d: Device): Promise<SyncRecord[]> =>
    (await published(d)).filter((r) => r.type === 'extension')
  const EXT_C = 'gggggggggggggggggggggggggggggggg'

  /**
   * The desktop installs the extension, the laptop lands and approves it, the desktop adopts
   * the approval's clock: both hold one record – on, unpinned – with the same bytes.
   */
  async function shared(
    a: Device,
    b: Device
  ): Promise<{ A: InFlightExtensions; B: InFlightExtensions }> {
    const A = hostOf<InFlightExtensions>(a)
    const B = hostOf<InFlightExtensions>(b)
    A.add(EXT_A, 'chrome-web-store', { enabled: true, toolbarPinned: false })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    B.land(EXT_A)
    await settle()
    B.approve(EXT_A)
    await settle()
    await b.engine.syncNow()
    await a.engine.syncNow()
    await settle()
    await a.engine.syncNow()
    const approvedAt = B.installed.get(EXT_A)!.enabledAt!
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: approvedAt })
    const [mine, theirs] = [await extensionRecords(a), await extensionRecords(b)]
    expect(mine.find((r) => r.id === EXT_A)).toEqual(theirs.find((r) => r.id === EXT_A))
    return { A, B }
  }

  it('condition 4 – merges a record switch by switch under each switch’s clock: the desktop pins at t1, the laptop turns off at t1 + 1 s; after two rounds both hold {enabled: false, toolbarPinned: true} as one record, and a third device lands the same', async () => {
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const b = device('Work laptop', { extensions: inFlightExtensions })
    const { A, B } = await shared(a, b)
    const t0 = A.installed.get(EXT_A)!.toolbarPinnedAt!
    expect(B.installed.get(EXT_A)!.toolbarPinnedAt).toBe(t0)

    // t1: pinned to the toolbar on the desktop. t1 + 1 s (the test's second is a few ms): turned
    // off on the laptop. Each flip is stamped at its commit, with the device's time as the
    // switch's clock.
    await settle()
    A.set(EXT_A, { toolbarPinned: true })
    await settle()
    const t1 = A.installed.get(EXT_A)!.toolbarPinnedAt!
    expect(t1).toBeGreaterThan(t0)
    B.set(EXT_A, { enabled: false })
    await settle()
    const t2 = B.installed.get(EXT_A)!.enabledAt!
    expect(t2).toBeGreaterThan(t1)

    // Round 1: each publishes its own edit; the laptop's record is the later one, so the laptop
    // takes nothing of the desktop's yet.
    const bBefore = B.applied.length
    await a.engine.syncNow()
    await b.engine.syncNow()
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: false, toolbarPinned: false })
    expect(
      B.applied
        .slice(bBefore)
        .flat()
        .filter((c) => c.id === EXT_A)
    ).toHaveLength(0)

    // Round 2: the laptop's record wins on the desktop. Its host merges switch by switch – the
    // disable is taken (the laptop's clock for it, t1 + 1 s, is later than the approval's), the
    // pin is KEPT (the desktop's clock for it, t1, is later than the laptop's, the install's) –
    // and the commit that lands the merge is the desktop's edit: the merged record goes out
    // under a fresh stamp. The laptop takes the pin from it and holds the same bytes.
    await a.engine.syncNow()
    expect(A.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store off unpinned from Work laptop`
    )
    await settle()
    expect(A.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: t2,
      toolbarPinned: true,
      toolbarPinnedAt: t1
    })
    await a.engine.syncNow()
    const merged = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(merged.data).toEqual({
      store: 'chrome-web-store',
      enabled: false,
      toolbarPinned: true,
      enabledAt: t2,
      toolbarPinnedAt: t1,
      installedAt: t0
    })
    expect(merged.modified).toBeGreaterThan(t2)
    await b.engine.syncNow()
    expect(B.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store off pinned from Desk (Linux)`
    )
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: t2,
      toolbarPinned: true,
      toolbarPinnedAt: t1
    })
    await b.engine.syncNow()
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)).toEqual(merged)
    // Steady state: a round each hands nothing over and stamps nothing.
    const [aBatches, bBatches] = [A.applied.length, B.applied.length]
    await a.engine.syncNow()
    await b.engine.syncNow()
    await settle()
    expect(A.applied).toHaveLength(aBatches)
    expect(B.applied).toHaveLength(bBatches)
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)).toEqual(merged)
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)).toEqual(merged)
    expect(A.republished).toEqual([])
    expect(B.republished).toEqual([])

    // A third device joins: the one merged record reaches it, and its landing is the same –
    // off, pinned, the two clocks the record's.
    const c = device('Studio', { extensions: inFlightExtensions })
    const C = hostOf<InFlightExtensions>(c)
    await setup(c)
    await c.engine.confirmMerge(true)
    expect(C.log()).toHaveLength(1)
    expect(C.log()[0]).toMatch(
      new RegExp(
        `^${EXT_A.slice(0, 4)} chrome-web-store off pinned from (Desk \\(Linux\\)|Work laptop)$`
      )
    )
    await settle()
    C.land(EXT_A)
    expect(C.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      pendingApproval: true,
      toolbarPinned: true,
      enabledAt: t2,
      toolbarPinnedAt: t1
    })
  }, 30_000)

  it('condition 4 – a record whose clocks are both older lands nothing and is re-published under a fresh stamp, so the peer takes this device’s copy: a laptop that merged late never beats a desktop’s two later flips', async () => {
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const b = device('Work laptop', { extensions: inFlightExtensions })
    const { A, B } = await shared(a, b)

    // The desktop flips both switches (t1, t2). The laptop, meanwhile, adopts an older clock of
    // a third device's copy – a commit that stamps its record later than the desktop's, while
    // both its clocks stay the older ones – before it reads the desktop's file.
    await settle()
    A.set(EXT_A, { toolbarPinned: true })
    await settle()
    A.set(EXT_A, { enabled: false })
    await settle()
    const mine = A.installed.get(EXT_A)!
    await a.engine.syncNow()
    B.set(EXT_A, { toolbarPinnedAt: (B.installed.get(EXT_A)!.toolbarPinnedAt ?? 0) + 1 })
    await settle()
    const theirs = B.installed.get(EXT_A)!
    expect(theirs.toolbarPinnedAt!).toBeLessThan(mine.toolbarPinnedAt!)
    expect(theirs.enabledAt!).toBeLessThan(mine.enabledAt!)

    // The laptop's record is the later one on the wire; the desktop takes it, and its host
    // lands nothing from it – both of the desktop's clocks are the later ones. The record is
    // re-committed instead, so the desktop's copy goes out under a fresh stamp, and the laptop
    // takes both switches from it.
    await b.engine.syncNow()
    const late = (await extensionRecords(b)).find((r) => r.id === EXT_A)!
    await a.engine.syncNow()
    expect(A.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Work laptop`
    )
    await settle()
    expect(A.republished).toEqual([EXT_A])
    expect(A.installed.get(EXT_A)).toEqual(mine)
    await a.engine.syncNow()
    const republished = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(republished.modified).toBeGreaterThan(late.modified)
    expect(republished.data).toEqual({
      store: 'chrome-web-store',
      enabled: false,
      toolbarPinned: true,
      enabledAt: mine.enabledAt,
      toolbarPinnedAt: mine.toolbarPinnedAt,
      installedAt: mine.installedAt
    })
    await b.engine.syncNow()
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: mine.enabledAt,
      toolbarPinned: true,
      toolbarPinnedAt: mine.toolbarPinnedAt
    })
    await b.engine.syncNow()
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)).toEqual(republished)
  }, 30_000)

  it('D1 – an id handed to the applier is frozen for the round’s re-snapshot: nothing is published for it until the applier commits, so no device ever reads the pre-apply copy under the winner’s stamp', async () => {
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const b = device('Work laptop', { extensions: inFlightExtensions })
    const { A, B } = await shared(a, b)
    const c = device('Studio', { extensions: inFlightExtensions })
    const C = hostOf<InFlightExtensions>(c)
    await setup(c)
    await c.engine.confirmMerge(true)
    await settle()
    C.land(EXT_A)
    await settle()
    C.approve(EXT_A)
    await settle()
    await c.engine.syncNow()
    await a.engine.syncNow()
    await settle()
    await b.engine.syncNow()
    await settle()
    const shape = A.installed.get(EXT_A)!
    const landing = B.installed.get(EXT_A)!
    // The same switches under the same clocks; a device's own install time is its own (the
    // landing's), and what the landing publishes for it is the desktop's (round 5).
    expect(landing).toEqual({
      ...shape,
      installedAt: landing.installedAt,
      updatedAt: landing.updatedAt
    })
    expect(B.publishedInstalledAt(EXT_A)).toBe(shape.installedAt)
    expect(C.installed.get(EXT_A)!.enabledAt).toBe(shape.enabledAt)
    expect(C.publishedInstalledAt(EXT_A)).toBe(shape.installedAt)

    // The desktop turns the extension off: its record goes out at t1.
    await settle()
    A.set(EXT_A, { enabled: false })
    await settle()
    await a.engine.syncNow()
    const off = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(off.data).toMatchObject({ enabled: false })

    // The claim, read where it can be read: every device file in the folder, DECRYPTED, at
    // each checkpoint that follows (the folder holds the current files – a device's round
    // overwrites its file – so "ever" is the sum of the checkpoints, not one look at the end).
    // No copy of the extension on the wire may say "on" under the desktop's stamp, and the
    // laptop publishes nothing for it while its applier holds the record.
    const wire = async (): Promise<Map<string, SyncRecord | undefined>> => {
      const files = await publishedAll()
      expect(files.size).toBe(3)
      const copies = new Map<string, SyncRecord | undefined>()
      for (const [deviceId, records] of files) {
        const copy = records.find((r) => r.id === EXT_A)
        if (copy && !copy.deleted && copy.modified === off.modified) {
          expect(copy.data, `${deviceId}: the stale copy under the desktop's stamp`).toEqual(
            off.data
          )
        }
        copies.set(deviceId, copy)
      }
      return copies
    }
    const laptop = b.engine.status().deviceId

    // The laptop's round takes the record and hands it to its applier, which holds it (the
    // startup hold, the attach, the id's busy work – the desktop's applier acts later). The
    // laptop's own file, written at the end of that round, carries NOTHING for the extension:
    // not its copy – still on – under the desktop's stamp, and no tombstone.
    B.manual = true
    await b.engine.syncNow()
    expect(B.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store off unpinned from Desk (Linux)`
    )
    expect(B.installed.get(EXT_A)!.enabled).toBe(true)
    expect(B.syncedExtensionsInFlight().has(EXT_A)).toBe(true)
    expect((await wire()).get(laptop)).toBeUndefined()
    await settle()
    expect((await wire()).get(laptop)).toBeUndefined()

    // A third device reads the folder meanwhile: the desktop's record is the only copy, and
    // that is what it lands. Nothing on the wire ever said "on" under the desktop's stamp.
    await c.engine.syncNow()
    expect(C.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store off unpinned from Desk (Linux)`
    )
    expect(C.log().filter((line) => line.endsWith('from Work laptop'))).toEqual([])
    await settle()
    expect(C.installed.get(EXT_A)!.enabled).toBe(false)
    expect((await wire()).get(laptop)).toBeUndefined()

    // The laptop's applier commits: the extension stands as the record says – the same bytes –
    // and the laptop's next round publishes the record under the desktop's stamp, as adopted.
    B.commit()
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: (off.data as { enabledAt: number }).enabledAt
    })
    expect(B.syncedExtensionsInFlight().size).toBe(0)
    await b.engine.syncNow()
    expect((await wire()).get(laptop)).toEqual(off)
    // A round of the third device's, and every copy on the wire is the desktop's record, byte
    // for byte – the same stamp, the same clocks.
    await c.engine.syncNow()
    const copies = await wire()
    expect(copies.size).toBe(3)
    for (const copy of copies.values()) expect(copy).toEqual(off)
  }, 30_000)

  it('D4 (b) – an uninstall is a tombstone in the metadata at its commit, persisted before any push: quit before the push, relaunch, and the tombstone travels; nothing comes back', async () => {
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const b = device('Work laptop', { extensions: inFlightExtensions })
    const { A, B } = await shared(a, b)
    expect(B.ids()).toEqual([EXT_A])

    // Uninstalled on the desktop; the state broadcast that carries the removal runs (the next
    // turn of the loop) and the desktop quits before any push – its file in the folder still
    // says the extension is installed.
    A.drop(EXT_A)
    await settle()
    const files = close(a)
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)).toMatchObject({
      deleted: false
    })
    const meta = (JSON.parse(files['sync.json']!) as { meta: MetaMap }).meta
    expect(meta[EXT_A]).toMatchObject({ type: 'extension', deleted: true })
    expect(meta[EXT_A]!.modified).toBeGreaterThan(0)

    // Relaunched on the files the closed desktop left: its first round publishes the tombstone
    // (the metadata's, at the uninstall's time); the laptop takes it, and the laptop's live
    // record – older than the tombstone – wins nothing on the desktop.
    const io = memoryIo()
    Object.assign(io.files, files)
    const again = device('Desk (Linux)', { io, extensions: inFlightExtensions })
    const AGAIN = hostOf<InFlightExtensions>(again)
    expect(again.engine.status().deviceId).toBe(a.engine.status().deviceId)
    await again.engine.syncNow()
    expect(again.engine.status().lastError).toBeNull()
    const gone = (await extensionRecords(again)).find((r) => r.id === EXT_A)!
    expect(gone).toMatchObject({ deleted: true, data: null, modified: meta[EXT_A]!.modified })
    await b.engine.syncNow()
    expect(B.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} removed from Desk (Linux)`)
    await settle()
    expect(B.ids()).toEqual([])
    await again.engine.syncNow()
    await settle()
    expect(AGAIN.ids()).toEqual([])
    expect(AGAIN.applied).toEqual([])
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)).toMatchObject({
      deleted: true
    })
  }, 30_000)

  it('D5 – the collector reads the registry’s projection (`syncSources`), never `list()` and its manifest reads, at setup, in every round and at every state broadcast; a host without the projection (the phone) is read through `list()`', async () => {
    const a = device('Desk (Linux)', { extensions: countingExtensions })
    const c = device('Pixel 9', { extensions: phoneExtensions })
    const A = hostOf<CountingExtensions>(a)
    const C = hostOf<PublishingExtensions>(c)
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    A.add(EXT_B, 'edge-add-ons', { enabled: false })
    C.add(EXT_P, 'chrome-web-store')

    // The chrome's snapshot reads `list()` at every broadcast (`Browser.state.extras`, one read
    // per window) – the one read allowed; any other `list()` – the engine's – throws.
    const state = a.browser.state
    const snapshot = state.snapshot.bind(state)
    state.snapshot = (win) => {
      A.uiReading = true
      try {
        return snapshot(win)
      } finally {
        A.uiReading = false
      }
    }
    A.forbidList = true
    await setup(a)
    await setup(c)
    await c.engine.confirmMerge(true)
    expect(A.syncSourcesCalls).toBeGreaterThan(0)
    expect((await extensionRecords(a)).map((r) => r.id).sort()).toEqual([EXT_A, EXT_B].sort())
    expect((await extensionRecords(c)).map((r) => r.id)).toEqual([EXT_P])
    await settle()

    // Every broadcast is a read of the projection (the engine's `onLocalChange`), none of `list()`
    // beyond the snapshot's.
    let reads = A.syncSourcesCalls
    let lists = A.listCalls
    for (const edit of [
      () => A.set(EXT_A, { enabled: false }),
      () => A.set(EXT_B, { toolbarPinned: true }),
      () => A.drop(EXT_B)
    ]) {
      edit()
      await settle()
      expect(A.syncSourcesCalls).toBeGreaterThan(reads)
      expect(A.listCalls - lists).toBe(a.browser.allWindows().length)
      reads = A.syncSourcesCalls
      lists = A.listCalls
    }

    // Every round reads the projection – at the collect, and again at the re-snapshot after an
    // apply.
    for (let round = 0; round < 3; round += 1) {
      reads = A.syncSourcesCalls
      await a.engine.syncNow()
      expect(A.syncSourcesCalls).toBeGreaterThan(reads)
      await c.engine.syncNow()
    }
    expect(a.engine.status().lastError).toBeNull()
    const mine = await extensionRecords(a)
    expect(mine.find((r) => r.id === EXT_A)!.data).toMatchObject({ enabled: false })
    expect(mine.find((r) => r.id === EXT_B)).toMatchObject({ deleted: true })
    // The phone's install is handed over each round while its install is outstanding (never
    // landed here) – three rounds, three requests, nothing else.
    const request = `${EXT_P.slice(0, 4)} chrome-web-store on unpinned from Pixel 9`
    expect(A.log()).toEqual([request, request, request])
    // The phone's shape has no projection: its store install went out through `list()`.
    expect((await extensionRecords(c)).find((r) => r.id === EXT_P)!.data).toMatchObject({
      store: 'chrome-web-store',
      enabled: true
    })
  }, 30_000)

  it('the engine rule of #712 – an `extension` record this build cannot read (a store it does not know, switches that are no booleans, a tombstone under no extension id) is never applied, never in the metadata, never tombstoned: found and skipped each round, while the readable record beside it lands', async () => {
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const A = hostOf<InFlightExtensions>(a)
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    await setup(a)

    // A peer on a later build writes its file under the folder's key.
    const own = folderFiles('/drive').get(deviceFileName(a.engine.status().deviceId))!
    const salt = (JSON.parse(own) as { envelope: { salt: string } }).envelope.salt
    const key = await folderKey(salt)
    const later = Date.now() + 10
    const theirs: SyncRecord[] = [
      {
        id: EXT_B,
        type: 'extension',
        modified: later,
        deleted: false,
        data: { store: 'firefox-add-ons', enabled: true, toolbarPinned: false }
      },
      {
        id: EXT_C,
        type: 'extension',
        modified: later,
        deleted: false,
        data: { store: 'chrome-web-store', enabled: 'yes', toolbarPinned: false }
      },
      { id: 'not-an-extension-id', type: 'extension', modified: later, deleted: true, data: null },
      {
        id: EXT_P,
        type: 'extension',
        modified: later,
        deleted: false,
        data: { store: 'chrome-web-store', enabled: true, toolbarPinned: true }
      }
    ]
    folderFiles('/drive').set(
      deviceFileName('peer-later-build'),
      serializeDeviceFile({
        deviceId: 'peer-later-build',
        deviceName: 'Phone (a later build)',
        updatedAt: later,
        envelope: await encryptJson(key, salt, { v: 1, records: theirs })
      })
    )

    const unreadable = [EXT_B, EXT_C, 'not-an-extension-id']
    for (let round = 0; round < 3; round += 1) {
      await a.engine.syncNow()
      await settle()
      expect(a.engine.status().lastError).toBeNull()
      // The readable one is handed to the host (its install outstanding, every round); the
      // three others reach it never.
      expect(A.applied.length).toBe(round + 1)
      for (const batch of A.applied) expect(batch.map((c) => c.id)).toEqual([EXT_P])
      // Nothing in the desktop's file for them – no copy, no tombstone – and nothing in its
      // metadata; the peer's file still carries them, found again next round.
      const mine = await published(a)
      for (const id of unreadable)
        expect(
          mine.find((r) => r.id === id),
          id
        ).toBeUndefined()
      const meta = (a.engine as unknown as { data: { meta: MetaMap } }).data.meta
      for (const id of unreadable) expect(meta[id], id).toBeUndefined()
      expect(meta[EXT_P]).toMatchObject({ type: 'extension', deleted: false, modified: later })
      expect(folderFiles('/drive').has(deviceFileName('peer-later-build'))).toBe(true)
    }
    expect(A.ids()).toEqual([EXT_A])
  }, 30_000)

  it('R9 – a phone (no applier) beside two desktops: a desktop’s flip never reverts across three rounds; the phone’s clock-less copy never travels under the winner’s stamp – its file carries nothing for the id while it holds a record it could not apply, through a relaunch; a phone flip of Enabled (its clock) beats an older desktop switch and loses to a newer one; a phone that never touched the toolbar pin never overrides a desktop’s', async () => {
    // The phone first: its file is the first the folder lists, so on a tie of `modified` its
    // copy would be the one `newestByRecord` keeps – the order the defect needed.
    const p = device('Pixel 9', { extensions: phoneExtensions })
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const b = device('Work laptop', { extensions: inFlightExtensions })
    const P = hostOf<PublishingExtensions>(p)
    const A = hostOf<InFlightExtensions>(a)
    const B = hostOf<InFlightExtensions>(b)
    // Installed from the store on all three at T0: the phone's install writes no clock, the
    // desktops' stamp both switches at T0; every copy carries the one install time (the
    // scenario is the switches' – the install time's merge has its own pins below).
    const T0 = Date.now() - 60_000
    P.add(EXT_A, 'chrome-web-store', { enabled: true, installedAt: T0 })
    A.add(EXT_A, 'chrome-web-store', {
      enabled: true,
      enabledAt: T0,
      toolbarPinnedAt: T0,
      installedAt: T0
    })
    B.add(EXT_A, 'chrome-web-store', {
      enabled: true,
      enabledAt: T0,
      toolbarPinnedAt: T0,
      installedAt: T0
    })
    const phoneId = p.engine.status().deviceId
    /** The phone's copy of the record on the wire, decrypted – undefined when its file carries none. */
    const phoneCopy = async (): Promise<SyncRecord | undefined> =>
      (await publishedAll()).get(phoneId)?.find((r) => r.id === EXT_A)
    const switches = (
      host: PublishingExtensions
    ): Pick<ExtensionInfo, 'enabled' | 'enabledAt' | 'toolbarPinned' | 'toolbarPinnedAt'> => {
      const e = host.installed.get(EXT_A)!
      return {
        enabled: e.enabled,
        enabledAt: e.enabledAt,
        toolbarPinned: e.toolbarPinned,
        toolbarPinnedAt: e.toolbarPinnedAt
      }
    }
    /**
     * Every copy of the record on the wire carries `record`'s switches, live, and the phone's
     * file carries none. The stamps may differ: a desktop that merged the same switches on its
     * own stamps them at its own commit.
     */
    const wireIs = async (record: SyncRecord, note: string): Promise<void> => {
      for (const [deviceId, records] of await publishedAll()) {
        const copy = records.find((r) => r.id === EXT_A)
        if (deviceId === phoneId) expect(copy, `${note}: the phone's file`).toBeUndefined()
        else if (copy) {
          expect(copy.deleted, `${note}: ${deviceId}`).toBe(false)
          expect(copy.data, `${note}: ${deviceId}`).toEqual(record.data)
        }
      }
    }

    // The phone's record goes out first, clock-less, at 0 – the install's time alone beside the
    // three fields (the phone's `list()` projects its registry's). The desktop's merge takes it,
    // lands nothing from it (its clocks read as 0, older than the install's) and re-publishes
    // its own copy under a fresh stamp; the laptop holds the same bytes and adopts the record
    // as it is.
    await setup(p)
    expect((await phoneCopy())?.data).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: false,
      installedAt: T0
    })
    await setup(a)
    await a.engine.confirmMerge(true)
    await settle()
    expect(A.republished).toEqual([EXT_A])
    await a.engine.syncNow()
    const first = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(first.data).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: false,
      enabledAt: T0,
      toolbarPinnedAt: T0,
      installedAt: T0
    })
    expect(first.modified).toBeGreaterThan(0)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    await b.engine.syncNow()
    // The same bytes on the laptop: the desktop's record is no winner there (`winningRemote`
    // skips an equal hash), and the merge's entry stands until a copy differs.
    expect((await extensionRecords(b)).find((r) => r.id === EXT_A)!.data).toEqual(first.data)
    expect(B.applied).toEqual([])
    // The phone takes the desktop's record and can apply nothing: its file drops the id rather
    // than carrying its own copy under the desktop's stamp; its copy stands as the user left it.
    await p.engine.syncNow()
    expect(p.engine.status().lastError).toBeNull()
    expect(await phoneCopy()).toBeUndefined()
    expect(P.installed.get(EXT_A)).toMatchObject({ enabled: true })
    expect(P.installed.get(EXT_A)).not.toHaveProperty('enabledAt')

    // THE DEFECT'S ROUND. The desktop turns the extension off at t2: its record goes out under
    // t2 with the disable's clock. Three rounds follow, the phone reading before the laptop
    // each time: the phone's file never carries its copy – still on, clock-less – under the
    // desktop's stamp (the copy a tie would have handed the laptop, whose re-publish would then
    // have turned the desktop back on); the laptop takes the disable; the desktop's flip stands.
    await settle()
    A.set(EXT_A, { enabled: false })
    await settle()
    await a.engine.syncNow()
    const off = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    const t2 = A.installed.get(EXT_A)!.enabledAt!
    expect(t2).toBeGreaterThan(T0)
    expect(off.data).toEqual({
      store: 'chrome-web-store',
      enabled: false,
      toolbarPinned: false,
      enabledAt: t2,
      toolbarPinnedAt: T0,
      installedAt: T0
    })
    for (let round = 0; round < 3; round += 1) {
      await p.engine.syncNow()
      expect(await phoneCopy(), `round ${round}: the phone's file`).toBeUndefined()
      await b.engine.syncNow()
      await settle()
      await a.engine.syncNow()
      await settle()
      expect(switches(A), `round ${round}: the desktop`).toEqual({
        enabled: false,
        enabledAt: t2,
        toolbarPinned: false,
        toolbarPinnedAt: T0
      })
      expect(switches(B), `round ${round}: the laptop`).toEqual({
        enabled: false,
        enabledAt: t2,
        toolbarPinned: false,
        toolbarPinnedAt: T0
      })
      await wireIs(off, `round ${round}`)
    }
    expect(A.republished).toEqual([EXT_A])
    expect(B.republished).toEqual([])
    expect(P.installed.get(EXT_A)).toMatchObject({ enabled: true })

    // The desktop pins the extension to its toolbar at t3; the laptop takes the pin; the phone
    // never touches it (no clock for it, ever).
    await settle()
    A.set(EXT_A, { toolbarPinned: true })
    await settle()
    const t3 = A.installed.get(EXT_A)!.toolbarPinnedAt!
    expect(t3).toBeGreaterThan(t2)
    await a.engine.syncNow()
    const pinned = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    await b.engine.syncNow()
    await settle()
    expect(switches(B)).toEqual({
      enabled: false,
      enabledAt: t2,
      toolbarPinned: true,
      toolbarPinnedAt: t3
    })
    await p.engine.syncNow()
    await wireIs(pinned, 'after the pin')

    // THE PHONE'S FLIP BEATS AN OLDER DESKTOP SWITCH. Its user turns the extension off and on
    // again at t4 (> t3): the phone clocks the flip, and its record goes out under a fresh stamp
    // – `enabledAt: t4`, NO clock for the pin. The flip is the later write of Enabled: both
    // desktops take it at the phone's clock. Neither gives up its pin: the phone's record has
    // no clock for the pin, which reads as 0 – older than t3.
    await settle()
    P.set(EXT_A, { enabled: false })
    await settle()
    P.set(EXT_A, { enabled: true })
    await settle()
    const t4 = P.installed.get(EXT_A)!.enabledAt!
    expect(t4).toBeGreaterThan(t3)
    expect(P.installed.get(EXT_A)).not.toHaveProperty('toolbarPinnedAt')
    await p.engine.syncNow()
    const flipped = (await phoneCopy())!
    expect(flipped.data).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: false,
      enabledAt: t4,
      installedAt: T0
    })
    expect(flipped.modified).toBeGreaterThan(pinned.modified)
    await a.engine.syncNow()
    expect(A.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Pixel 9`)
    await settle()
    expect(switches(A)).toEqual({
      enabled: true,
      enabledAt: t4,
      toolbarPinned: true,
      toolbarPinnedAt: t3
    })
    await b.engine.syncNow()
    await settle()
    expect(switches(B)).toEqual({
      enabled: true,
      enabledAt: t4,
      toolbarPinned: true,
      toolbarPinnedAt: t3
    })
    // The desktop's commit publishes the merged record afresh; the phone takes it and, applying
    // nothing, leaves the wire again.
    await a.engine.syncNow()
    const merged = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(merged.data).toEqual({
      store: 'chrome-web-store',
      enabled: true,
      toolbarPinned: true,
      enabledAt: t4,
      toolbarPinnedAt: t3,
      installedAt: T0
    })
    expect(merged.modified).toBeGreaterThan(flipped.modified)
    await b.engine.syncNow()
    await p.engine.syncNow()
    await wireIs(merged, 'after the phone’s flip landed')
    expect(P.installed.get(EXT_A)).toMatchObject({ enabled: true, toolbarPinned: false })

    // THE PHONE'S FLIP LOSES TO A NEWER DESKTOP SWITCH. Its user turns the extension off and on
    // again at t5 without a round between; the desktop turns it off at t6 > t5. The desktop's
    // write is the later one: its record wins on the laptop and on the phone, the phone's wins
    // nowhere – both desktops stand off at t6 – and the phone's copy leaves the wire once it
    // reads the desktop's record.
    await settle()
    P.set(EXT_A, { enabled: false })
    await settle()
    P.set(EXT_A, { enabled: true })
    await settle()
    const t5 = P.installed.get(EXT_A)!.enabledAt!
    A.set(EXT_A, { enabled: false })
    await settle()
    const t6 = A.installed.get(EXT_A)!.enabledAt!
    expect(t6).toBeGreaterThan(t5)
    await p.engine.syncNow()
    expect((await phoneCopy())!.data).toMatchObject({ enabled: true, enabledAt: t5 })
    await a.engine.syncNow()
    await settle()
    expect(switches(A)).toEqual({
      enabled: false,
      enabledAt: t6,
      toolbarPinned: true,
      toolbarPinnedAt: t3
    })
    const later = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    expect(later.data).toMatchObject({ enabled: false, enabledAt: t6 })
    await b.engine.syncNow()
    await settle()
    expect(switches(B)).toEqual({
      enabled: false,
      enabledAt: t6,
      toolbarPinned: true,
      toolbarPinnedAt: t3
    })
    expect(B.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store off pinned from Desk (Linux)`
    )
    await p.engine.syncNow()
    await b.engine.syncNow()
    await wireIs(later, 'after the desktop’s later flip')
    expect(P.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: t5 })

    // THE HOLD SURVIVES A RELAUNCH. The phone quits and comes back on its files, its registry as
    // it left it: the boot seed adopts nothing for the id, its first round publishes nothing
    // under it – the desktop's record is the only copy – and the user's next flip here is the
    // change that publishes, under a fresh stamp with its clock.
    const files = close(p)
    expect(
      (JSON.parse(files['sync.json']!) as { unappliedExtensions?: Record<string, string> })
        .unappliedExtensions
    ).toHaveProperty(EXT_A)
    const io = memoryIo()
    Object.assign(io.files, files)
    const kept = P.installed.get(EXT_A)!
    const again = device('Pixel 9', {
      io,
      extensions: (browser) => {
        const host = new PublishingExtensions(browser)
        host.installed.set(EXT_A, kept)
        return host
      }
    })
    const AGAIN = hostOf<PublishingExtensions>(again)
    expect(again.engine.status().deviceId).toBe(phoneId)
    await again.engine.syncNow()
    expect(again.engine.status().lastError).toBeNull()
    await wireIs(later, 'after the relaunch')
    await settle()
    AGAIN.set(EXT_A, { enabled: false })
    await settle()
    const t7 = AGAIN.installed.get(EXT_A)!.enabledAt!
    expect(t7).toBeGreaterThan(t6)
    await again.engine.syncNow()
    expect((await phoneCopy())!).toMatchObject({
      data: { store: 'chrome-web-store', enabled: false, toolbarPinned: false, enabledAt: t7 }
    })
    expect((await phoneCopy())!.modified).toBeGreaterThan(later.modified)
  }, 30_000)
})

/**
 * The #715 verifiers' low observations, built as one follow-up (services pass 17, seed #38):
 * (a) the decline's time under a peer clock running ahead – stamped no earlier than the install
 * it declines, so one decline closes the request; (b) what an absence is measured against goes
 * with the metadata at a disconnect – a landing removed while this device was not syncing is
 * no decline, and the next setup offers the peers' extensions afresh; (c) the round-3 notes
 * pinned end to end – a switch flipped here while the applier holds the id's record is stamped
 * at the release under the flip's own clock, and an approval given while a peer's flip landed
 * during the open prompt is the later write.
 */
describe('the extensions across devices – the #715 follow-ups (seed #38)', () => {
  const extensionRecords = async (d: Device): Promise<SyncRecord[]> =>
    (await published(d)).filter((r) => r.type === 'extension')
  const declinedOf = (d: Device): Record<string, number> | undefined => {
    d.engine.flushSync()
    return (JSON.parse(d.io.files['sync.json']!) as { declinedExtensions?: Record<string, number> })
      .declinedExtensions
  }
  const metaOf = (d: Device): MetaMap => {
    d.engine.flushSync()
    return (JSON.parse(d.io.files['sync.json']!) as { meta: MetaMap }).meta
  }
  const handedTo = (host: StoreExtensions, id: string): number =>
    host.applied.flat().filter((c) => c.id === id).length

  /** A peer's device file in the folder, written with the folder's key: `record` its one record. */
  async function peerWriter(
    d: Device,
    peerId: string,
    peerName: string
  ): Promise<(record: SyncRecord) => Promise<void>> {
    const own = folderFiles('/drive').get(deviceFileName(d.engine.status().deviceId))!
    const salt = (JSON.parse(own) as { envelope: { salt: string } }).envelope.salt
    const key = await folderKey(salt)
    return async (record) => {
      folderFiles('/drive').set(
        deviceFileName(peerId),
        serializeDeviceFile({
          deviceId: peerId,
          deviceName: peerName,
          updatedAt: record.modified,
          envelope: await encryptJson(key, salt, { v: 1, records: [record] })
        })
      )
    }
  }

  it('(a) a peer’s clock 10 min ahead: the decline is stamped no earlier than the install it declines – one decline closes the request, the unchanged record (and its flips) re-offers nothing across the rounds, and only a fresh install by hand on the peer, later still by its clock, re-offers once', async () => {
    const b = device('Work laptop', { extensions: desktopExtensions })
    const B = hostOf<StoreExtensions>(b)
    await setup(b)
    const peerFile = await peerWriter(b, 'peer-ahead', 'Studio')

    // The peer's clock runs ten minutes ahead of the laptop's: the install it made by hand just
    // now is stamped ten minutes into the laptop's future, as are its switches and the record.
    const AHEAD_MS = 10 * 60_000
    const installedAhead = Date.now() + AHEAD_MS
    const ahead: SyncRecord = {
      id: EXT_A,
      type: 'extension',
      modified: installedAhead,
      deleted: false,
      data: {
        store: 'chrome-web-store',
        enabled: true,
        toolbarPinned: false,
        enabledAt: installedAhead,
        toolbarPinnedAt: installedAhead,
        installedAt: installedAhead
      }
    }
    await peerFile(ahead)
    await b.engine.syncNow()
    expect(B.log()).toEqual([`${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Studio`])
    await settle()
    B.land(EXT_A)
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: false, pendingApproval: true })
    // The landing publishes the install time its record carried – the peer's, ahead.
    expect(B.publishedInstalledAt(EXT_A)).toBe(installedAhead)

    // The user declines. The decline's time is the install's – ten minutes ahead of the
    // laptop's clock – not the laptop's now: stamped at now, `installedAt > declinedAt` would
    // hold for the unchanged record, and the round would hand it over again, the landing
    // declined again at each, until the laptop's clock passed the peer's install.
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    const declinedAt = declinedOf(b)![EXT_A]!
    expect(declinedAt).toBe(installedAhead)
    expect(declinedAt).toBeGreaterThan(Date.now())
    expect(B.ids()).toEqual([])

    // Three rounds on the same record: no request reaches the host, the decline stands with
    // its time, nothing for the id leaves the laptop.
    const handed = handedTo(B, EXT_A)
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await settle()
      expect(b.engine.status().lastError, `round ${round}`).toBeNull()
    }
    expect(handedTo(B, EXT_A)).toBe(handed)
    expect(B.ids()).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAt })
    expect(await extensionRecords(b)).toEqual([])

    // The peer flips a switch: its record is stamped anew – later still, by its clock – under
    // the same install. A flip re-offers nothing.
    const flippedAhead = installedAhead + 60_000
    await peerFile({
      ...ahead,
      modified: flippedAhead,
      data: { ...(ahead.data as object), enabled: false, enabledAt: flippedAhead }
    })
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await settle()
    }
    expect(handedTo(B, EXT_A)).toBe(handed)
    expect(B.ids()).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAt })

    // The peer uninstalls and installs it again by hand, two minutes later by its clock: an
    // `installedAt` later than the decline – the one re-offer. The request reaches the host,
    // the decline is closed.
    const reinstalledAhead = installedAhead + 120_000
    await peerFile({
      ...ahead,
      modified: reinstalledAhead,
      data: {
        ...(ahead.data as object),
        enabledAt: reinstalledAhead,
        toolbarPinnedAt: reinstalledAhead,
        installedAt: reinstalledAhead
      }
    })
    await b.engine.syncNow()
    expect(handedTo(B, EXT_A)).toBe(handed + 1)
    expect(B.log().at(-1)).toBe(`${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Studio`)
    expect(declinedOf(b)).toBeUndefined()

    // Landed and declined once more: the decline takes the new install's time, and the same
    // record re-offers nothing again – once was the re-offer.
    await settle()
    B.land(EXT_A)
    await settle()
    expect(B.publishedInstalledAt(EXT_A)).toBe(reinstalledAhead)
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect(declinedOf(b)).toEqual({ [EXT_A]: reinstalledAhead })
    const after = handedTo(B, EXT_A)
    for (let round = 0; round < 3; round += 1) {
      await b.engine.syncNow()
      await settle()
    }
    expect(handedTo(B, EXT_A)).toBe(after)
    expect(B.ids()).toEqual([])
    expect(declinedOf(b)).toEqual({ [EXT_A]: reinstalledAhead })
  }, 30_000)

  it('(a) a peer in step with this device: the decline is stamped at this device’s time, as before – the install, earlier, is no later than it', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    const installedAt = A.installed.get(EXT_A)!.installedAt
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    B.land(EXT_A)
    await settle()
    expect(B.publishedInstalledAt(EXT_A)).toBe(installedAt)
    const beforeDecline = Date.now()
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    const declinedAt = declinedOf(b)![EXT_A]!
    expect(declinedAt).toBeGreaterThanOrEqual(beforeDecline)
    expect(declinedAt).toBeLessThanOrEqual(Date.now())
    expect(declinedAt).toBeGreaterThanOrEqual(installedAt)
    // The decline stands against the same record across the rounds, as before.
    const handed = handedTo(B, EXT_A)
    await a.engine.syncNow()
    await b.engine.syncNow()
    await settle()
    expect(handedTo(B, EXT_A)).toBe(handed)
    expect(declinedOf(b)).toEqual({ [EXT_A]: declinedAt })
  }, 30_000)

  it('(b) a landing removed while this device is DISCONNECTED is no decline: the next setup – into a folder with no peer yet, whose first round runs at once – writes none, and the peer that joins it later is offered afresh; a decline made while connected stands until the disconnect, which forgets it with the metadata, and the next setup offers that one afresh too', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    const wireFor = async (d: Device, id: string, folder: string): Promise<SyncRecord[]> =>
      ((await publishedAll(folder)).get(d.engine.status().deviceId) ?? []).filter(
        (r) => r.id === id
      )
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    B.land(EXT_A)
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: false, pendingApproval: true })
    const laptop = b.engine.status().deviceId

    // Sync is turned off on the laptop, and the landing removed while it is off: housekeeping,
    // not the user's answer to a request – the engine holds none. No decline is written.
    const handed = handedTo(B, EXT_A)
    b.engine.disconnect(false)
    expect(b.engine.status().enabled).toBe(false)
    expect(declinedOf(b)).toBeUndefined()
    await settle()
    B.drop(EXT_A)
    await settle()
    expect(declinedOf(b)).toBeUndefined()
    expect(B.ids()).toEqual([])

    // The laptop sets up again, into a folder nobody else is in yet: no merge to confirm, the
    // first round runs at once – and its read measures no absence. Measured against the set
    // before the disconnect, the landing gone would have been written as a decline here (and
    // kept: no merge wipes it), to stand against a peer joining this folder later with the
    // extension – a decline carried from one setup into the next.
    await setup(b, '/other')
    expect(b.engine.status().deviceId).toBe(laptop)
    expect(b.engine.status().pendingMerge).toBe(false)
    expect(b.engine.status().lastError).toBeNull()
    expect(declinedOf(b)).toBeUndefined()
    expect(await wireFor(b, EXT_A, '/other')).toEqual([])

    // The desktop joins that folder: its record is handed to the laptop's host – the landing
    // offered afresh – and nothing for the id goes out from the laptop, no tombstone least of
    // all; the desktop keeps the extension.
    await setup(a, '/other')
    await a.engine.confirmMerge(true)
    await b.engine.syncNow()
    expect(declinedOf(b)).toBeUndefined()
    expect(handedTo(B, EXT_A)).toBe(handed + 1)
    expect(B.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Desk (Linux)`
    )
    expect(await wireFor(b, EXT_A, '/other')).toEqual([])
    await a.engine.syncNow()
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true })

    // By contrast, the landing removed while CONNECTED is the decline, as ruled: persisted with
    // its time, standing across the rounds – no request reaches the host.
    await settle()
    B.land(EXT_A)
    await settle()
    B.drop(EXT_A)
    await settle()
    await b.engine.syncNow()
    expect(declinedOf(b)).toEqual({ [EXT_A]: expect.any(Number) as number })
    const declined = handedTo(B, EXT_A)
    for (let round = 0; round < 2; round += 1) {
      await a.engine.syncNow()
      await b.engine.syncNow()
      await settle()
    }
    expect(handedTo(B, EXT_A)).toBe(declined)
    expect(B.ids()).toEqual([])
    expect(await wireFor(b, EXT_A, '/other')).toEqual([])

    // The disconnect forgets the decline with the metadata, and the next setup – the same
    // folder, the merge confirmed – offers the extension afresh: the one rule for both. What
    // the next setup offers is the peers' current set, whatever this device answered under the
    // previous one.
    b.engine.disconnect(false)
    expect(declinedOf(b)).toBeUndefined()
    await setup(b, '/other')
    expect(b.engine.status().pendingMerge).toBe(true)
    await b.engine.confirmMerge(true)
    expect(declinedOf(b)).toBeUndefined()
    expect(handedTo(B, EXT_A)).toBe(declined + 1)
    expect(B.log().at(-1)).toBe(
      `${EXT_A.slice(0, 4)} chrome-web-store on unpinned from Desk (Linux)`
    )
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true })
  }, 30_000)

  it('(c) a switch flipped here while the applier holds the id’s record is stamped at the release: nothing for the id leaves this device the while, and the commit that lands the record carries the flip under its own clock – the flip’s time – with a stamp later than the winner’s; the peer takes the pin by that clock', async () => {
    const a = device('Desk (Linux)', { extensions: inFlightExtensions })
    const b = device('Work laptop', { extensions: inFlightExtensions })
    const A = hostOf<InFlightExtensions>(a)
    const B = hostOf<InFlightExtensions>(b)
    A.add(EXT_A, 'chrome-web-store', { enabled: true, toolbarPinned: false })
    const installedAt = A.installed.get(EXT_A)!.installedAt
    const t0 = A.installed.get(EXT_A)!.toolbarPinnedAt!
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    B.land(EXT_A)
    await settle()
    B.approve(EXT_A)
    await settle()
    await b.engine.syncNow()
    await a.engine.syncNow()
    await settle()
    await a.engine.syncNow()
    const approvedAt = B.installed.get(EXT_A)!.enabledAt!
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: approvedAt })

    // The desktop turns the extension off at t1; its record goes out.
    await settle()
    A.set(EXT_A, { enabled: false })
    await settle()
    await a.engine.syncNow()
    const off = (await extensionRecords(a)).find((r) => r.id === EXT_A)!
    const t1 = (off.data as { enabledAt: number }).enabledAt
    expect(t1).toBeGreaterThan(approvedAt)
    expect((off.data as { toolbarPinnedAt: number }).toolbarPinnedAt).toBe(t0)

    // The laptop's round takes it and hands it to the applier, which holds it (the startup
    // hold, the attach, the id's busy work).
    B.manual = true
    await b.engine.syncNow()
    expect(B.syncedExtensionsInFlight().has(EXT_A)).toBe(true)
    expect(metaOf(b)[EXT_A]).toMatchObject({ modified: off.modified, hash: hashData(off.data) })

    // The user pins it on the laptop meanwhile, at t2: the flip is clocked at its commit (the
    // switch's own clock), but the id is in flight – the entry is not stamped, and nothing for
    // the id leaves the laptop, not even across a round.
    await settle()
    B.set(EXT_A, { toolbarPinned: true })
    await settle()
    const t2 = B.installed.get(EXT_A)!.toolbarPinnedAt!
    expect(t2).toBeGreaterThan(t1)
    const laptop = b.engine.status().deviceId
    const onWire = async (): Promise<SyncRecord | undefined> =>
      ((await publishedAll()).get(laptop) ?? []).find((r) => r.id === EXT_A)
    expect(metaOf(b)[EXT_A]).toMatchObject({ modified: off.modified, hash: hashData(off.data) })
    await b.engine.syncNow()
    expect(await onWire()).toBeUndefined()
    expect(metaOf(b)[EXT_A]).toMatchObject({ modified: off.modified, hash: hashData(off.data) })

    // The applier commits: the disable lands (t1 is later than the approval's clock), the pin is
    // KEPT (t2 is later than the record's t0) – and the commit that lands the merge is the
    // edit. The release stamps the merged record – later than the winner's stamp, so the peer
    // takes it – with the pin under its own clock, t2: the flip's time, not the stamp's.
    B.commit()
    await settle()
    expect(B.syncedExtensionsInFlight().size).toBe(0)
    expect(B.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: t1,
      toolbarPinned: true,
      toolbarPinnedAt: t2
    })
    const entry = metaOf(b)[EXT_A]!
    expect(entry.modified).toBeGreaterThan(off.modified)
    expect(entry.modified).toBeGreaterThanOrEqual(t2)
    await b.engine.syncNow()
    const merged = (await onWire())!
    expect(merged.modified).toBe(entry.modified)
    expect(merged.data).toEqual({
      store: 'chrome-web-store',
      enabled: false,
      toolbarPinned: true,
      enabledAt: t1,
      toolbarPinnedAt: t2,
      installedAt
    })

    // The desktop takes the pin by its clock and keeps its own disable (the same clock); the
    // two hold one record.
    await a.engine.syncNow()
    await settle()
    expect(A.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: t1,
      toolbarPinned: true,
      toolbarPinnedAt: t2
    })
    await a.engine.syncNow()
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)).toEqual(merged)
    expect(A.republished).toEqual([])
    // (The round run while the id was in flight handed the outstanding record over once more,
    // as every round does; that second copy found the pin's clock here the later one and asked
    // for a re-publish – a commit in the same tick as the one that landed the merge: one
    // broadcast, one stamp, the record above.)
    expect(B.republished).toEqual([EXT_A])
  }, 30_000)

  it('(c) a peer’s flip while the approval prompt stands open here: the approval is clocked at the confirm, the later write – both devices end on; the peer’s disable, made during the prompt, is the older write and reverts nothing', async () => {
    const a = device('Desk (Linux)', { extensions: desktopExtensions })
    const b = device('Work laptop', { extensions: desktopExtensions })
    const A = hostOf<StoreExtensions>(a)
    const B = hostOf<StoreExtensions>(b)
    A.add(EXT_A, 'chrome-web-store', { enabled: true })
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    await settle()
    B.land(EXT_A)
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: false, pendingApproval: true })

    // The user clicks Enable on the laptop: the approval prompt opens and stands.
    const clickAt = Date.now()
    await settle()
    // The desktop turns the extension off meanwhile, at tA > the click; its record reaches the
    // laptop, whose landing takes the disable's clock (a disable always lands; the landing was
    // off already).
    A.set(EXT_A, { enabled: false })
    await settle()
    const tA = A.installed.get(EXT_A)!.enabledAt!
    expect(tA).toBeGreaterThan(clickAt)
    await a.engine.syncNow()
    await b.engine.syncNow()
    await settle()
    expect(B.installed.get(EXT_A)).toMatchObject({
      enabled: false,
      enabledAt: tA,
      pendingApproval: true
    })

    // The user confirms, at tC > tA: the enable is written at the confirm (`flipClock`), never
    // at the click – the click's time would be the older write, and the desktop's disable
    // would have beaten the approval the user just gave.
    await settle()
    B.approve(EXT_A)
    await settle()
    const tC = B.installed.get(EXT_A)!.enabledAt!
    expect(tC).toBeGreaterThan(tA)
    await b.engine.syncNow()
    const approval = (await extensionRecords(b)).find((r) => r.id === EXT_A)!
    expect(approval.data).toMatchObject({ enabled: true, enabledAt: tC })
    // The desktop takes the approval by its clock: both on, one record.
    await a.engine.syncNow()
    await settle()
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: tC })
    await a.engine.syncNow()
    expect((await extensionRecords(a)).find((r) => r.id === EXT_A)).toEqual(approval)
    // Steady: a round each more, and neither device reverts the other.
    await b.engine.syncNow()
    await a.engine.syncNow()
    await settle()
    expect(A.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: tC })
    expect(B.installed.get(EXT_A)).toMatchObject({ enabled: true, enabledAt: tC })
  }, 30_000)
})
