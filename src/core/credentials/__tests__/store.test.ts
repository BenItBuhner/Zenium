import { describe, expect, it } from 'vitest'
import { NOTE_MAX_LENGTH } from '../../../shared/types'
import { CredentialStore } from '../store'
import { VAULT_DOCUMENT, VaultError } from '../vault'
import { FakeKeyWrap, MemoryIO, corruptBase64 } from './fakes'

interface Setup {
  io: MemoryIO
  keys: FakeKeyWrap
  store: CredentialStore
}

function setup(options: { os?: boolean; io?: MemoryIO; keys?: FakeKeyWrap } = {}): Setup {
  const io = options.io ?? new MemoryIO()
  const keys = options.keys ?? new FakeKeyWrap()
  if (options.os === false) keys.available = false
  const store = new CredentialStore(io, keys)
  store.loadSync()
  return { io, keys, store }
}

/** A second process on the same device: same documents, same device key. */
function reopen(previous: Setup): Setup {
  return setup({ io: previous.io, keys: previous.keys })
}

async function code(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`)
  )
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(condition()).toBe(true)
}

describe('CredentialStore lifecycle', () => {
  it('creates a vault under the OS key, persists logins and reopens them silently', async () => {
    const first = setup()
    expect(first.store.exists()).toBe(false)
    await first.store.unlock()
    expect(first.store.unlocked()).toBe(true)
    expect(first.store.protection()).toEqual({ os: true, passphrase: false })

    const added = first.store.add({
      url: 'https://Accounts.Example.com/login?next=1',
      username: 'ada',
      password: 'pw-1',
      notes: 'work'
    })
    expect(added.origin).toBe('https://accounts.example.com')
    expect(added.url).toBe('https://accounts.example.com/login?next=1')
    await first.store.flush()
    expect(first.io.documents.get(VAULT_DOCUMENT)).not.toContain('pw-1')

    const second = reopen(first)
    expect(second.store.exists()).toBe(true)
    expect(second.store.unlocked()).toBe(false)
    await second.store.unlock(undefined, false)
    expect(second.store.list()).toEqual([added])
    expect(second.keys.unwraps).toBe(1)
  })

  it('keeps a login added right before the vault is locked', async () => {
    const first = setup()
    await first.store.unlock()
    const kept = first.store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    // Lock before the queued write has sealed anything: the write must still land in full.
    first.store.lock()
    expect(first.store.unlocked()).toBe(false)
    await first.store.flush()

    const second = reopen(first)
    await second.store.unlock(undefined, false)
    expect(second.store.list()).toEqual([kept])
  })

  it('requires a passphrase without an OS keystore and opens with it later', async () => {
    const first = setup({ os: false })
    expect(await code(first.store.unlock())).toBe('locked')
    await first.store.unlock('open sesame please')
    expect(first.store.protection()).toEqual({ os: false, passphrase: true })
    first.store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await first.store.flush()

    const second = reopen(first)
    expect(await code(second.store.unlock())).toBe('locked')
    expect(await code(second.store.unlock('wrong'))).toBe('wrong-key')
    await second.store.unlock('open sesame please')
    expect(second.store.count()).toBe(1)
    expect(await second.store.verifyPassphrase('open sesame please')).toBe(true)
    expect(await second.store.verifyPassphrase('nope')).toBe(false)
  })

  it('adds the OS wrapping when the keystore becomes usable after a passphrase unlock', async () => {
    const first = setup({ os: false })
    await first.store.unlock('open sesame please')
    await first.store.flush()

    first.keys.available = true
    const second = reopen(first)
    await second.store.unlock('open sesame please')
    await second.store.flush()
    expect(second.store.protection()).toEqual({ os: true, passphrase: true })

    const third = reopen(second)
    await third.store.unlock()
    expect(third.store.unlocked()).toBe(true)
  })

  it('a passphrase added to an OS vault becomes a second way in and the re-auth secret', async () => {
    const first = setup()
    await first.store.unlock()
    first.store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await first.store.setPassphrase('second way in')
    await first.store.flush()
    expect(first.store.protection()).toEqual({ os: true, passphrase: true })
    expect(await first.store.verifyPassphrase('second way in')).toBe(true)

    first.keys.available = false
    const second = reopen(first)
    expect(await code(second.store.unlock())).toBe('locked')
    await second.store.unlock('second way in')
    expect(second.store.count()).toBe(1)
  })

  it('a silent unlock fails when the OS key wants an interactive authentication', async () => {
    const first = setup()
    await first.store.unlock()
    await first.store.flush()
    first.keys.requiresInteraction = true
    const second = reopen(first)
    expect(await code(second.store.unlock(undefined, false))).toContain('authentication required')
    await second.store.unlock(undefined, true)
    expect(second.store.unlocked()).toBe(true)
  })

  it('locks, dropping every plaintext login, and unlocks again', async () => {
    const { store } = setup()
    await store.unlock()
    store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await store.flush()
    store.lock()
    expect(store.unlocked()).toBe(false)
    expect(store.list()).toEqual([])
    expect(() => store.add({ url: 'https://b.example', username: 'u', password: 'p' })).toThrow(
      VaultError
    )
    await store.unlock()
    expect(store.count()).toBe(1)
  })

  it('reset forgets the vault and the next unlock starts empty', async () => {
    const first = setup()
    await first.store.unlock()
    first.store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await first.store.reset()
    expect(first.store.exists()).toBe(false)
    expect(first.io.documents.get(VAULT_DOCUMENT)).toBe('')
    await first.store.unlock()
    expect(first.store.count()).toBe(0)
  })

  it('reports a corrupt document and refuses to unlock it', async () => {
    const io = new MemoryIO()
    io.documents.set(VAULT_DOCUMENT, '{"format":"zenium-passwords","version":1,"vaultId":"x"}')
    const { store } = setup({ io })
    expect(store.exists()).toBe(true)
    expect(store.error()?.code).toBe('corrupt')
    expect(await code(store.unlock())).toBe('corrupt')
  })

  it('reports a tampered document', async () => {
    const first = setup()
    await first.store.unlock()
    first.store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await first.store.flush()
    const text = first.io.documents.get(VAULT_DOCUMENT) ?? ''
    const file = JSON.parse(text) as { entries: Array<{ data: string }> }
    file.entries[0].data = corruptBase64(file.entries[0].data)
    first.io.documents.set(VAULT_DOCUMENT, JSON.stringify(file))
    const second = reopen(first)
    expect(second.store.error()).toBeNull()
    expect(await code(second.store.unlock())).toBe('tampered')
    expect(second.store.unlocked()).toBe(false)
  })

  it('a blob written on another device does not open the vault', async () => {
    const first = setup()
    await first.store.unlock()
    await first.store.flush()
    const other = setup({ io: first.io, keys: new FakeKeyWrap() })
    // The keystore's own refusal surfaces (not a VaultError), and the vault stays locked.
    expect(await code(other.store.unlock())).toMatch(/^other:/)
    expect(other.store.unlocked()).toBe(false)
  })

  it('flushSync writes the newest sealed document when its write has not landed', async () => {
    const first = setup()
    await first.store.unlock()
    await first.store.flush()
    first.io.hang = true
    first.store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await until(() => first.io.hung === 1)
    expect(JSON.parse(first.io.documents.get(VAULT_DOCUMENT) ?? '').entries).toHaveLength(0)

    first.store.flushSync()
    expect(first.io.writes).toBe(2)
    // A second flushSync has nothing new to write.
    first.store.flushSync()
    expect(first.io.writes).toBe(2)

    first.io.hang = false
    const second = reopen(first)
    await second.store.unlock()
    expect(second.store.count()).toBe(1)
  })

  it('keeps working when a write fails and retries with the next change', async () => {
    const { io, store } = setup()
    await store.unlock()
    io.failure = new Error('disk full')
    store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    await store.flush()
    expect(store.count()).toBe(1)
    io.failure = null
    store.add({ url: 'https://b.example', username: 'u', password: 'p' })
    await store.flush()
    const text = io.documents.get(VAULT_DOCUMENT) ?? ''
    expect((JSON.parse(text) as { entries: unknown[] }).entries).toHaveLength(2)
  })
})

describe('CredentialStore reads', () => {
  async function seeded(): Promise<Setup> {
    const s = setup()
    await s.store.unlock()
    s.store.add({ url: 'https://accounts.example.com/login', username: 'ada', password: 'p1' }, 100)
    s.store.add(
      { url: 'https://www.example.com/', username: 'bob', password: 'p2', notes: 'shared box' },
      200
    )
    s.store.add({ url: 'http://legacy.example.com/', username: 'carol', password: 'p3' }, 300)
    s.store.add({ url: 'https://other.example/', username: 'ada', password: 'p4' }, 400)
    s.store.add(
      { url: 'https://192.168.1.1/', username: 'admin', password: 'p5', realm: 'Router' },
      500
    )
    return s
  }

  it('lists most recently changed first and searches every term', async () => {
    const { store } = await seeded()
    expect(store.list().map((c) => c.username)).toEqual(['admin', 'ada', 'carol', 'bob', 'ada'])
    expect(store.search('ada').map((c) => c.origin)).toEqual([
      'https://other.example',
      'https://accounts.example.com'
    ])
    expect(store.search('ADA example.com').map((c) => c.username)).toEqual(['ada'])
    expect(store.search('shared').map((c) => c.username)).toEqual(['bob'])
    expect(store.search('   ')).toHaveLength(5)
    expect(store.search('nobody')).toEqual([])
  })

  it('finds logins for an origin by registrable domain, exact origin first, never towards http', async () => {
    const { store } = await seeded()
    const forWww = store.findForOrigin('https://www.example.com/some/page')
    expect(forWww.map((c) => c.username)).toEqual(['bob', 'carol', 'ada'])
    // An https login is never offered on an http page of the same site; http ones are.
    expect(store.findForOrigin('http://www.example.com').map((c) => c.username)).toEqual(['carol'])
    // HTTP auth logins are not form logins.
    expect(store.findForOrigin('https://192.168.1.1')).toEqual([])
    expect(store.findForHttpAuth('https://192.168.1.1', 'Router').map((c) => c.username)).toEqual([
      'admin'
    ])
    expect(store.findForHttpAuth('https://192.168.1.1', 'Other')).toEqual([])
    expect(store.findForHttpAuth('https://www.example.com', 'Router')).toEqual([])
    expect(store.findForOrigin('https://unrelated.test')).toEqual([])
    expect(store.findForOrigin('not a url')).toEqual([])
  })

  it('ranks the most recently used login first inside a site', async () => {
    const { store } = await seeded()
    const carol = store.list().find((c) => c.username === 'carol')!
    store.markUsed(carol.id, 9_000)
    const forHttp = store.findForOrigin('http://www.example.com')
    expect(forHttp[0].username).toBe('carol')
    expect(store.get(carol.id)?.lastUsedAt).toBe(9_000)
  })
})

describe('CredentialStore writes', () => {
  it('updates fields, re-deriving the origin from a new URL', async () => {
    const { store } = setup()
    await store.unlock()
    const login = store.add({ url: 'https://a.example', username: 'u', password: 'p' }, 1)
    const updated = store.update(login.id, { url: 'b.example/path', password: 'q' }, 2)
    expect(updated).toMatchObject({
      origin: 'https://b.example',
      url: 'https://b.example/path',
      username: 'u',
      password: 'q',
      createdAt: 1,
      updatedAt: 2
    })
    expect(() => store.update(login.id, { url: 'ftp://x' })).toThrow('valid http or https')
    expect(store.update('missing', { username: 'x' })).toBeNull()
    expect(() => store.add({ url: 'javascript:alert(1)', username: 'u', password: 'p' })).toThrow()
  })

  it('removes and restores a login under its old id', async () => {
    const { store } = setup()
    await store.unlock()
    const login = store.add({ url: 'https://a.example', username: 'u', password: 'p' })
    expect(store.remove(login.id)).toEqual(login)
    expect(store.remove(login.id)).toBeNull()
    expect(store.count()).toBe(0)
    expect(store.restore(login)).toBe(true)
    expect(store.restore(login)).toBe(false)
    expect(store.get(login.id)).toEqual(login)
    await store.flush()
  })

  it('keeps the never-save list normalised, sorted and persisted', async () => {
    const first = setup()
    await first.store.unlock()
    // The registrable domain is what gets listed: a subdomain of a co.uk site folds into it.
    first.store.neverSaveAdd('https://Sub.Shop.Example.co.uk/cart')
    first.store.neverSaveAdd('ads.example')
    first.store.neverSaveAdd('ads.example')
    first.store.neverSaveAdd('')
    expect(first.store.neverSaveList()).toEqual(['ads.example', 'example.co.uk'])
    expect(first.store.isNeverSave('https://login.ads.example/x')).toBe(true)
    expect(first.store.isNeverSave('https://shop.example.co.uk')).toBe(true)
    expect(first.store.isNeverSave('https://example.com')).toBe(false)
    first.store.neverSaveRemove('ADS.example')
    await first.store.flush()
    const second = reopen(first)
    await second.store.unlock()
    expect(second.store.neverSaveList()).toEqual(['example.co.uk'])
  })

  it('clips oversized fields', async () => {
    const { store } = setup()
    await store.unlock()
    const login = store.add({
      url: 'https://a.example',
      username: 'u'.repeat(5000),
      password: 'p'.repeat(5000),
      notes: 'n'.repeat(20_000)
    })
    expect(login.username).toHaveLength(4096)
    expect(login.password).toHaveLength(4096)
    // Chrome's limit for a note written here (ID-34).
    expect(login.notes).toHaveLength(NOTE_MAX_LENGTH)
  })
})

describe('CredentialStore: the breach memory of a login (ID-31) and its note (ID-34)', () => {
  it('starts unchecked, records a verdict and the warning, and counts the compromised logins not ignored', async () => {
    const { store } = setup()
    await store.unlock()
    const a = store.add({ url: 'https://a.example', username: 'ada', password: 'pw-a' })
    const b = store.add({ url: 'https://b.example', username: 'bob', password: 'pw-b' })
    expect(a).toMatchObject({ breached: null, checkedAt: null, leakWarnedAt: null, leakIgnoredAt: null })
    expect(store.compromisedCount()).toBe(0)

    store.recordLeak(a.id, { breached: 12, leakWarnedAt: 1_000 }, 1_000)
    expect(store.get(a.id)).toMatchObject({ breached: 12, checkedAt: 1_000, leakWarnedAt: 1_000 })
    // The login itself did not change: its `updatedAt` stays (sync sees a memory, not an edit).
    expect(store.get(a.id)!.updatedAt).toBe(a.updatedAt)
    store.recordLeaks([{ id: b.id, fields: { breached: 0 } }, { id: 'missing', fields: { breached: 1 } }], 2_000)
    expect(store.get(b.id)).toMatchObject({ breached: 0, checkedAt: 2_000, leakWarnedAt: null })
    expect(store.compromisedCount()).toBe(1)

    store.recordLeak(a.id, { leakIgnoredAt: 3_000 })
    expect(store.get(a.id)).toMatchObject({ breached: 12, checkedAt: 1_000, leakIgnoredAt: 3_000 })
    expect(store.compromisedCount()).toBe(0)
    expect(store.recordLeak('missing', { breached: 1 })).toBeNull()
  })

  it('resets the memory when the password value changes, and only then', async () => {
    const { store } = setup()
    await store.unlock()
    const a = store.add({ url: 'https://a.example', username: 'ada', password: 'pw-a' })
    store.recordLeak(a.id, { breached: 12, leakWarnedAt: 1_000, leakIgnoredAt: 1_500 }, 1_000)
    store.update(a.id, { username: 'ada@a.example', notes: 'same password' })
    expect(store.get(a.id)).toMatchObject({ breached: 12, leakIgnoredAt: 1_500 })
    store.update(a.id, { password: 'pw-a' })
    expect(store.get(a.id)).toMatchObject({ breached: 12, leakIgnoredAt: 1_500 })
    store.update(a.id, { password: 'pw-a2' })
    expect(store.get(a.id)).toMatchObject({
      breached: null,
      checkedAt: null,
      leakWarnedAt: null,
      leakIgnoredAt: null
    })
  })

  it('keeps the memory across a lock and a reopen, and an import that replaces the password starts it over', async () => {
    const first = setup()
    await first.store.unlock()
    const a = first.store.add({ url: 'https://a.example', username: 'ada', password: 'pw-a' })
    const b = first.store.add({ url: 'https://b.example', username: 'bob', password: 'pw-b' })
    first.store.recordLeak(a.id, { breached: 3, leakWarnedAt: 10, leakIgnoredAt: 20 }, 10)
    first.store.recordLeak(b.id, { breached: 3, leakWarnedAt: 10 }, 10)
    await first.store.flush()

    const second = reopen(first)
    await second.store.unlock()
    expect(second.store.get(a.id)).toMatchObject({ breached: 3, checkedAt: 10, leakWarnedAt: 10, leakIgnoredAt: 20 })
    expect(second.store.compromisedCount()).toBe(1)
    second.store.importRows(
      [
        { url: 'https://a.example', username: 'ada', password: 'pw-a', notes: '' },
        { url: 'https://b.example', username: 'bob', password: 'imported', notes: '' }
      ],
      'replace',
      'chrome',
      500
    )
    // The same value again is nothing new; another value is a login to check afresh.
    expect(second.store.get(a.id)).toMatchObject({ breached: 3, leakIgnoredAt: 20 })
    expect(second.store.get(b.id)).toMatchObject({ password: 'imported', breached: null, leakWarnedAt: null })
  })

  it('clips a note written here at Chrome\u2019s limit but keeps a longer one that arrives from another device', async () => {
    const { store } = setup()
    await store.unlock()
    const a = store.add({ url: 'https://a.example', username: 'ada', password: 'pw', notes: 'n'.repeat(1_500) })
    expect(a.notes).toHaveLength(NOTE_MAX_LENGTH)
    store.update(a.id, { notes: 'm'.repeat(1_200) })
    expect(store.get(a.id)!.notes).toHaveLength(NOTE_MAX_LENGTH)
    store.applySynced({
      ...a,
      notes: 'x'.repeat(5_000),
      breached: 7,
      checkedAt: 40,
      leakWarnedAt: 40,
      leakIgnoredAt: null
    })
    expect(store.get(a.id)).toMatchObject({ breached: 7, checkedAt: 40, leakWarnedAt: 40, leakIgnoredAt: null })
    expect(store.get(a.id)!.notes).toHaveLength(5_000)
  })
})

describe('CredentialStore import', () => {
  const rows = [
    { url: 'https://a.example/login', username: 'ada', password: 'new-a', notes: 'from chrome' },
    { url: 'https://b.example', username: 'bob', password: 'same-b', notes: '' },
    { url: 'https://c.example', username: 'carol', password: 'c', notes: '' },
    { url: 'https://d.example', username: 'dan', password: '', notes: '' },
    { url: 'not a url', username: 'eve', password: 'e', notes: '' }
  ]

  async function existing(): Promise<Setup> {
    const s = setup()
    await s.store.unlock()
    s.store.add({ url: 'https://a.example/', username: 'ada', password: 'old-a', notes: 'mine' })
    s.store.add({ url: 'https://b.example/', username: 'bob', password: 'same-b' })
    return s
  }

  it('skip keeps what is saved', async () => {
    const { store } = await existing()
    const result = store.importRows(rows, 'skip', 'chrome')
    expect(result).toEqual({
      format: 'chrome',
      total: 5,
      added: 1,
      replaced: 0,
      skipped: 2,
      invalid: 2
    })
    expect(store.count()).toBe(3)
    expect(store.list().find((c) => c.username === 'ada')?.password).toBe('old-a')
  })

  it('replace overwrites the password and notes of matching logins', async () => {
    const { store } = await existing()
    const result = store.importRows(rows, 'replace', 'chrome', 777)
    expect(result).toMatchObject({ added: 1, replaced: 1, skipped: 1, invalid: 2 })
    const ada = store.list().find((c) => c.username === 'ada')!
    expect(ada.password).toBe('new-a')
    expect(ada.notes).toBe('from chrome')
    expect(ada.updatedAt).toBe(777)
    expect(store.count()).toBe(3)
  })

  it('keep-both adds a second login for a conflicting password', async () => {
    const { store } = await existing()
    const result = store.importRows(rows, 'keep-both', 'chrome')
    expect(result).toMatchObject({ added: 2, replaced: 0, skipped: 1, invalid: 2 })
    const adas = store.list().filter((c) => c.username === 'ada')
    expect(adas.map((c) => c.password).sort()).toEqual(['new-a', 'old-a'])
  })

  it('treats realms as part of the identity and keeps import timestamps', async () => {
    const { store } = setup()
    await store.unlock()
    const result = store.importRows(
      [
        { url: 'https://r.example', username: 'admin', password: 'p', notes: '', realm: 'Router' },
        {
          url: 'https://r.example',
          username: 'admin',
          password: 'p',
          notes: '',
          createdAt: 1234,
          lastUsedAt: 2345
        }
      ],
      'skip',
      'firefox',
      9999
    )
    expect(result).toMatchObject({ added: 2, skipped: 0 })
    const form = store.list().find((c) => c.realm === null)!
    expect(form.createdAt).toBe(1234)
    expect(form.lastUsedAt).toBe(2345)
    expect(form.updatedAt).toBe(9999)
    expect(store.findForHttpAuth('https://r.example', 'Router')).toHaveLength(1)
  })

  it('persists imported logins', async () => {
    const first = setup()
    await first.store.unlock()
    first.store.importRows(rows, 'skip', 'chrome')
    await first.store.flush()
    const second = reopen(first)
    await second.store.unlock()
    expect(second.store.count()).toBe(3)
  })
})

describe('CredentialStore addresses, cards and passkey records', () => {
  const address = {
    country: 'US',
    name: 'Ada Lovelace',
    organization: '',
    streetAddress: '1600 Amphitheatre Pkwy',
    locality: 'Mountain View',
    region: 'CA',
    postalCode: '94043',
    sortingCode: '',
    phone: '',
    email: 'ada@example.com'
  }
  const card = {
    number: '4242424242424242',
    expMonth: 3,
    expYear: 2029,
    name: 'Ada Lovelace',
    nickname: ''
  }
  const passkey = {
    rpId: 'example.com',
    rpName: 'Example',
    userName: 'ada@example.com',
    userDisplayName: 'Ada',
    credentialId: 'AQID-g',
    origin: 'https://example.com'
  }

  it('keeps every kind in the one encrypted vault and reopens them', async () => {
    const first = setup()
    await first.store.unlock()
    first.store.add({ url: 'https://example.com/login', username: 'ada', password: 'pw' })
    const a = first.store.addAddress(address, 1_000)
    const c = first.store.addCard({ ...card, number: '4242 4242 4242 4242' }, 1_000)
    const p = first.store.addPasskey(passkey, 1_000)
    expect(c.number).toBe('4242424242424242')
    await first.store.flush()
    const text = first.io.documents.get(VAULT_DOCUMENT)!
    for (const secret of ['4242424242424242', 'Amphitheatre', 'ada@example.com', 'AQID-g'])
      expect(text).not.toContain(secret)

    const second = reopen(first)
    await second.store.unlock(undefined, false)
    expect(second.store.count()).toBe(1)
    expect(second.store.listAddresses()).toEqual([{ ...a }])
    expect(second.store.listCards()).toEqual([{ ...c }])
    expect(second.store.listPasskeys()).toEqual([{ ...p }])
    expect(second.store.getAddress(a.id)?.email).toBe('ada@example.com')
    expect(second.store.getCard(c.id)?.number).toBe('4242424242424242')
  })

  it('updates, marks used, orders by use and removes', async () => {
    const { store } = setup()
    await store.unlock()
    const a1 = store.addAddress(address, 1_000)
    const a2 = store.addAddress({ ...address, name: 'Bob' }, 2_000)
    expect(store.listAddresses().map((a) => a.id)).toEqual([a2.id, a1.id])
    store.markAddressUsed(a1.id, 3_000)
    expect(store.listAddresses().map((a) => a.id)).toEqual([a1.id, a2.id])
    expect(store.updateAddress(a1.id, { phone: '555' }, 4_000)).toMatchObject({
      phone: '555',
      updatedAt: 4_000,
      lastUsedAt: 3_000
    })
    expect(store.updateAddress('address_nope', { phone: '1' })).toBeNull()
    expect(store.removeAddress(a2.id)?.id).toBe(a2.id)
    expect(store.listAddresses()).toHaveLength(1)

    const c1 = store.addCard(card, 1_000)
    expect(store.updateCard(c1.id, { expYear: 2031, nickname: 'Work' }, 5_000)).toMatchObject({
      expYear: 2031,
      nickname: 'Work',
      number: '4242424242424242'
    })
    store.markCardUsed(c1.id, 6_000)
    expect(store.getCard(c1.id)?.lastUsedAt).toBe(6_000)
    expect(store.removeCard(c1.id)?.id).toBe(c1.id)
    expect(store.listCards()).toEqual([])

    const p1 = store.addPasskey(passkey, 1_000)
    const p2 = store.addPasskey(
      { ...passkey, userName: 'bob@example.com', credentialId: 'BBBB' },
      2_000
    )
    expect(store.listPasskeys().map((p) => p.id)).toEqual([p2.id, p1.id])
    store.markPasskeyUsed(p1.id, 3_000)
    expect(store.listPasskeys().map((p) => p.id)).toEqual([p1.id, p2.id])
    expect(store.findPasskey('example.com', 'BBBB')?.id).toBe(p2.id)
    expect(store.findPasskey('example.com', '', 'ada@example.com')?.id).toBe(p1.id)
    expect(store.findPasskey('other.example', 'AQID-g')).toBeNull()
    expect(store.removePasskey(p1.id)?.id).toBe(p1.id)
    expect(store.listPasskeys()).toHaveLength(1)
  })

  it('refuses writes while locked and lists nothing', async () => {
    const first = setup()
    await first.store.unlock()
    first.store.addAddress(address)
    await first.store.flush()
    const second = reopen(first)
    expect(second.store.listAddresses()).toEqual([])
    expect(() => second.store.addAddress(address)).toThrow()
    expect(() => second.store.addCard(card)).toThrow()
    expect(() => second.store.addPasskey(passkey)).toThrow()
  })

  it('leaves a vault written by this version readable by the login-only reader of older ones', async () => {
    // The login list ignores the other record kinds instead of failing on them.
    const first = setup()
    await first.store.unlock()
    first.store.add({ url: 'https://example.com', username: 'ada', password: 'pw' })
    first.store.addCard(card)
    await first.store.flush()
    const second = reopen(first)
    await second.store.unlock(undefined, false)
    expect(second.store.list().map((c) => c.username)).toEqual(['ada'])
    expect(second.store.count()).toBe(1)
  })
})
