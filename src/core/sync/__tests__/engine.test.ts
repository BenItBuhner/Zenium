import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../../shared/types'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import { FOLDER_LOST_MESSAGE } from '../engine'
import { SETTINGS_RECORD_ID, hashData, type MetaMap, type SyncRecord } from '../records'
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
describe('an edit is stamped where it is made, not where it is noticed', () => {
  type Json = Record<string, unknown>
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

  async function settingsRecord(d: Device): Promise<SyncRecord> {
    const record = (await published(d)).find((r) => r.id === SETTINGS_RECORD_ID)
    expect(record).toBeDefined()
    return record!
  }

  /**
   * Leave a closed device's files as the previous build left them: its settings edited in
   * `state.json`, and its sync metadata naming the hash of the settings record as that build
   * wrote it (`recordAsWritten`).
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
    const before = sync.meta[SETTINGS_RECORD_ID]!
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
    /** Keys this build puts on every record, which the peer's record lacks. */
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
    }
  ]

  const edits: Array<{
    name: string
    patch: (s: Settings) => Partial<Settings>
    read: (s: Settings) => unknown
  }> = [
    { name: 'colorScheme', patch: () => ({ colorScheme: 'dark' }), read: (s) => s.colorScheme },
    {
      name: 'resources.memoryPercent',
      patch: (s) => ({ resources: { ...s.resources, memoryPercent: 42 } }),
      read: (s) => s.resources.memoryPercent
    }
  ]

  describe.each(causes)('$name', (cause) => {
    it.each(edits)(
      "the device's first sync on the new build takes the peer's unpulled edit of $name instead of reverting it",
      async ({ patch, read }) => {
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
          // What the desktop publishes is the phone's record (plus whatever this build puts on
          // every record) at the PHONE's timestamp – never at its own launch.
          const mine = await settingsRecord(upgraded)
          expect(mine.modified).toBe(theirs.modified)
          expect(mine.modified).toBeLessThan(launched)
          expect(hashData(mine.data)).toBe(hashData({ ...(theirs.data as Json), ...cause.carries }))
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
