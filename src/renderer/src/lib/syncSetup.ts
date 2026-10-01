import type {
  AccountErrorKind,
  HostCapabilities,
  SyncAccountLinkFailure,
  SyncScope,
  SyncSetupRefusal,
  SyncStatus,
  SyncTransportKind,
  WebDavErrorKind,
  WebDavProbe,
  WebDavSyncCredentials
} from '@shared/types'
import { DEFAULT_WEBDAV_FOLDER, webDavFolderSegments } from '@core/sync/webdav'
import { cmd } from './api'
import { createStore } from './store'
import { browserStore, forgetToast, uiStore } from './ui'
import { relativeTime } from './utils'

/**
 * What the Sync settings builder (`pages/settings/sync.tsx`, the one section both hosts draw
 * since #193 put the desktop on the shared builder) keeps beside its rows: the words, the setup
 * draft kept between the rows, and the setup call turned into a form's answer.
 */

/** The engine's floor for a passphrase (`core/sync/engine.ts` refuses shorter ones). */
export const SYNC_PASSPHRASE_MIN = 8

/**
 * Chrome's sync-passphrase wording (its custom-passphrase dialog: the passphrase encrypts the
 * data, anyone holding it can read the data, nothing can recover a forgotten one), with Zenium
 * in Chrome's place; the folder sentence is Zen's ("Sync your Spaces across devices", 1.22).
 */
export const SYNC_COPY = {
  intro:
    'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Pick a folder that your cloud drive or Syncthing already keeps in sync and a passphrase: everything is encrypted on this device before it is written, so the folder only ever holds ciphertext.',
  // The same paragraph on a host that can also reach a WebDAV server (ID-32): the server is
  // named beside the folder, and the closing clause holds for both – "there" is the folder or
  // the server the sentence has just named (the lead's Q4 ruling on #628: one dash pair, the
  // clause reworded rather than a second pair); the folder-only paragraph keeps its own clause.
  introServer:
    'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Pick a folder that your cloud drive or Syncthing already keeps in sync – or a WebDAV server such as Nextcloud – and a passphrase: everything is encrypted on this device before it is written, so what is stored there is only ever ciphertext.',
  folder: 'Sync folder',
  folderUnset: 'Choose a folder that your cloud drive keeps in sync.',
  device: 'This device',
  deviceHint: 'The name other devices show for this one.',
  turnOn: 'Turn on sync',
  turnOnHint: 'Create the passphrase every device will share.',
  turnOnNeedsFolder: 'Choose a sync folder first.',
  turnOnNeedsServer: 'Fill in the server address, username and app password first.',
  // The transport choice (ID-32): where the encrypted records go. A value row on the phone
  // (§9.13's picker, the current option as the row's line) and §9.14's two radios on the
  // desktop; each option's second line is what makes it the choice.
  transport: 'Sync through',
  transportFolder: 'A folder on this device',
  transportFolderHint: 'Shared through your own cloud drive',
  transportWebDav: 'A WebDAV server',
  transportWebDavHint: 'Nextcloud and others',
  // The server form's rows (§9.12 fields in rows; the phone's one-field sheets). The address is
  // the DAV root as Nextcloud's own manual gives it for third-party clients
  // (`remote.php/dav/files/USERNAME/`); the app password is the one its Security settings make,
  // never the account's own – the manual's rule for every WebDAV client. An `http://` address
  // is taken (a home server on a LAN; the lead's Q1 ruling on #628) with its one risk stated
  // once, in the warn ink under the field once the field is left holding one – never while
  // typing, and not a refusal: the records are ciphertext either way, so the app password is
  // the one thing sent unprotected and the sentence names it alone.
  server: 'Server address',
  serverHint: 'For Nextcloud: https://cloud.example.com/remote.php/dav/files/USERNAME/',
  serverPlaceholder: 'https://',
  serverInvalid: 'Enter an address that starts with https:// or http://',
  serverPlainHttp: 'Over http:// the app password is sent unprotected.',
  username: 'Username',
  usernameHint: 'Your account on the server.',
  appPassword: 'App password',
  appPasswordHint:
    'Create one under Security in the server’s personal settings – never the account’s own password.',
  appPasswordSet: '••••••••',
  serverFolder: 'Folder',
  serverFolderHint: 'Where the zenium-sync folder is kept on the server.',
  serverRootFolder: 'The top level of your files',
  // The toast's word when the connected page's Folder row is copied from its hold's Copy – the
  // phone sheet's row, the tablet card's button (services seed #34; the lead: the toast "names
  // the row") – as "Version copied" is the version row's (SET-54).
  serverFolderCopied: 'Folder copied',
  // Test connection: an action row that reports its result in its description (§9.33: the ink
  // alone, no glyph) and is §9.30's busy row while the server is asked. The sentences are the
  // server's outcomes as the page speaks them everywhere one reaches the user
  // (`webDavOutcomeLine`: the Test row, the Turn on refusal, the line under Sync now) –
  // uncontracted, stated of the server or the address, a full stop each, and never a method
  // name or a status code (§9.33).
  // `notWebDav` is for an address that answers, but not as a WebDAV server; `forbidden` names
  // the folder, the row the user can change (the lead's Q3 ruling); `redirected` is an address
  // the server sends elsewhere – the host's fetch follows no redirect, so an `http://` address
  // bounced to `https://` says so and wants the https address typed.
  test: 'Test connection',
  testHint: 'Reaches the server with these details; nothing is written yet.',
  testing: 'Connecting…',
  connected: 'Connected.',
  refused: 'The server refused the sign-in.',
  unreachable: 'The server could not be reached.',
  notWebDav: 'The address did not answer as a WebDAV server.',
  forbidden: 'The server did not allow writing to the folder.',
  redirected: 'The address redirected elsewhere.',
  // The host's secret store could not keep the app password (the setup's and the App password
  // row's typed refusal, `SyncSetupRefusal.reason: 'secrets'`): what did not happen, stated of
  // the device, since the server took the details.
  appPasswordNotKept: 'The app password could not be kept on this device.',
  testAction: 'Test',
  // Connected through a server: the group's heading, and the rows that name the server in use.
  whereFolder: 'Folder and device',
  whereServer: 'Server and device',
  serverInUse: 'WebDAV server',
  authRefused: 'The server refused the sign-in',
  authRefusedHint: 'Enter a new app password to keep syncing.',
  appPasswordAgainHint: 'The one the server takes now; the old one is forgotten.',
  passphraseTitle: 'Create a passphrase',
  passphraseDescription:
    'Zenium uses your passphrase to encrypt your data. Anyone who has your passphrase can read your encrypted data. Zenium can’t recover your data if you forget your passphrase.',
  passphrase: 'Passphrase',
  confirm: 'Confirm passphrase',
  tooShort: `Use at least ${SYNC_PASSPHRASE_MIN} characters`,
  mismatch: 'Passphrases do not match',
  notTurnedOn: 'Sync could not be turned on',
  syncNow: 'Sync now',
  syncing: 'Syncing…',
  firstSync: 'Waiting for first sync',
  folderLost: 'The sync folder is no longer accessible',
  folderLostHint: 'Choose it again to keep syncing.',
  chooseAgain: 'Choose folder',
  mergeRow: 'This folder already has synced data',
  mergeRowHint: 'Choose how it comes together with this device to finish setting up.',
  mergeTitle: 'Combine with the data in this folder?',
  mergeDescription:
    'Another device has already synced to this folder. The first sync brings the two together the way you choose.',
  merge: 'Merge',
  mergeHint:
    'What the other devices synced is added to this device, and this device’s Spaces to theirs.',
  replace: 'Keep only this device’s data',
  // Two lines at the phone's width (§10.4 clamps a row's description at two).
  replaceHint:
    'Their Spaces, folders and settings are replaced with this device’s; passwords are always merged.',
  continue: 'Continue',
  devices: 'Other devices',
  noDevices: 'No other device has synced to this folder yet',
  // Chrome's label for the other devices' open tabs (ID-28); the row's descriptions are the
  // list's summary, or why there is none to open: the dependent row's parent (§10.4) or an
  // empty list (§9.17: a row that leads to an empty list is disabled, not left to open it).
  // The two sentences take the full stop the page's other sentences carry; a group's empty
  // line (§9.17) takes none.
  remoteTabs: 'Tabs from other devices',
  remoteTabsOff: 'Turn on Open tabs in What you sync to see them.',
  remoteTabsNone: 'No open tabs on your other devices yet.',
  remoteTabsDeviceEmpty: 'No open tabs on this device',
  scope: 'What you sync',
  turnOff: 'Turn off sync',
  turnOffHint: 'This device stops syncing and keeps what it has.',
  turnOffTitle: 'Turn off sync?',
  turnOffDescription:
    'This device stops syncing and keeps everything it has. Other devices keep syncing with each other.',
  // The prompt's one choice on both hosts (§9.23): a checkbox row submitted with Turn off, never
  // a row or a second action of its own.
  wipeRemote: 'Also remove this device’s data from the folder',
  wipeRemoteHint: 'Other devices forget what this one synced; what they have of their own stays.',
  turnOffAction: 'Turn off',
  // The Zenium account (the third transport, first among them where the host reaches the
  // service): the paragraph that names it before the folder and the server, its option in Sync
  // through, and the sign-in's rows – Sign in opens the service's page in a new tab, the code
  // stands with the wait and Cancel until the tab is approved, then the account's email with
  // Sign out; the passphrase step is Turn on sync's, as for the other two.
  introAccount:
    'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Sign in to your Zenium account – or pick a folder that your cloud drive keeps in sync, or a WebDAV server such as Nextcloud – and choose a passphrase: everything is encrypted on this device before it is sent, so what is stored is only ever ciphertext.',
  transportAccount: 'Zenium account',
  transportAccountHint: 'Recommended – nothing else to set up',
  account: 'Zenium account',
  accountSignIn: 'Sign in',
  accountSignInHint: 'Opens the sign-in page in a new tab.',
  accountSignInAgain: 'Sign in again',
  accountWaiting: 'Waiting for you to sign in in the new tab…',
  accountCancel: 'Cancel sign-in',
  accountCancelAction: 'Cancel',
  accountSignOut: 'Sign out',
  accountSignOutHint: 'This device forgets the sign-in.',
  accountSignOutSyncHint: 'This device stops syncing and keeps what it has.',
  accountSignOutTitle: 'Sign out of your Zenium account?',
  accountSignOutDescription:
    'This device stops syncing and keeps everything it has. Your other devices keep syncing.',
  accountSignedOut: 'You were signed out of your Zenium account',
  accountSignedOutHint: 'Sign in again to keep syncing.',
  accountCodeExpired: 'The code expired before the sign-in finished.',
  accountNotKept: 'The sign-in could not be kept on this device.',
  turnOnNeedsAccount: 'Sign in to your Zenium account first.',
  whereAccount: 'Account and device',
  noDevicesAccount: 'No other device has synced to this account yet',
  mergeRowAccount: 'Your Zenium account already has synced data',
  mergeTitleAccount: 'Combine with the data in your account?',
  mergeDescriptionAccount:
    'Another device has already synced to your Zenium account. The first sync brings the two together the way you choose.',
  wipeRemoteAccount: 'Also remove this device’s data from your Zenium account',
  // The account's outcomes as the page says them (`accountOutcomeLine`): what happened, stated
  // of the account, a full stop each, never a code or a status (§9.33).
  accountSignedOutLine: 'You were signed out of your Zenium account.',
  accountQuota: 'Your Zenium account’s sync storage is full.',
  accountTooLarge: 'Some of this device’s data is too large to sync.',
  accountRateLimited: 'Too many requests to your Zenium account. Try again in a moment.',
  accountUnreachable: 'Your Zenium account could not be reached.',
  accountRefused: 'Your Zenium account did not accept the request.'
} as const

/**
 * Settings › Account: the Zenium account on a page of its own – the sign-in by email, the sync
 * it carries and its status, the other devices, Sign out. The sign-in rows and the device rows
 * are Sync's (`accountSignInRows`, `deviceRows`); these are the page's own sentences.
 */
export const ACCOUNT_COPY = {
  heading: 'Zenium account',
  intro:
    'Sign in to sync your bookmarks and settings across devices. Everything is encrypted on this device before it is sent, so what is stored is only ever ciphertext.',
  introSignedIn:
    'Your Spaces, folders, pinned tabs, bookmarks, passwords and settings stay the same on every device you sign in on.',
  signedInAs: 'Signed in as',
  unavailable: 'Not available on this device',
  unavailableHint: 'This device cannot reach the Zenium account service.',
  sync: 'Sync',
  syncOff: 'Off',
  syncOffHint: 'Turn on sync to keep this device’s data the same as your other devices’.',
  turnOn: 'Turn on sync',
  // Sync is set up another way on this device: a fact, with the way to the account under Sync.
  syncElsewhereFolder: 'This device syncs through a folder, not your account.',
  syncElsewhereServer: 'This device syncs through a WebDAV server, not your account.',
  syncElsewhereHint: 'Turn off sync under Sync to sync through your account instead.',
  settings: 'Sync settings',
  settingsHint: 'What you sync, this device’s name and the other ways to sync.',
  settingsAction: 'Open',
  devices: 'Devices',
  noDevicesOff: 'Turn on sync to see your other devices',
  thisDevice: 'This device'
} as const

/** Settings › Sync › What you sync › Extensions (services pass 16, ID-44): the lead's label, verbatim. */
export const EXTENSIONS_SCOPE_LABEL = 'Extensions'
/** The Extensions row's hint (ID-44): the lead's words, verbatim. */
export const EXTENSIONS_SCOPE_HINT =
  'Store extensions and whether they are enabled and pinned; unpacked ones stay on this device.'

/**
 * The one hint of the Addresses and Payment methods rows (services pass 16, ID-45; the lead's
 * words): the fact the name cannot carry – the protection – as the Passwords hint carries it.
 */
const SYNC_SCOPE_ENCRYPTED_HINT = 'Encrypted with your sync passphrase.'

/**
 * The data types in the page's own order: Chrome's types first – Bookmarks, History, Open tabs,
 * Passwords, Addresses, Payment methods, Reading list, Settings, Extensions; Chrome's "Manage
 * what you sync" seats Reading list directly after Bookmarks, ours sits after the vault's three,
 * as the lead seated it, and Extensions closes Chrome's list, after Settings and before Spaces
 * (the lead's seat, round 4) – then Zenium's own: Spaces, folders, pinned tabs, Essentials,
 * containers, shortcuts, Boosts, Mods. Every key of `SyncScope` is here once (the engine's
 * toggles are the page's). A row with `requires` shows on the hosts with that capability alone
 * (`scopeGroup`): the Extensions row where extensions install.
 */
export const SYNC_SCOPES: ReadonlyArray<{
  key: keyof SyncScope
  label: string
  hint?: string
  requires?: keyof HostCapabilities
}> = [
  { key: 'bookmarks', label: 'Bookmarks' },
  { key: 'history', label: 'History' },
  { key: 'openTabs', label: 'Open tabs', hint: 'Unpinned tabs arrive unloaded on other devices.' },
  {
    key: 'passwords',
    label: 'Passwords',
    hint: 'Saved passwords and passkey records, encrypted with your sync passphrase.'
  },
  // The vault's addresses and payment cards (services pass 16, ID-45; the `address` and
  // `payment-method` records): Chrome's "Addresses and more" and "Payment methods" types, a
  // toggle each, seated right after Passwords – the vault's three together – as the lead ruled,
  // with the lead's one hint on both.
  { key: 'addresses', label: 'Addresses', hint: SYNC_SCOPE_ENCRYPTED_HINT },
  { key: 'paymentMethods', label: 'Payment methods', hint: SYNC_SCOPE_ENCRYPTED_HINT },
  // The reading list's row (services pass 11, the `reading-list-entry` record). No hint: a hint
  // here carries a fact the name cannot (a behaviour, a protection, a scope), never a
  // restatement – "Reading list" stands on its name as Bookmarks and History do (the lead's rule).
  { key: 'readingList', label: 'Reading list' },
  { key: 'settings', label: 'Settings' },
  // The Extensions row (services pass 16, ID-44, the `extension` record): Chrome's type of the
  // same name, seated where the lead seated it – after Settings, before Spaces: the last of
  // Chrome's types, ahead of Zenium's own. The lead's words verbatim, label and hint – the hint
  // carries the two facts the name cannot: what of an extension travels, and which extensions
  // stay. Drawn on every host that installs extensions (`requires`): the desktop and the phone
  // both install from the stores; a host without the capability has no row and nothing to
  // publish.
  {
    key: 'extensions',
    label: EXTENSIONS_SCOPE_LABEL,
    hint: EXTENSIONS_SCOPE_HINT,
    requires: 'extensions'
  },
  { key: 'spaces', label: 'Spaces', hint: 'Names, icons, themes and order.' },
  { key: 'folders', label: 'Folders' },
  { key: 'pinnedTabs', label: 'Pinned tabs' },
  { key: 'essentials', label: 'Essentials' },
  { key: 'containers', label: 'Containers' },
  { key: 'shortcuts', label: 'Keyboard shortcuts' },
  { key: 'boosts', label: 'Boosts' },
  // The Mods' row (services pass 15, ID-43, the `mod` record): the browser chrome's CSS mods,
  // named as Settings › Mods names them. Chrome's row for the type is "Themes" (its one theme
  // per profile, `UserSelectableType::kThemes`); ours toggles the Mod list alone – the look
  // settings travel with Settings and each space's theme with Spaces – so the row says what it
  // moves. No hint, as with Boosts (the lead's rule: a hint never restates the name). DRAFT
  // until the lead approves the label.
  { key: 'mods', label: 'Mods' }
]

/**
 * The Settings row id of a data type's switch in What you sync (`sync.tsx`'s scope group): what
 * `zen://settings/sync?row=<id>` brings on screen – the History page's "Open sync settings"
 * row lands on the Open tabs switch this way.
 */
export function syncScopeRowId(key: keyof SyncScope): string {
  return `sync-scope:${key}`
}

/** The one-line status of a connected device: syncing, the last sync's age, or the wait for the first. */
export function syncStatusLine(sync: SyncStatus, now = Date.now()): string {
  if (sync.syncing) return SYNC_COPY.syncing
  if (sync.lastSyncAt) return `Last synced ${midSentence(relativeTime(sync.lastSyncAt, now))}`
  return SYNC_COPY.firstSync
}

/**
 * An age after "Last synced": `relativeTime` opens a line of its own on a device row ("Just
 * now"), so it capitalises; after a phrase the word is lower case (§9.1). A count or a date
 * starts with a digit and is left as it is.
 */
function midSentence(age: string): string {
  return age.charAt(0).toLowerCase() + age.slice(1)
}

/**
 * Test connection's state (ID-32): nothing asked yet, the server being asked (§9.30's busy
 * row), or the last answer – kept until a detail of the form changes, since the answer was to
 * those details.
 */
export type SyncProbeState =
  { state: 'idle' } | { state: 'busy' } | { state: 'done'; probe: WebDavProbe }

/**
 * What the setup rows have collected but not set up yet (`sync.setup` has not run): the page is
 * rebuilt from the browser state on every render and the engine knows nothing of a folder or a
 * server until setup, so the draft lives here between the rows – the folder `sync.chooseFolder`
 * returned, the transport picked, the server's details with the app password typed for it (in
 * this process's memory alone, never a store on disk; the engine keeps it in the host's secret
 * store once setup has run), and Test connection's answer. Cleared once sync is on, or turned
 * off (`clearSyncSetup`).
 */
export interface SyncSetupDraft {
  folder: string | null
  /** The transport picked in Sync through; null until one is, the host's default (`setupTransport`). */
  transport: SyncTransportKind | null
  webdav: WebDavSyncCredentials
  probe: SyncProbeState
}

/**
 * The transport the setup rows are for: the one picked, if the host can reach it, else the
 * host's first – the Zenium account where it reaches the service, a folder elsewhere. A draft
 * that names a transport the host cannot reach is read as the folder.
 */
export function setupTransport(
  sync: Pick<SyncStatus, 'accountAvailable' | 'webdavAvailable'>,
  picked: SyncTransportKind | null
): SyncTransportKind {
  const transport = picked ?? (sync.accountAvailable ? 'account' : 'folder')
  if (transport === 'account' && !sync.accountAvailable) return 'folder'
  if (transport === 'webdav' && !sync.webdavAvailable) return 'folder'
  return transport
}

/**
 * The folder the server form starts with: the engine's default by its name – `Zenium`, the
 * folder under the account's files that holds the `zenium-sync` directory, with no trailing
 * slash. The one value the connected page's Folder row reads back (`webDavFolderLine`), so
 * the two surfaces say the same thing; the engine reads `Zenium` and `Zenium/` alike
 * (`webDavFolderSegments`).
 */
export const WEBDAV_FOLDER_DEFAULT = DEFAULT_WEBDAV_FOLDER

export function emptySyncSetup(): SyncSetupDraft {
  return {
    folder: null,
    transport: null,
    webdav: { url: '', username: '', password: '', folder: WEBDAV_FOLDER_DEFAULT },
    probe: { state: 'idle' }
  }
}

export const syncSetupStore = createStore<SyncSetupDraft>(emptySyncSetup(), 'syncSetup')

/** Back to the empty draft: sync is on (the app password has gone to the engine) or turned off. */
export function clearSyncSetup(): void {
  syncSetupStore.set(emptySyncSetup())
}

/**
 * A detail of the server form changed: the draft takes it and the last test's answer no longer
 * applies (it answered the details before), so the row is back to its hint.
 */
export function editWebDavDraft(patch: Partial<WebDavSyncCredentials>): void {
  const { webdav } = syncSetupStore.get()
  syncSetupStore.set({ webdav: { ...webdav, ...patch }, probe: { state: 'idle' } })
}

/**
 * Why an address cannot be a server's, or nothing: a URL with an http or https scheme. The
 * form's other details are free text; an empty address is not refused here (the row is simply
 * not filled in yet – Test connection and Turn on sync wait on it), so a field the user clears
 * carries no error.
 */
export function webDavAddressProblem(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return undefined
  } catch {
    // Not a URL at all: the sentence below.
  }
  return SYNC_COPY.serverInvalid
}

/**
 * What an address the form keeps costs, or nothing: an `http://` address sends the app password
 * in the clear (Basic auth is the password base64-encoded, RFC 7617 §2), so the row states it
 * once under the field – the warn ink, not a refusal (`FieldRow.warning`), and only for an
 * address the field has been left holding, since the builder reads the committed draft. The
 * records themselves are ciphertext over either scheme.
 */
export function webDavAddressWarning(url: string): string | undefined {
  try {
    if (new URL(url.trim()).protocol === 'http:') return SYNC_COPY.serverPlainHttp
  } catch {
    // Not a URL: `webDavAddressProblem` has refused it, or the field is empty.
  }
  return undefined
}

/** The server form has what a connection needs: a valid address, a username and an app password. */
export function webDavDraftComplete(webdav: WebDavSyncCredentials): boolean {
  return (
    webdav.url.trim() !== '' &&
    webDavAddressProblem(webdav.url) === undefined &&
    webdav.username.trim() !== '' &&
    webdav.password !== ''
  )
}

/** The credentials as the engine takes them: trimmed, the folder as typed (the engine splits it). */
export function webDavCredentials(webdav: WebDavSyncCredentials): WebDavSyncCredentials {
  return {
    url: webdav.url.trim(),
    username: webdav.username.trim(),
    password: webdav.password,
    folder: webdav.folder.trim()
  }
}

/**
 * Test connection: the engine reaches the DAV root once with the form's details (PROPFIND
 * `Depth: 0` – nothing is created) and the row reports the answer. The row is busy while it
 * runs; a second press while busy does nothing; an answer to details that have since changed is
 * dropped (the edit put the row back to idle, and the answer was to the old details).
 */
export async function testWebDavConnection(): Promise<void> {
  const draft = syncSetupStore.get()
  if (draft.probe.state === 'busy' || !webDavDraftComplete(draft.webdav)) return
  const asked = draft.webdav
  syncSetupStore.set({ probe: { state: 'busy' } })
  let probe: WebDavProbe
  try {
    probe = await cmd('sync.testWebDav', webDavCredentials(asked))
  } catch {
    probe = { ok: false, kind: 'unavailable', status: 0 }
  }
  if (syncSetupStore.get().webdav !== asked) return
  syncSetupStore.set({ probe: { state: 'done', probe } })
}

/**
 * The one place the transport's typed outcome (`WebDavErrorKind`, the engine's class of what
 * the server answered) becomes the page's sentence – the Test connection row, the Turn on
 * refusal under the passphrase, the line under Sync now (the lead's Q2 ruling on #628: the
 * ruled sentences everywhere an outcome reaches the user, and no method name or status code in
 * any of them, §9.33). The sign-in refused (401); the server not allowing the write – a 403, or
 * a folder still locked or changing under the writes after the engine's quiet retries (412 /
 * 423) – names the Folder row, the one the user can change; the server not reached (a network
 * failure, a timeout, a 5xx); the address redirected (a 3xx the host's fetch does not follow);
 * and an address that answered, but not as a WebDAV server (a web page's 200 or 405 to
 * PROPFIND, a 404 where the root should be).
 */
export function webDavOutcomeLine(kind: WebDavErrorKind): string {
  switch (kind) {
    case 'auth':
      return SYNC_COPY.refused
    case 'forbidden':
    case 'conflict':
      return SYNC_COPY.forbidden
    case 'unavailable':
      return SYNC_COPY.unreachable
    case 'redirect':
      return SYNC_COPY.redirected
    case 'missing':
    case 'refused':
      return SYNC_COPY.notWebDav
  }
}

/**
 * The account service's typed outcome (`AccountErrorKind`) as the page's sentence – the line
 * under Sync now, the Turn on refusal – in the page's words alone: no function name, error code
 * or status ever reaches it (§9.33). The service ended the sign-in; the account's storage is
 * full; a document too large to keep; too many requests; the service not reached; anything
 * else it refused.
 */
export function accountOutcomeLine(kind: AccountErrorKind): string {
  switch (kind) {
    case 'signed-out':
      return SYNC_COPY.accountSignedOutLine
    case 'quota':
      return SYNC_COPY.accountQuota
    case 'too-large':
      return SYNC_COPY.accountTooLarge
    case 'rate-limited':
      return SYNC_COPY.accountRateLimited
    case 'unavailable':
      return SYNC_COPY.accountUnreachable
    case 'refused':
      return SYNC_COPY.accountRefused
  }
}

/**
 * Why the last sign-in did not finish (`SyncStatus.accountLinkFailure`), as the Sign in row's
 * line: the code ran out, the service could not be reached or asked to slow down, or this
 * device's secret store would not keep the sign-in.
 */
export function accountLinkFailureLine(failure: SyncAccountLinkFailure): string {
  switch (failure) {
    case 'expired':
      return SYNC_COPY.accountCodeExpired
    case 'unavailable':
      return SYNC_COPY.accountUnreachable
    case 'rate-limited':
      return SYNC_COPY.accountRateLimited
    case 'secrets':
      return SYNC_COPY.accountNotKept
  }
}

/**
 * The line under Sync now for the round's error: a classified one is the page's sentence for
 * its class – the server's (`webDavOutcomeLine`) or the account's (`accountOutcomeLine`), read
 * by the transport since the two share some names – and an error with no class (the folder
 * transport's, a record that would not decrypt) is the engine's line.
 */
export function syncErrorLine(
  sync: Pick<SyncStatus, 'transport' | 'lastError' | 'lastErrorKind'>
): string | null {
  const kind = sync.lastErrorKind
  if (!kind) return sync.lastError
  return sync.transport === 'account'
    ? accountOutcomeLine(kind as AccountErrorKind)
    : webDavOutcomeLine(kind as WebDavErrorKind)
}

/**
 * The engine's typed refusal of a setup or a new app password (`sync.setup`,
 * `sync.setWebDavPassword`) as the form's sentence: the server's answer through
 * `webDavOutcomeLine`, the account's through `accountOutcomeLine`, or the secret store that
 * could not keep the password.
 */
export function syncSetupRefusalLine(refusal: SyncSetupRefusal): string {
  switch (refusal.reason) {
    case 'server':
      return webDavOutcomeLine(refusal.kind)
    case 'account':
      return accountOutcomeLine(refusal.kind)
    case 'secrets':
      return SYNC_COPY.appPasswordNotKept
  }
}

/**
 * The Test connection row's line for its state: the hint before any test, "Connecting…" while
 * one runs, then the answer – connected, or the server's outcome in the page's words
 * (`webDavOutcomeLine`).
 */
export function probeLine(state: SyncProbeState): string {
  if (state.state === 'idle') return SYNC_COPY.testHint
  if (state.state === 'busy') return SYNC_COPY.testing
  if (state.probe.ok) return SYNC_COPY.connected
  return webDavOutcomeLine(state.probe.kind)
}

/**
 * The server folder as the connected page names it: the folder by its name, as the engine reads
 * what was typed (`webDavFolderSegments`: empty, dot and parent segments dropped, the segments
 * joined with `/`, no trailing slash – `Zenium`, `Backups/Zenium`), or the account's top level
 * for none. The same string the form's Folder field holds for the same folder, so the setup
 * and the connected page never disagree on it.
 */
export function webDavFolderLine(folder: string): string {
  const segments = webDavFolderSegments(folder)
  return segments.length === 0 ? SYNC_COPY.serverRootFolder : segments.join('/')
}

/** The server as the connected page names it: the account on the host ("alice on cloud.example.com"). */
export function webDavServerLine(webdav: { url: string; username: string }): string {
  let host = webdav.url.trim()
  try {
    host = new URL(webdav.url).host || host
  } catch {
    // Not a URL: the address as it was kept.
  }
  return `${webdav.username} on ${host}`
}

/**
 * Turn sync on with what the form collected, and answer as a form does: `null` when sync is on,
 * else the sentence to show under the passphrase. A WebDAV server's answer, or a secret store
 * that cannot keep the app password, comes back typed (`SyncSetupRefusal`) and is the page's
 * sentence for it (`syncSetupRefusalLine`) – the engine's own words never reach the form. The
 * engine reports its other refusals – a passphrase that does not open the folder's data, a
 * folder that cannot be read – as error toasts, which would land under the sheet's scrim (§9.33:
 * messages sit below sheets); the first one raised while the call runs is taken off the message
 * layer and becomes the form's §9.12 validation line instead (§9.30: a refusal shows its reason
 * under the field).
 */
export async function turnOnSync(opts: {
  folder: string
  passphrase: string
  deviceName: string
  scope: SyncScope
  /** Where the folder lives (ID-32); absent means a folder of this device's, as before. */
  transport?: SyncTransportKind
  /** The WebDAV server and its app password when `transport` is `webdav`; never kept here. */
  webdav?: WebDavSyncCredentials
}): Promise<string | null> {
  const seen = new Set(uiStore.get().toasts.map((t) => t.id))
  let refusal: string | null = null
  let typed: SyncSetupRefusal | null = null
  const unsubscribe = uiStore.subscribe(() => {
    for (const toast of uiStore.get().toasts) {
      if (seen.has(toast.id) || toast.kind !== 'error') continue
      seen.add(toast.id)
      refusal ??= toast.message
      // Off the message layer once this notification has run its course (a nested set would
      // re-enter the store's own listener loop).
      queueMicrotask(() => forgetToast(toast.id))
    }
  })
  try {
    typed = await cmd('sync.setup', opts)
  } catch (error) {
    refusal ??= (error instanceof Error && error.message) || SYNC_COPY.notTurnedOn
  } finally {
    // A desktop host sends the toast event ahead of the command's reply on the same channel;
    // one turn of the loop lets a trailing one land before the listener is let go.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    unsubscribe()
  }
  if (typed) return syncSetupRefusalLine(typed)
  if (refusal) return refusal
  return browserStore.get().state?.sync.enabled ? null : SYNC_COPY.notTurnedOn
}
