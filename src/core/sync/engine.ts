import type {
  AccountErrorKind,
  SyncAccountLink,
  SyncAccountLinkFailure,
  SyncDevice,
  SyncDeviceTabs,
  SyncScope,
  SyncSetupRefusal,
  SyncStatus,
  SyncTransportKind,
  WebDavErrorKind,
  WebDavProbe,
  WebDavSyncCredentials,
  WebDavSyncSettings
} from '../../shared/types'
import { newId } from '../../shared/ids'
import { JsonStore } from '../store/JsonStore'
import type { Browser } from '../browser'
import type { HistoryVisitsEvent } from '../history'
import { RETENTION_MS } from '../history'
import type { ZenWindow } from '../window'
import { defer, type SyncHost, type SyncPlatformHost, type SyncTransport } from '../platform'
import { fromBase64, toBase64 } from '../credentials/crypto'
import { isExtensionId } from '../extensions/store'
import { applyRemote } from './apply'
import { decryptJson, deriveKey, encryptJson, newSalt } from './crypto'
import {
  collectLocal,
  defaultScope,
  diffLocal,
  extensionDeclineStands,
  extensionRecordData,
  extensionRecordReadable,
  extensionStoreOf,
  frozenRecords,
  hashData,
  inScope,
  isSettingsRecord,
  isVaultRecordType,
  metaFromRemote,
  newestByRecord,
  pendingExtensionRequests,
  seedSettingsMeta,
  vaultRecordReadable,
  winningRemote,
  type ExtensionSyncSource,
  type LocalSources,
  type MetaMap,
  type SyncRecord
} from './records'
import {
  deviceFileName,
  ensureReadme,
  isFolderLost,
  readDeviceFiles,
  serializeDeviceFile,
  type DeviceFile
} from './transport'
import {
  historyPageName,
  inboxName,
  openTabsName,
  ownsName,
  parseHistoryPageName,
  parseInboxName,
  parseOpenTabsName,
  readDocument,
  serializeDocument,
  type SyncDocument,
  type SyncDocumentKind
} from './documents'
import {
  HISTORY_PAGES_PER_ROUND,
  advanceCursor,
  appendOpen,
  applyEntries,
  entriesFromEvent,
  entriesFromVisits,
  expiredPages,
  initialHistoryState,
  pagesToRead,
  planWrites,
  readHistoryPage,
  readHistoryState,
  refreshTitles,
  rememberDeletion,
  seedFloor,
  takeWrites,
  type HistorySyncState,
  type StreamCursor
} from './history'
import { collectOpenTabs, openTabsHash, readOpenTabs, sortDeviceTabs } from './openTabs'
import {
  SENDS_REMEMBERED,
  SEND_TTL_MS,
  isSendableUrl,
  readSendTab,
  sendTabArrivedText,
  type SendTabDocument
} from './sendTab'
import {
  WEBDAV_SECRET_KEY,
  WebDavTransport,
  isWebDavError,
  webDavFolderName,
  webDavFolderUrl
} from './webdav'
import {
  ACCOUNT_VERSION_POLL_MS,
  AccountClient,
  AccountSession,
  AccountTransport,
  forgetAccountSecrets,
  isAccountError,
  isSignedOut,
  linkDevice,
  type AccountGrant,
  type AccountLinkResult
} from './account'
import { accountEndpoints } from './accountEndpoints'

interface Persisted {
  version: 1
  enabled: boolean
  /**
   * Where the folder is: the host's path or tree URI with the folder transport, the
   * `zenium-sync` directory's URL with the WebDAV one (ID-32; the status shows it as it is), the
   * account service's URL with the Zenium account.
   */
  folder: string | null
  /** How `folder` is reached; absent in a `sync.json` from before ID-32 (the folder transport). */
  transport?: SyncTransportKind
  /** The WebDAV server's settings, never its app password (`Platform.secrets` keeps that). */
  webdav?: WebDavSyncSettings | null
  /**
   * The Zenium account signed in to, never its tokens (`Platform.secrets` keeps the refresh
   * token): set from the approved sign-in on, before setup too – the passphrase step comes after
   * the sign-in, and a restart in between keeps the sign-in.
   */
  account?: { email: string } | null
  /** Base64 scrypt key (derived once from the passphrase). */
  key: string | null
  salt: string | null
  deviceId: string
  deviceName: string
  scope: SyncScope
  meta: MetaMap
  lastSyncAt: number | null
  devices: SyncDevice[]
  /** First sync still needs the user's merge decision. */
  pendingMerge: boolean
  /** The history stream: this device's pages and its place in the others' (`history.ts`). */
  history: HistorySyncState
  /** Fingerprint of the open-tabs document in the folder; null while there is none. */
  openTabsHash: string | null
  /** Ids of the sent tabs this device opened, newest last (`SENDS_REMEMBERED` at most). */
  consumedSends: string[]
  /**
   * The store extensions this device holds whose `extension` record a remote copy won while
   * this host could apply nothing (no `ExtensionHost.applySyncedExtensions` – the phone), by
   * id: the hash of this device's own copy at the take (ID-44). Such an id is left out of
   * `sources()` – its entry the winner's, frozen (`frozenRecords`), nothing published under it
   * – until the copy's hash changes (the user's flip here, which goes out under a fresh stamp
   * with its clock) or the extension is gone; the round that takes a winner writes the entry,
   * the read that finds the change drops it. Persisted, since a relaunch's boot seed would
   * otherwise adopt the stale copy's hash into the winner's entry (`seedMeta`) and the next
   * round publish it under the winner's stamp. Absent (a `sync.json` from before; a host with
   * an applier, which never writes it): nothing held.
   */
  unappliedExtensions?: Record<string, string>
  /**
   * The synced extensions the user DECLINED on this device (ID-44; the lead's ruling, round 4),
   * by id: the time the landing – installed by a peer's record, turned off, waiting for the
   * user's approval – was removed here before being approved. A decline closes the request on
   * this device alone: no tombstone goes out (the other devices keep the extension), and the
   * peer's live record is not handed to this device's applier again while the decline stands
   * against it – any copy whose install is not later than the decline (`extensionDeclineStands`
   * on the record's `installedAt`; a flip's newer stamp re-offers nothing, nor does a record
   * without the time). A copy carrying a LATER install (a fresh install of the id by hand on a
   * peer after the decline) is offered once more and closes the entry, as does a tombstone for
   * the id, or an install of it here. Persisted, so a relaunch does not re-offer what the user
   * declined. Absent when nothing is declined.
   */
  declinedExtensions?: Record<string, number>
}

interface Payload {
  v: 1
  records: SyncRecord[]
}

const PUSH_DEBOUNCE_MS = 4_000
export const DEFAULT_POLL_MS = 45_000
const FIRST_SYNC_DELAY_MS = 1_500
/**
 * How many rounds in a row a WebDAV `conflict` (412 / 423: a precondition failed, a resource
 * locked by another client) is run again after the push debounce before it is shown as an error.
 */
export const WEBDAV_CONFLICT_RETRIES = 3
/**
 * Through the Zenium account the version poll (`AccountTransport.watch`) is what brings another
 * device's change in; the engine's own poll is only the net under it, this often at most.
 */
export const ACCOUNT_ROUND_POLL_MS = 5 * 60_000
/**
 * Through the Zenium account a round whose device file would say what the last one said does
 * not write it (every write bumps the version every other device polls, and each would answer
 * with a round of its own – for ever); the file is written anyway this often, so the others'
 * "last seen" keeps moving.
 */
export const DEVICE_FILE_HEARTBEAT_MS = 10 * 60_000

/** What a device connects to: the host's folder, a WebDAV server with its app password, or the account. */
type SyncTarget =
  | { transport: 'folder'; folder: string }
  | { transport: 'webdav'; settings: WebDavSyncSettings; password: string }
  | { transport: 'account'; session: AccountSession }

export const FOLDER_LOST_MESSAGE =
  'The sync folder is no longer accessible. Choose it again to keep syncing.'
export const WRONG_PASSPHRASE_MESSAGE = 'That passphrase does not match the data in this folder.'
export const OTHER_PASSPHRASE_FOLDER_MESSAGE =
  'That folder holds sync data set up with a different passphrase. Turn sync off and set it up again to use it.'
export const SEND_TAB_UNKNOWN_DEVICE_MESSAGE = 'That device is no longer in your sync folder.'
export const SEND_TAB_NOT_A_PAGE_MESSAGE = 'Only web pages can be sent to your devices.'
export const ACCOUNT_SIGN_IN_FIRST_MESSAGE = 'Sign in to your Zenium account first.'
export const OTHER_PASSPHRASE_ACCOUNT_MESSAGE =
  'That account holds sync data set up with a different passphrase. Turn sync off and set it up again to use it.'

/** An account error as a toast says it (the engine's own sentences; the settings page has its own words). */
export function accountErrorMessage(kind: AccountErrorKind): string {
  switch (kind) {
    case 'signed-out':
      return 'You were signed out of your Zenium account.'
    case 'quota':
      return 'Your Zenium account’s sync storage is full.'
    case 'too-large':
      return 'This is too large to sync.'
    case 'rate-limited':
      return 'Too many requests to your Zenium account. Try again in a moment.'
    case 'unavailable':
      return 'Your Zenium account could not be reached.'
    case 'refused':
      return 'Your Zenium account did not accept the request.'
  }
}

type Timer = ReturnType<typeof setTimeout>

/**
 * Zen 1.22 "Sync your Spaces across devices" for the Chromium port. Mozilla accounts are not
 * available to a non-Firefox browser, so devices exchange end-to-end encrypted record sets
 * through a folder they all see (cloud drive / Syncthing). Merge is last-writer-wins per record,
 * like Firefox Sync.
 *
 * The engine is platform-neutral: the folder's bytes come and go through the host's
 * `SyncTransport` (node:fs on desktop, the Storage Access Framework on Android), the folder
 * picker and the device's default name are the host's too (`SyncPlatformHost`), and the crypto
 * runs on Web Crypto with scrypt-js (or the host's own scrypt). Device files written by the
 * Electron-only engine keep decrypting: same envelope, same key derivation, same record hashes
 * (`__tests__/compat.test.ts`).
 *
 * Beside its record set (the `.zensync` device file) a device owns documents (`.zenpage`,
 * `documents.ts`): the pages of its history stream (`history.ts`, ID-13 / HB-48), its open tabs
 * for the others' "Tabs from other devices" (`openTabs.ts`, ID-28), and an inbox of tabs the
 * others sent it (`sendTab.ts`, ID-27). One round pulls and merges the records, publishes the
 * device file, then moves the three: history written and read up to each stream's cursor, the
 * tab list rewritten when it changed and the others' read, the inbox opened and consumed.
 */
export class SyncEngine implements SyncHost {
  private data: Persisted
  private readonly store: JsonStore<Persisted>
  private key: Uint8Array | null = null
  private transport: SyncTransport | null = null
  private unwatch: (() => void) | null = null
  private pushTimer: Timer | null = null
  private pollTimer: Timer | null = null
  private firstSyncTimer: Timer | null = null
  private running: Promise<void> | null = null
  private applying = false
  /** The credential records have had the boot seed (`seedMeta`): the vault was open for one. */
  private seededVault = false
  /**
   * The store extensions installed here at the previous `sources()` read (ID-44), each with
   * whether it was still a landing waiting for the user's approval (`pendingApproval`), or null
   * before the first: what an absence is measured against – an approved extension gone is an
   * uninstall (`LocalSources.removedExtensions`), a pending one gone is the user's decline
   * (`Persisted.declinedExtensions`).
   */
  private presentExtensions: Map<string, boolean> | null = null
  /** The device name behind each record the last `readRemote` read (`originOf`). */
  private remoteOrigins: WeakMap<SyncRecord, string> | null = null
  /** A remote stream is being applied to the history model: its events are not ours to publish. */
  private applyingHistory = false
  private syncing = false
  private lastError: string | null = null
  /** The class of `lastError` when the WebDAV or account transport raised it (`SyncStatus.lastErrorKind`). */
  private lastErrorKind: WebDavErrorKind | AccountErrorKind | null = null
  /** The device's account sign-in, made on first use; replaced whole by a new sign-in. */
  private accountSession: AccountSession | null = null
  /** The sign-in under way (`SyncStatus.accountLink`), and what cancels it. */
  private accountLink: SyncAccountLink | null = null
  private linkController: AbortController | null = null
  private accountLinkFailure: SyncAccountLinkFailure | null = null
  /**
   * The account service ended the sign-in (`SyncStatus.accountSignedOut`): as `authRefused`, the
   * timers are stopped and `run()` sends nothing until the user signs in again.
   */
  private accountSignedOut = false
  /** The device file as last written through the account (`DEVICE_FILE_HEARTBEAT_MS`). */
  private published: { hash: string; at: number } | null = null
  private folderLost = false
  private folderName: string | null = null
  /**
   * The WebDAV server refused the sign-in on the last round (`SyncStatus.authRefused`): the
   * timers are stopped and `run()` makes no request until `setWebDavPassword` connects again.
   */
  private authRefused = false
  /** WebDAV conflicts run again in a row (`WEBDAV_CONFLICT_RETRIES`); a clean round resets it. */
  private conflictRetries = 0
  /** Which `connect` the transport being opened belongs to: a later one makes an earlier one moot. */
  private connectGeneration = 0
  /** The other devices' open tabs as last read, by their (reduced) id. */
  private readonly remoteTabs = new Map<string, SyncDeviceTabs>()
  private remoteTabsVersion = 0

  constructor(
    private readonly browser: Browser,
    private readonly host: SyncPlatformHost
  ) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'sync.json', 300)
    const saved = this.store.readSync()
    this.data = {
      version: 1,
      enabled: false,
      folder: null,
      key: null,
      salt: null,
      deviceId: newId('device'),
      deviceName: host.deviceNameDefault(),
      scope: defaultScope(),
      meta: {},
      lastSyncAt: null,
      devices: [],
      pendingMerge: false,
      history: initialHistoryState(),
      openTabsHash: null,
      consumedSends: [],
      ...(saved?.version === 1 ? saved : {})
    }
    // A scope key this build added (`passwords`, `history`, `readingList`) starts at its default
    // on a device set up before; the history state of an older `sync.json` is completed the same
    // way.
    this.data.scope = { ...defaultScope(), ...this.data.scope }
    this.data.history = readHistoryState(this.data.history)
    if (!Array.isArray(this.data.consumedSends)) this.data.consumedSends = []
    const unapplied = readUnappliedExtensions(this.data.unappliedExtensions)
    if (unapplied) this.data.unappliedExtensions = unapplied
    else delete this.data.unappliedExtensions
    const declined = readDeclinedExtensions(this.data.declinedExtensions)
    if (declined) this.data.declinedExtensions = declined
    else delete this.data.declinedExtensions
    if (typeof this.data.account?.email !== 'string') this.data.account = null
    // A WebDAV device without its settings, or an account device without its account (a
    // hand-edited store), is a folder device.
    const transport = this.data.transport
    if (!(transport === 'account' && this.data.account)) {
      if (transport !== 'webdav' || !this.data.webdav) this.data.transport = 'folder'
    }
    if (this.data.transport !== 'webdav') this.data.webdav = null
    if (this.data.key) this.key = fromBase64(this.data.key)
  }

  start(): void {
    this.seedMeta(this.sources())
    this.browser.state.subscribe(() => this.onLocalChange())
    this.browser.history.onVisits((event) => this.onVisits(event))
    if (this.data.enabled && this.data.folder && this.key) void this.connect()
  }

  /**
   * The boot seed: every local record hashed against the metadata the last run persisted, a
   * changed hash adopted WITHOUT a new `modified`. Nothing that differs at start was made by the
   * user in this session – it is the build's: a settings default this build added and the load
   * spread onto the settings (`state.ts` loads `{ ...DEFAULT_SETTINGS, ...persisted }`), a
   * sanitiser's new normal form, a boot migration. Stamped, such a change would go out as a
   * whole-record edit at this device's first sync on the new build and beat a peer's real edit
   * the device had not pulled yet (see `DiffLocalOptions.stamp`). Runs before the state is
   * subscribed, so the subscriber's first diff sees this session's edits alone; unconditionally,
   * with no knowledge of which key changed, so a future default or sanitiser cannot bring the
   * fault back. A record new to the local set stays out of the metadata (it takes `modified = 0`
   * at its first diff, as always: a record no one edited never beats a peer's); a record the
   * metadata knows but the set lacks keeps its entry (the next diff tombstones it, as before).
   *
   * The credential records are behind the vault's lock at start (`syncSources()` is null until
   * it opens, silently for an OS-protected vault a moment after `start()`, or by the user's
   * hand): they get the same seed at the first broadcast that finds the vault open
   * (`credentialsOnly`: nothing else is seeded then – by that time the other records' changes
   * are the user's), before that broadcast's diff could stamp the build's change to a login's
   * record shape as an edit of every login.
   *
   * The settings record is seeded key by key (`seedSettingsMeta`): an entry from before per-key
   * merge gains its per-key entries here, every key at the record's time; a key this build
   * added starts at 0; a changed value's hash is adopted at the key's own time.
   */
  private seedMeta(sources: LocalSources, credentialsOnly = false): void {
    if (sources.credentials) this.seededVault = true
    if (!this.data.enabled || this.data.pendingMerge) return
    const meta = this.data.meta
    let changed = false
    for (const [id, { type, data }] of collectLocal(sources, this.data.scope)) {
      if (credentialsOnly && !isVaultRecordType(type)) continue
      const prev = meta[id]
      if (!prev || prev.deleted) continue
      if (isSettingsRecord(id, type)) {
        const seeded = seedSettingsMeta(prev, data)
        if (seeded !== prev) {
          meta[id] = seeded
          changed = true
        }
        continue
      }
      const hash = hashData(data)
      if (prev.hash === hash) continue
      meta[id] = { ...prev, hash }
      changed = true
    }
    if (changed) this.persist()
  }

  status(): SyncStatus {
    return {
      enabled: this.data.enabled,
      folder: this.data.folder,
      folderName:
        this.data.folder === null
          ? null
          : this.data.transport === 'webdav' && this.data.webdav
            ? webDavFolderName(this.data.webdav)
            : this.data.transport === 'account' && this.data.account
              ? this.data.account.email
              : (this.folderName ?? this.data.folder),
      folderLost: this.folderLost,
      deviceId: this.data.deviceId,
      deviceName: this.data.deviceName,
      scope: this.data.scope,
      lastSyncAt: this.data.lastSyncAt,
      lastError: this.lastError,
      lastErrorKind: this.lastErrorKind,
      syncing: this.syncing,
      devices: this.data.devices,
      pendingMerge: this.data.pendingMerge,
      remoteTabsVersion: this.remoteTabsVersion,
      transport: this.data.transport ?? 'folder',
      webdav: this.data.webdav ?? null,
      webdavAvailable: this.webdavAvailable(),
      authRefused: this.authRefused,
      accountAvailable: this.accountAvailable(),
      account: this.data.account ?? null,
      accountLink: this.accountLink,
      accountLinkFailure: this.accountLinkFailure,
      accountSignedOut: this.accountSignedOut
    }
  }

  /** A WebDAV server takes a fetch that speaks its methods and a store for its app password. */
  private webdavAvailable(): boolean {
    return Boolean(this.host.fetch && this.browser.platform.secrets)
  }

  /** The account takes the same: a fetch that reaches the service, a store for the refresh token. */
  private accountAvailable(): boolean {
    return this.webdavAvailable()
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  chooseFolder(win: ZenWindow): Promise<string | null> {
    return this.host.chooseFolder(win)
  }

  /**
   * Enable sync. If other devices already wrote to the folder the passphrase must decrypt their
   * data, and the user is asked how to merge before anything is applied. With `transport:
   * 'webdav'` the folder is the server's (ID-32): reached with the app password given here,
   * which the host's secret store keeps from then on – the settings without it go to `sync.json`.
   *
   * The order for a server, and why: the probe (nothing stored, nothing made) → the password into
   * the secret store → the folder and the README made, the device files read, the key derived →
   * `disconnect(false, { keepSecret: true })` → the new data written. The store comes before the
   * server is written to so that a device whose store refuses (a Keystore that will not take it)
   * leaves no folder and no README behind on the server; and nothing of the standing
   * configuration – its connection, its data – is touched before the disconnect, the last step
   * but one. The store holds ONE password (`WEBDAV_SECRET_KEY`), so the value it held before is
   * read first, and any refusal after the write – the server's, the passphrase's, a throw – puts
   * it back (`set(previous)`), or deletes the key when there was none: the delete is scoped to the
   * password this setup wrote, and a standing server configuration keeps its own. Should that
   * restore itself fail, its throw is swallowed and the refusal is still what comes back – but
   * the store may then hold the refused setup's password, or nothing, where the standing
   * configuration's was: that configuration's next connect (a restart) reads it, is refused or
   * finds `null`, and asks for the password again – `authRefused`, the chrome's existing ask.
   * Nothing pretends otherwise.
   *
   * A server's refusal, and a secret store that cannot keep the password (or read what it holds),
   * come back typed (`SyncSetupRefusal`) for the chrome to say in its words – no method or status
   * of the protocol reaches a sentence (§9.33); the folder transport's refusals are toasted as
   * before.
   *
   * With `transport: 'account'` the home is the Zenium account the device signed in to before
   * (`startAccountLink`: the refresh token is in the store already, the account in `sync.json`):
   * nothing is stored here, the account's documents are read as a folder's, and the sign-in is
   * kept through the disconnect (`keepAccount`). The service's refusal comes back typed
   * (`reason: 'account'`); a sign-in it has ended is forgotten with it, for the chrome to offer
   * the sign-in again. Any other setup signs a device that had signed in out of the account.
   */
  async setup(
    opts: {
      folder: string
      passphrase: string
      deviceName: string
      scope: SyncScope
      transport?: SyncTransportKind
      webdav?: WebDavSyncCredentials
    },
    win: ZenWindow
  ): Promise<SyncSetupRefusal | null> {
    if (!opts.passphrase || opts.passphrase.length < 8) {
      this.browser.toast('Choose a passphrase of at least 8 characters.', 'error', win)
      return null
    }
    let target: SyncTarget
    if (opts.transport === 'webdav') {
      if (!opts.webdav || !this.webdavAvailable()) {
        this.browser.toast(
          this.describe(new Error('WebDAV is not available on this device')),
          'error',
          win
        )
        return null
      }
      const { password, ...settings } = opts.webdav
      target = { transport: 'webdav', settings, password }
    } else if (opts.transport === 'account') {
      if (!this.accountAvailable() || !this.data.account) {
        this.browser.toast(ACCOUNT_SIGN_IN_FIRST_MESSAGE, 'error', win)
        return null
      }
      target = { transport: 'account', session: this.session() }
    } else {
      target = { transport: 'folder', folder: opts.folder }
    }
    // Deriving the key takes a moment (seconds on a phone): the chrome shows the form busy.
    this.setBusy(true)
    // Set once the password is in the store: what a refusal after that point must undo.
    let restoreSecret: (() => Promise<void>) | null = null
    // Set at the point of no return: from the disconnect on, the new setup is the device's.
    let kept = false
    try {
      const transport = this.openTransport(target)
      if (target.transport === 'webdav' && transport instanceof WebDavTransport) {
        // The address answers as a WebDAV server to these credentials before anything is made
        // there: a wrong root would otherwise read as an empty folder (a listing's 404 is "no
        // directory yet") and fail on the first round instead of at the setup.
        const probe = await transport.probe()
        if (!probe.ok) return { reason: 'server', kind: probe.kind, status: probe.status }
        // The password into the store before the server is written to (Android's ask): a store
        // that refuses leaves no folder and no README behind, and a device that restarts before
        // the store took it would be a WebDAV device without a password, refused every round.
        // The one key is shared with whatever configuration stands, so its value is read first
        // and put back on a refusal; a store that cannot even be read is not one to keep a
        // password in – the same typed refusal, before anything is written anywhere.
        const secrets = this.browser.platform.secrets!
        let previous: string | null
        try {
          previous = await secrets.get(WEBDAV_SECRET_KEY)
          await secrets.set(WEBDAV_SECRET_KEY, target.password)
        } catch {
          return { reason: 'secrets' }
        }
        restoreSecret = async (): Promise<void> => {
          try {
            if (previous === null) await secrets.delete(WEBDAV_SECRET_KEY)
            else await secrets.set(WEBDAV_SECRET_KEY, previous)
          } catch {
            // The refusal is still what comes back; the store may now hold the wrong password
            // or none for the standing configuration, whose next connect asks for it (see the
            // doc comment).
          }
        }
      }
      let existing: DeviceFile[]
      try {
        await ensureReadme(transport)
        existing = (await readDeviceFiles(transport)).filter(
          (f) => f.deviceId !== this.data.deviceId
        )
      } catch (error) {
        if (target.transport === 'webdav' && isWebDavError(error))
          return { reason: 'server', kind: error.kind, status: error.status }
        if (target.transport === 'account' && isAccountError(error)) {
          if (error.kind === 'signed-out') {
            this.forgetAccount()
            this.persist()
          }
          return { reason: 'account', kind: error.kind }
        }
        this.browser.toast(this.describe(error), 'error', win)
        return null
      }
      const salt = existing[0]?.envelope.salt ?? newSalt()
      const key = await deriveKey(opts.passphrase, salt, this.host.scrypt)
      if (existing.length) {
        try {
          await decryptJson(key, existing[0].envelope)
        } catch {
          this.browser.toast(WRONG_PASSPHRASE_MESSAGE, 'error', win)
          return null
        }
      }
      // The point of no return: the password in the store is the new setup's, and the disconnect
      // leaves it there (`keepSecret`); every other disconnect forgets it.
      kept = true
      this.disconnect(false, {
        keepSecret: target.transport === 'webdav',
        keepAccount: target.transport === 'account'
      })
      this.key = key
      this.data = {
        ...this.data,
        enabled: true,
        folder:
          target.transport === 'folder'
            ? target.folder
            : target.transport === 'webdav'
              ? webDavFolderUrl(target.settings)
              : target.session.client.endpoints.cloudUrl,
        transport: target.transport,
        webdav: target.transport === 'webdav' ? target.settings : null,
        key: toBase64(key),
        salt,
        deviceName: opts.deviceName.trim() || this.host.deviceNameDefault(),
        scope: { ...defaultScope(), ...opts.scope },
        meta: {},
        pendingMerge: existing.length > 0,
        openTabsHash: null
      }
      delete this.data.unappliedExtensions
      delete this.data.declinedExtensions
      // The stream starts over in this folder; the sequence number never goes back, so a device
      // that read the old stream (the same folder joined again) does not sit past the new pages.
      this.data.history = { ...initialHistoryState(), seq: this.data.history.seq }
      if (this.data.scope.history) this.startSeed(Date.now())
      this.persist()
      this.attach(transport)
      if (target.transport === 'account') this.renameAccountDevice()
    } finally {
      // Refused after the store took the password – by the server, the passphrase, a throw:
      // the store back to what it held, so a refused setup leaves nothing behind on either side.
      if (!kept && restoreSecret) await restoreSecret()
      this.setBusy(false)
    }
    if (!this.data.pendingMerge) await this.syncNow()
    this.browser.state.commitVolatile()
    return null
  }

  /** Reach a WebDAV server once with these credentials; nothing is made or kept (Test connection). */
  async testWebDav(credentials: WebDavSyncCredentials): Promise<WebDavProbe> {
    if (!this.host.fetch) return { ok: false, kind: 'unavailable', status: 0 }
    return new WebDavTransport(credentials, this.host.fetch).probe()
  }

  /**
   * A new app password for the configured server (the old one was revoked – `authRefused` – or
   * rotated): kept in the secret store, the connection made again with it – the poll and the
   * push run again from here – and a round run. A store that cannot keep it is the typed
   * refusal, never a rejection; the old password stays refused.
   */
  async setWebDavPassword(password: string): Promise<SyncSetupRefusal | null> {
    if (!this.data.enabled || this.data.transport !== 'webdav' || !this.data.webdav || !this.key)
      return null
    const secrets = this.browser.platform.secrets
    if (!secrets || !password) return null
    try {
      await secrets.set(WEBDAV_SECRET_KEY, password)
    } catch {
      return { reason: 'secrets' }
    }
    this.authRefused = false
    this.lastError = null
    this.lastErrorKind = null
    this.conflictRetries = 0
    await this.connect(password)
    await this.syncNow()
    return null
  }

  // ---------------------------------------------------------------------------
  // The Zenium account
  // ---------------------------------------------------------------------------

  /**
   * Sign this device in to the Zenium account (`account.ts`'s `linkDevice`): the sign-in page
   * opens in a new tab of `win`'s – the browser itself is where the user signs in – and its code
   * is in the status for the chrome to show beside it. Resolves once the code is shown, or the
   * start failed (`accountLinkFailure`); the approval is awaited in the background, every
   * `interval` seconds, until it comes, the code expires or `cancelAccountLink`. Offered before
   * setup – the passphrase step follows the approval – and to a device the service signed out
   * (`accountSignedOut`), which syncs again once it is approved. A device syncing through a
   * folder, a server or a sign-in the service still takes has nothing to sign in to.
   */
  async startAccountLink(win: ZenWindow): Promise<void> {
    if (!this.accountAvailable()) {
      this.browser.toast('The Zenium account is not available on this device.', 'error', win)
      return
    }
    // Syncing through a folder or a server, or through a sign-in that still holds: nothing to
    // sign in to (a second approval would replace a live refresh token in the store).
    if (this.data.enabled && (this.data.transport !== 'account' || !this.accountSignedOut)) return
    this.cancelAccountLink()
    const controller = new AbortController()
    this.linkController = controller
    this.accountLinkFailure = null
    this.browser.state.commitVolatile()
    let shown = (): void => undefined
    const codeShown = new Promise<void>((resolve) => (shown = resolve))
    void this.runAccountLink(controller, win, shown).finally(shown)
    await codeShown
  }

  /** Stop waiting for the sign-in under way; a later approval of its code is signed out again. */
  cancelAccountLink(): void {
    this.linkController?.abort()
    this.linkController = null
    if (this.accountLink) {
      this.accountLink = null
      this.browser.state.commitVolatile()
    }
  }

  /**
   * Sign out of the Zenium account: a device syncing through it turns sync off (`disconnect`,
   * which forgets the sign-in at the service and in the store); a device that signed in and
   * never set up only forgets the sign-in.
   */
  signOutAccount(): void {
    if (this.data.enabled && this.data.transport === 'account') {
      this.disconnect(false)
      return
    }
    this.cancelAccountLink()
    if (!this.data.account) return
    this.forgetAccount()
    this.persist()
    this.browser.state.commitVolatile()
  }

  private async runAccountLink(
    controller: AbortController,
    win: ZenWindow,
    shown: () => void
  ): Promise<void> {
    let result: AccountLinkResult | null = null
    let failure: SyncAccountLinkFailure | null = null
    try {
      result = await linkDevice(this.accountClient(), this.browser.platform.secrets!, {
        deviceName: this.data.deviceName,
        kind: this.host.deviceKind?.() ?? 'desktop',
        signal: controller.signal,
        onCode: (start) => {
          this.accountLink = {
            userCode: start.userCode,
            verificationUrl: start.verificationUriComplete,
            expiresAt: start.expiresAt
          }
          this.browser.state.commitVolatile()
          this.browser.tabs.createTab({ url: start.verificationUriComplete, active: true }, win)
          shown()
        }
      })
    } catch (error) {
      failure =
        isAccountError(error) && error.kind === 'rate-limited' ? 'rate-limited' : 'unavailable'
    }
    // Cancelled, or another sign-in took its place: that one owns the status now.
    if (this.linkController !== controller) return
    this.linkController = null
    this.accountLink = null
    if (result?.status === 'expired') failure = 'expired'
    else if (result?.status === 'secrets') failure = 'secrets'
    this.accountLinkFailure = failure
    if (result?.status === 'approved') await this.accountApproved(result.grant, win)
    this.browser.state.commitVolatile()
  }

  /**
   * An approved sign-in (its refresh token in the store already): the session from now on.
   * Before setup the account is only noted – the passphrase step is next. A device the service
   * had signed out connects again and syncs; signed in to ANOTHER account, it first checks that
   * the key opens what that account holds (as `setFolder` does for a folder) and, if not, signs
   * that account out again – the data stays where it was.
   */
  private async accountApproved(grant: AccountGrant, win: ZenWindow): Promise<void> {
    const session = this.newSession()
    session.adopt(grant)
    this.accountSession = session
    if (!(this.data.enabled && this.data.transport === 'account' && this.key)) {
      this.data.account = { email: grant.email }
      this.persist()
      return
    }
    if (this.data.account?.email !== grant.email) {
      try {
        const others = (
          await readDeviceFiles(this.openTransport({ transport: 'account', session }))
        ).filter((f) => f.deviceId !== this.data.deviceId)
        if (others.length) await decryptJson(this.key, others[0].envelope)
      } catch (error) {
        this.browser.toast(
          isAccountError(error)
            ? accountErrorMessage(error.kind)
            : OTHER_PASSPHRASE_ACCOUNT_MESSAGE,
          'error',
          win
        )
        this.accountSession = null
        void session.signOut().catch(() => undefined)
        void forgetAccountSecrets(this.browser.platform.secrets)
        return
      }
      // Another account holds none of this device's pages: the open buffer is written again.
      this.data.history.written = 0
      this.data.history.pages = []
      this.data.openTabsHash = null
    }
    this.data.account = { email: grant.email }
    this.accountSignedOut = false
    this.lastError = null
    this.lastErrorKind = null
    this.persist()
    await this.connect()
    await this.syncNow()
  }

  private accountClient(): AccountClient {
    return new AccountClient(accountEndpoints(), this.host.fetch!)
  }

  private newSession(): AccountSession {
    return new AccountSession(this.accountClient(), this.browser.platform.secrets!, {
      onGrant: (grant) => {
        if (!this.data.account || this.data.account.email === grant.email) return
        this.data.account = { email: grant.email }
        this.persist()
        this.browser.state.commitVolatile()
      }
    })
  }

  /** The device's sign-in, made on first use (the refresh token is read from the store then). */
  private session(): AccountSession {
    this.accountSession ??= this.newSession()
    return this.accountSession
  }

  /**
   * Forget the account at the service and here, best effort: the refresh token is read into the
   * session's memory; once `after` settles (a wipe still writing through the session) the
   * service signs the device out (`devices:signOut`, so no device is left at the service
   * holding a live session); then the token leaves the store, whatever the service answered –
   * a sign-out the service never heard (offline) leaves a session the account's device list
   * still shows, and the website's Sign out or the daily purge is the way to end it.
   */
  private forgetAccount(after: Promise<unknown> = Promise.resolve()): void {
    this.cancelAccountLink()
    const session = this.accountSession ?? (this.accountAvailable() ? this.newSession() : null)
    this.accountSession = null
    this.data.account = null
    this.accountSignedOut = false
    const secrets = this.browser.platform.secrets
    void (async () => {
      await session?.load()
      await after
      await session?.signOut().catch(() => undefined)
      await forgetAccountSecrets(secrets)
    })()
  }

  /**
   * Zen prompts how to combine local Spaces with the cloud copy the first time. Passwords are
   * outside the question: Chrome's password sync always merges by entry, so "keep this device's
   * data" never deletes another device's logins, and types this device does not sync are left
   * to the devices that do.
   *
   * History is a stream per device, never one shared copy, so the question reads differently
   * there: "merge" takes the other devices' visits in from the start of their streams, "keep
   * this device's data" skips what they have published so far and follows them from here on –
   * nothing of theirs is deleted either way (Chrome merges history and never asks). This
   * device's own history is published in both cases.
   */
  async confirmMerge(merge: boolean): Promise<void> {
    if (!this.data.pendingMerge) return
    this.data.pendingMerge = false
    const remote = await this.readRemote()
    const sources = this.sources()
    const local = collectLocal(sources, this.data.scope)
    const meta: MetaMap = {}
    if (merge) {
      // Merge: records that exist on both sides (settings, shortcuts, ordering, shared ids)
      // adopt the cloud copy; everything only this device has is added to it.
      for (const [id, { type, data }] of local) {
        if (remote.has(id)) meta[id] = { type, hash: hashData(data), modified: -1, deleted: false }
      }
    } else {
      // Keep this device's data: stamp every local record as freshly edited (so it beats the
      // cloud copy) and tombstone records that only exist remotely.
      const now = Date.now()
      for (const [id, { type }] of local)
        meta[id] = { type, hash: '', modified: now, deleted: false }
      for (const [id, r] of remote) {
        if (local.has(id) || r.deleted) continue
        // The peers' extensions are not tombstoned either (ID-44): "keep this device's data"
        // is about the data, and the tombstone would UNINSTALL software on every other device;
        // like a password, an extension the peers hold reaches this device instead – landing
        // turned off, waiting for the user's approval, nothing granted (`applySyncedExtensions`).
        if (isVaultRecordType(r.type) || r.type === 'extension' || !inScope(r, this.data.scope))
          continue
        meta[id] = { type: r.type, hash: '', modified: now, deleted: true }
      }
      if (this.data.scope.history) await this.skipRemoteHistory().catch(() => undefined)
    }
    this.data.meta = meta
    delete this.data.unappliedExtensions
    delete this.data.declinedExtensions
    this.persist()
    await this.syncNow()
  }

  setScope(patch: Partial<SyncScope>): void {
    const before = this.data.scope
    this.data.scope = { ...this.data.scope, ...patch }
    // History turned on: what this device visited since it last published goes out (the backlog
    // again, from where it left off). Off: nothing is taken back from the folder.
    if (this.data.scope.history && !before.history && this.data.enabled) this.startSeed(Date.now())
    this.persist()
    this.browser.state.commitVolatile()
    this.schedulePush()
  }

  /** The device's name; the account's list of devices (its website) takes it too, best effort. */
  setDeviceName(name: string): void {
    this.data.deviceName = name.trim() || this.host.deviceNameDefault()
    this.persist()
    this.browser.state.commitVolatile()
    this.schedulePush()
    this.renameAccountDevice()
  }

  /**
   * The account's list of devices takes the sync name, best effort: the session was named at
   * sign-in, before the person chose one.
   */
  private renameAccountDevice(): void {
    if (this.data.account && this.accountAvailable() && !this.accountSignedOut)
      void this.session()
        .mutation('devices:rename', { name: this.data.deviceName })
        .catch(() => undefined)
  }

  /**
   * Point the device at a folder again: the one it had is gone (an unmounted drive, a revoked
   * Android tree), or the user moves the shared copy. The key and this device's record history
   * stay, so nothing is re-merged; a folder whose files the key does not open belongs to another
   * passphrase and is refused.
   */
  async setFolder(folder: string, win: ZenWindow): Promise<void> {
    if (!this.data.enabled || !this.key) {
      this.browser.toast('Set up sync first.', 'error', win)
      return
    }
    this.setBusy(true)
    try {
      const transport = this.openTransport({ transport: 'folder', folder })
      let others: DeviceFile[]
      try {
        await ensureReadme(transport)
        others = (await readDeviceFiles(transport)).filter((f) => f.deviceId !== this.data.deviceId)
      } catch (error) {
        this.browser.toast(this.describe(error), 'error', win)
        return
      }
      if (others.length) {
        try {
          await decryptJson(this.key, others[0].envelope)
        } catch {
          this.browser.toast(OTHER_PASSPHRASE_FOLDER_MESSAGE, 'error', win)
          return
        }
      }
      this.stopTransport()
      // A WebDAV device pointed at a folder of the host's leaves the server: its app password
      // has no further use here. An account device leaves the account the same way, signed out.
      if (this.data.transport === 'webdav') this.forgetWebDavPassword()
      if (this.data.transport === 'account' || this.data.account) this.forgetAccount()
      this.data.folder = folder
      this.data.transport = 'folder'
      this.data.webdav = null
      this.folderLost = false
      this.authRefused = false
      this.lastError = null
      this.lastErrorKind = null
      // The new folder has none of this device's pages: the whole open buffer is written again,
      // and the sealed pages it had elsewhere are not there to expire.
      this.data.history.written = 0
      this.data.history.pages = []
      this.data.openTabsHash = null
      this.persist()
      this.attach(transport)
    } finally {
      this.setBusy(false)
    }
    await this.syncNow()
  }

  /**
   * Turn sync off; optionally delete this device's file and documents from the folder. A WebDAV
   * device's app password leaves the secret store with it, unless `keepSecret` says the store
   * already holds the next setup's: `setup` is the one caller that passes it (it stores before it
   * disconnects); the user's turn-off (`sync.disconnect`, with or without the wipe) passes nothing
   * and forgets, as `setFolder` forgets on its own when a server device goes back to a folder.
   *
   * The Zenium account is forgotten the same way – signed out at the service once the wipe, if
   * any, is through, its refresh token out of the store – unless `keepAccount` says the next
   * setup is the account's (`setup` again, the one caller that passes it).
   */
  disconnect(
    wipeRemote: boolean,
    options: { keepSecret?: boolean; keepAccount?: boolean } = {}
  ): void {
    const transport = this.transport
    const wiped =
      wipeRemote && transport
        ? this.removeOwnDocuments(transport).catch(() => undefined)
        : Promise.resolve()
    this.stopTransport()
    if (this.data.transport === 'webdav' && !options.keepSecret) this.forgetWebDavPassword()
    const account = options.keepAccount ? (this.data.account ?? null) : null
    if ((this.data.transport === 'account' || this.data.account) && !options.keepAccount)
      this.forgetAccount(wiped)
    this.key = null
    this.data = {
      ...this.data,
      enabled: false,
      folder: null,
      transport: 'folder',
      webdav: null,
      account,
      key: null,
      meta: {},
      pendingMerge: false,
      devices: [],
      history: { ...initialHistoryState(), seq: this.data.history.seq },
      openTabsHash: null
    }
    delete this.data.unappliedExtensions
    delete this.data.declinedExtensions
    this.lastError = null
    this.lastErrorKind = null
    this.folderLost = false
    this.folderName = null
    this.authRefused = false
    this.accountSignedOut = false
    this.conflictRetries = 0
    if (this.remoteTabs.size) {
      this.remoteTabs.clear()
      this.remoteTabsVersion += 1
    }
    this.persist()
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Tabs from other devices, Send to your devices
  // ---------------------------------------------------------------------------

  tabsFromDevices(): SyncDeviceTabs[] {
    if (!this.data.enabled || !this.data.scope.openTabs) return []
    // The device's kind rides on its announcement (the device file), not on its tabs document.
    const kinds = new Map(this.data.devices.map((d) => [d.id, d.kind]))
    return sortDeviceTabs(
      [...this.remoteTabs.values()].map((list) => {
        const deviceKind = kinds.get(list.deviceId)
        return deviceKind ? { ...list, deviceKind } : list
      }),
      Date.now()
    )
  }

  /**
   * Chrome's "Send to your devices": the page lands in the target's inbox in the folder and opens
   * there as a tab once the device syncs. The sender only confirms it was handed over – whether
   * the target is on is the folder's business.
   */
  async sendTab(
    opts: { deviceId: string; url: string; title?: string; tabId?: string },
    win: ZenWindow
  ): Promise<void> {
    if (!this.data.enabled || !this.transport || !this.key) {
      this.browser.toast('Set up sync first.', 'error', win)
      return
    }
    const target = this.data.devices.find((d) => d.id === opts.deviceId)
    if (!target) {
      this.browser.toast(SEND_TAB_UNKNOWN_DEVICE_MESSAGE, 'error', win)
      return
    }
    const tab = opts.tabId ? this.browser.tabs.tab(opts.tabId) : undefined
    const url = opts.url || tab?.url || ''
    if (!isSendableUrl(url)) {
      this.browser.toast(SEND_TAB_NOT_A_PAGE_MESSAGE, 'error', win)
      return
    }
    const now = Date.now()
    const doc: SendTabDocument = {
      v: 1,
      id: newId('send'),
      url,
      title: (opts.title ?? tab?.customTitle ?? tab?.title ?? '').slice(0, 500),
      at: now,
      from: { id: this.data.deviceId, name: this.data.deviceName }
    }
    try {
      await this.writeDocument(this.transport, inboxName(target.id, doc.id), 'send-tab', doc, now)
      this.browser.toast(`Sent to ${target.name}`, 'info', win)
    } catch (error) {
      this.browser.toast(
        isFolderLost(error)
          ? FOLDER_LOST_MESSAGE
          : isAccountError(error)
            ? `Could not send the tab. ${accountErrorMessage(error.kind)}`
            : `Could not send the tab: ${this.describe(error)}`,
        'error',
        win
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Syncing
  // ---------------------------------------------------------------------------

  /**
   * The transport for a target: the host's folder transport, or the shared WebDAV or account one
   * over the host's fetch (`webdavAvailable` / `accountAvailable` was checked by whoever chose
   * the target). The account's version poll keeps the host's pace where the host has a
   * foreground (Android: its poll's period, only while in front, and at every return to the
   * front); elsewhere it asks every `ACCOUNT_VERSION_POLL_MS`.
   */
  private openTransport(target: SyncTarget): SyncTransport {
    if (target.transport === 'folder') return this.host.createTransport(target.folder)
    if (target.transport === 'account') {
      const host = this.host
      return new AccountTransport(target.session, {
        versionPollMs: host.foreground
          ? (host.pollMs ?? ACCOUNT_VERSION_POLL_MS)
          : ACCOUNT_VERSION_POLL_MS,
        ...(host.foreground ? { foreground: () => host.foreground!() } : {}),
        ...(host.onForeground ? { onForeground: (l: () => void) => host.onForeground!(l) } : {})
      })
    }
    return new WebDavTransport({ ...target.settings, password: target.password }, this.host.fetch!)
  }

  /**
   * Connect to what `sync.json` names. The folder transport is attached before this returns
   * (nothing is awaited on that path); a WebDAV server waits for its app password from the
   * secret store – `password` skips the read when the caller has it – and a missing one, or a
   * host without the pieces, is `authRefused`: the status the chrome acts on, never a silent stop.
   */
  private async connect(password?: string): Promise<void> {
    this.stopTransport()
    const generation = ++this.connectGeneration
    if (this.data.transport === 'webdav' && this.data.webdav) {
      const settings = this.data.webdav
      let secret = password ?? null
      if (secret === null && this.webdavAvailable()) {
        try {
          secret = await this.browser.platform.secrets!.get(WEBDAV_SECRET_KEY)
        } catch {
          secret = null
        }
      }
      if (generation !== this.connectGeneration) return
      if (!secret || !this.webdavAvailable()) {
        this.authRefused = true
        this.browser.state.commitVolatile()
        return
      }
      this.attach(this.openTransport({ transport: 'webdav', settings, password: secret }))
      return
    }
    // The account's refresh token is read at the first request: a store without one ends the
    // session there, and the round reports it as `accountSignedOut`.
    if (this.data.transport === 'account' && this.data.account) {
      if (!this.accountAvailable()) {
        this.accountSignedOut = true
        this.browser.state.commitVolatile()
        return
      }
      this.attach(this.openTransport({ transport: 'account', session: this.session() }))
      return
    }
    if (this.data.folder !== null)
      this.attach(this.openTransport({ transport: 'folder', folder: this.data.folder }))
  }

  /** Run the folder through this transport from now on: its watcher, the poll, the first round. */
  private attach(transport: SyncTransport): void {
    this.stopTransport()
    this.connectGeneration += 1
    this.transport = transport
    this.published = null
    this.unwatch = transport.watch?.(() => void this.syncNow()) ?? null
    const hostPollMs = this.host.pollMs ?? DEFAULT_POLL_MS
    const pollMs =
      this.data.transport === 'account' && hostPollMs > 0
        ? Math.max(hostPollMs, ACCOUNT_ROUND_POLL_MS)
        : hostPollMs
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => {
        if (this.host.foreground?.() === false) return
        void this.syncNow()
      }, pollMs)
    }
    this.firstSyncTimer = setTimeout(() => void this.syncNow(), FIRST_SYNC_DELAY_MS)
    this.folderName = null
    const folder = this.data.folder
    if (this.host.folderName && folder !== null && this.data.transport === 'folder') {
      void this.host
        .folderName(folder)
        .then((name) => {
          if (this.data.folder !== folder) return
          this.folderName = name || null
          this.browser.state.commitVolatile()
        })
        .catch(() => undefined)
    }
  }

  /** The app password out of the host's store, best effort: a store that fails keeps a dead secret. */
  private forgetWebDavPassword(): void {
    void this.browser.platform.secrets?.delete(WEBDAV_SECRET_KEY).catch(() => undefined)
  }

  private stopTransport(): void {
    this.unwatch?.()
    this.unwatch = null
    this.transport = null
    this.stopTimers()
  }

  /** No round starts on its own from here: the poll, a pending push, the first round after an attach. */
  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    if (this.firstSyncTimer) clearTimeout(this.firstSyncTimer)
    this.firstSyncTimer = null
  }

  /**
   * Stamp local edits the moment they are committed (not when the next sync happens to run), so
   * last-writer-wins reflects the real order of edits across devices. This is the ONE place an
   * edit is stamped: the state broadcast that carries it runs this, and the round (`run()`)
   * never stamps what it merely notices (`DiffLocalOptions.stamp`). A push is scheduled only
   * when something to publish changed: a record, or the open-tabs list.
   */
  private onLocalChange(): void {
    if (!this.data.enabled || this.applying || this.data.pendingMerge) return
    const sources = this.sources()
    if (sources.credentials && !this.seededVault) this.seedMeta(sources, true)
    const now = Date.now()
    const diff = diffLocal(this.data.meta, collectLocal(sources, this.data.scope), now, {
      stamp: now,
      frozen: frozenRecords(sources, this.data.scope, this.data.meta)
    })
    // The metadata is taken whether or not a record changed: a settings entry the last round
    // left without per-key entries (the record first seen there) has them now, from the values
    // as they stand at its time (`RecordMeta.keys`), so this session's first edit of a key is
    // placed on that key and not on the record whole.
    this.data.meta = diff.meta
    if (diff.changed) this.persist()
    if (diff.changed || this.openTabsChanged()) this.schedulePush()
  }

  /** The history model changed by the user's hand (not by a stream): the stream records it. */
  private onVisits(event: HistoryVisitsEvent): void {
    if (!this.data.enabled || this.applyingHistory || !this.data.scope.history) return
    const now = Date.now()
    const entries = entriesFromEvent(event, now)
    if (entries.length === 0) return
    // This device's own deletions are remembered too: a stream read later must not undo them.
    for (const e of entries) rememberDeletion(this.data.history.deletions, e, now)
    appendOpen(this.data.history, entries)
    this.persist()
    if (!this.data.pendingMerge) this.schedulePush()
  }

  private schedulePush(): void {
    // A refused sign-in holds every push too: the change waits for the new password's round.
    if (!this.data.enabled || this.data.pendingMerge || this.authRefused || this.accountSignedOut)
      return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.syncNow(), PUSH_DEBOUNCE_MS)
  }

  /**
   * @param meta The metadata an absence is read against (`this.data.meta`, or the round's
   *   merged map before it is stored): a pending landing gone whose entry is a tombstone was
   *   removed by that tombstone, not declined by the user.
   */
  private sources(meta: MetaMap = this.data.meta): LocalSources {
    const state = this.browser.state
    // The store extensions installed here, and the ones gone since the previous read (ID-44):
    // an uninstall is the one absence `diffLocal` may tombstone (`frozenRecords`), and it is
    // seen at the commit that removed the record – the previous read still held the id. Read
    // from the registry's projection (`syncSources`, no manifest read; `list()` on a host
    // without one). A landing still waiting for the user's approval (`pendingApproval`) that is
    // gone is NOT an uninstall but the user's DECLINE of the synced extension (the lead's
    // ruling, round 4): it tombstones nothing – the other devices keep the extension; the entry
    // stays frozen – and is remembered with its time (`Persisted.declinedExtensions`), so the
    // peer's record is not handed to the applier here again while the decline stands
    // (`extensionDeclineStands`). An extension whose winning record is with the host's applier
    // and not committed yet is left out of the collected set – its entry stays frozen, so the
    // copy the record found here never travels under the winner's time; the applier's commit is
    // the edit that publishes the applied state – but it still counts as present, since a switch
    // in flight is no uninstall. On a host without an applier the same absence holds an
    // extension whose record a remote copy won and nothing here could apply
    // (`unappliedExtensions`): present, frozen, off the wire until this device's own registry
    // changes for it.
    const host = this.browser.extensions
    const all = host.syncSources?.() ?? host.list()
    const present = new Map<string, boolean>()
    for (const ext of all)
      if (extensionStoreOf(ext.source)) present.set(ext.id, ext.pendingApproval === true)
    const removedExtensions = new Set<string>()
    let declined = this.data.declinedExtensions
    let declinedChanged = false
    if (this.presentExtensions) {
      const now = Date.now()
      for (const [id, wasPending] of this.presentExtensions) {
        if (present.has(id)) continue
        if (wasPending && !meta[id]?.deleted) {
          declined = { ...(declined ?? {}), [id]: now }
          declinedChanged = true
        } else removedExtensions.add(id)
      }
    }
    // An install of a declined id here closes the decline: the extension is this device's now.
    if (declined) {
      const kept = Object.entries(declined).filter(([id]) => !present.has(id))
      if (kept.length !== Object.keys(declined).length) {
        declined = Object.fromEntries(kept)
        declinedChanged = true
      }
    }
    if (declinedChanged) {
      if (declined && Object.keys(declined).length > 0) this.data.declinedExtensions = declined
      else delete this.data.declinedExtensions
      this.persist()
    }
    this.presentExtensions = present
    const inFlight = host.syncedExtensionsInFlight?.()
    const unapplied = this.unappliedExtensions(all)
    const extensions =
      (inFlight && inFlight.size > 0) || unapplied.size > 0
        ? all.filter((ext) => !inFlight?.has(ext.id) && !unapplied.has(ext.id))
        : all
    return {
      model: state.model,
      settings: state.settings,
      shortcutOverrides: state.shortcutOverrides,
      bookmarks: state.bookmarks,
      boosts: this.browser.boosts.all(),
      credentials: this.browser.passwords.syncSources(),
      siteData: this.browser.siteData.policy(),
      readingList: state.readingList,
      mods: this.browser.mods.all(),
      extensions,
      removedExtensions
    }
  }

  /**
   * The ids `Persisted.unappliedExtensions` still holds against the registry as read now: one
   * whose copy hashes as it did at the take stays held, out of the collected set; one whose
   * copy changed – the user's flip here – or is gone is released, the diff that follows the
   * edit that publishes it, stamped fresh. Empty on a host with an applier, which holds none.
   */
  private unappliedExtensions(all: readonly ExtensionSyncSource[]): Set<string> {
    const held = this.data.unappliedExtensions
    if (!held) return new Set()
    const hashes = new Map<string, string | null>()
    for (const ext of all) hashes.set(ext.id, extensionSourceHash(ext))
    const still = new Set<string>()
    const next: Record<string, string> = {}
    for (const [id, hash] of Object.entries(held)) {
      if (hashes.get(id) !== hash) continue
      still.add(id)
      next[id] = hash
    }
    if (still.size !== Object.keys(held).length) {
      if (still.size > 0) this.data.unappliedExtensions = next
      else delete this.data.unappliedExtensions
      this.persist()
    }
    return still
  }

  /**
   * The round took `winners` on a host that cannot apply an `extension` record (ID-44): each
   * extension winner whose extension this device holds is held as unapplied, under its copy's
   * hash as it stands, before the round's re-snapshot – which then leaves the id out, keeps
   * the winner's entry (`frozenRecords`) and publishes nothing under it; the copy this device
   * could not change never travels under the winner's stamp. Released by `sources()` once the
   * copy changes here or the extension is gone.
   */
  private holdUnapplied(winners: readonly SyncRecord[], sources: LocalSources): void {
    const local = collectLocal(sources, this.data.scope)
    let held = this.data.unappliedExtensions
    for (const w of winners) {
      if (w.type !== 'extension') continue
      const mine = local.get(w.id)
      if (!mine) continue
      held = { ...(held ?? {}), [w.id]: hashData(mine.data) }
    }
    if (held) this.data.unappliedExtensions = held
  }

  /**
   * The winners as they go to the host, less the extension records the user declined here
   * (ID-44; `Persisted.declinedExtensions`): a live winner whose install is not later than the
   * decline (`installedAt`; `extensionDeclineStands`) stands declined – it stays among the
   * winners for the metadata merge (the entry follows the peer's copy, so nothing is
   * re-published under this device's name) but is not handed to the applier; a live winner
   * carrying a later install (a fresh install of the id by hand on a peer) or a tombstone for
   * the id closes the decline and goes through as any winner.
   */
  private admitDeclined(winners: readonly SyncRecord[]): SyncRecord[] {
    const declined = this.data.declinedExtensions
    if (!declined) return [...winners]
    const out: SyncRecord[] = []
    let next: Record<string, number> | null = null
    for (const w of winners) {
      const at = w.type === 'extension' ? declined[w.id] : undefined
      if (at === undefined) {
        out.push(w)
        continue
      }
      if (extensionDeclineStands(at, w)) continue
      next ??= { ...declined }
      delete next[w.id]
      out.push(w)
    }
    if (next) {
      if (Object.keys(next).length > 0) this.data.declinedExtensions = next
      else delete this.data.declinedExtensions
      this.persist()
    }
    return out
  }

  /** Every other device's newest records; a folder that cannot be read throws. */
  private async readRemote(): Promise<Map<string, SyncRecord>> {
    if (!this.transport || !this.key) return new Map()
    const files = (await readDeviceFiles(this.transport)).filter(
      (f) => f.deviceId !== this.data.deviceId
    )
    const lists: SyncRecord[][] = []
    const devices = new Map(this.data.devices.map((d) => [d.id, d]))
    const origins = new WeakMap<SyncRecord, string>()
    for (const file of files) {
      try {
        const payload = await decryptJson<Payload>(this.key, file.envelope)
        if (payload?.v === 1 && Array.isArray(payload.records)) {
          lists.push(payload.records)
          // Which device said it, per record (the extension removal's toast names it, ID-44):
          // `newestByRecord` keeps the record objects themselves, so the name follows each.
          for (const r of payload.records) origins.set(r, file.deviceName)
        }
        devices.set(file.deviceId, {
          id: file.deviceId,
          name: file.deviceName,
          lastSeen: file.updatedAt,
          ...(file.kind ? { kind: file.kind } : {})
        })
      } catch {
        this.lastError = `Could not decrypt data from "${file.deviceName}" (different passphrase?)`
      }
    }
    this.data.devices = [...devices.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20)
    this.remoteOrigins = origins
    return newestByRecord(lists)
  }

  /** The device that published a record the last `readRemote` read, as it names itself. */
  private originOf(record: SyncRecord): string | null {
    return this.remoteOrigins?.get(record) ?? null
  }

  /** One full round: pull + merge remote changes, then publish our record set. */
  syncNow(): Promise<void> {
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<void> {
    // A refused sign-in stops the rounds outright – Sync now included: a request with the dead
    // app password is what a server's brute-force protection counts (Nextcloud's: per address,
    // 25 s delays then a block for every client behind it) – until `setWebDavPassword`. A
    // sign-in the account service ended holds them the same way, until the user signs in again.
    if (
      !this.data.enabled ||
      !this.transport ||
      !this.key ||
      this.data.pendingMerge ||
      this.authRefused ||
      this.accountSignedOut
    )
      return
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    this.syncing = true
    this.lastError = null
    this.lastErrorKind = null
    this.browser.state.commitVolatile()
    try {
      const remote = await this.readRemote()
      // A state broadcast already scheduled (the store defers them a macrotask) is delivered
      // before the local set is read, so an edit it carries reaches the diff below stamped by
      // `onLocalChange` – the round never stamps, and would otherwise publish that edit under
      // its previous timestamp and adopt its hash, leaving it unstamped for good.
      await new Promise<void>((resolve) => defer(resolve))
      const now = Date.now()
      const scope = this.data.scope
      const sources = this.sources()
      // The local snapshot, `stamp: null`: an edit made since the last round is already stamped
      // (`onLocalChange`, at its commit), and a hash change the round alone sees is not an edit
      // – it keeps its `modified` (`DiffLocalOptions.stamp` names the rule and the fault).
      let local = diffLocal(this.data.meta, collectLocal(sources, scope), now, {
        stamp: null,
        frozen: frozenRecords(sources, scope, this.data.meta)
      })
      // Types turned off are not received either (Chrome's toggles), and the vault's records
      // (logins, addresses, payment cards) wait for the vault to be open: left out of the
      // metadata, they win again next round. A vault record this build cannot read (a kind of
      // `credential` from a later build, garbage) is left out the same way, every round: a
      // winner that lands nothing would otherwise be tombstoned at the re-snapshot below, and
      // the tombstone applied by the peer that made it (`vaultRecordReadable`). An `extension`
      // record this build cannot read (a store a later build knows) follows the same rule
      // (`extensionRecordReadable`): never applied, never in the metadata, never tombstoned –
      // found and skipped again each round.
      const vaultOpen = Boolean(sources.credentials)
      const winners = winningRemote(local.meta, remote).filter(
        (r) =>
          inScope(r, scope) &&
          (!isVaultRecordType(r.type) || (vaultOpen && vaultRecordReadable(r))) &&
          extensionRecordReadable(r)
      )
      // The extension records this device took but whose install has not landed (ID-44): handed
      // to the host again, every round, beside the winners – its own back-off decides whether it
      // tries the store again. They are already in the metadata: nothing below is theirs. A
      // record the user declined here is handed over neither way while the decline stands
      // (`admitDeclined`, `pendingExtensionRequests`).
      const outstanding = pendingExtensionRequests(
        local.meta,
        collectLocal(sources, scope),
        remote,
        winners,
        scope,
        this.data.declinedExtensions ?? {}
      )
      const handed = [...this.admitDeclined(winners), ...outstanding]
      if (handed.length) {
        this.applying = true
        try {
          applyRemote(this.browser, handed, (r) => this.originOf(r))
        } finally {
          this.applying = false
        }
      }
      if (winners.length) {
        // Re-snapshot after applying; remote winners keep their own timestamps. `stamp: null`
        // here too: a winner this device's sanitisers normalise differently from the peer that
        // sent it re-publishes under the PEER's timestamp, so every peer skips it (`<=`) – two
        // builds' normal forms never bounce a record back and forth. The settings winner is a
        // set of keys: its entry is this device's with those keys at the peer's times, and the
        // re-snapshot places each key the same way (`diffSettings`).
        const merged: MetaMap = { ...local.meta, ...metaFromRemote(winners, local.meta) }
        // A host without an applier changed nothing for an extension winner (ID-44): the copy it
        // holds is held as unapplied before the re-snapshot reads the registry, so the id is
        // left out – the winner's entry kept, nothing published under it – and not re-published
        // under the winner's stamp (`holdUnapplied`).
        if (!this.browser.extensions.applySyncedExtensions) this.holdUnapplied(winners, sources)
        // Read against the merged metadata: a pending landing a winner's tombstone removed (a
        // host that acts on the hand-over at once) is that tombstone's doing, not a decline.
        const after = this.sources(merged)
        local = diffLocal(merged, collectLocal(after, scope), now, {
          stamp: null,
          frozen: frozenRecords(after, scope, merged)
        })
        for (const w of winners) {
          // The settings entry the re-snapshot made is the one to keep: per key at the peer's
          // times, the record hash this device's own – the winner whole has nothing to add.
          if (isSettingsRecord(w.id, w.type)) continue
          const entry = local.meta[w.id]
          const fromRemote = metaFromRemote([w])[w.id]
          if (entry && fromRemote && entry.hash === fromRemote.hash) local.meta[w.id] = fromRemote
          else if (!entry && w.deleted) local.meta[w.id] = fromRemote
        }
      }
      this.data.meta = local.meta
      const kind = this.host.deviceKind?.()
      // Through the account an unchanged device file waits for its heartbeat
      // (`DEVICE_FILE_HEARTBEAT_MS`): the plaintext is compared, the ciphertext never repeats.
      const fingerprint =
        this.data.transport === 'account'
          ? hashData({ records: local.records, name: this.data.deviceName, kind: kind ?? null })
          : null
      const published = this.published
      if (
        fingerprint === null ||
        published?.hash !== fingerprint ||
        now - published.at >= DEVICE_FILE_HEARTBEAT_MS
      ) {
        const file: DeviceFile = {
          deviceId: this.data.deviceId,
          deviceName: this.data.deviceName,
          ...(kind ? { kind } : {}),
          updatedAt: now,
          envelope: await encryptJson(this.key, this.data.salt ?? newSalt(), {
            v: 1,
            records: local.records
          } satisfies Payload)
        }
        await this.transport.write(deviceFileName(this.data.deviceId), serializeDeviceFile(file))
        this.published = fingerprint === null ? null : { hash: fingerprint, at: now }
      }
      // The documents: the folder listed once for the three.
      const names = await this.transport.list()
      await this.syncHistory(this.transport, this.key, names, now)
      await this.syncOpenTabs(this.transport, this.key, names, now)
      await this.syncInbox(this.transport, this.key, names, now)
      this.data.lastSyncAt = now
      this.folderLost = false
      this.authRefused = false
      this.conflictRetries = 0
      this.persist()
    } catch (error) {
      if (isFolderLost(error)) {
        this.folderLost = true
        this.lastError = FOLDER_LOST_MESSAGE
      } else if (isWebDavError(error) && error.kind === 'auth') {
        // The server refused the sign-in: the app password was revoked or changed. Sync stays
        // configured, and nothing more is sent with that password – the poll and any pending
        // push stop here, `run()` and `schedulePush` hold – until the chrome brings a new one
        // (`setWebDavPassword`), whose connect starts the timers again.
        this.authRefused = true
        this.lastError = error.message
        this.lastErrorKind = error.kind
        this.stopTimers()
      } else if (isSignedOut(error)) {
        // The account service ended the sign-in (signed out from the website, the account
        // deleted, a refresh refused). A round of a session a new sign-in has since replaced
        // says nothing of the new one. Otherwise, as a refused app password: nothing more is
        // sent until the user signs in again (`startAccountLink`), and the dead refresh token
        // leaves the store; the account stays named for the chrome's "Sign in again".
        if (this.accountSession && !this.accountSession.signedOut) return
        this.accountSignedOut = true
        this.lastError = accountErrorMessage('signed-out')
        this.lastErrorKind = 'signed-out'
        this.stopTimers()
        void forgetAccountSecrets(this.browser.platform.secrets)
      } else if (
        isWebDavError(error) &&
        error.kind === 'conflict' &&
        this.conflictRetries < WEBDAV_CONFLICT_RETRIES
      ) {
        // A precondition failed or a resource is locked by another client: the round is run
        // again after the push debounce, quietly, a few times before it shows as an error.
        this.conflictRetries += 1
        this.schedulePush()
      } else if (isAccountError(error)) {
        this.lastError = accountErrorMessage(error.kind)
        this.lastErrorKind = error.kind
      } else {
        this.lastError = (error as Error).message || 'Sync failed'
        this.lastErrorKind = isWebDavError(error) ? error.kind : null
      }
    } finally {
      this.syncing = false
      this.browser.state.commitVolatile()
    }
  }

  // ---------------------------------------------------------------------------
  // The history stream (ID-13 / HB-48)
  // ---------------------------------------------------------------------------

  /** Begin (or resume) publishing the backlog: the retention window past what went out before. */
  private startSeed(now: number): void {
    const state = this.data.history
    const since = Math.max(now - RETENTION_MS, state.publishedUntil + 1)
    state.seed = { since: seedFloor(this.browser.history, since, now), until: now, cursor: null }
  }

  /**
   * "Keep this device's data" at the merge question: the other devices' streams are followed
   * from their current end, nothing published so far is taken in.
   */
  private async skipRemoteHistory(): Promise<void> {
    if (!this.transport || !this.key) return
    const names = await this.transport.list()
    const streams = this.streamsIn(names)
    for (const [dev, seqs] of streams) {
      const last = Math.max(...seqs)
      const doc = await readDocument(this.transport, historyPageName(dev, last))
      if (!doc) continue
      try {
        const page = readHistoryPage(await decryptJson(this.key, doc.envelope))
        if (page) {
          const cursor: StreamCursor = advanceCursor(page)
          if (!page.sealed) cursor.updatedAt = doc.updatedAt
          this.data.history.cursors[dev] = cursor
        }
      } catch {
        // Unreadable: the stream is read from its start like any other.
      }
    }
  }

  /** The other devices' history pages in the folder: (reduced) device id → sequence numbers. */
  private streamsIn(names: string[]): Map<string, number[]> {
    const streams = new Map<string, number[]>()
    for (const name of names) {
      const parsed = parseHistoryPageName(name)
      if (!parsed || ownsName(this.data.deviceId, parsed.deviceId)) continue
      const seqs = streams.get(parsed.deviceId) ?? []
      seqs.push(parsed.seq)
      streams.set(parsed.deviceId, seqs)
    }
    return streams
  }

  /**
   * This device's stream out, the others' in. Out: the backlog under way (a few pages a round),
   * the buffer written as pages, pages past retention removed. In: every other stream from its
   * cursor on, each page applied once through the model's batch import and delete paths, the
   * events that raises kept out of this device's stream (`applyingHistory`).
   */
  private async syncHistory(
    transport: SyncTransport,
    key: Uint8Array,
    names: string[],
    now: number
  ): Promise<void> {
    const state = this.data.history
    if (!this.data.scope.history) return
    // 1. The backlog: some pages of the model's export per round, the rest next round.
    let seeded = 0
    while (state.seed && seeded < HISTORY_PAGES_PER_ROUND) {
      const page = this.browser.history.exportVisits({
        since: state.seed.since,
        until: state.seed.until,
        cursor: state.seed.cursor
      })
      appendOpen(state, entriesFromVisits(page.visits))
      if (page.next === null) state.seed = null
      else state.seed.cursor = page.next
      seeded += 1
    }
    // 2. The buffer as pages (the visits not yet out with the titles their pages have by now);
    //    the state moves only once every write went through.
    refreshTitles(state, (url) => this.browser.history.titleFor(url))
    const plannedOpen = state.open.length
    const { writes, after } = planWrites(state)
    for (const w of writes) {
      await this.writeDocument(
        transport,
        historyPageName(this.data.deviceId, w.seq),
        'history',
        w.page,
        now
      )
    }
    if (writes.length) takeWrites(state, after, plannedOpen)
    // 3. Pages whose newest event is past the retention window, or beyond the count cap.
    for (const seq of expiredPages(state, now)) {
      await transport.remove(historyPageName(this.data.deviceId, seq))
      state.pages = state.pages.filter((p) => p.seq !== seq)
    }
    // 4. The other streams, from where this device left each (a round reads so many pages of
    //    one stream; the rest follow in the next).
    let more = false
    for (const [dev, seqs] of this.streamsIn(names)) {
      let cursor = state.cursors[dev]
      const wanted = pagesToRead(seqs, cursor)
      if (wanted.length && Math.max(...seqs) > wanted[wanted.length - 1]) more = true
      for (const seq of wanted) {
        const doc = await readDocument(transport, historyPageName(dev, seq))
        if (!doc || doc.kind !== 'history') continue
        if (cursor && cursor.seq === seq && cursor.updatedAt === doc.updatedAt) continue
        let page
        try {
          page = readHistoryPage(await decryptJson(key, doc.envelope))
        } catch {
          this.lastError = `Could not decrypt history from "${doc.deviceName}" (different passphrase?)`
          break
        }
        if (!page) continue
        const from = cursor && cursor.seq === seq ? Math.min(cursor.index, page.entries.length) : 0
        this.applyingHistory = true
        try {
          applyEntries(this.browser.history, page.entries, from, state.deletions, now)
        } finally {
          this.applyingHistory = false
        }
        // An open page is read again only once its document changed; a sealed one is past.
        cursor = advanceCursor(page)
        if (!page.sealed) cursor.updatedAt = doc.updatedAt
        state.cursors[dev] = cursor
      }
    }
    if (state.seed || more) this.schedulePush()
  }

  // ---------------------------------------------------------------------------
  // Open tabs (ID-28)
  // ---------------------------------------------------------------------------

  /** Whether the list in the folder no longer matches this device's tabs. */
  private openTabsChanged(): boolean {
    if (!this.data.scope.openTabs) return this.data.openTabsHash !== null
    return (
      openTabsHash(collectOpenTabs(Object.values(this.browser.state.model.tabs))) !==
      this.data.openTabsHash
    )
  }

  /**
   * This device's list rewritten when it changed (removed with the type off), the others' read
   * when their document did – the toggle works both ways: off, nothing is shown either.
   */
  private async syncOpenTabs(
    transport: SyncTransport,
    key: Uint8Array,
    names: string[],
    now: number
  ): Promise<void> {
    const own = openTabsName(this.data.deviceId)
    if (!this.data.scope.openTabs) {
      if (this.data.openTabsHash !== null) {
        await transport.remove(own)
        this.data.openTabsHash = null
      }
      if (this.remoteTabs.size) {
        this.remoteTabs.clear()
        this.remoteTabsVersion += 1
      }
      return
    }
    const doc = collectOpenTabs(Object.values(this.browser.state.model.tabs))
    const hash = openTabsHash(doc)
    if (hash !== this.data.openTabsHash) {
      await this.writeDocument(transport, own, 'open-tabs', doc, now)
      this.data.openTabsHash = hash
    }
    let changed = false
    const seen = new Set<string>()
    for (const name of names) {
      const dev = parseOpenTabsName(name)
      if (!dev || ownsName(this.data.deviceId, dev)) continue
      seen.add(dev)
      const prev = this.remoteTabs.get(dev)
      const document = await readDocument(transport, name)
      if (!document || document.kind !== 'open-tabs') continue
      if (prev && prev.updatedAt === document.updatedAt) continue
      try {
        const tabs = readOpenTabs(await decryptJson(key, document.envelope))
        if (!tabs) continue
        this.remoteTabs.set(dev, {
          deviceId: document.deviceId,
          deviceName: document.deviceName,
          updatedAt: document.updatedAt,
          tabs: tabs.tabs
        })
        changed = true
      } catch {
        this.lastError = `Could not decrypt data from "${document.deviceName}" (different passphrase?)`
      }
    }
    for (const dev of [...this.remoteTabs.keys()]) {
      if (seen.has(dev)) continue
      this.remoteTabs.delete(dev)
      changed = true
    }
    if (changed) this.remoteTabsVersion += 1
  }

  // ---------------------------------------------------------------------------
  // Send to your devices (ID-27)
  // ---------------------------------------------------------------------------

  /**
   * The tabs the others sent this device: each opens once and its file goes; a send this
   * device already opened (the file came back with a cloud drive's hiccup) only goes. A send
   * left to anyone for `SEND_TTL_MS` is dropped by whoever sees it.
   */
  private async syncInbox(
    transport: SyncTransport,
    key: Uint8Array,
    names: string[],
    now: number
  ): Promise<void> {
    for (const name of names) {
      const parsed = parseInboxName(name)
      if (!parsed) continue
      const mine = ownsName(this.data.deviceId, parsed.targetId)
      if (mine && this.data.consumedSends.includes(parsed.sendId)) {
        await transport.remove(name)
        continue
      }
      const doc = await readDocument(transport, name)
      if (!doc) continue
      if (!mine) {
        if (now - doc.updatedAt > SEND_TTL_MS) await transport.remove(name)
        continue
      }
      let sent: SendTabDocument | null = null
      try {
        sent = readSendTab(await decryptJson(key, doc.envelope))
      } catch {
        this.lastError = `Could not decrypt a tab sent from "${doc.deviceName}" (different passphrase?)`
      }
      // Consumed first, whatever opening it does: a tab is never opened twice.
      this.data.consumedSends.push(parsed.sendId)
      if (this.data.consumedSends.length > SENDS_REMEMBERED)
        this.data.consumedSends.splice(0, this.data.consumedSends.length - SENDS_REMEMBERED)
      await transport.remove(name)
      if (sent && now - sent.at <= SEND_TTL_MS) this.openSentTab(sent)
    }
  }

  /**
   * A sent tab arrives: on a host with its own notification shade for the browser (Android) it
   * is posted there, under the app's "Sharing" channel, and opens on the tap (the tap of a
   * notification this core never showed opens its `url` – the existing path); elsewhere it
   * opens as a tab right away, with a toast naming the sender, as Chrome's desktop does.
   */
  private openSentTab(sent: SendTabDocument): void {
    const host = this.browser.platform.webNotifications
    if (host) {
      void host
        .show({
          id: `send/${sent.id}`,
          origin: new URL(sent.url).origin,
          tabId: '',
          url: sent.url,
          title: sendTabArrivedText(sent),
          body: sent.title || sent.url,
          icon: '',
          tag: '',
          silent: false,
          requireInteraction: false,
          renotify: false,
          timestamp: sent.at || Date.now(),
          channel: 'sharing'
        })
        .then((shown) => {
          if (!shown) this.openSentTabNow(sent)
        })
        .catch(() => this.openSentTabNow(sent))
      return
    }
    this.openSentTabNow(sent)
  }

  private openSentTabNow(sent: SendTabDocument): void {
    const win = this.browser.focusedWindow()
    this.browser.tabs.createTab({ url: sent.url, active: true }, win)
    this.browser.toast(sendTabArrivedText(sent), 'info', win)
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  private async writeDocument(
    transport: SyncTransport,
    name: string,
    kind: SyncDocumentKind,
    payload: unknown,
    now: number
  ): Promise<void> {
    if (!this.key) return
    const doc: SyncDocument = {
      kind,
      deviceId: this.data.deviceId,
      deviceName: this.data.deviceName,
      updatedAt: now,
      envelope: await encryptJson(this.key, this.data.salt ?? newSalt(), payload)
    }
    await transport.write(name, serializeDocument(doc))
  }

  /** Everything this device wrote: its record file, its pages, its tab list, its unread inbox. */
  private async removeOwnDocuments(transport: SyncTransport): Promise<void> {
    const id = this.data.deviceId
    await transport.remove(deviceFileName(id))
    for (const name of await transport.list()) {
      const page = parseHistoryPageName(name)
      const tabs = parseOpenTabsName(name)
      const inbox = parseInboxName(name)
      if (
        (page && ownsName(id, page.deviceId)) ||
        (tabs && ownsName(id, tabs)) ||
        (inbox && ownsName(id, inbox.targetId))
      )
        await transport.remove(name)
    }
  }

  private setBusy(busy: boolean): void {
    this.syncing = busy
    this.browser.state.commitVolatile()
  }

  private describe(error: unknown): string {
    if (isFolderLost(error)) return 'That folder cannot be opened. Choose another one.'
    const message = (error as Error)?.message
    return message ? `The folder could not be read: ${message}` : 'The folder could not be read.'
  }

  private persist(): void {
    this.store.write(this.data)
  }

  flushSync(): void {
    this.store.flushSync()
  }
}

/** The hash `collectLocal` gives an extension's record here, or null for one it does not publish. */
function extensionSourceHash(ext: ExtensionSyncSource): string | null {
  const store = extensionStoreOf(ext.source)
  return store && !ext.pendingApproval ? hashData(extensionRecordData(ext, store)) : null
}

/**
 * `Persisted.unappliedExtensions` as read from `sync.json`: extension ids to hash strings,
 * anything else dropped; undefined when nothing valid is held, so the key stays absent.
 */
function readUnappliedExtensions(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  let any = false
  for (const [id, hash] of Object.entries(value as Record<string, unknown>)) {
    if (!isExtensionId(id) || typeof hash !== 'string' || !hash) continue
    out[id] = hash
    any = true
  }
  return any ? out : undefined
}

/**
 * `Persisted.declinedExtensions` as read from `sync.json`: extension ids to the decline's time
 * (a finite number above 0), anything else dropped; undefined when nothing valid is held, so
 * the key stays absent.
 */
function readDeclinedExtensions(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  let any = false
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (!isExtensionId(id) || typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    out[id] = at
    any = true
  }
  return any ? out : undefined
}
