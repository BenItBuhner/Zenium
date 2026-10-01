import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncSetupRefusal } from '../../../shared/types'
import type { SecretStore } from '../../platform'
import { ACCOUNT_SECRET_KEY, AccountClient, AccountSession, AccountTransport } from '../account'
import { accountEndpoints } from '../accountEndpoints'
import {
  ACCOUNT_SIGN_IN_FIRST_MESSAGE,
  WRONG_PASSPHRASE_MESSAGE,
  accountErrorMessage
} from '../engine'
import { README_NAME, SyncFolderLostError, isDeviceFileName } from '../transport'
import { FakeAccountServer } from './fakeAccountServer'
import {
  PASSPHRASE,
  device,
  folderFiles,
  setTransportFactory,
  teardown,
  unlockVault,
  type Device,
  type HarnessTransport
} from './harness'

/**
 * The sync engine through the Zenium account, two ways (as `engineWebDav.test.ts` runs it over
 * a WebDAV server).
 *
 * First, the whole two-device convergence suite (`engine.test.ts`, `engineDocuments.test.ts`)
 * again with `AccountTransport` in the folder transport's place: every folder of the harness is
 * an account of the fake service whose documents ARE the test's folder map, so the scenarios and
 * their assertions on the folder's files hold unchanged â€“ every listing is `sync:list`, every
 * read of the device files one `sync:readMany`, every write `sync:write` with a rotated token
 * behind it. The two things a folder has that an account does not â€“ `lost`, and the README a
 * file manager would show â€“ are the harness transport's own, layered on the real one.
 *
 * Then the engine's account paths: the sign-in with its code and new tab, the setup and the
 * merge question, the refresh token in the secret store alone, the service ending the sign-in
 * (`accountSignedOut`) and the sign-in again, the quota's typed error, signing out, the rename,
 * the quiet rounds (an unchanged device file waits for its heartbeat) and the version watch.
 */

const server = new FakeAccountServer()

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    }
  }
}

class HarnessAccountTransport extends AccountTransport implements HarnessTransport {
  lost = false

  constructor(
    session: AccountSession,
    private readonly docs: Map<string, string>
  ) {
    super(session, { versionPollMs: 0 })
  }

  private gone(): void {
    if (this.lost) throw new SyncFolderLostError()
  }

  override async list(): Promise<string[]> {
    this.gone()
    // The README as a folder has it: listed once written (the engine's `ensureReadme` writes it).
    const names = await super.list()
    return this.docs.has(README_NAME) ? names : names.filter((n) => n !== README_NAME)
  }

  override read(name: string): Promise<string | null> {
    this.gone()
    return super.read(name)
  }

  override readMany(names: string[]): Promise<(string | null)[]> {
    this.gone()
    return super.readMany(names)
  }

  override write(name: string, text: string): Promise<void> {
    this.gone()
    // The folder suite looks for the README a folder holds; the account keeps none.
    if (name === README_NAME) {
      this.docs.set(name, text)
      return Promise.resolve()
    }
    return super.write(name, text)
  }

  override remove(name: string): Promise<void> {
    this.gone()
    return super.remove(name)
  }
}

setTransportFactory((folder) => {
  const email = `${folder.replace(/[^A-Za-z0-9]/g, '') || 'root'}@drive.test`
  const docs = folderFiles(folder)
  server.account(email, docs)
  const grant = server.signIn(email)
  const secrets = memorySecrets()
  secrets.values.set(ACCOUNT_SECRET_KEY, grant.refreshToken)
  const session = new AccountSession(
    new AccountClient(accountEndpoints('dev'), server.fetch),
    secrets
  )
  session.adopt(grant)
  return new HarnessAccountTransport(session, docs)
})

afterEach(async () => {
  vi.restoreAllMocks()
  teardown()
  // The turned-off devices sign out in the background: through before the next test's service.
  await new Promise((r) => setTimeout(r, 20))
  server.reset()
})

// The convergence suites, through the account this time.
await import('./engine.test')
await import('./engineDocuments.test')

// ---------------------------------------------------------------------------

const EMAIL = 'ada@example.com'

type AccountDevice = Device & { secrets: SecretStore & { values: Map<string, string> } }

function accountDevice(
  name: string,
  options: {
    io?: Device['io']
    keys?: Device['keys']
    secrets?: SecretStore & { values: Map<string, string> }
    kind?: 'desktop' | 'laptop' | 'phone' | 'tablet'
  } = {}
): AccountDevice {
  const secrets = options.secrets ?? memorySecrets()
  const d = device(name, { ...options, fetch: server.fetch, secrets })
  return Object.assign(d, { secrets })
}

/** The user presses Sign in (in a real window: the sign-in page opens a tab there), the code shows, and they approve it on the website. */
async function signIn(d: Device, email = EMAIL): Promise<void> {
  await d.engine.startAccountLink(d.browser.ensureWindow())
  const link = d.engine.status().accountLink
  expect(link).not.toBeNull()
  server.approve(link!.userCode, email)
  await vi.waitFor(() => {
    expect(d.engine.status().accountLink).toBeNull()
    expect(d.engine.status().account).toEqual({ email })
  })
}

async function setupAccount(d: Device, passphrase = PASSPHRASE): Promise<SyncSetupRefusal | null> {
  return d.engine.setup(
    {
      folder: '',
      passphrase,
      deviceName: d.name,
      scope: d.engine.status().scope,
      transport: 'account'
    },
    d.win
  )
}

async function join(a: AccountDevice, b: AccountDevice): Promise<void> {
  await signIn(a)
  expect(await setupAccount(a)).toBeNull()
  await signIn(b)
  expect(await setupAccount(b)).toBeNull()
  expect(b.engine.status().pendingMerge).toBe(true)
  await b.engine.confirmMerge(true)
  expect(a.engine.status().lastError).toBeNull()
  expect(b.engine.status().lastError).toBeNull()
}

const docs = (): Map<string, string> => server.account(EMAIL).docs
const sessionOf = (deviceName: string): ReturnType<FakeAccountServer['sessionsOf']>[number] =>
  server.sessionsOf(EMAIL).filter((s) => s.deviceName === deviceName && !s.revoked)[0]!

describe('the engine through the Zenium account', () => {
  it('signs in with a code in a new tab, sets up, and two devices converge; the token lives in the secret store alone', async () => {
    const a = accountDevice('Desk (Linux)')
    const b = accountDevice('Pixel 9', { kind: 'phone' })
    await unlockVault(a)
    await unlockVault(b)
    expect(a.engine.status()).toMatchObject({
      accountAvailable: true,
      account: null,
      accountLink: null,
      accountSignedOut: false
    })

    // The passphrase step comes after the sign-in, never before.
    expect(await setupAccount(a)).toBeNull()
    expect(a.toasts.at(-1)).toBe(ACCOUNT_SIGN_IN_FIRST_MESSAGE)
    expect(a.engine.status().enabled).toBe(false)

    await a.engine.startAccountLink(a.browser.ensureWindow())
    const link = a.engine.status().accountLink!
    expect(link.userCode).toMatch(/^[A-Z0-9]{8}$/)
    expect(link.expiresAt).toBeGreaterThan(Date.now())
    // The sign-in page opened in a new tab of this browser, the code filled in.
    expect(Object.values(a.browser.state.model.tabs).map((t) => t.url)).toContain(
      link.verificationUrl
    )
    expect(link.verificationUrl).toContain(link.userCode)
    expect([...server.links.values()][0]).toMatchObject({
      deviceName: 'Desk (Linux)',
      kind: 'desktop'
    })
    server.approve(link.userCode, EMAIL)
    await vi.waitFor(() => expect(a.engine.status().account).toEqual({ email: EMAIL }))
    expect(a.engine.status().accountLink).toBeNull()
    const token = a.secrets.values.get(ACCOUNT_SECRET_KEY)!
    expect(token).toBeTruthy()

    const bm = a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })!
    expect(await setupAccount(a)).toBeNull()
    expect(a.toasts).toEqual([ACCOUNT_SIGN_IN_FIRST_MESSAGE])
    expect(a.engine.status()).toMatchObject({
      enabled: true,
      transport: 'account',
      account: { email: EMAIL },
      folderName: EMAIL,
      lastError: null,
      pendingMerge: false
    })
    // One device file and nothing readable; no README is stored in an account.
    expect([...docs().keys()].filter(isDeviceFileName)).toHaveLength(1)
    expect(docs().has(README_NAME)).toBe(false)
    for (const text of docs().values()) expect(text).not.toContain('zenium.app')
    // The refresh token is in the store and nowhere else.
    const stored = a.secrets.values.get(ACCOUNT_SECRET_KEY)!
    expect(JSON.stringify(a.engine.status())).not.toContain(stored)
    expect(JSON.stringify(a.io.files)).not.toContain(stored)
    expect(JSON.stringify(a.io.files)).not.toContain('at.session')

    await signIn(b)
    expect(await setupAccount(b)).toBeNull()
    expect(b.engine.status().pendingMerge).toBe(true)
    await b.engine.confirmMerge(true)
    expect(b.browser.bookmarks.get(bm.id)?.url).toBe('https://zenium.app/')
    expect(server.sessionsOf(EMAIL).map((s) => [s.deviceName, s.kind])).toEqual([
      ['Desk (Linux)', 'desktop'],
      ['Pixel 9', 'phone']
    ])

    b.browser.bookmarks.create({ title: 'Docs', url: 'https://docs.example/' })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.state.bookmarks.some((n) => n.url === 'https://docs.example/')).toBe(true)
    expect(a.engine.status().devices.map((d) => d.name)).toEqual(['Pixel 9'])
  }, 30_000)

  it('carries history and sent tabs between the devices', async () => {
    const a = accountDevice('Desk (Linux)')
    const b = accountDevice('Pixel 9')
    const T0 = Date.now() - 3 * 86_400_000
    a.browser.history.visit('https://a.example/one', 'One', null, { at: T0 })
    await join(a, b)
    expect(b.browser.history.recent(10).map((e) => e.url)).toContain('https://a.example/one')

    b.browser.history.visit('https://b.example/', 'B', null, { at: T0 + 1000 })
    await b.engine.syncNow()
    await a.engine.syncNow()
    expect(a.browser.history.recent(10).map((e) => e.url)).toContain('https://b.example/')

    const bId = b.engine.status().deviceId
    await a.engine.sendTab({ deviceId: bId, url: 'https://sent.example/', title: 'Sent' }, a.win)
    expect(a.toasts.at(-1)).toBe('Sent to Pixel 9')
    expect([...docs().keys()].some((n) => n.includes('.inbox.'))).toBe(true)
    await b.engine.syncNow()
    expect(
      Object.values(b.browser.state.model.tabs).some((t) => t.url === 'https://sent.example/')
    ).toBe(true)
    expect([...docs().keys()].some((n) => n.includes('.inbox.'))).toBe(false)
  }, 30_000)

  it('refuses a passphrase that does not open the accountâ€™s data, and keeps the sign-in', async () => {
    const a = accountDevice('Desk (Linux)')
    const b = accountDevice('Pixel 9')
    await signIn(a)
    await setupAccount(a)
    await signIn(b)
    expect(await setupAccount(b, 'a different passphrase')).toBeNull()
    expect(b.toasts.at(-1)).toBe(WRONG_PASSPHRASE_MESSAGE)
    expect(b.engine.status()).toMatchObject({ enabled: false, account: { email: EMAIL } })
    expect(await setupAccount(b)).toBeNull()
    expect(b.engine.status().enabled).toBe(true)
  }, 30_000)

  it('the start, the expiry and the cancel of a sign-in each leave the page what to say', async () => {
    const a = accountDevice('Desk (Linux)')
    server.offline = true
    await a.engine.startAccountLink(a.browser.ensureWindow())
    expect(a.engine.status()).toMatchObject({
      accountLink: null,
      accountLinkFailure: 'unavailable'
    })
    server.offline = false

    server.linkTtlMs = 0
    await a.engine.startAccountLink(a.browser.ensureWindow())
    await vi.waitFor(() => expect(a.engine.status().accountLinkFailure).toBe('expired'))
    expect(a.engine.status().accountLink).toBeNull()
    server.linkTtlMs = 60_000

    server.interval = 1
    await a.engine.startAccountLink(a.browser.ensureWindow())
    expect(a.engine.status()).toMatchObject({ accountLinkFailure: null })
    const code = a.engine.status().accountLink!.userCode
    a.engine.cancelAccountLink()
    expect(a.engine.status().accountLink).toBeNull()
    server.approve(code, EMAIL)
    await new Promise((r) => setTimeout(r, 1200))
    expect(a.engine.status().account).toBeNull()
    expect(a.secrets.values.size).toBe(0)
    // The approved code was never exchanged: no session came of it.
    expect(server.sessions.size).toBe(0)
  }, 30_000)

  it('a sign-out from the website stops the rounds as accountSignedOut; signing in again resumes', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    expect(a.engine.status().lastError).toBeNull()
    server.revoke(sessionOf('Desk (Linux)').id)
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      enabled: true,
      accountSignedOut: true,
      account: { email: EMAIL },
      lastError: accountErrorMessage('signed-out'),
      lastErrorKind: 'signed-out'
    })
    await vi.waitFor(() => expect(a.secrets.values.has(ACCOUNT_SECRET_KEY)).toBe(false))
    // Nothing more is sent with the dead sign-in.
    const sent = server.log.length
    a.browser.bookmarks.create({ title: 'Later', url: 'https://later.example/' })
    await a.engine.syncNow()
    expect(server.log.length).toBe(sent)

    await signIn(a)
    await vi.waitFor(() =>
      expect(a.engine.status()).toMatchObject({
        accountSignedOut: false,
        lastError: null,
        enabled: true
      })
    )
    await a.engine.syncNow()
    const b = accountDevice('Pixel 9')
    await signIn(b)
    await setupAccount(b)
    await b.engine.confirmMerge(true)
    expect(b.browser.state.bookmarks.some((n) => n.url === 'https://later.example/')).toBe(true)
  }, 30_000)

  it('an account deleted is signed out the same way; a setup it refuses comes back typed', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    server.deleteAccount(EMAIL)
    expect(await setupAccount(a)).toEqual({ reason: 'account', kind: 'signed-out' })
    // The sign-in is forgotten with it, for the page to offer it again.
    expect(a.engine.status()).toMatchObject({ enabled: false, account: null })
  }, 30_000)

  it('a full account is the quota error, typed for the page', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    server.limits.maxBytes = 10
    a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({
      lastError: accountErrorMessage('quota'),
      lastErrorKind: 'quota',
      accountSignedOut: false,
      enabled: true
    })
    server.limits.maxBytes = 1 << 30
    await a.engine.syncNow()
    expect(a.engine.status()).toMatchObject({ lastError: null, lastErrorKind: null })
  }, 30_000)

  it('signing out turns sync off, signs the device out at the service and forgets the token', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    const session = sessionOf('Desk (Linux)')
    a.engine.signOutAccount()
    expect(a.engine.status()).toMatchObject({
      enabled: false,
      account: null,
      accountSignedOut: false
    })
    await vi.waitFor(() => expect(session.revoked).toBe(true))
    expect(a.secrets.values.size).toBe(0)

    // Signed in and never set up: only the sign-in is forgotten.
    await signIn(a)
    const second = sessionOf('Desk (Linux)')
    a.engine.signOutAccount()
    expect(a.engine.status().account).toBeNull()
    await vi.waitFor(() => expect(second.revoked).toBe(true))
    expect(a.secrets.values.size).toBe(0)
  }, 30_000)

  it('turning off with the wipe removes this deviceâ€™s documents before the sign-out', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    const session = sessionOf('Desk (Linux)')
    expect([...docs().keys()].filter(isDeviceFileName)).toHaveLength(1)
    a.engine.disconnect(true)
    await vi.waitFor(() => expect(session.revoked).toBe(true))
    expect([...docs().keys()].filter(isDeviceFileName)).toHaveLength(0)
    expect(a.secrets.values.size).toBe(0)
    expect(a.engine.status().account).toBeNull()
  }, 30_000)

  it('moving to a folder leaves the account', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    const session = sessionOf('Desk (Linux)')
    await a.engine.setFolder('/drive', a.win)
    expect(a.engine.status()).toMatchObject({
      transport: 'folder',
      folder: '/drive',
      account: null
    })
    await vi.waitFor(() => expect(session.revoked).toBe(true))
    expect(a.secrets.values.size).toBe(0)
  }, 30_000)

  it('renames the device in the accountâ€™s list too', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    const session = sessionOf('Desk (Linux)')
    a.engine.setDeviceName('Study desk')
    await vi.waitFor(() => expect(session.deviceName).toBe('Study desk'))
  }, 30_000)

  it('the name chosen at setup reaches the account’s list', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    const session = sessionOf('Desk (Linux)')
    expect(
      await a.engine.setup(
        {
          folder: '',
          passphrase: PASSPHRASE,
          deviceName: 'Kitchen laptop',
          scope: a.engine.status().scope,
          transport: 'account'
        },
        a.win
      )
    ).toBeNull()
    await vi.waitFor(() => expect(session.deviceName).toBe('Kitchen laptop'))
  }, 30_000)

  it('a restart connects with the token from the store; a store without one is signed out', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    a.engine.flushSync()
    const again = accountDevice('Desk (Linux)', { io: a.io, keys: a.keys, secrets: a.secrets })
    expect(again.engine.status()).toMatchObject({
      enabled: true,
      transport: 'account',
      account: { email: EMAIL }
    })
    const refreshes = server.count('/auth/refresh')
    await again.engine.syncNow()
    expect(again.engine.status().lastError).toBeNull()
    expect(server.count('/auth/refresh')).toBe(refreshes + 1)

    again.engine.flushSync()
    const bare = accountDevice('Desk (Linux)', { io: a.io, keys: a.keys })
    await bare.engine.syncNow()
    expect(bare.engine.status()).toMatchObject({ enabled: true, accountSignedOut: true })
  }, 30_000)

  it('an unchanged device file is not written again until its heartbeat', async () => {
    const a = accountDevice('Desk (Linux)')
    await signIn(a)
    await setupAccount(a)
    const sid = sessionOf('Desk (Linux)').id
    const writes = (): number => server.countBy(sid, 'mutation sync:write')
    const before = writes()
    await a.engine.syncNow()
    await a.engine.syncNow()
    expect(writes()).toBe(before)

    a.browser.bookmarks.create({ title: 'Zenium', url: 'https://zenium.app/' })
    await a.engine.syncNow()
    expect(writes()).toBe(before + 1)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    await a.engine.syncNow()
    expect(writes()).toBe(before + 2)
  }, 30_000)

  it('another deviceâ€™s change brings a round through the version watch; its own rounds do not ping-pong', async () => {
    const a = accountDevice('Desk (Linux)')
    const b = accountDevice('Pixel 9')
    // A host with a foreground (Android's): the version is asked at the host's pace.
    a.host.foreground = () => true
    a.host.pollMs = 40
    await join(a, b)
    const aSid = sessionOf('Desk (Linux)').id

    b.browser.bookmarks.create({ title: 'Docs', url: 'https://docs.example/' })
    await b.engine.syncNow()
    await vi.waitFor(() =>
      expect(a.browser.state.bookmarks.some((n) => n.url === 'https://docs.example/')).toBe(true)
    )
    // Quiet now: the version is asked, but no round follows from A's own writes.
    await new Promise((r) => setTimeout(r, 200))
    const lists = server.countBy(aSid, 'query sync:list')
    await new Promise((r) => setTimeout(r, 400))
    expect(server.countBy(aSid, 'query sync:version')).toBeGreaterThan(3)
    expect(server.countBy(aSid, 'query sync:list')).toBe(lists)
  }, 30_000)
})
