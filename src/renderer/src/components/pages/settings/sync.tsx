import { FolderX, KeyRound, UserX } from 'lucide-react'
import type {
  HostCapabilities,
  SyncDeviceTabs,
  SyncRemoteTab,
  SyncStatus,
  SyncTransportKind,
  UIState,
  WebDavSyncCredentials
} from '@shared/types'
import { displayUrl, getHost } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { downloadFolderLabel } from '@renderer/lib/downloadText'
import {
  remoteTabCount,
  remoteTabsStore,
  remoteTabsSummary,
  remoteTabsWanted
} from '@renderer/lib/remoteTabs'
import {
  SYNC_COPY,
  SYNC_SCOPES,
  accountLinkFailureLine,
  clearSyncSetup,
  editWebDavDraft,
  probeLine,
  setupTransport,
  syncScopeRowId,
  syncErrorLine,
  syncSetupRefusalLine,
  syncSetupStore,
  syncStatusLine,
  testWebDavConnection,
  webDavAddressProblem,
  webDavAddressWarning,
  webDavCredentials,
  webDavDraftComplete,
  webDavFolderLine,
  webDavServerLine,
  type SyncSetupDraft
} from '@renderer/lib/syncSetup'
import { relativeTime } from '@renderer/lib/utils'
import { DeviceGlyph, anyDeviceKind } from '../../DeviceGlyph'
import { FaviconGlyph } from './blocks'
import { choice, type RowGroup, type SettingsRow } from './model'
import type { SectionContext } from './sections'
import { SyncDisconnectForm, SyncMergeForm, SyncPassphraseForm } from './syncForms'

/**
 * Settings › Sync (ID-08's UI) on the shared builder: the phone's rows (design language v2
 * §10.3–10.4) and, since #193 put the desktop Settings tab on the same builder, the desktop's
 * (§10.5: the same rows in the desktop vocabulary, an action's `button` trailing it – a label
 * the phone never reads), reading `state.sync` and running the same `sync.*` commands. Before
 * setup: the folder row (the system folder picker, the chosen tree's name as the description),
 * the device name and Turn on sync, whose sheet (a dialog on the desktop) is the passphrase form
 * (§9.23 title block in Chrome's words, two secret fields, §9.30 busy while the key is derived
 * and the folder read); What you sync in Chrome's order follows, so a device can leave a type
 * out before its first push. Connected: Sync now with the status line as its description, the
 * merge question as a sheet while the first sync waits on it, the §9.17 / §9.33 message row
 * when the folder is lost (ink and a trailing tinted glyph, no card) over the folder row that
 * chooses it again, the device name, the other devices with their last-seen time and their
 * count (0 when none, §9.17), the toggles, and Turn off sync – a §9.23 prompt whose one choice,
 * removing this device's file from the folder, is a checkbox row submitted with the action.
 *
 * The desktop and tablet page keeps what the pane it replaces had (#193's inventory: no row of
 * the pane is lost): the same rows under the builder's headings, and one way off. The pane's
 * second button, Turn off and remove this device's data, is that checkbox in Turn off sync's
 * prompt – the design lead's ruling on #261's desktop page: a choice that only means something
 * together with the footer's action is a checkbox row inside the prompt (§9.23), not a second
 * action – so the phone's sheet and the desktop's dialog (`dialogs.tsx`'s form dialog, the title
 * block over the same form) are the one composition, Chrome's and Firefox's shape.
 *
 * A host that can reach a WebDAV server (ID-32; `webdavAvailable`: a fetch and a secret store)
 * opens the setup with the transport choice – a folder on this device, or a WebDAV server such
 * as Nextcloud – and the server's rows take the folder row's place: the address, the username,
 * the app password (a masked field), the folder under the account's files, and Test connection,
 * an action row that reports its answer in its description (§9.33) and is busy while the server
 * is asked (§9.30). Turn on sync waits on the form as it waits on a folder. Connected through a
 * server, the page's second group is Server and device – the account on the host and the folder,
 * facts to read (the server is set once; the way to another is Turn off sync and set up again)
 * – and a sign-in the server has stopped taking is the §9.33 message row over the App password
 * row that gives the engine a new one, as the folder-lost row stands over the folder row. The
 * server's answers reach the user in the page's sentences alone (`webDavOutcomeLine`, one
 * mapping for the Test row, the Turn on refusal and the line under Sync now); the engine's
 * method names and status codes never do (§9.33).
 *
 * A host that reaches the Zenium account service (`accountAvailable`: the same fetch and secret
 * store) offers the account first in Sync through, picked unless the user picks another: Sign
 * in opens the service's page in a new tab, the code that tab shows stands with "Waiting for you
 * to sign in in the new tab…" over Cancel sign-in until it is approved, and the account's email
 * with Sign out follows; Turn on sync's passphrase form is the step after, the passphrase never
 * leaving the device. Connected through it, the second group is Account and device – the email
 * and Sign out, which confirms and turns sync off – and an account that has signed this device
 * out is the §9.33 message row over Sign in again. The service's answers reach the user in the
 * page's sentences alone (`accountOutcomeLine`, `accountLinkFailureLine`).
 */
export function syncGroups({ state, formFactor }: SectionContext): RowGroup[] {
  const sync = state.sync
  return sync.enabled
    ? connectedGroups(sync, state.tabs, formFactor, state.capabilities)
    : setupGroups(sync, state.capabilities)
}

// ---------------------------------------------------------------------------
// Before setup
// ---------------------------------------------------------------------------

function setupGroups(sync: SyncStatus, caps: HostCapabilities): RowGroup[] {
  const draft = syncSetupStore.get()
  // The account and the server are choices only where the host can reach them; elsewhere the
  // page is the folder's and the draft's transport is read as the folder whatever it says.
  const transport = setupTransport(sync, draft.transport)
  const server = transport === 'webdav'
  const account = transport === 'account'
  const ready = account
    ? sync.account !== null && !sync.accountSignedOut
    : server
      ? webDavDraftComplete(draft.webdav)
      : draft.folder !== null
  const choices = sync.accountAvailable || sync.webdavAvailable
  return [
    {
      id: 'sync-setup',
      heading: 'Set up sync',
      description: sync.accountAvailable
        ? SYNC_COPY.introAccount
        : sync.webdavAvailable
          ? SYNC_COPY.introServer
          : SYNC_COPY.intro,
      rows: [
        ...(choices ? [transportRow(sync, transport)] : []),
        ...(account
          ? accountSetupRows(sync)
          : server
            ? webDavRows(draft)
            : [folderDraftRow(draft.folder)]),
        deviceNameRow(sync),
        {
          kind: 'action',
          id: 'sync-turn-on',
          label: SYNC_COPY.turnOn,
          description: ready
            ? SYNC_COPY.turnOnHint
            : account
              ? SYNC_COPY.turnOnNeedsAccount
              : server
                ? SYNC_COPY.turnOnNeedsServer
                : SYNC_COPY.turnOnNeedsFolder,
          keywords: ['set up', 'enable', 'passphrase', 'encrypt'],
          button: 'Turn on…',
          // Nothing to set up without a folder, or a server filled in: laid out at 40 %, not
          // pressable (§10.4).
          disabled: !ready,
          form: {
            title: SYNC_COPY.passphraseTitle,
            description: SYNC_COPY.passphraseDescription,
            render: (close) =>
              account && ready ? (
                <SyncPassphraseForm
                  folder=""
                  account
                  deviceName={sync.deviceName}
                  scope={sync.scope}
                  close={close}
                />
              ) : server && ready ? (
                <SyncPassphraseForm
                  folder=""
                  webdav={webDavCredentials(draft.webdav)}
                  deviceName={sync.deviceName}
                  scope={sync.scope}
                  close={close}
                />
              ) : transport === 'folder' && draft.folder ? (
                <SyncPassphraseForm
                  folder={draft.folder}
                  deviceName={sync.deviceName}
                  scope={sync.scope}
                  close={close}
                />
              ) : null
          }
        }
      ]
    },
    scopeGroup(sync, caps)
  ]
}

/** The folder the setup will use: the system picker, the chosen tree's name as the description. */
function folderDraftRow(pending: string | null): SettingsRow {
  return {
    kind: 'action',
    id: 'sync-folder',
    label: SYNC_COPY.folder,
    description: pending ? downloadFolderLabel(pending) : SYNC_COPY.folderUnset,
    // A path once a folder is chosen (§9.2's exception: one line, its start shortened); the
    // "Not set" line before is prose.
    address: pending !== null,
    keywords: FOLDER_KEYWORDS,
    // The desktop's button (§10.5): the Downloads folder row's verb once a folder is set.
    button: pending ? 'Change…' : 'Choose…',
    onPress: () => {
      // A dismissed picker keeps the draft as it is.
      void cmd('sync.chooseFolder', undefined).then((folder) => {
        if (folder) syncSetupStore.set({ folder })
      })
    }
  }
}

/**
 * Sync through (ID-32): where the encrypted records go. A value row – the phone's §9.13 picker,
 * the current option as the row's line – that the desktop draws as §9.14's radios, since the
 * options' second lines are the choice: the Zenium account first, the recommended one, where the
 * host reaches the service; then a folder; then a WebDAV server where the host reaches one.
 * Picking one swaps the rows under it, drops the last test's answer with the form it answered,
 * and leaving the account stops a sign-in still waiting for its tab.
 */
function transportRow(sync: SyncStatus, transport: SyncTransportKind): SettingsRow {
  const options: Array<{ value: SyncTransportKind; label: string; description: string }> = []
  if (sync.accountAvailable)
    options.push({
      value: 'account',
      label: SYNC_COPY.transportAccount,
      description: SYNC_COPY.transportAccountHint
    })
  options.push({
    value: 'folder',
    label: SYNC_COPY.transportFolder,
    description: SYNC_COPY.transportFolderHint
  })
  if (sync.webdavAvailable)
    options.push({
      value: 'webdav',
      label: SYNC_COPY.transportWebDav,
      description: SYNC_COPY.transportWebDavHint
    })
  return choice({
    id: 'sync-transport',
    label: SYNC_COPY.transport,
    value: transport,
    keywords: [
      'transport',
      ...(sync.accountAvailable ? ['zenium account', 'account', 'sign in'] : []),
      ...(sync.webdavAvailable ? ['webdav', 'nextcloud', 'server'] : []),
      'cloud drive',
      'folder'
    ],
    radios: true,
    options,
    onChange: (value) => {
      if (value !== 'account' && sync.accountLink) run('sync.accountCancel', undefined)
      syncSetupStore.set({ transport: value, probe: { state: 'idle' } })
    }
  })
}

/**
 * The Zenium account before setup: Sign in until the service has approved this device, then the
 * account's email and Sign out (this device forgets the sign-in; nothing else is kept yet). The
 * passphrase is Turn on sync's step, as for a folder or a server.
 */
function accountSetupRows(sync: SyncStatus): SettingsRow[] {
  if (sync.account && !sync.accountLink && !sync.accountSignedOut) {
    return [
      accountRow(sync.account.email),
      {
        kind: 'action',
        id: 'sync-account-sign-out',
        label: SYNC_COPY.accountSignOut,
        description: SYNC_COPY.accountSignOutHint,
        keywords: ACCOUNT_KEYWORDS,
        button: SYNC_COPY.accountSignOut,
        onPress: () => run('sync.accountSignOut', undefined)
      }
    ]
  }
  return accountSignInRows(sync, SYNC_COPY.accountSignIn)
}

/**
 * Signing in, the same rows before setup and once the service has signed this device out: Sign
 * in (or Sign in again) opens the service's page in a new tab – the browser itself is where the
 * user signs in – and while the engine waits for its approval the code that tab shows stands in
 * its place with the wait as its line, over Cancel sign-in. A sign-in that did not finish says
 * why under the row in the page's words, never the service's (§9.33).
 */
export function accountSignInRows(
  sync: SyncStatus,
  label: string,
  /**
   * The stem of the rows' ids: Sync's are `sync-account-…` (the account among its transports),
   * the Account page's `account-…` (the page is the account).
   */
  prefix = 'sync-account'
): SettingsRow[] {
  const link = sync.accountLink
  if (link) {
    return [
      {
        kind: 'info',
        id: `${prefix}-code`,
        label: link.userCode,
        description: SYNC_COPY.accountWaiting,
        keywords: [...ACCOUNT_KEYWORDS, 'code']
      },
      {
        kind: 'action',
        id: `${prefix}-cancel`,
        label: SYNC_COPY.accountCancel,
        keywords: ACCOUNT_KEYWORDS,
        button: SYNC_COPY.accountCancelAction,
        onPress: () => run('sync.accountCancel', undefined)
      }
    ]
  }
  const failure = sync.accountLinkFailure
  return [
    {
      kind: 'action',
      id: `${prefix}-sign-in`,
      label,
      description: failure ? accountLinkFailureLine(failure) : SYNC_COPY.accountSignInHint,
      tone: failure ? 'danger' : undefined,
      keywords: ACCOUNT_KEYWORDS,
      button: label,
      onPress: () => run('sync.accountSignIn', undefined)
    }
  ]
}

/** The account this device is signed in to, by its email: a fact to read. */
function accountRow(email: string): SettingsRow {
  return {
    kind: 'info',
    id: 'sync-account',
    label: SYNC_COPY.account,
    description: email,
    keywords: [...ACCOUNT_KEYWORDS, 'email']
  }
}

export const ACCOUNT_KEYWORDS = ['zenium account', 'account', 'sign in', 'sign out'] as const

/**
 * The server form as rows (§9.12's fields in rows on the desktop – the address stacked, since
 * a DAV root is longer than the 160 inline field shows; the phone's one-field sheets): the
 * address, checked as a URL when the field is left (§9.12: a refusal under the field at fault,
 * never while typing) and, left holding an `http://` address, carrying the one risk of that in
 * the warn ink under the field (`warning`; the lead's Q1 ruling on #628: taken, not refused,
 * the app password named as the one thing sent unprotected); the username; the app password, a
 * masked field whose row shows dots once it holds one and its hint before; the folder under the
 * account's files; then Test connection, at 40 % until the three details a connection needs
 * are in.
 */
function webDavRows(draft: SyncSetupDraft): SettingsRow[] {
  const { webdav, probe } = draft
  const complete = webDavDraftComplete(webdav)
  return [
    {
      kind: 'field',
      id: 'sync-webdav-url',
      label: SYNC_COPY.server,
      description: SYNC_COPY.serverHint,
      display: webdav.url || SYNC_COPY.serverHint,
      // The phone's row shows the address once one is in (§9.2's exception: one line, its
      // start shortened, the host and path readable); the hint before it is prose.
      address: webdav.url !== '',
      keywords: ['webdav', 'nextcloud', 'url', 'dav'],
      value: webdav.url,
      input: 'url',
      form: 'stacked',
      placeholder: SYNC_COPY.serverPlaceholder,
      warning: webDavAddressWarning(webdav.url),
      onCommit: (value) => {
        // A refused address is not kept: the sheet clears it (§9.12), so the row does not
        // show what was refused, and Test connection never reaches for it.
        const problem = webDavAddressProblem(value)
        if (problem === undefined) editWebDavDraft({ url: value })
        return problem
      }
    },
    {
      kind: 'field',
      id: 'sync-webdav-username',
      label: SYNC_COPY.username,
      description: SYNC_COPY.usernameHint,
      display: webdav.username || SYNC_COPY.usernameHint,
      keywords: ['account', 'login'],
      value: webdav.username,
      input: 'text',
      onCommit: (value) => {
        editWebDavDraft({ username: value })
        return undefined
      }
    },
    {
      kind: 'field',
      id: 'sync-webdav-password',
      label: SYNC_COPY.appPassword,
      description: SYNC_COPY.appPasswordHint,
      display: webdav.password ? SYNC_COPY.appPasswordSet : SYNC_COPY.appPasswordHint,
      keywords: ['password', 'token', 'secret'],
      value: webdav.password,
      input: 'password',
      secret: true,
      onCommit: (value) => {
        editWebDavDraft({ password: value })
        return undefined
      }
    },
    {
      kind: 'field',
      id: 'sync-webdav-folder',
      label: SYNC_COPY.serverFolder,
      description: SYNC_COPY.serverFolderHint,
      // The phone's row shows the folder as typed: a path (§9.2's exception).
      address: true,
      keywords: ['folder', 'directory', 'path'],
      value: webdav.folder,
      input: 'text',
      onCommit: (value) => {
        editWebDavDraft({ folder: value })
        return undefined
      }
    },
    {
      kind: 'action',
      id: 'sync-webdav-test',
      label: SYNC_COPY.test,
      description: probeLine(probe),
      // The answer's ink is the description's alone (§9.33: an action row reporting its result
      // carries no glyph); a connection is the plain line.
      tone: probe.state === 'done' && !probe.probe.ok ? 'danger' : undefined,
      keywords: ['test', 'check', 'connection', 'connect'],
      button: SYNC_COPY.testAction,
      busy: probe.state === 'busy',
      disabled: !complete,
      onPress: () => void testWebDavConnection()
    }
  ]
}

const FOLDER_KEYWORDS = [
  'folder',
  'cloud drive',
  'dropbox',
  'google drive',
  'onedrive',
  'nextcloud',
  'syncthing'
] as const

// ---------------------------------------------------------------------------
// Connected
// ---------------------------------------------------------------------------

function connectedGroups(
  sync: SyncStatus,
  held: UIState['tabs'],
  formFactor: SectionContext['formFactor'],
  caps: HostCapabilities
): RowGroup[] {
  const status: SettingsRow[] = []
  if (sync.folderLost) {
    // The §9.17 / §9.33 message row: the way out as the description and the state's glyph
    // trailing at 16 – a lone status row trails its glyph (§9.33), never leading in a group
    // whose other row, Sync now, has none (§10.4's mixing rule) – both in the danger ink through
    // the row's one `tone` (the glyph carries no ink class of its own), and nothing to press:
    // the folder row under it is the follow-up (§9.17: a group's next row is its action).
    status.push({
      kind: 'info',
      id: 'sync-folder-lost',
      label: SYNC_COPY.folderLost,
      description: SYNC_COPY.folderLostHint,
      tone: 'danger',
      keywords: ['error', 'lost', 'revoked'],
      trailing: <FolderX className="zen-settings-trailing-glyph" aria-hidden="true" />
    })
  }
  if (sync.authRefused) {
    // The server's refusal (a revoked app password; ID-32) is the same lone status row: the way
    // out as the description, the key glyph trailing in the danger ink, and the App password
    // row that gives the engine a new one first in the group under it (§9.17).
    status.push({
      kind: 'info',
      id: 'sync-auth-refused',
      label: SYNC_COPY.authRefused,
      description: SYNC_COPY.authRefusedHint,
      tone: 'danger',
      keywords: ['error', 'password', 'refused', 'revoked', '401'],
      trailing: <KeyRound className="zen-settings-trailing-glyph" aria-hidden="true" />
    })
  }
  const account = sync.transport === 'account'
  const signedOut = account && sync.accountSignedOut
  if (signedOut) {
    // The service ended this device's sign-in (signed out on the website, the account deleted):
    // the same lone status row, Sign in again first in the group under it (§9.17).
    status.push({
      kind: 'info',
      id: 'sync-account-signed-out',
      label: SYNC_COPY.accountSignedOut,
      description: SYNC_COPY.accountSignedOutHint,
      tone: 'danger',
      keywords: ['error', 'signed out', 'account', 'sign in'],
      trailing: <UserX className="zen-settings-trailing-glyph" aria-hidden="true" />
    })
  }
  if (sync.pendingMerge) status.push(mergeRow(account))
  // The error the engine keeps is the folder-lost sentence while the folder is lost, the
  // server's answer while the sign-in is refused, and the account's signed-out line while the
  // service has signed this device out: the row above says it, so the status line does not say
  // it twice. A server's or the account's other answer is the page's sentence for its class
  // (`lastErrorKind` through `syncErrorLine`), never the engine's method and status; an error
  // with no class – the folder transport's, a record that would not decrypt – is the engine's
  // line, as before.
  const error = sync.folderLost || sync.authRefused || signedOut ? null : syncErrorLine(sync)
  status.push({
    kind: 'action',
    id: 'sync-now',
    label: SYNC_COPY.syncNow,
    description: error ?? syncStatusLine(sync),
    tone: error ? 'danger' : undefined,
    keywords: ['last synced', 'status', 'refresh'],
    button: SYNC_COPY.syncNow,
    busy: sync.syncing,
    // Nothing to sync to until the folder is chosen again, the server or the account takes the
    // sign-in again, or the merge is answered.
    disabled: sync.folderLost || sync.authRefused || signedOut || sync.pendingMerge,
    onPress: () => run('sync.now', undefined)
  })
  const server = sync.transport === 'webdav' && sync.webdav !== null ? sync.webdav : null
  return [
    { id: 'sync-status', heading: 'Status', rows: status },
    {
      id: 'sync-where',
      heading: account
        ? SYNC_COPY.whereAccount
        : server
          ? SYNC_COPY.whereServer
          : SYNC_COPY.whereFolder,
      rows: [
        ...(account
          ? connectedAccountRows(sync)
          : server
            ? serverRows(server, sync.authRefused, formFactor)
            : [
                {
                  kind: 'action',
                  id: 'sync-folder',
                  label: SYNC_COPY.folder,
                  description: sync.folderName ?? sync.folder ?? SYNC_COPY.folderUnset,
                  // A path while a folder is set (§9.2's exception); "Not set" is prose.
                  address: Boolean(sync.folderName ?? sync.folder),
                  keywords: FOLDER_KEYWORDS,
                  button: 'Change…',
                  onPress: () => {
                    void cmd('sync.chooseFolder', undefined).then((folder) => {
                      if (folder) run('sync.setFolder', { folder })
                    })
                  }
                } satisfies SettingsRow
              ]),
        deviceNameRow(sync)
      ]
    },
    {
      id: 'sync-devices',
      heading: SYNC_COPY.devices,
      // The count reads 0 rather than disappearing (§9.17): over the empty sentence it is the
      // one number on the page that says the state, and the sentence explains it.
      aside: sync.devices.length.toLocaleString(),
      rows: [
        ...deviceRows(sync.devices),
        // The devices' tabs follow the devices (§9.17: a group's next row is its action); with
        // no device there is nothing to list, so the row is not drawn disabled on the first
        // screen – it appears when its state does (§10.4).
        ...(sync.devices.length > 0 ? [remoteTabsRow(sync, held)] : [])
      ],
      empty: account ? SYNC_COPY.noDevicesAccount : SYNC_COPY.noDevices
    },
    scopeGroup(sync, caps),
    { id: 'sync-off', heading: null, rows: [turnOffRow(account)] }
  ]
}

/**
 * The merge question while the first sync waits on it: an action row whose sheet (the desktop's
 * dialog) is the merge form, in the account's words when the data is the account's.
 */
export function mergeRow(account: boolean, prefix = 'sync'): SettingsRow {
  return {
    kind: 'action',
    id: `${prefix}-merge`,
    label: account ? SYNC_COPY.mergeRowAccount : SYNC_COPY.mergeRow,
    description: SYNC_COPY.mergeRowHint,
    keywords: ['merge', 'first sync', 'replace', 'combine'],
    button: 'Choose…',
    form: {
      title: account ? SYNC_COPY.mergeTitleAccount : SYNC_COPY.mergeTitle,
      description: account ? SYNC_COPY.mergeDescriptionAccount : SYNC_COPY.mergeDescription,
      render: (close) => <SyncMergeForm close={close} />
    }
  }
}

/**
 * Connected through the Zenium account: while the service has signed this device out, the
 * sign-in rows first – Sign in again, the code and Cancel while it waits – the status row's
 * follow-up (§9.17); then the account by its email and Sign out, which confirms first with
 * the verb in the plain ink (§9.23's third form): the service forgets this device's sign-in, and
 * sync turns off with everything this device has kept.
 */
function connectedAccountRows(sync: SyncStatus): SettingsRow[] {
  return [
    ...(sync.accountSignedOut ? accountSignInRows(sync, SYNC_COPY.accountSignInAgain) : []),
    ...(sync.account ? [accountRow(sync.account.email)] : []),
    {
      kind: 'action',
      id: 'sync-account-sign-out',
      label: SYNC_COPY.accountSignOut,
      description: SYNC_COPY.accountSignOutSyncHint,
      keywords: ACCOUNT_KEYWORDS,
      button: `${SYNC_COPY.accountSignOut}…`,
      confirm: {
        title: SYNC_COPY.accountSignOutTitle,
        description: SYNC_COPY.accountSignOutDescription,
        action: SYNC_COPY.accountSignOut,
        verbTone: 'plain'
      },
      onPress: () => {
        run('sync.accountSignOut', undefined)
        clearSyncSetup()
      }
    }
  ]
}

/**
 * Connected through a server (ID-32): the server in use as facts – the account on the host, and
 * the folder under its files as it was typed, or the top level. Nothing to press: the server is set once, and another server is Turn off
 * sync and set up again (the engine keeps no command to move a configured device between
 * servers). While the server refuses the sign-in, the App password row stands first – the
 * status row's follow-up (§9.17) – a masked field whose commit hands the engine the new
 * password (`sync.setWebDavPassword`) and lets it sync again: the sheet is §9.30's busy form
 * while the engine keeps the password and runs a round with it, and a secret store that
 * cannot keep it is the field's refusal in the page's words (the typed `SyncSetupRefusal`);
 * a password the server refuses in its turn leaves the status row standing, since the round
 * reports it. At other times the row is not drawn (§10.4: a row for a state most users never
 * enter appears when its state does).
 *
 * On the touch layouts the Folder row also copies its path (`RowCopy`; services seed #34, the
 * lead's word: "The Folder row carries copy on both touch layouts"): a row that both copies and
 * carries an address, so the hold opens the row's address sheet – the whole path – with Copy as
 * its one row on a phone, and raises the held card with Copy as its one footer button on a
 * tablet (the copy is the line as the row shows it, `folderLine`, the very text either surface
 * holds). Not on the desktop (`formFactor !== 'desktop'`, the version row's rule, SET-54): "on
 * the desktop you copy from the folder editor's field"; the root, whose line is a sentence,
 * copies nothing.
 */
function serverRows(
  server: Omit<WebDavSyncCredentials, 'password'>,
  authRefused: boolean,
  formFactor: SectionContext['formFactor']
): SettingsRow[] {
  const rows: SettingsRow[] = []
  if (authRefused) {
    rows.push({
      kind: 'field',
      id: 'sync-webdav-password',
      label: SYNC_COPY.appPassword,
      description: SYNC_COPY.appPasswordAgainHint,
      display: SYNC_COPY.appPasswordAgainHint,
      keywords: ['password', 'token', 'secret'],
      value: '',
      input: 'password',
      secret: true,
      onCommit: (value) => {
        if (value === '') return undefined
        return cmd('sync.setWebDavPassword', { password: value }).then(
          (refusal) => (refusal ? syncSetupRefusalLine(refusal) : undefined),
          // The host's channel failing: the password did not get kept, and the sentence says so.
          () => SYNC_COPY.appPasswordNotKept
        )
      }
    })
  }
  // The folder as a path (§9.2's exception: one line, its start shortened, the leaf readable)
  // – unless it is the root, whose line is a sentence. The Server row's line is a phrase about
  // the account ("alice on cloud.example.com"), prose to §9.2.
  const folderLine = webDavFolderLine(server.folder)
  const isPath = folderLine !== SYNC_COPY.serverRootFolder
  rows.push(
    {
      kind: 'info',
      id: 'sync-server',
      label: SYNC_COPY.serverInUse,
      description: webDavServerLine(server),
      keywords: ['webdav', 'nextcloud', 'server', 'account', server.url]
    },
    {
      kind: 'info',
      id: 'sync-server-folder',
      label: SYNC_COPY.serverFolder,
      description: folderLine,
      address: isPath,
      keywords: ['folder', 'directory', 'path'],
      ...(isPath && formFactor !== 'desktop'
        ? { copy: { text: folderLine, confirmation: SYNC_COPY.serverFolderCopied } }
        : {})
    }
  )
  return rows
}

/**
 * The one way off, the same row on every shell: Turn off sync, whose §9.23 prompt – a sheet on
 * the phone, the form dialog on the desktop, opened by the row's `button` in the danger ink
 * (§10.5) – holds the wipe as a checkbox row submitted with the destructive action ("Also
 * remove this device's data from the folder"). Never a row of its own: removing the data only
 * means something together with turning off.
 */
function turnOffRow(account: boolean): SettingsRow {
  return {
    kind: 'action',
    id: 'sync-disconnect',
    label: SYNC_COPY.turnOff,
    description: SYNC_COPY.turnOffHint,
    keywords: ['disconnect', 'stop', 'remove', 'wipe'],
    button: 'Turn off…',
    destructive: true,
    form: {
      title: SYNC_COPY.turnOffTitle,
      description: SYNC_COPY.turnOffDescription,
      render: (close) => <SyncDisconnectForm close={close} account={account} />
    }
  }
}

// ---------------------------------------------------------------------------
// Shared rows
// ---------------------------------------------------------------------------

/**
 * "This device": the name other devices list for this one, the pane's own label on both hosts
 * (#193's inventory); the engine keeps it before and after setup.
 */
function deviceNameRow(sync: SyncStatus): SettingsRow {
  return {
    kind: 'field',
    id: 'sync-device-name',
    label: SYNC_COPY.device,
    description: SYNC_COPY.deviceHint,
    keywords: ['device name', 'rename'],
    value: sync.deviceName,
    input: 'text',
    onCommit: (value) => {
      if (value.trim() !== sync.deviceName) run('sync.setDeviceName', { name: value })
      return undefined
    }
  }
}

/**
 * The other devices, most recently seen first: each an info row with the device's name and,
 * trailing, when it was last seen. The device's kind leads the name at the full ink (§10.4;
 * services pass 4): the laptop, phone or tablet its announcement carried (`DeviceGlyph`), the
 * 69 % stand-in for a device whose build carried none – while ANY device of the list announced
 * one (`anyDeviceKind`, the #453 lead check's condition on §10.4): a list in which no device did
 * has no glyph column at all, the names at the gutter, rather than a column of stand-ins.
 */
export function deviceRows(devices: SyncStatus['devices'], prefix = 'sync'): SettingsRow[] {
  const glyphs = anyDeviceKind(devices)
  return [...devices]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((device): SettingsRow => ({
      kind: 'info',
      id: `${prefix}-device:${device.id}`,
      label: device.name,
      keywords: ['device', 'last seen', ...(device.kind ? [device.kind] : [])],
      leading: glyphs ? <DeviceGlyph kind={device.kind} /> : undefined,
      // The last-seen age trails the name in the summary's 13 at 69 %, `tabular-nums` (§4).
      trailing: <span className="zen-settings-summary">{relativeTime(device.lastSeen)}</span>
    }))
}

/**
 * "Tabs from other devices" (ID-28, Chrome's label): an item row whose description is the list's
 * summary ("12 tabs on 2 devices"), opening the sheet – the desktop's dialog – that lists each
 * device's open tabs under the device's name (§10.3 heading, its count as the aside) as §10.4
 * rows: favicon, title, host and when the tab was last in front; a tap opens the tab here. The
 * row is a dependent of the Open tabs switch in What you sync: with it off the row stays laid
 * out at 40 % and says so (§10.4), and with nothing to open it is disabled rather than left to
 * open an empty sheet (§9.17). The list is the store's (`remoteTabsStore`), asked of the core
 * once per `remoteTabsVersion` by the page's `useRemoteTabs`, never read here. `held` is this
 * device's own tabs: the Open tabs scope also carries the tab records (ID-10), so a tab another
 * device lists may already sit in this sidebar under the same id, and its row then brings that
 * tab to the front rather than opening a second one. The row stands under the builder's
 * hairline (`hairline`, the #453 lead check): the device run above it leads with glyphs and
 * this action row has none, and the one `--v2-border` line closes the run where the leading
 * edges part – a separator, not an empty slot drawn for alignment.
 */
function remoteTabsRow(sync: SyncStatus, held: UIState['tabs']): SettingsRow {
  const wanted = remoteTabsWanted(sync)
  const devices = wanted ? remoteTabsStore.get().devices : []
  const count = remoteTabCount(devices)
  return {
    kind: 'item',
    id: 'sync-remote-tabs',
    label: SYNC_COPY.remoteTabs,
    description: wanted ? remoteTabsSummary(devices) : SYNC_COPY.remoteTabsOff,
    keywords: ['open tabs', 'synced tabs', 'other devices', 'remote tabs'],
    disabled: !wanted || count === 0,
    hairline: true,
    sheet: {
      title: SYNC_COPY.remoteTabs,
      groups: [...devices]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((device) => remoteDeviceGroup(device, held))
    }
  }
}

/** One device's tabs, newest activity first as the engine lists them, under the device's name. */
function remoteDeviceGroup(device: SyncDeviceTabs, held: UIState['tabs']): RowGroup {
  return {
    id: `sync-remote-tabs:${device.deviceId}`,
    heading: device.deviceName,
    aside: device.tabs.length.toLocaleString(),
    rows: device.tabs.map((tab) => remoteTabRow(device, tab, tab.tabId in held)),
    empty: SYNC_COPY.remoteTabsDeviceEmpty
  }
}

/**
 * A tab of another device: its title over "host · when it was last in front", the favicon
 * leading – every row of the list carries one, so the list keeps one glyph column (§10.4's
 * mixing rule). Opening it is an action that leaves the page: the sheet goes first and the tab
 * opens once it has gone (`closesSheet`), the new tab in front, as the history rows open theirs
 * – or, when this device already holds that very tab (`held`), that tab comes to the front.
 */
function remoteTabRow(device: SyncDeviceTabs, tab: SyncRemoteTab, held: boolean): SettingsRow {
  // The bare host, as the Recently closed rows write theirs.
  const host = getHost(tab.url).replace(/^www\./, '')
  const when = relativeTime(tab.lastActive)
  return {
    kind: 'action',
    id: `sync-remote-tab:${device.deviceId}:${tab.tabId}`,
    label: tab.title.trim() || displayUrl(tab.url),
    description: host ? `${host} · ${when}` : when,
    leading: <FaviconGlyph src={tab.favicon} page={tab.url} />,
    // The title is the page's, any length: one line, truncating from the end, as the History
    // rows (§6; the #314 ruling) – the host under it says which page a cut title is.
    truncate: true,
    closesSheet: true,
    onPress: () =>
      held
        ? run('tab.activate', { tabId: tab.tabId })
        : run('tab.create', { url: tab.url, active: true })
  }
}

/**
 * What you sync: one switch per data type, in Chrome's order (`SYNC_SCOPES`). A type whose row
 * `requires` a capability is drawn on the hosts that have it alone: the Extensions row (ID-44)
 * where extensions install – the desktop and the phone – and nowhere a host holds none.
 */
function scopeGroup(sync: SyncStatus, caps: HostCapabilities): RowGroup {
  return {
    id: 'sync-scope',
    heading: SYNC_COPY.scope,
    rows: SYNC_SCOPES.filter(({ requires }) => !requires || caps[requires]).map(
      ({ key, label, hint }) => ({
        kind: 'switch',
        id: syncScopeRowId(key),
        label,
        description: hint,
        keywords: ['sync', 'data type'],
        checked: sync.scope[key],
        onChange: (checked) => run('sync.setScope', { [key]: checked })
      })
    )
  }
}
