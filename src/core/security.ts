import type {
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
  /**
   * One dialog per protection space: the engine challenges every request behind the same realm
   * (a page and its images), and they all wait for the one answer.
   */
  private readonly inFlight = new Map<string, Promise<HttpCredentials | null>>()
  private readonly certificateInFlight = new Map<string, Promise<number | null>>()

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
      this.answeredAt.set(key, now)
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
      failedBefore
    }
    const answer = await this.show(prompt)
    if (!answer || answer.kind !== 'http-auth') {
      this.answeredAt.delete(key)
      return null
    }
    const credentials = { username: answer.username, password: answer.password }
    if (answer.remember) this.credentials.set(key, credentials)
    this.answeredAt.set(key, this.now())
    return credentials
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
  }

  /** Queue the prompt; the chrome shows it once its tab is the active one (tab-modal, like Chrome). */
  private show(prompt: SecurityPrompt): Promise<SecurityPromptResponse | null> {
    return new Promise((resolve) => {
      this.pending.push({ prompt, resolve })
      this.browser.state.commitVolatile()
    })
  }
}
