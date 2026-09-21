import { afterEach, describe, expect, it } from 'vitest'
import { FOLDER_LOST_MESSAGE } from '../engine'
import { README_NAME, SYNC_DIR_NAME, isDeviceFileName } from '../transport'
import {
  device,
  folderFiles,
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
