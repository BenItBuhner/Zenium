import type {
  CheckupSummary,
  Credential,
  CredentialLeakAction,
  CredentialLeakWarning
} from '../../shared/types'
import { newId } from '../../shared/ids'
import type { Browser } from '../browser'
import type { ZenWindow } from '../window'
import { lookupBreachCount } from './checkup'
import type { LoginCandidate } from './fill'
import { domainOf, normalizeOrigin, siteLabel } from './origins'
import type { CredentialStore } from './store'

/**
 * The sign-in leak warning (ID-31; Chrome's leak detection, Edge's Password Monitor): a
 * password a page's sign-in form submitted is looked up in the breach corpus with the checkup's
 * k-anonymity range request, and when it is known breached the tab gets a warning to answer.
 *
 * The decisions are pure (`savedLoginFor`, `decideLeakCheck`, `changePasswordUrl`) so the unit
 * tests drive them with plain data; `LeakDetector` runs them over the live store and tabs.
 *
 * Chrome's rules, followed here: the check runs once the page has moved on after the submit
 * (never on the submit path), in private tabs too; a warning shows once per saved login per
 * password value and never again for one the user ignored, until the password changes; nothing
 * is remembered for an unsaved sign-in or in a private tab; a network failure warns nothing and
 * records nothing, so the next sign-in tries again; the setting off runs no check at all.
 */

/** Where a site is asked for its change-password page (W3C well-known URL, Chrome's first try). */
export const WELL_KNOWN_CHANGE_PASSWORD = '/.well-known/change-password'
/**
 * Chrome's probe beside it: a site that answers 200 to this URL answers 200 to anything (a
 * catch-all), so its change-password answer proves nothing and the origin is opened instead.
 */
export const WELL_KNOWN_NOT_EXIST =
  '/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200'
/** How long the two probes may take together before the origin is opened. */
export const CHANGE_PASSWORD_PROBE_MS = 4_000
/** A check's result waits this long for the save prompt's answer to attach to the saved login. */
const RESULT_TTL_MS = 5 * 60_000

const sameUser = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The saved login that holds exactly the submitted credentials among `matches` (the logins
 * usable on the page's origin): the same password, and the same username when the form had one.
 * The breach state describes one password value, so only such a login carries the memory.
 */
export function savedLoginFor(
  candidate: Pick<LoginCandidate, 'origin' | 'username' | 'password'>,
  matches: Credential[]
): Credential | null {
  const username = candidate.username.trim()
  const same = matches.filter(
    (c) => c.password === candidate.password && (!username || sameUser(c.username, username))
  )
  if (same.length === 0) return null
  return (
    same.find((c) => c.origin === candidate.origin) ??
    same.sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))[0]
  )
}

export interface LeakCheckContext {
  /** Settings › Passwords › Warn you if passwords are exposed in a data breach. */
  enabled: boolean
  /** The tab is private: the check runs and warns, but nothing is remembered. */
  isPrivate: boolean
  /** The saved login holding these credentials (`savedLoginFor`), null when none or the vault is locked. */
  saved: Credential | null
}

export type LeakCheckDecision =
  | {
      kind: 'skip'
      /**
       * `empty`: no password; `disabled`: the setting is off; `warned`: this login already
       * warned for this password value; `ignored`: the user ignored the warning for it.
       */
      reason: 'empty' | 'disabled' | 'warned' | 'ignored'
    }
  | {
      kind: 'check'
      /** The login the result and the warning are remembered on; null when nothing is (unsaved, private). */
      credentialId: string | null
    }

/** Check, or stay quiet: Chrome's rules over the setting, the tab and the saved login's memory. */
export function decideLeakCheck(
  candidate: Pick<LoginCandidate, 'password'>,
  context: LeakCheckContext
): LeakCheckDecision {
  if (!candidate.password) return { kind: 'skip', reason: 'empty' }
  if (!context.enabled) return { kind: 'skip', reason: 'disabled' }
  const saved = context.saved
  if (saved) {
    if (saved.leakIgnoredAt !== null) return { kind: 'skip', reason: 'ignored' }
    if (saved.leakWarnedAt !== null) return { kind: 'skip', reason: 'warned' }
  }
  return { kind: 'check', credentialId: saved && !context.isPrivate ? saved.id : null }
}

/**
 * Where "Change password" takes the tab: the site's `/.well-known/change-password` when it
 * answers 2xx (after redirects) while the not-exist probe does not (Chrome's
 * `WellKnownChangePasswordNavigationThrottle`), else the site itself. `answers` says whether a
 * URL answered 2xx; a failure or a timeout counts as no.
 */
export async function changePasswordUrl(
  origin: string,
  answers: (url: string) => Promise<boolean>
): Promise<string> {
  const site = normalizeOrigin(origin)
  if (!site) return origin
  const fallback = `${site}/`
  const wellKnown = `${site}${WELL_KNOWN_CHANGE_PASSWORD}`
  const [supported, catchAll] = await Promise.all([
    answers(wellKnown).catch(() => false),
    answers(`${site}${WELL_KNOWN_NOT_EXIST}`).catch(() => true)
  ])
  return supported && !catchAll ? wellKnown : fallback
}

/** A submitted login the detector checks: the candidate and the tab it was submitted in. */
export interface LeakCandidate extends Pick<
  LoginCandidate,
  'origin' | 'url' | 'username' | 'password'
> {
  tabId: string
}

interface LeakResult {
  origin: string
  username: string
  password: string
  count: number
  at: number
}

/**
 * Runs the leak check over the live store and tabs and owns the warnings
 * (`PasswordsStatus.leaks`). The autofill service hands it every judged sign-in
 * (`check`) and every login it then saved or updated (`onSaved`); the chrome answers the
 * warnings through `passwords.leakRespond` (`respond`).
 */
export class LeakDetector {
  private readonly warnings = new Map<string, CredentialLeakWarning>()
  /** Results of checks whose credentials were not saved when they finished, by tab, for `onSaved`. */
  private readonly results = new Map<string, LeakResult>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly inflight = new Set<Promise<unknown>>()
  /** Called when a warning is raised, answered or dropped, and after a result was recorded on a login. */
  onChange: () => void = () => {}

  constructor(
    private readonly browser: Browser,
    private readonly store: CredentialStore,
    private readonly fetchRange: (prefix: string, signal: AbortSignal) => Promise<string | null>
  ) {}

  /** Warnings waiting for the user, oldest first. */
  active(): CredentialLeakWarning[] {
    return [...this.warnings.values()]
  }

  /** Resolves once every check started so far has finished (tests, demo drivers). */
  async whenSettled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
  }

  /**
   * A sign-in the page confirmed: look the password up, off the submit path. Nothing here waits
   * on the vault: a locked one only means no memory is read or written.
   */
  check(candidate: LeakCandidate): Promise<void> {
    const work = this.run(candidate).catch(() => undefined)
    this.inflight.add(work)
    void work.finally(() => this.inflight.delete(work))
    return work
  }

  private async run(candidate: LeakCandidate): Promise<void> {
    const tab = this.browser.tabs.tab(candidate.tabId)
    if (!tab) return
    const isPrivate = this.browser.tabs.isPrivate(tab)
    const decision = decideLeakCheck(candidate, {
      enabled: this.browser.state.settings.passwords.leakDetection,
      isPrivate,
      saved: this.saved(candidate)
    })
    if (decision.kind === 'skip') return
    this.aborts.get(candidate.tabId)?.abort()
    const abort = new AbortController()
    this.aborts.set(candidate.tabId, abort)
    this.results.delete(candidate.tabId)
    let count: number | null
    try {
      count = await lookupBreachCount(
        candidate.password,
        { fetchRange: this.fetchRange },
        abort.signal
      )
    } finally {
      if (this.aborts.get(candidate.tabId) === abort) this.aborts.delete(candidate.tabId)
    }
    // Aborted (the tab is gone or another sign-in followed) or the network failed: not checked.
    if (count === null || abort.signal.aborted) return
    if (!this.browser.tabs.tab(candidate.tabId)) return
    const now = Date.now()
    // The save prompt may have been answered, or the vault opened, while the lookup ran.
    const saved = this.saved(candidate)
    if (saved && (saved.leakWarnedAt !== null || saved.leakIgnoredAt !== null)) {
      // Warned or ignored meanwhile (another tab): only the count is news.
      if (!isPrivate) this.store.recordLeak(saved.id, { breached: count }, now)
      return
    }
    const credentialId = saved && !isPrivate ? saved.id : null
    if (credentialId) {
      this.store.recordLeak(
        credentialId,
        { breached: count, ...(count > 0 ? { leakWarnedAt: now } : {}) },
        now
      )
    } else if (!isPrivate) {
      this.results.set(candidate.tabId, {
        origin: candidate.origin,
        username: candidate.username,
        password: candidate.password,
        count,
        at: now
      })
    }
    if (count > 0) {
      this.warnings.set(candidate.tabId, {
        id: newId('leak'),
        tabId: candidate.tabId,
        origin: candidate.origin,
        site: siteLabel(candidate.origin),
        username: candidate.username,
        breachCount: count,
        credentialId,
        private: isPrivate
      })
    }
    this.onChange()
  }

  private saved(candidate: LeakCandidate): Credential | null {
    if (!this.store.unlocked()) return null
    return savedLoginFor(candidate, this.store.findForOrigin(candidate.origin))
  }

  /**
   * The autofill service saved or updated a login from a judged sign-in: a result the check
   * reached for the same credentials before the prompt was answered is recorded on it now, and
   * the tab's warning is remembered on it (Ignore then sticks).
   */
  onSaved(credential: Credential, candidate: LeakCandidate): void {
    const result = this.results.get(candidate.tabId)
    if (!result) return
    if (
      result.origin !== candidate.origin ||
      result.password !== credential.password ||
      Date.now() - result.at > RESULT_TTL_MS
    )
      return
    this.results.delete(candidate.tabId)
    if (!this.store.unlocked()) return
    this.store.recordLeak(
      credential.id,
      { breached: result.count, ...(result.count > 0 ? { leakWarnedAt: result.at } : {}) },
      result.at
    )
    const warning = this.warnings.get(candidate.tabId)
    if (warning && warning.origin === candidate.origin && warning.credentialId === null) {
      this.warnings.set(candidate.tabId, { ...warning, credentialId: credential.id })
      this.onChange()
    }
  }

  /** The user answered a warning (`passwords.leakRespond`). */
  async respond(id: string, action: CredentialLeakAction, win?: ZenWindow): Promise<void> {
    const warning = this.active().find((w) => w.id === id)
    if (!warning) return
    this.warnings.delete(warning.tabId)
    this.onChange()
    switch (action) {
      case 'ignore':
        if (warning.credentialId && this.store.unlocked())
          this.store.recordLeak(warning.credentialId, { leakIgnoredAt: Date.now() })
        return
      case 'openManager':
        this.browser.pages.open('settings', 'autofill', win ?? this.windowOf(warning.tabId))
        return
      case 'changePassword': {
        const url = await this.track(
          changePasswordUrl(warning.origin, (probe) => this.answers(probe))
        )
        if (!this.browser.tabs.tab(warning.tabId)) return
        this.browser.tabs.navigate(warning.tabId, url, { transition: 'link' })
        return
      }
      case 'dismiss':
        return
    }
  }

  /** The tab committed a navigation: a warning about a site the tab has left goes (Chrome's rule). */
  onNavigated(tabId: string): void {
    const warning = this.warnings.get(tabId)
    const tab = this.browser.tabs.tab(tabId)
    if (!warning || !tab) return
    const origin = normalizeOrigin(tab.url)
    if (origin && sameSite(origin, warning.origin)) return
    this.warnings.delete(tabId)
    this.results.delete(tabId)
    this.onChange()
  }

  onTabGone(tabId: string): void {
    this.aborts.get(tabId)?.abort()
    this.aborts.delete(tabId)
    this.results.delete(tabId)
    if (this.warnings.delete(tabId)) this.onChange()
  }

  /** The vault locked or was reset: no warning can be remembered any more; the pending results go. */
  onLocked(): void {
    this.results.clear()
  }

  private async answers(url: string): Promise<boolean> {
    const response = await this.browser.platform.net.fetchText(url, {
      timeoutMs: CHANGE_PASSWORD_PROBE_MS
    })
    return response.ok
  }

  private windowOf(tabId: string): ZenWindow | undefined {
    try {
      return this.browser.tabs.windowFor(tabId)
    } catch {
      return undefined
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work)
    void work.finally(() => this.inflight.delete(work)).catch(() => undefined)
    return work
  }
}

/** The same registrable domain (or the same host when there is none: an intranet name, an IP). */
function sameSite(a: string, b: string): boolean {
  if (a === b) return true
  const da = domainOf(a)
  const db = domainOf(b)
  if (da && db) return da === db
  return siteLabel(a) === siteLabel(b)
}

/**
 * The checkup summary with `compromised` read off the open vault (the logins known breached
 * whose warning was not ignored); the rest as it was.
 */
export function withLiveCompromised(
  summary: CheckupSummary,
  store: Pick<CredentialStore, 'unlocked' | 'compromisedCount'>
): CheckupSummary {
  if (!store.unlocked()) return summary
  const compromised = store.compromisedCount()
  return compromised === summary.compromised ? summary : { ...summary, compromised }
}
