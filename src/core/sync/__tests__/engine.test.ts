import { afterEach, describe, expect, it } from 'vitest'
import type { ReadingListEntry, Settings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import { READING_LIST_CAP } from '../../../shared/readingList'
import { FOLDER_LOST_MESSAGE } from '../engine'
import {
  SETTINGS_RECORD_ID,
  hashData,
  settingsKeyTime,
  type MetaMap,
  type SyncRecord
} from '../records'
import { README_NAME, SYNC_DIR_NAME, isDeviceFileName, parseDeviceFile } from '../transport'
import {
  type Device,
  device,
  folderFiles,
  memoryIo,
  published,
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
      name: 'a renamed key (the 0.4.x restoreSession switch folded into startup at boot, the switch mirrored beside it for a release)',
      upgrade: (files, record) => {
        // The previous build's record: the switch (on, as the untouched default reads), no
        // `startup`; this build's mirrors the switch and adds the key it folded.
        const { startup: _folded, ...asWritten } = record
        void _folded
        expect(asWritten.restoreSession).toBe(true)
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

  it('the cap after a round is a deliberate deletion: the entries the cap takes out are tombstoned and the peers drop them too', async () => {
    const a = device('Desk (Linux)')
    const b = device('Pixel 9')
    // In sync at two under the cap, two of the shared entries read (the cap's first to go).
    const shared: ReadingListEntry[] = []
    for (let i = 1; i <= READING_LIST_CAP - 2; i++) {
      shared.push(a.browser.readingList.add(`https://shared.example/${i}`, `Shared ${i}`)!)
    }
    expect(a.browser.readingList.setRead(shared[0]!.id, true)).toBe(true)
    expect(a.browser.readingList.setRead(shared[1]!.id, true)).toBe(true)
    await setup(a)
    await setup(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.state.readingList).toHaveLength(READING_LIST_CAP - 2)

    // Apart, each device saves two pages: both lists sit at the cap, nothing trimmed yet.
    await settle()
    const a1 = a.browser.readingList.add('https://desk.example/1', 'Desk 1')!
    const a2 = a.browser.readingList.add('https://desk.example/2', 'Desk 2')!
    const b1 = b.browser.readingList.add('https://phone.example/1', 'Phone 1')!
    const b2 = b.browser.readingList.add('https://phone.example/2', 'Phone 2')!
    await settle()
    expect(a.browser.state.readingList).toHaveLength(READING_LIST_CAP)
    expect(b.browser.state.readingList).toHaveLength(READING_LIST_CAP)

    // The desktop's two land on the phone, which runs over the cap: the two read entries go,
    // and the phone's round tombstones them at now – a deletion the whole fleet follows.
    await a.engine.syncNow()
    await b.engine.syncNow()
    expect(b.browser.state.readingList).toHaveLength(READING_LIST_CAP)
    expect(b.browser.readingList.get(a1.id)).not.toBeNull()
    expect(b.browser.readingList.get(a2.id)).not.toBeNull()
    expect(b.browser.readingList.get(shared[0]!.id)).toBeNull()
    expect(b.browser.readingList.get(shared[1]!.id)).toBeNull()
    const bRecords = await readingRecords(b)
    for (const id of [shared[0]!.id, shared[1]!.id]) {
      const tomb = bRecords.find((r) => r.id === id)!
      expect(tomb).toMatchObject({ deleted: true })
      expect(tomb.modified).toBeGreaterThan(0)
    }
    // The desktop takes the phone's two and the two tombstones: the removals land first, so the
    // list is exactly at the cap with nothing more to trim – the same thousand on both.
    await a.engine.syncNow()
    expect(a.browser.state.readingList).toHaveLength(READING_LIST_CAP)
    expect(a.browser.readingList.get(shared[0]!.id)).toBeNull()
    expect(a.browser.readingList.get(shared[1]!.id)).toBeNull()
    expect(a.browser.readingList.get(b1.id)).not.toBeNull()
    expect(a.browser.readingList.get(b2.id)).not.toBeNull()
    expect(ids(a)).toEqual(ids(b))
    await b.engine.syncNow()
    expect(ids(a)).toEqual(ids(b))
  }, 60_000)
})
