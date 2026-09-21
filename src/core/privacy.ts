import {
  BROWSING_DATA_ADVANCED,
  DEFAULT_CONTAINER_ID,
  PRIVATE_CONTAINER_ID,
  type BrowsingDataCount,
  type BrowsingDataRange,
  type BrowsingDataType,
  type ClearBrowsingDataResult,
  type ExtensionInfo,
  type PasswordsStatus,
  type PermissionRule,
  type ReauthOutcome,
  type SafetyCheckResult,
  type SafetyCheckRow,
  type SafetyState
} from '../shared/types'
import type { UpdateStatus } from '../shared/updates'
import { contentSetting } from '../shared/contentSettings'
import type { Browser } from './browser'
import type { EngineDataCounts } from './platform'
import type { ZenWindow } from './window'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Chrome's "Last 4 weeks". */
const MONTH_MS = 28 * DAY_MS

/** Safety check: a site with this many granted permissions is worth a look. */
export const MANY_PERMISSIONS = 3
/** Safety check: a granted permission on a site not visited for this long is unused (Chrome: 60 days). */
export const UNUSED_PERMISSION_MS = 60 * DAY_MS

/** Where a browsing-data range starts, given the moment it is measured from. */
export function rangeStart(range: BrowsingDataRange, now: number): number {
  switch (range) {
    case 'hour':
      return now - HOUR_MS
    case 'day':
      return now - DAY_MS
    case 'week':
      return now - 7 * DAY_MS
    case 'month':
      return now - MONTH_MS
    case 'all':
      return 0
  }
}

/** Ranges close at the far end so a visit stamped a moment ahead of the clock still goes. */
const RANGE_END = Number.MAX_SAFE_INTEGER

const NO_FORM_DATA = 'Zenium does not save form entries, addresses or payment methods'
const VAULT_LOCKED = 'Unlock the password vault to count and clear saved passwords'
const NO_VAULT = 'This device has no password vault'

/**
 * Clear browsing data and Safety check: the two privacy tools of Settings, over the services
 * that own each kind of data. History goes through the history service's range commands (the
 * history page invokes `privacy.clearBrowsingData` with the same ranges); cookies, storage and
 * cache go to the engine per container; passwords need the vault's re-authentication first,
 * and when that fails nothing at all is cleared.
 */
export class PrivacyService {
  constructor(
    private readonly browser: Browser,
    private readonly now: () => number = Date.now
  ) {}

  /** How much of each type the range holds, in the order the dialog lists them. */
  async counts(range: BrowsingDataRange): Promise<BrowsingDataCount[]> {
    const now = this.now()
    const from = rangeStart(range, now)
    const engine = await this.engineCounts()
    return BROWSING_DATA_ADVANCED.map((type) => this.countOf(type, from, engine))
  }

  private countOf(
    type: BrowsingDataType,
    from: number,
    engine: EngineDataCounts | null
  ): BrowsingDataCount {
    const b = this.browser
    switch (type) {
      case 'history':
        return count(type, b.history.count(from, RANGE_END), 'visits', true)
      case 'cookies':
        return count(type, engine?.cookieSites ?? null, 'sites', false)
      case 'cache':
        return count(type, engine?.cacheBytes ?? null, 'bytes', false)
      case 'downloads':
        return count(type, b.downloads.finishedInRange(from, RANGE_END).length, 'downloads', true)
      case 'passwords': {
        if (!b.state.capabilities.passwords) return count(type, null, 'logins', true, NO_VAULT)
        if (b.passwords.status().locked) return count(type, null, 'logins', true, VAULT_LOCKED)
        const saved = b.passwords.list().filter((c) => c.createdAt >= from).length
        return count(type, saved, 'logins', true)
      }
      case 'autofill':
        return count(type, null, 'entries', false, NO_FORM_DATA)
      case 'sitePermissions':
        return count(type, b.permissions.rules().length, 'permissions', false)
      case 'recentlyClosed':
        return count(type, b.state.recentlyClosed.length, 'entries', false)
    }
  }

  private async engineCounts(): Promise<EngineDataCounts | null> {
    const sessions = this.browser.platform.sessions
    if (!sessions.browsingDataCounts) return null
    try {
      return await sessions.browsingDataCounts(this.containerIds())
    } catch {
      return null
    }
  }

  /** Every persistent container; the private session is wiped when its last window or tab closes. */
  private containerIds(): string[] {
    const ids = new Set<string>([DEFAULT_CONTAINER_ID])
    for (const container of this.browser.state.model.containers) ids.add(container.id)
    ids.delete(PRIVATE_CONTAINER_ID)
    return [...ids]
  }

  /**
   * Clear the chosen types. Passwords are cleared first and only after re-authentication;
   * a refused or pending re-authentication clears nothing and is reported as the outcome.
   */
  async clearBrowsingData(
    range: BrowsingDataRange,
    types: BrowsingDataType[],
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<ClearBrowsingDataResult>> {
    const b = this.browser
    const now = this.now()
    const from = rangeStart(range, now)
    const chosen = new Set(types)
    const cleared: BrowsingDataType[] = []
    if (chosen.has('passwords')) {
      if (!b.state.capabilities.passwords) return { status: 'denied', reason: NO_VAULT }
      const outcome = await b.passwords.removeInRange(from, RANGE_END, passphrase, win)
      if (outcome.status !== 'ok') return outcome
      // Credentials the engine cached for HTTP authentication go with the saved ones.
      b.security.forgetSession()
      await quiet(b.platform.sessions.clearAuthCache?.())
      cleared.push('passwords')
    }
    if (chosen.has('history')) {
      // The omnibox's learned shortcuts go with the history they were learned from: all of them
      // with all of it (through the history service's clear), the range's with the range.
      if (range === 'all') b.history.clear()
      else {
        b.history.deleteRange(from, RANGE_END)
        b.omniboxShortcuts.forgetRange(from, RANGE_END)
      }
      cleared.push('history')
    }
    const engineKinds: Array<'cookies' | 'storage' | 'cache'> = []
    if (chosen.has('cookies')) engineKinds.push('cookies', 'storage')
    if (chosen.has('cache')) engineKinds.push('cache')
    if (engineKinds.length > 0) {
      const sessions = b.platform.sessions
      if (sessions.clearBrowsingData) {
        await quiet(sessions.clearBrowsingData(this.containerIds(), engineKinds))
      } else {
        // Hosts without the granular call drop everything of every container.
        for (const id of this.containerIds()) await quiet(sessions.clearContainerData(id))
      }
      // Site data gone, certificate decisions gone: as Chrome resets them with the cookies.
      if (chosen.has('cookies'))
        for (const id of this.containerIds()) b.security.certificateExceptions.forgetContainer(id)
      if (chosen.has('cookies')) cleared.push('cookies')
      if (chosen.has('cache')) cleared.push('cache')
    }
    if (chosen.has('downloads')) {
      b.downloads.removeFinishedInRange(from, RANGE_END)
      cleared.push('downloads')
    }
    if (chosen.has('sitePermissions')) {
      b.permissions.resetSites()
      cleared.push('sitePermissions')
    }
    if (chosen.has('recentlyClosed')) {
      b.session.clearRecentlyClosed()
      cleared.push('recentlyClosed')
    }
    b.state.commitVolatile()
    return { status: 'ok', value: { cleared } }
  }

  /** The last run's result, which `UIState.lastSafetyCheck` carries; null before the first run. */
  private lastCheck: SafetyCheckResult | null = null

  lastSafetyCheck(): SafetyCheckResult | null {
    return this.lastCheck
  }

  /**
   * `privacy.safetyCheck`: run the check, keep the result for the state (the phone Settings rows
   * read it there, the desktop pane reads the return) and push it to every window.
   */
  runSafetyCheck(): SafetyCheckResult {
    const result = this.safetyCheck()
    this.lastCheck = result
    this.browser.state.commitVolatile()
    return result
  }

  /** Safety check over the live services; the composition itself is pure (`composeSafetyCheck`). */
  safetyCheck(): SafetyCheckResult {
    const b = this.browser
    const lastVisit = new Map<string, number>()
    for (const entry of b.history.recent(Number.MAX_SAFE_INTEGER)) {
      const origin = originOf(entry.url)
      if (!origin) continue
      const seen = lastVisit.get(origin)
      if (seen === undefined || seen < entry.lastVisit) lastVisit.set(origin, entry.lastVisit)
    }
    return composeSafetyCheck({
      now: this.now(),
      updates: b.state.capabilities.updates ? b.updates.status() : null,
      safeBrowsing: readSafeBrowsingSetting(b.state.settings),
      passwords: b.state.capabilities.passwords ? b.passwords.status() : null,
      rules: b.permissions.rules(),
      lastVisitByOrigin: lastVisit,
      notificationsShown: b.permissions.activity('notifications'),
      extensions: b.state.capabilities.extensions ? b.extensions.list() : null
    })
  }
}

function count(
  type: BrowsingDataType,
  value: number | null,
  unit: BrowsingDataCount['unit'],
  rangeApplies: boolean,
  unavailable: string | null = null
): BrowsingDataCount {
  return { type, count: value, unit, rangeApplies, unavailable }
}

async function quiet(promise: Promise<unknown> | undefined): Promise<void> {
  try {
    await promise
  } catch {
    // Best effort: an engine that fails to clear one kind must not stop the rest.
  }
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Safety check composition
// ---------------------------------------------------------------------------

export interface SafeBrowsingReading {
  /** The Safe Browsing setting exists in this build. */
  configured: boolean
  enabled: boolean | null
}

/**
 * The Safe Browsing switch as another package defines it (`settings.safeBrowsing.enabled`, or a
 * plain boolean). Read structurally so this file needs no knowledge of that package's model and
 * reports "not configured" until it is there.
 */
export function readSafeBrowsingSetting(settings: unknown): SafeBrowsingReading {
  if (!settings || typeof settings !== 'object' || !('safeBrowsing' in settings))
    return { configured: false, enabled: null }
  const value = (settings as { safeBrowsing: unknown }).safeBrowsing
  if (typeof value === 'boolean') return { configured: true, enabled: value }
  if (value && typeof value === 'object') {
    const inner = value as { enabled?: unknown; level?: unknown; mode?: unknown }
    if (typeof inner.enabled === 'boolean') return { configured: true, enabled: inner.enabled }
    const mode = inner.level ?? inner.mode
    if (typeof mode === 'string') return { configured: true, enabled: mode !== 'off' }
  }
  return { configured: false, enabled: null }
}

export interface SafetyCheckInput {
  now: number
  /** Null when the host has no updater. */
  updates: UpdateStatus | null
  safeBrowsing: SafeBrowsingReading
  /** Null when the host has no password manager. */
  passwords: PasswordsStatus | null
  rules: PermissionRule[]
  lastVisitByOrigin: Map<string, number>
  notificationsShown: Array<{ origin: string; count: number }>
  /** Null when the host runs no extensions. */
  extensions: ExtensionInfo[] | null
}

/** Pure: every row of Safety check from the facts the services report. */
export function composeSafetyCheck(input: SafetyCheckInput): SafetyCheckResult {
  return {
    checkedAt: input.now,
    updates: updatesRow(input.updates),
    safeBrowsing: safeBrowsingRow(input.safeBrowsing),
    passwords: passwordsRow(input.passwords),
    permissions: permissionsRow(input.rules, input.lastVisitByOrigin, input.now),
    notifications: notificationsRow(input.rules, input.notificationsShown),
    extensions: extensionsRow(input.extensions)
  }
}

function row(state: SafetyState, summary: string): SafetyCheckRow {
  return { state, summary }
}

function updatesRow(status: UpdateStatus | null): SafetyCheckResult['updates'] {
  if (!status)
    return {
      ...row('unavailable', 'This build does not check for updates'),
      currentVersion: '',
      latestVersion: null
    }
  const latest = status.release?.version ?? null
  const base = { currentVersion: status.currentVersion, latestVersion: latest }
  switch (status.phase) {
    case 'up-to-date':
      return { ...row('safe', `Zenium is up to date (${status.currentVersion})`), ...base }
    case 'available':
    case 'downloading':
      return { ...row('warning', `Zenium ${latest ?? ''} is available`.trim()), ...base }
    case 'ready':
      return {
        ...row('warning', `Zenium ${latest ?? ''} is ready to install; restart to finish`.trim()),
        ...base
      }
    case 'error':
      return { ...row('info', status.error ?? 'Zenium could not check for updates'), ...base }
    case 'checking':
      return { ...row('info', 'Checking for updates'), ...base }
    case 'idle':
      return {
        ...row(
          'info',
          status.mode === 'manual'
            ? 'This installation is updated by hand; check the release page'
            : 'Zenium has not checked for updates yet'
        ),
        ...base
      }
  }
}

function safeBrowsingRow(reading: SafeBrowsingReading): SafetyCheckResult['safeBrowsing'] {
  const base = { configured: reading.configured, enabled: reading.enabled }
  if (!reading.configured)
    return { ...row('unavailable', 'Safe Browsing is not configured in this build'), ...base }
  return reading.enabled
    ? { ...row('safe', 'Safe Browsing is on'), ...base }
    : { ...row('warning', 'Safe Browsing is off'), ...base }
}

/**
 * The Passwords row reads the device's checkup summary (`PasswordsStatus.checkupSummary`: the
 * last Password Checkup's counts and time, kept outside the vault, with `compromised` kept live
 * by the sign-in leak check), so it costs no request and speaks while the vault is locked. A
 * login a sign-in flagged before any checkup ran shows as compromised, and the row still says
 * the checkup never ran (`checkedAt: null`) so the chrome offers to run it.
 */
function passwordsRow(status: PasswordsStatus | null): SafetyCheckResult['passwords'] {
  const none = { compromised: 0, weak: 0, reused: 0, known: false, checkedAt: null }
  if (!status) return { ...row('unavailable', 'This device has no password vault'), ...none }
  const summary = status.checkupSummary
  const counts = { ...summary, known: true }
  if (status.locked) {
    if (summary.checkedAt === null && summary.compromised === 0)
      return { ...row('info', 'Unlock the password vault to check your passwords'), ...none }
  } else if (status.count === 0)
    return { ...row('safe', 'No saved passwords'), ...none, known: true }
  if (summary.compromised > 0)
    return {
      ...row(
        'warning',
        `${plural(summary.compromised, 'compromised password')} found; change them now`
      ),
      ...counts
    }
  if (summary.checkedAt === null)
    return { ...row('info', 'Run Password Checkup to look for compromised passwords'), ...none }
  if (summary.weak > 0 || summary.reused > 0) {
    const parts: string[] = []
    if (summary.weak > 0) parts.push(plural(summary.weak, 'weak password'))
    if (summary.reused > 0) parts.push(plural(summary.reused, 'reused password'))
    return { ...row('info', parts.join(', ')), ...counts }
  }
  // The run in this session left logins unchecked (network): neither safe nor compromised.
  const unchecked = status.checkup.finishedAt === null ? 0 : status.checkup.unchecked.length
  if (unchecked > 0)
    return { ...row('info', `${plural(unchecked, 'password')} could not be checked`), ...counts }
  return { ...row('safe', 'No compromised passwords found'), ...counts }
}

/** Rows of the catalogue that grant a site a capability (not the content rows: ads, pop-ups). */
function isCapability(permission: string): boolean {
  const group = contentSetting(permission)?.group
  return group === 'permissions' || group === 'additional'
}

function permissionsRow(
  rules: PermissionRule[],
  lastVisit: Map<string, number>,
  now: number
): SafetyCheckResult['permissions'] {
  const granted = new Map<string, string[]>()
  for (const rule of rules) {
    if (rule.decision !== 'allow' || !isCapability(rule.permission)) continue
    const list = granted.get(rule.origin) ?? []
    list.push(rule.permission)
    granted.set(rule.origin, list)
  }
  const review: SafetyCheckResult['permissions']['review'] = []
  for (const [origin, permissions] of granted) {
    const seen = lastVisit.get(origin)
    if (seen !== undefined && now - seen > UNUSED_PERMISSION_MS)
      review.push({ origin, permissions, reason: 'unused' })
    else if (permissions.length >= MANY_PERMISSIONS)
      review.push({ origin, permissions, reason: 'many' })
  }
  review.sort((a, b) => b.permissions.length - a.permissions.length || cmp(a.origin, b.origin))
  const base = { grantedSites: granted.size, review }
  if (granted.size === 0) return { ...row('safe', 'No site holds extra permissions'), ...base }
  if (review.length === 0)
    return {
      ...row('safe', `${plural(granted.size, 'site')} with permissions you granted`),
      ...base
    }
  return {
    ...row(
      'info',
      `${plural(review.length, 'site')} worth a look: unused permissions or several at once`
    ),
    ...base
  }
}

function notificationsRow(
  rules: PermissionRule[],
  shown: Array<{ origin: string; count: number }>
): SafetyCheckResult['notifications'] {
  const counts = new Map(shown.map((entry) => [entry.origin, entry.count]))
  const sites = rules
    .filter((rule) => rule.permission === 'notifications' && rule.decision === 'allow')
    .map((rule) => ({ origin: rule.origin, shown: counts.get(rule.origin) ?? 0 }))
    .sort((a, b) => b.shown - a.shown || cmp(a.origin, b.origin))
  if (sites.length === 0) return { ...row('safe', 'No site may send notifications'), sites }
  const busy = sites.filter((site) => site.shown > 0).length
  return {
    ...row(
      'info',
      busy > 0
        ? `${plural(sites.length, 'site')} may send notifications; ${busy} did this session`
        : `${plural(sites.length, 'site')} may send notifications`
    ),
    sites
  }
}

function extensionsRow(extensions: ExtensionInfo[] | null): SafetyCheckResult['extensions'] {
  if (!extensions) return { ...row('unavailable', 'This host runs no extensions'), flagged: [] }
  const flagged: SafetyCheckResult['extensions']['flagged'] = []
  for (const ext of extensions) {
    const reasons: string[] = []
    if (ext.error) reasons.push(`Could not be loaded: ${ext.error}`)
    if (ext.pendingWarnings && ext.pendingWarnings.length > 0)
      reasons.push('An update asks for new permissions')
    if (ext.publisher === null && ext.source !== 'unpacked')
      reasons.push('Not signed by a known store')
    if (ext.updateState === 'error' && ext.updateError) reasons.push(ext.updateError)
    if (reasons.length > 0) flagged.push({ id: ext.id, name: ext.name, reasons })
  }
  if (extensions.length === 0) return { ...row('safe', 'No extensions installed'), flagged }
  if (flagged.length === 0)
    return { ...row('safe', `${plural(extensions.length, 'extension')} without warnings`), flagged }
  return { ...row('warning', `${plural(flagged.length, 'extension')} to review`), flagged }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
