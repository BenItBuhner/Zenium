import { describe, expect, it } from 'vitest'
import type { ClientCertificateInfo } from '../../shared/types'
import type { Browser } from '../browser'
import {
  AUTH_RETRY_WINDOW_MS,
  SecurityPromptService,
  SessionHttpCredentialStore,
  httpAuthKey,
  type HttpAuthChallenge
} from '../security'

function service(): { s: SecurityPromptService; clock: { now: number }; commits: () => number } {
  const clock = { now: 1_000_000 }
  let commits = 0
  const browser = {
    state: {
      commitVolatile: () => {
        commits++
      }
    }
  } as unknown as Browser
  const s = new SecurityPromptService(browser, new SessionHttpCredentialStore(), () => clock.now)
  return { s, clock, commits: () => commits }
}

const BASIC: HttpAuthChallenge = {
  host: 'intranet.example',
  port: 443,
  realm: 'Staff',
  scheme: 'Basic',
  isProxy: false,
  secure: true
}

function cert(fingerprint: string, subject: string): ClientCertificateInfo {
  return {
    fingerprint,
    subject,
    issuer: 'Example CA',
    serialNumber: '01',
    validFrom: 0,
    validTo: 4_000_000_000_000
  }
}

/** Let the service queue its prompt (it does so synchronously inside the promise executor). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('httpAuthKey', () => {
  it('is the protection space: side, host, port and realm', () => {
    expect(httpAuthKey(BASIC)).toBe('server|intranet.example:443|Staff')
    expect(httpAuthKey({ ...BASIC, host: 'INTRANET.example', isProxy: true })).toBe(
      'proxy|intranet.example:443|Staff'
    )
    expect(httpAuthKey({ ...BASIC, realm: 'Other' })).not.toBe(httpAuthKey(BASIC))
  })
})

describe('SecurityPromptService: HTTP authentication', () => {
  it('shows one dialog with the challenge and hands the answer back', async () => {
    const { s, commits } = service()
    const pending = s.httpAuth(BASIC, 't1')
    await settle()
    const [prompt] = s.list()
    expect(prompt.kind).toBe('http-auth')
    if (prompt.kind !== 'http-auth') return
    expect(prompt).toMatchObject({
      tabId: 't1',
      host: 'intranet.example',
      port: 443,
      realm: 'Staff',
      scheme: 'basic',
      isProxy: false,
      secure: true,
      failedBefore: false
    })
    expect(commits()).toBe(1)
    s.respond(prompt.id, { kind: 'http-auth', username: 'ana', password: 'pw', remember: false })
    expect(await pending).toEqual({ username: 'ana', password: 'pw' })
    expect(s.list()).toEqual([])
    expect(commits()).toBe(2)
  })

  it('cancel gives up (the page shows the 401) and ignores answers to unknown prompts', async () => {
    const { s } = service()
    const pending = s.httpAuth(BASIC, 't1')
    await settle()
    s.respond('nope', null)
    expect(s.list().length).toBe(1)
    s.respond(s.list()[0].id, null)
    expect(await pending).toBe(null)
  })

  it('every request behind the same realm waits for the one dialog', async () => {
    const { s } = service()
    const page = s.httpAuth(BASIC, 't1')
    const image = s.httpAuth(BASIC, 't1')
    const other = s.httpAuth({ ...BASIC, realm: 'Admin' }, 't1')
    await settle()
    expect(s.list().length).toBe(2)
    s.respond(s.list()[0].id, { kind: 'http-auth', username: 'a', password: 'b', remember: false })
    expect(await page).toEqual({ username: 'a', password: 'b' })
    expect(await image).toEqual({ username: 'a', password: 'b' })
    s.respond(s.list()[0].id, null)
    expect(await other).toBe(null)
  })

  it('a challenge right after an answer means it was refused: ask again, say so', async () => {
    const { s, clock } = service()
    const first = s.httpAuth(BASIC, 't1')
    await settle()
    s.respond(s.list()[0].id, {
      kind: 'http-auth',
      username: 'a',
      password: 'wrong',
      remember: false
    })
    await first
    clock.now += 200
    const retry = s.httpAuth(BASIC, 't1')
    await settle()
    const [prompt] = s.list()
    expect(prompt.kind === 'http-auth' && prompt.failedBefore).toBe(true)
    s.respond(prompt.id, null)
    expect(await retry).toBe(null)
    // Long after the last answer the realm is simply asking anew.
    clock.now += AUTH_RETRY_WINDOW_MS
    const later = s.httpAuth(BASIC, 't1')
    await settle()
    const [fresh] = s.list()
    expect(fresh.kind === 'http-auth' && fresh.failedBefore).toBe(false)
    s.respond(fresh.id, null)
    await later
  })

  it('remembered credentials are sent without asking until they stop working', async () => {
    const { s, clock } = service()
    const first = s.httpAuth(BASIC, 't1')
    await settle()
    s.respond(s.list()[0].id, { kind: 'http-auth', username: 'a', password: 'b', remember: true })
    await first
    clock.now += AUTH_RETRY_WINDOW_MS + 1
    expect(await s.httpAuth(BASIC, 't2')).toEqual({ username: 'a', password: 'b' })
    expect(s.list()).toEqual([])
    // Refused right away: the stored pair is dropped and the user sees the dialog.
    clock.now += 100
    const retry = s.httpAuth(BASIC, 't2')
    await settle()
    expect(s.list().length).toBe(1)
    expect(s.credentials.get(httpAuthKey(BASIC))).toBe(null)
    s.respond(s.list()[0].id, null)
    await retry
    // Forgetting the session drops what is remembered.
    const again = s.httpAuth(BASIC, 't1')
    await settle()
    s.respond(s.list()[0].id, { kind: 'http-auth', username: 'a', password: 'b', remember: true })
    await again
    s.forgetSession()
    expect(s.credentials.get(httpAuthKey(BASIC))).toBe(null)
  })

  it('a tab going away cancels its prompts and leaves the others', async () => {
    const { s } = service()
    const mine = s.httpAuth(BASIC, 't1')
    const proxy = s.httpAuth({ ...BASIC, isProxy: true, host: 'proxy.example', port: 3128 }, null)
    await settle()
    s.cancelForTab('t1')
    expect(await mine).toBe(null)
    const [left] = s.list()
    expect(s.list().length).toBe(1)
    expect(left.kind === 'http-auth' && left.isProxy).toBe(true)
    s.respond(left.id, null)
    expect(await proxy).toBe(null)
  })
})

describe('SecurityPromptService: client certificates', () => {
  const certs = [cert('aa', 'Ana Staff'), cert('bb', 'Ana Admin')]

  it('never sends a certificate silently and keeps the choice per host for the session', async () => {
    const { s } = service()
    const first = s.clientCertificate('intranet.example', certs, 't1')
    await settle()
    const [prompt] = s.list()
    expect(prompt.kind).toBe('client-certificate')
    if (prompt.kind !== 'client-certificate') return
    expect(prompt.host).toBe('intranet.example')
    expect(prompt.certificates.map((c) => c.subject)).toEqual(['Ana Staff', 'Ana Admin'])
    s.respond(prompt.id, { kind: 'client-certificate', index: 1 })
    expect(await first).toBe(1)
    // The same host again, the list in another order: the same certificate, no dialog.
    expect(await s.clientCertificate('intranet.example', [certs[1], certs[0]], 't1')).toBe(0)
    expect(s.list()).toEqual([])
    // Another host asks anew.
    const other = s.clientCertificate('other.example', certs, 't1')
    await settle()
    expect(s.list().length).toBe(1)
    s.respond(s.list()[0].id, null)
    expect(await other).toBe(null)
  })

  it('"continue without" is remembered too, and forgotten with the session', async () => {
    const { s } = service()
    const first = s.clientCertificate('intranet.example', certs, 't1')
    await settle()
    s.respond(s.list()[0].id, null)
    expect(await first).toBe(null)
    expect(await s.clientCertificate('intranet.example', certs, 't1')).toBe(null)
    expect(s.list()).toEqual([])
    s.forgetSession()
    const again = s.clientCertificate('intranet.example', certs, 't1')
    await settle()
    expect(s.list().length).toBe(1)
    s.respond(s.list()[0].id, { kind: 'client-certificate', index: 5 })
    // An index outside the list counts as "none".
    expect(await again).toBe(null)
  })

  it('parallel requests to one host share the chooser; an empty list needs no dialog', async () => {
    const { s } = service()
    expect(await s.clientCertificate('intranet.example', [], 't1')).toBe(null)
    const a = s.clientCertificate('intranet.example', certs, 't1')
    const b = s.clientCertificate('intranet.example', certs, 't1')
    await settle()
    expect(s.list().length).toBe(1)
    s.respond(s.list()[0].id, { kind: 'client-certificate', index: 0 })
    expect(await a).toBe(0)
    expect(await b).toBe(0)
  })
})
