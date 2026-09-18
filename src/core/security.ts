import type {
  CertificateDetails,
  ClientCertificateInfo,
  HttpAuthPrompt,
  SecurityPrompt,
  SecurityPromptResponse
} from '../shared/types'
import { newId } from '../shared/ids'
import type { Browser } from './browser'

export interface HttpCredentials {
  username: string
  password: string
}

/** What a host knows about an authentication challenge. */
export interface HttpAuthChallenge {
  host: string
  port: number
  realm: string
  /** Challenge scheme as the host reports it (any case); '' when it does not know. */
  scheme: string
  isProxy: boolean
  /** Whether the credentials travel over TLS. */
  secure: boolean
}

/**
 * Where remembered HTTP credentials live. The built-in store forgets everything when the browser
 * quits; the encrypted credential store can back this interface later.
 */
export interface HttpCredentialStore {
  get(key: string): HttpCredentials | null
  set(key: string, credentials: HttpCredentials): void
  delete(key: string): void
  clear(): void
}

export class SessionHttpCredentialStore implements HttpCredentialStore {
  private readonly entries = new Map<string, HttpCredentials>()

  get(key: string): HttpCredentials | null {
    return this.entries.get(key) ?? null
  }

  set(key: string, credentials: HttpCredentials): void {
    this.entries.set(key, credentials)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Credentials are remembered per protection space: proxy or server, host, port and realm. */
export function httpAuthKey(
  c: Pick<HttpAuthChallenge, 'host' | 'port' | 'realm' | 'isProxy'>
): string {
  return `${c.isProxy ? 'proxy' : 'server'}|${c.host.toLowerCase()}:${c.port}|${c.realm}`
}

/**
 * A challenge that arrives this soon after we answered one for the same protection space means
 * the answer was refused (the engine asks again for the same request).
 */
export const AUTH_RETRY_WINDOW_MS = 60_000

/** `host:port` of an https address (443 when it leaves the port out); null for any other URL. */
export function certificateSiteOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null
    return `${parsed.hostname.toLowerCase()}:${parsed.port || '443'}`
  } catch {
    return null
  }
}

/** A certificate the user proceeded past, and the `ERR_CERT_*` code it failed with. */
export interface CertificateException {
  code: number
  certificate: CertificateDetails
}

/**
 * The certificates the user proceeded past this session, remembered as Chrome remembers them: per
 * site (host and port) and per certificate, so a site that changes its certificate asks again,
 * until the browser quits. Kept per container, so a private window's exceptions end with its
 * session. Nothing here is persisted. The hosts ask on every TLS handshake (Chromium keeps no
 * decision of its own in Electron), so this is the one place the answer lives.
 */
export class CertificateExceptions {
  private readonly allowed = new Map<string, CertificateException>()

  /**
   * Remember `certificate` for the site of `url`; false when `url` is not https or the
   * certificate has no fingerprint to remember it by.
   */
  allow(containerId: string, url: string, code: number, certificate: CertificateDetails): boolean {
    const key = this.key(containerId, url, certificate.fingerprint)
    if (!key) return false
    // Re-added last, so `exceptionFor` names the exception the latest load went ahead under.
    this.allowed.delete(key)
    this.allowed.set(key, { code, certificate })
    return true
  }

  isAllowed(containerId: string, url: string, fingerprint: string): boolean {
    const key = this.key(containerId, url, fingerprint)
    return key !== null && this.allowed.has(key)
  }

  /**
   * The exception a load of `url` in `containerId` goes ahead under, if the session has one for
   * its site: a committed https page of such a site was loaded over the excepted certificate (the
   * host asked, and this was the answer), unless the site has since put a valid one up. The
   * latest one when several certificates of the site were excepted.
   */
  exceptionFor(containerId: string, url: string): CertificateException | null {
    const site = certificateSiteOf(url)
    if (!site) return null
    const prefix = `${containerId}|${site}|`
    let found: CertificateException | null = null
    for (const [key, exception] of this.allowed) if (key.startsWith(prefix)) found = exception
    return found
  }

  /** The container's session ended (private browsing) or its site data was cleared: its exceptions go. */
  forgetContainer(containerId: string): void {
    for (const key of this.allowed.keys())
      if (key.startsWith(`${containerId}|`)) this.allowed.delete(key)
  }

  get size(): number {
    return this.allowed.size
  }

  private key(containerId: string, url: string, fingerprint: string): string | null {
    const site = certificateSiteOf(url)
    if (!site || !fingerprint) return null
    return `${containerId}|${site}|${fingerprint}`
  }
}

interface Pending {
  prompt: SecurityPrompt
  resolve: (response: SecurityPromptResponse | null) => void
}

/**
 * The prompts the engine needs an answer for before a request can go on: HTTP authentication
 * (Basic, Digest, NTLM, Negotiate, proxies) and client-certificate selection. Both are shown by
 * the chrome as a Zenium dialog; hosts only report the challenge and forward the answer.
 */
export class SecurityPromptService {
  private readonly pending: Pending[] = []
  /** Certificate chosen per host for this session; null means "continue without one". */
  private readonly certificateChoices = new Map<string, string | null>()
  /** When each protection space was last answered (to recognise refused credentials). */
  private readonly answeredAt = new Map<string, number>()
  /** The username last sent per protection space, offered again when it was refused. */
  private readonly lastUsername = new Map<string, string>()
  /**
   * One dialog per protection space: the engine challenges every request behind the same realm
   * (a page and its images), and they all wait for the one answer.
   */
  private readonly inFlight = new Map<string, Promise<HttpCredentials | null>>()
  private readonly certificateInFlight = new Map<string, Promise<number | null>>()
  /**
   * Server certificates the user proceeded past (the interstitial's "Proceed"). Separate from
   * `forgetSession`, which is about sign-ins; these end with the session or the browser.
   */
  readonly certificateExceptions = new CertificateExceptions()

  constructor(
    private readonly browser: Browser,
    readonly credentials: HttpCredentialStore = new SessionHttpCredentialStore(),
    private readonly now: () => number = Date.now
  ) {}

  list(): SecurityPrompt[] {
    return this.pending.map((p) => p.prompt)
  }

  /**
   * HTTP authentication. Resolves with the credentials to send, or null to give up (the page then
   * shows the server's 401). Remembered credentials are sent once without asking; when the same
   * space challenges again right away they were wrong, and the user sees the dialog.
   */
  async httpAuth(
    challenge: HttpAuthChallenge,
    tabId: string | null
  ): Promise<HttpCredentials | null> {
    const key = httpAuthKey(challenge)
    const waiting = this.inFlight.get(key)
    if (waiting) return waiting
    const now = this.now()
    const failedBefore = now - (this.answeredAt.get(key) ?? -Infinity) < AUTH_RETRY_WINDOW_MS
    const remembered = this.credentials.get(key)
    if (remembered && !failedBefore) {
      this.sent(key, remembered)
      return remembered
    }
    if (remembered) this.credentials.delete(key)
    const asking = this.askHttpAuth(key, challenge, tabId, failedBefore)
    this.inFlight.set(key, asking)
    try {
      return await asking
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async askHttpAuth(
    key: string,
    challenge: HttpAuthChallenge,
    tabId: string | null,
    failedBefore: boolean
  ): Promise<HttpCredentials | null> {
    const prompt: HttpAuthPrompt = {
      id: newId('auth'),
      kind: 'http-auth',
      tabId,
      host: challenge.host,
      port: challenge.port,
      realm: challenge.realm,
      scheme: challenge.scheme.toLowerCase(),
      isProxy: challenge.isProxy,
      secure: challenge.secure,
      failedBefore,
      username: failedBefore ? (this.lastUsername.get(key) ?? '') : ''
    }
    const answer = await this.show(prompt)
    if (!answer || answer.kind !== 'http-auth') {
      this.answeredAt.delete(key)
      return null
    }
    const credentials = { username: answer.username, password: answer.password }
    if (answer.remember) this.credentials.set(key, credentials)
    this.sent(key, credentials)
    return credentials
  }

  private sent(key: string, credentials: HttpCredentials): void {
    this.answeredAt.set(key, this.now())
    this.lastUsername.set(key, credentials.username)
  }

  /**
   * Client certificate selection. Resolves with the index of the certificate to send, or null to
   * continue without one. Nothing is ever sent silently: the first request per host asks, and
   * the answer (including "none") holds for the rest of the session, as in Chrome.
   */
  async clientCertificate(
    host: string,
    certificates: ClientCertificateInfo[],
    tabId: string | null
  ): Promise<number | null> {
    const remembered = this.certificateChoices.get(host)
    if (remembered === null) return null
    if (remembered !== undefined) {
      const index = certificates.findIndex((c) => c.fingerprint === remembered)
      if (index >= 0) return index
    }
    if (!certificates.length) return null
    const waiting = this.certificateInFlight.get(host)
    if (waiting) {
      // Same host, same session: the answer to the first chooser applies here as well.
      await waiting
      return this.clientCertificate(host, certificates, tabId)
    }
    const asking = this.askClientCertificate(host, certificates, tabId)
    this.certificateInFlight.set(host, asking)
    try {
      return await asking
    } finally {
      this.certificateInFlight.delete(host)
    }
  }

  private async askClientCertificate(
    host: string,
    certificates: ClientCertificateInfo[],
    tabId: string | null
  ): Promise<number | null> {
    const answer = await this.show({
      id: newId('cert'),
      kind: 'client-certificate',
      tabId,
      host,
      certificates
    })
    const index =
      answer?.kind === 'client-certificate' && certificates[answer.index] ? answer.index : null
    this.certificateChoices.set(host, index === null ? null : certificates[index].fingerprint)
    return index
  }

  /** The chrome answered (or dismissed) a prompt. */
  respond(id: string, response: SecurityPromptResponse | null): void {
    const i = this.pending.findIndex((p) => p.prompt.id === id)
    if (i < 0) return
    const [entry] = this.pending.splice(i, 1)
    this.browser.state.commitVolatile()
    entry.resolve(response)
  }

  /** A tab went away: its prompts are moot. */
  cancelForTab(tabId: string): void {
    for (const p of this.pending.filter((p) => p.prompt.tabId === tabId))
      this.respond(p.prompt.id, null)
  }

  /** Forget the credentials and certificate choices of this session. */
  forgetSession(): void {
    this.credentials.clear()
    this.certificateChoices.clear()
    this.answeredAt.clear()
    this.lastUsername.clear()
  }

  /** Queue the prompt; the chrome shows it once its tab is the active one (tab-modal, like Chrome). */
  private show(prompt: SecurityPrompt): Promise<SecurityPromptResponse | null> {
    return new Promise((resolve) => {
      this.pending.push({ prompt, resolve })
      this.browser.state.commitVolatile()
    })
  }
}
