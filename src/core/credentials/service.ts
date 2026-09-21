import type {
  CheckupState,
  CheckupSummary,
  Credential,
  CredentialLeakAction,
  CredentialSummary,
  GeneratorOptions,
  ImportConflict,
  ImportResult,
  PasskeyEntry,
  PasswordsStatus,
  ReauthOutcome
} from '../../shared/types'
import { emptyCheckupSummary, sanitizePasswordsDevice } from '../../shared/types'
import { emptyCheckupState } from '../../shared/defaults'
import type { Browser } from '../browser'
import { KeyWrapError } from '../platform'
import type { KeyWrapHost, PasswordsHost, ReauthHost } from '../platform'
import type { ZenWindow } from '../window'
import {
  HIBP_RANGE_URL,
  RANGE_TIMEOUT_MS,
  passphraseWordlist,
  runCheckup,
  zxcvbnScorer
} from './checkup'
import { SensitiveClipboard } from './clipboard'
import { parseImport, toChromeCsv } from './csv'
import { clearsInLabel } from './fill'
import { generatePassphrase, generatePassword } from './generator'
import { PBKDF2_PARAMS, deriveWithWebCrypto } from './kdf'
import { LeakDetector, withLiveCompromised } from './leak'
import { domainOf, siteLabel } from './origins'
import { describeRules, parsePasswordRules, rulesForHost } from './rules'
import { CredentialStore } from './store'
import { VaultError } from './vault'

/** How long a deleted login can be brought back. */
const UNDO_WINDOW_MS = 60_000
/** Checkup progress broadcasts are rate-limited to this many milliseconds apart. */
const PROGRESS_INTERVAL_MS = 120

/** Hosts without a keystore: passphrase-only vaults, no OS re-authentication. */
export class NoopKeyWrap implements KeyWrapHost {
  async osAvailable(): Promise<boolean> {
    return false
  }
  async wrap(): Promise<string> {
    throw new KeyWrapError('unavailable', 'No OS keystore on this host')
  }
  async unwrap(): Promise<Uint8Array> {
    throw new KeyWrapError('unavailable', 'No OS keystore on this host')
  }
  kdfParams(): typeof PBKDF2_PARAMS {
    return PBKDF2_PARAMS
  }
  deriveKey(
    passphrase: string,
    salt: Uint8Array,
    params: typeof PBKDF2_PARAMS
  ): Promise<Uint8Array> {
    return deriveWithWebCrypto(passphrase, salt, params)
  }
}

export class NoopReauth implements ReauthHost {
  async available(): Promise<boolean> {
    return false
  }
  async verify(): Promise<boolean> {
    return false
  }
}

/**
 * The password manager behind the chrome's `passwords.*` commands: owns the `CredentialStore`,
 * gates secrets behind re-authentication (OS prompt, else the vault passphrase) with a grace
 * period, runs the checkup, and does CSV import / export through the host's dialogs. Everything
 * the UI shows is one `PasswordsStatus` in the UI state plus `passwords.list`.
 */
export class PasswordService {
  readonly store: CredentialStore
  /** Copies of passwords and card numbers go through here (sensitive flag, timed clearing). */
  readonly clipboard: SensitiveClipboard
  /** The sign-in leak check and its warnings (ID-31). */
  readonly leaks: LeakDetector
  private readonly host: PasswordsHost
  private checkup: CheckupState = emptyCheckupState()
  private checkupAbort: AbortController | null = null
  private lastProgressAt = 0
  private lastReauthAt = 0
  private removed = new Map<
    string,
    { credential: Credential; timer: ReturnType<typeof setTimeout> }
  >()
  private revision = 0
  private osKeystore = false
  private osReauth = false
  private unlockError: string | null = null

  constructor(
    private readonly browser: Browser,
    host: PasswordsHost | undefined
  ) {
    this.host = host ?? { keys: new NoopKeyWrap(), reauth: new NoopReauth() }
    this.clipboard = new SensitiveClipboard(browser.platform.clipboard)
    this.store = new CredentialStore(browser.platform.io, this.host.keys)
    this.store.onChange = () => this.bump()
    this.leaks = new LeakDetector(browser, this.store, (prefix, signal) =>
      this.fetchRange(prefix, signal)
    )
    this.leaks.onChange = () => this.bump()
    this.store.loadSync()
    const error = this.store.error()
    if (error) this.unlockError = error.message
  }

  /** Probe the host and open an OS-protected vault silently (no prompt at startup). */
  /** `start()`'s probes and unlock, still running or finished (see `whenSettled`). */
  private starting: Promise<void> = Promise.resolve()

  /**
   * Resolves once `start()` has probed the OS keystore and re-authentication and, where the
   * store is OS-protected, tried the unlock. Tests and demo drivers wait on this rather than
   * guessing how many ticks the keystore's crypto takes.
   */
  whenSettled(): Promise<void> {
    return this.starting
  }

  start(): void {
    this.starting = (async () => {
      this.osKeystore = await this.host.keys.osAvailable().catch(() => false)
      this.osReauth = await this.host.reauth.available().catch(() => false)
      if (this.store.exists() && this.store.protection().os && !this.store.unlocked()) {
        try {
          await this.store.unlock(undefined, false)
        } catch {
          // Locked until the user opens the manager; the status says how to unlock.
        }
      }
      this.bump()
    })()
  }

  status(): PasswordsStatus {
    return {
      locked: !this.store.unlocked(),
      protection: this.store.protection(),
      osKeystore: this.osKeystore,
      osReauth: this.osReauth,
      count: this.store.count(),
      neverSave: this.store.neverSaveList(),
      revision: this.revision,
      error: this.unlockError,
      checkup: this.checkup,
      checkupSummary: this.checkupSummary(),
      leaks: this.leaks.active()
    }
  }

  /**
   * The last Password Checkup's counts and time, this device's (`state.passwordsDevice`, kept
   * outside the vault so Safety Check reads it locked). While the vault is open `compromised`
   * is the live count of logins known breached and not ignored, which the sign-in leak check
   * raises without a checkup; the summary is written back when that count moved.
   */
  checkupSummary(): CheckupSummary {
    return withLiveCompromised(this.browser.state.passwordsDevice.checkupSummary, this.store)
  }

  /** Write the summary back when the live compromised count moved (a store change, a warning). */
  private refreshSummary(): void {
    const stored = this.browser.state.passwordsDevice.checkupSummary
    const live = withLiveCompromised(stored, this.store)
    if (live !== stored) this.writeSummary(live)
  }

  private writeSummary(summary: CheckupSummary): void {
    const { state } = this.browser
    state.passwordsDevice = sanitizePasswordsDevice({
      ...state.passwordsDevice,
      checkupSummary: summary
    })
    state.commit()
  }

  /** The chrome answered a sign-in leak warning. */
  leakRespond(id: string, action: CredentialLeakAction, win?: ZenWindow): Promise<void> {
    return this.leaks.respond(id, action, win)
  }

  /** Persist now (also when a mobile host is backgrounded: a copied secret stays for pasting). */
  flushSync(): void {
    this.store.flushSync()
  }

  /** The app quits: a secret still waiting for its clearing timer leaves the clipboard now. */
  shutdown(): void {
    void this.clipboard.flush()
  }

  // ---------------------------------------------------------------------------
  // Lock state
  // ---------------------------------------------------------------------------

  async unlock(passphrase?: string): Promise<ReauthOutcome<null>> {
    if (this.store.unlocked()) return { status: 'ok', value: null }
    if (this.store.error()) return { status: 'denied' }
    if (!this.store.exists()) {
      const os = await this.host.keys.osAvailable().catch(() => false)
      if (!os && passphrase === undefined) return { status: 'setup-passphrase' }
    }
    try {
      await this.store.unlock(passphrase, true)
    } catch (error) {
      if (error instanceof VaultError) {
        if (error.code === 'locked')
          return this.store.protection().passphrase || !this.store.exists()
            ? { status: passphrase === undefined ? 'passphrase' : 'denied' }
            : { status: 'denied' }
        if (error.code === 'wrong-key') return { status: 'denied' }
        this.unlockError = error.message
        this.bump()
        return { status: 'denied' }
      }
      // The OS keystore refused. A passphrase wrapping is still a way in; otherwise a dismissed
      // prompt or a keystore that is unusable right now is only "try again", and just a key the
      // device has invalidated for good makes the vault unreadable (`status.error`, the reset).
      if (this.store.protection().passphrase) return { status: 'passphrase' }
      const reason = error instanceof Error ? error.message : String(error)
      if (error instanceof KeyWrapError && error.code === 'invalidated') {
        this.unlockError = reason
        this.bump()
      }
      return { status: 'denied', reason }
    }
    if (passphrase !== undefined) this.lastReauthAt = Date.now()
    this.unlockError = null
    this.bump()
    return { status: 'ok', value: null }
  }

  lock(): void {
    this.cancelCheckup()
    this.lastReauthAt = 0
    this.leaks.onLocked()
    this.store.lock()
  }

  async reset(): Promise<void> {
    this.cancelCheckup()
    this.checkup = emptyCheckupState()
    this.unlockError = null
    this.leaks.onLocked()
    await this.store.reset()
    // The summary described the vault that is gone.
    this.writeSummary(emptyCheckupSummary())
    this.bump()
  }

  async setPassphrase(
    passphrase: string,
    current: string | undefined,
    win?: ZenWindow
  ): Promise<ReauthOutcome<null>> {
    if (!this.store.unlocked()) return { status: 'denied' }
    if (passphrase.length < 8) return { status: 'denied' }
    if (this.store.protection().passphrase) {
      const gate = await this.reauth('Change the vault passphrase', current, win)
      if (gate.status !== 'ok') return gate
    }
    await this.store.setPassphrase(passphrase)
    this.lastReauthAt = Date.now()
    return { status: 'ok', value: null }
  }

  // ---------------------------------------------------------------------------
  // Re-authentication
  // ---------------------------------------------------------------------------

  /**
   * Verify the user before a secret is handed out. Order: the grace period, a passphrase supplied
   * with the command, the OS prompt; otherwise tell the chrome which passphrase step it needs.
   */
  private async reauth(
    reason: string,
    passphrase: string | undefined,
    win?: ZenWindow
  ): Promise<ReauthOutcome<null>> {
    const graceMs = this.browser.state.settings.passwords.reauthGraceSeconds * 1000
    if (this.lastReauthAt && Date.now() - this.lastReauthAt < graceMs)
      return { status: 'ok', value: null }
    if (passphrase !== undefined) {
      if (await this.store.verifyPassphrase(passphrase)) {
        this.lastReauthAt = Date.now()
        return { status: 'ok', value: null }
      }
      return { status: 'denied' }
    }
    if (this.osReauth) {
      const ok = await this.host.reauth.verify(reason, win).catch(() => false)
      if (ok) {
        this.lastReauthAt = Date.now()
        return { status: 'ok', value: null }
      }
      // The prompt failed or was dismissed; the passphrase remains a way in when there is one.
      return this.store.protection().passphrase ? { status: 'passphrase' } : { status: 'denied' }
    }
    return this.store.protection().passphrase
      ? { status: 'passphrase' }
      : { status: 'setup-passphrase' }
  }

  /** The re-authentication gate for other services (in-page fill of passwords and cards). */
  authorize(reason: string, passphrase?: string, win?: ZenWindow): Promise<ReauthOutcome<null>> {
    return this.reauth(reason, passphrase, win)
  }

  /** A re-authentication right now would have to ask for the vault passphrase in the chrome. */
  wouldAskPassphrase(): boolean {
    const graceMs = this.browser.state.settings.passwords.reauthGraceSeconds * 1000
    if (this.lastReauthAt && Date.now() - this.lastReauthAt < graceMs) return false
    return !this.osReauth && this.store.protection().passphrase
  }

  /**
   * Put a secret on the clipboard marked sensitive and say so; it is cleared again after the
   * configured timeout when the host can clear (`what`: "Password", "Card number").
   */
  copySecret(text: string, what: string, win?: ZenWindow): void {
    const seconds = this.clipboard.copy(
      text,
      this.browser.state.settings.passwords.clipboardClearSeconds
    )
    this.browser.toast(
      seconds > 0 ? `${what} copied, clears in ${clearsInLabel(seconds)}` : `${what} copied`,
      'info',
      win
    )
  }

  // ---------------------------------------------------------------------------
  // Logins
  // ---------------------------------------------------------------------------

  list(query = ''): CredentialSummary[] {
    if (!this.store.unlocked()) return []
    const favicons = this.browser.history.faviconsByDomain()
    return this.store.search(query).map((c) => this.summary(c, favicons))
  }

  private summary(c: Credential, favicons?: Map<string, string>): CredentialSummary {
    const domain = domainOf(c.origin)
    const icons = favicons ?? this.browser.history.faviconsByDomain()
    return {
      id: c.id,
      origin: c.origin,
      url: c.url,
      username: c.username,
      realm: c.realm,
      notes: c.notes,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastUsedAt: c.lastUsedAt,
      breached: c.breached,
      checkedAt: c.checkedAt,
      leakWarnedAt: c.leakWarnedAt,
      leakIgnoredAt: c.leakIgnoredAt,
      domain: domain || siteLabel(c.origin),
      favicon: icons.get(domain) ?? null
    }
  }

  async reveal(id: string, passphrase?: string, win?: ZenWindow): Promise<ReauthOutcome<string>> {
    const credential = this.store.get(id)
    if (!credential) return { status: 'denied' }
    const gate = await this.reauth(
      `Show the password for ${siteLabel(credential.origin)}`,
      passphrase,
      win
    )
    if (gate.status !== 'ok') return gate
    return { status: 'ok', value: credential.password }
  }

  async copy(
    id: string,
    field: 'username' | 'password',
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<null>> {
    const credential = this.store.get(id)
    if (!credential) return { status: 'denied' }
    if (field === 'password') {
      const gate = await this.reauth(
        `Copy the password for ${siteLabel(credential.origin)}`,
        passphrase,
        win
      )
      if (gate.status !== 'ok') return gate
      this.copySecret(credential.password, 'Password', win)
      return { status: 'ok', value: null }
    }
    this.browser.platform.clipboard.writeText(credential.username)
    this.browser.toast('Username copied', 'info', win)
    return { status: 'ok', value: null }
  }

  add(input: {
    url: string
    username: string
    password: string
    notes?: string
  }): CredentialSummary {
    return this.summary(this.store.add(input))
  }

  update(
    id: string,
    patch: Partial<Pick<Credential, 'url' | 'username' | 'password' | 'notes'>>
  ): CredentialSummary | null {
    const credential = this.store.update(id, patch)
    return credential ? this.summary(credential) : null
  }

  remove(id: string, win?: ZenWindow): void {
    const credential = this.store.remove(id)
    if (!credential) return
    const timer = setTimeout(() => this.removed.delete(id), UNDO_WINDOW_MS)
    this.removed.set(id, { credential, timer })
    this.browser.emit('passwords.removed', { id, site: siteLabel(credential.origin) }, win)
  }

  restore(id: string): boolean {
    const entry = this.removed.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.removed.delete(id)
    return this.store.restore(entry.credential)
  }

  /**
   * Clear browsing data: forget every login saved in `[fromMs, toMs)` after re-authentication;
   * resolves with how many went. A locked vault is refused (nothing to check the user against).
   */
  async removeInRange(
    fromMs: number,
    toMs: number,
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<number>> {
    if (!this.store.unlocked())
      return { status: 'denied', reason: 'Unlock the password vault first' }
    const gate = await this.reauth('Clear saved passwords', passphrase, win)
    if (gate.status !== 'ok') return gate
    const gone = this.store.list().filter((c) => c.createdAt >= fromMs && c.createdAt < toMs)
    for (const credential of gone) this.store.remove(credential.id)
    return { status: 'ok', value: gone.length }
  }

  neverSaveAdd(domain: string): void {
    this.store.neverSaveAdd(domain)
  }

  neverSaveRemove(domain: string): void {
    this.store.neverSaveRemove(domain)
  }

  /** In-page fill and the HTTP auth prompt will read through these (no re-auth for matching). */
  findForOrigin(origin: string): Credential[] {
    return this.store.findForOrigin(origin)
  }

  findForHttpAuth(origin: string, realm: string): Credential[] {
    return this.store.findForHttpAuth(origin, realm)
  }

  // ---------------------------------------------------------------------------
  // Sync (ID-09): what the engine publishes and what it applies from other devices
  // ---------------------------------------------------------------------------

  /**
   * Every login and passkey record while the vault is open, or null while it is locked: the
   * engine then neither publishes nor tombstones credential records, and holds the ones it
   * received until the vault opens (`core/sync/engine.ts`).
   */
  syncSources(): { logins: Credential[]; passkeys: PasskeyEntry[] } | null {
    if (!this.store.unlocked()) return null
    return { logins: this.store.list(), passkeys: this.store.listPasskeys() }
  }

  /** Another device's login won the merge: it replaces this device's copy under the same id. */
  applySyncedLogin(login: Credential): void {
    this.store.applySynced(login)
  }

  /**
   * A passkey's public record from another device. Only the metadata travels: the private key
   * is the other device's authenticator's, so the entry lists here but signs in only there.
   */
  applySyncedPasskey(passkey: PasskeyEntry): void {
    this.store.applySyncedPasskey(passkey)
  }

  /** A deletion made on another device; the undo window was that device's. */
  removeSynced(id: string): void {
    if (!this.store.removeSynced(id)) this.store.removeSyncedPasskey(id)
    const pending = this.removed.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      this.removed.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Generator
  // ---------------------------------------------------------------------------

  async generate(
    options: GeneratorOptions,
    domain?: string
  ): Promise<{ password: string; rules: string | null }> {
    if (options.mode === 'passphrase') {
      return { password: generatePassphrase(options, await passphraseWordlist()), rules: null }
    }
    const published = domain ? rulesForHost(domain) : null
    if (!published) return { password: generatePassword(options), rules: null }
    const rules = parsePasswordRules(published.text)
    return {
      password: generatePassword(options, rules),
      rules: `${published.host}: ${describeRules(rules) || 'published rules applied'}`
    }
  }

  // ---------------------------------------------------------------------------
  // Checkup
  // ---------------------------------------------------------------------------

  runCheckup(): void {
    if (this.checkup.running || !this.store.unlocked()) return
    const abort = new AbortController()
    this.checkupAbort = abort
    const credentials = this.store.list()
    this.checkup = {
      ...emptyCheckupState(),
      running: true,
      total: credentials.length,
      // Keep the previous verdicts visible while the new run replaces them.
      compromised: this.checkup.compromised,
      weak: this.checkup.weak,
      reused: this.checkup.reused
    }
    this.browser.state.commitVolatile()
    void (async () => {
      try {
        const score = await zxcvbnScorer()
        const result = await runCheckup(
          credentials,
          {
            fetchRange: (prefix, signal) => this.fetchRange(prefix, signal),
            score: async (password) => score(password)
          },
          (p) => this.progress(p.checked, p.total),
          abort.signal
        )
        if (this.checkupAbort !== abort) return
        const finishedAt = Date.now()
        this.checkup = {
          running: false,
          checked: this.checkup.checked,
          total: credentials.length,
          finishedAt,
          error: abort.signal.aborted
            ? 'Checkup cancelled'
            : result.offline
              ? 'Zenium could not reach the breach database; compromised passwords were not checked.'
              : null,
          compromised: result.compromised,
          weak: result.weak,
          reused: result.reused,
          unchecked: result.unchecked
        }
        // Each looked-up login keeps its verdict (the manager and Safety Check read it without
        // another request), and the device keeps the run's counts for Safety Check. A cancelled
        // run recorded what it reached but is not "the last checkup".
        if (this.store.unlocked()) {
          this.store.recordLeaks(
            [...result.breachCounts].map(([id, breached]) => ({ id, fields: { breached } })),
            finishedAt
          )
          if (!abort.signal.aborted)
            this.writeSummary({
              compromised: this.store.compromisedCount(),
              weak: result.weak.length,
              reused: result.reused.reduce((n, group) => n + group.length, 0),
              checkedAt: finishedAt
            })
        }
      } catch (error) {
        if (this.checkupAbort !== abort) return
        this.checkup = {
          ...this.checkup,
          running: false,
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : 'The checkup failed'
        }
      }
      this.checkupAbort = null
      this.browser.state.commitVolatile()
    })()
  }

  cancelCheckup(): void {
    this.checkupAbort?.abort()
  }

  private progress(checked: number, total: number): void {
    this.checkup = { ...this.checkup, checked, total }
    const now = Date.now()
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS && checked < total) return
    this.lastProgressAt = now
    this.browser.state.commitVolatile()
  }

  private async fetchRange(prefix: string, signal: AbortSignal): Promise<string | null> {
    const response = await this.browser.platform.net.fetchText(`${HIBP_RANGE_URL}${prefix}`, {
      signal,
      headers: { 'Add-Padding': 'true' },
      timeoutMs: RANGE_TIMEOUT_MS
    })
    if (!response.ok) return null
    return response.text
  }

  // ---------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------

  async import(conflict: ImportConflict, win?: ZenWindow): Promise<ImportResult | null> {
    if (!this.store.unlocked()) return null
    const files = await this.browser.platform.dialogs.pickTextFiles(
      { title: 'Import passwords from CSV', extensions: ['csv', 'txt'] },
      win
    )
    if (files.length === 0) return null
    const total: ImportResult = {
      format: null,
      total: 0,
      added: 0,
      replaced: 0,
      skipped: 0,
      invalid: 0
    }
    for (const file of files) {
      const parsed = parseImport(file.text)
      if (parsed.format === null) {
        total.invalid += Math.max(1, parsed.invalid)
        continue
      }
      const result = this.store.importRows(parsed.rows, conflict, parsed.format)
      total.format ??= parsed.format
      total.total += result.total + parsed.invalid
      total.added += result.added
      total.replaced += result.replaced
      total.skipped += result.skipped
      total.invalid += result.invalid + parsed.invalid
    }
    const imported = total.added + total.replaced
    this.browser.toast(
      total.format === null
        ? 'That file does not look like a password export.'
        : `Imported ${imported} ${imported === 1 ? 'login' : 'logins'}` +
            (total.skipped ? `, ${total.skipped} already saved` : '') +
            (total.invalid ? `, ${total.invalid} unusable` : ''),
      total.format === null ? 'error' : 'info',
      win
    )
    return total
  }

  async export(
    passphrase?: string,
    win?: ZenWindow
  ): Promise<ReauthOutcome<{ saved: boolean; count: number }>> {
    if (!this.store.unlocked()) return { status: 'denied' }
    const gate = await this.reauth('Export every saved password', passphrase, win)
    if (gate.status !== 'ok') return gate
    const credentials = this.store.list()
    const saved = await this.browser.platform.dialogs.saveTextFile(
      {
        title: 'Export passwords',
        defaultName: 'Zenium Passwords.csv',
        extensions: ['csv'],
        mimeType: 'text/csv',
        text: toChromeCsv(credentials)
      },
      win
    )
    if (saved)
      this.browser.toast(
        `Exported ${credentials.length} ${credentials.length === 1 ? 'login' : 'logins'} as plain text`,
        'info',
        win
      )
    return { status: 'ok', value: { saved, count: credentials.length } }
  }

  private bump(): void {
    this.revision++
    this.refreshSummary()
    this.browser.state.commitVolatile()
  }
}
