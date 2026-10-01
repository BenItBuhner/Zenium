import { UserX } from 'lucide-react'
import type { SyncStatus } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  ACCOUNT_COPY,
  SYNC_COPY,
  clearSyncSetup,
  syncErrorLine,
  syncStatusLine
} from '@renderer/lib/syncSetup'
import type { RowGroup, SettingsRow } from './model'
import type { SectionContext } from './sections'
import { ACCOUNT_KEYWORDS, accountSignInRows, deviceRows, mergeRow } from './sync'
import { SyncPassphraseForm } from './syncForms'

/**
 * Settings › Account: the Zenium account on a page of its own, on every host that syncs – the
 * one place a user scanning Settings for "Account" finds it (the account is also Sync's first
 * transport, where the full controls live). Before the sign-in: the page's paragraph and Sign
 * in, which opens the service's page in a new tab (the browser itself is where the email is
 * entered); while that tab waits, the code it shows stands with the wait over Cancel sign-in,
 * and a sign-in that did not finish says why in the page's words (`accountSignInRows`, Sync's
 * rows). Signed in: the account by its email, Sync with its status – Sync now while the account
 * carries the sync, Turn on sync (the passphrase form, the passphrase never leaving the device)
 * while sync is off, a fact while this device syncs another way – and the way to the full
 * controls under Sync; the other devices with their last-seen time (Sync's rows, `deviceRows`);
 * and Sign out, a destructive action that confirms first. An account that has signed this
 * device out is the §9.33 message row over Sign in again. A host that cannot reach the service
 * says so in one row and offers nothing else.
 */
export function accountGroups({ state, navigate }: SectionContext): RowGroup[] {
  const sync = state.sync
  if (!sync.accountAvailable) return [unavailableGroup()]
  const signedIn = sync.account !== null && !sync.accountSignedOut
  if (!signedIn) return [signInGroup(sync)]
  return [accountGroup(sync, navigate), devicesGroup(sync), signOutGroup(sync)]
}

function unavailableGroup(): RowGroup {
  return {
    id: 'account',
    heading: ACCOUNT_COPY.heading,
    rows: [
      {
        kind: 'info',
        id: 'account-unavailable',
        label: ACCOUNT_COPY.unavailable,
        description: ACCOUNT_COPY.unavailableHint,
        keywords: ACCOUNT_KEYWORDS
      }
    ]
  }
}

/**
 * Not signed in: the paragraph and Sign in – or, where the service ended this device's sign-in
 * while it synced through the account, the signed-out message row over Sign in again (§9.17:
 * a group's next row is its action).
 */
function signInGroup(sync: SyncStatus): RowGroup {
  const signedOut = sync.account !== null && sync.accountSignedOut
  return {
    id: 'account',
    heading: ACCOUNT_COPY.heading,
    description: ACCOUNT_COPY.intro,
    rows: [
      ...(signedOut
        ? [
            {
              kind: 'info',
              id: 'account-signed-out',
              label: SYNC_COPY.accountSignedOut,
              description: SYNC_COPY.accountSignedOutHint,
              tone: 'danger',
              keywords: ['error', 'signed out', 'account', 'sign in'],
              trailing: <UserX className="zen-settings-trailing-glyph" aria-hidden="true" />
            } satisfies SettingsRow
          ]
        : []),
      ...accountSignInRows(
        sync,
        signedOut ? SYNC_COPY.accountSignInAgain : SYNC_COPY.accountSignIn,
        'account'
      )
    ]
  }
}

/** Signed in: who, the sync the account carries and its status, and the way to the full controls. */
function accountGroup(sync: SyncStatus, navigate: SectionContext['navigate']): RowGroup {
  return {
    id: 'account',
    heading: ACCOUNT_COPY.heading,
    description: ACCOUNT_COPY.introSignedIn,
    rows: [
      {
        kind: 'info',
        id: 'account-email',
        label: ACCOUNT_COPY.signedInAs,
        description: sync.account?.email ?? '',
        keywords: [...ACCOUNT_KEYWORDS, 'email']
      },
      ...syncRows(sync),
      {
        kind: 'action',
        id: 'account-sync-settings',
        label: ACCOUNT_COPY.settings,
        description: ACCOUNT_COPY.settingsHint,
        keywords: ['sync', 'what you sync', 'device name', 'settings'],
        button: ACCOUNT_COPY.settingsAction,
        onPress: () => navigate('sync')
      }
    ]
  }
}

/**
 * The Sync row by the engine's state: Sync now with the status line while the account carries
 * the sync (the merge question first while the first sync waits on it; the §9.33 sentence for
 * an error, in the danger ink); Turn on sync with the passphrase form while sync is off; and a
 * fact to read while this device syncs through a folder or a server – the way to the account is
 * under Sync (the engine keeps no command to move a configured device between transports).
 */
function syncRows(sync: SyncStatus): SettingsRow[] {
  if (sync.enabled && sync.transport === 'account') {
    const error = syncErrorLine(sync)
    return [
      ...(sync.pendingMerge ? [mergeRow(true, 'account')] : []),
      {
        kind: 'action',
        id: 'account-sync-now',
        label: SYNC_COPY.syncNow,
        description: error ?? syncStatusLine(sync),
        tone: error ? 'danger' : undefined,
        keywords: ['sync', 'last synced', 'status', 'refresh'],
        button: SYNC_COPY.syncNow,
        busy: sync.syncing,
        disabled: sync.pendingMerge,
        onPress: () => run('sync.now', undefined)
      }
    ]
  }
  if (sync.enabled) {
    return [
      {
        kind: 'info',
        id: 'account-sync-elsewhere',
        label: ACCOUNT_COPY.sync,
        description: `${
          sync.transport === 'webdav'
            ? ACCOUNT_COPY.syncElsewhereServer
            : ACCOUNT_COPY.syncElsewhereFolder
        } ${ACCOUNT_COPY.syncElsewhereHint}`,
        keywords: ['sync', 'folder', 'server', 'webdav']
      }
    ]
  }
  return [
    {
      kind: 'action',
      id: 'account-sync-turn-on',
      label: ACCOUNT_COPY.turnOn,
      description: ACCOUNT_COPY.syncOffHint,
      keywords: ['sync', 'set up', 'enable', 'passphrase', 'encrypt'],
      button: 'Turn on…',
      form: {
        title: SYNC_COPY.passphraseTitle,
        description: SYNC_COPY.passphraseDescription,
        render: (close) => (
          <SyncPassphraseForm
            folder=""
            account
            deviceName={sync.deviceName}
            scope={sync.scope}
            close={close}
          />
        )
      }
    }
  ]
}

/**
 * The other devices signed in to the account, most recently seen first, with their count as the
 * heading's aside (0 rather than nothing, §9.17); the empty line says why there are none – no
 * other device yet, or sync still off on this one, since the list is what sync carries.
 */
function devicesGroup(sync: SyncStatus): RowGroup {
  const listing = sync.enabled && sync.transport === 'account'
  const devices = listing ? sync.devices : []
  return {
    id: 'account-devices',
    heading: ACCOUNT_COPY.devices,
    aside: devices.length.toLocaleString(),
    rows: deviceRows(devices, 'account'),
    empty: listing ? SYNC_COPY.noDevicesAccount : ACCOUNT_COPY.noDevicesOff
  }
}

/**
 * Sign out, a destructive action that confirms first (§10.4): the service forgets this device's
 * sign-in; while the account carried the sync, sync turns off with everything this device kept.
 */
function signOutGroup(sync: SyncStatus): RowGroup {
  const syncing = sync.enabled && sync.transport === 'account'
  return {
    id: 'account-sign-out',
    heading: null,
    rows: [
      {
        kind: 'action',
        id: 'account-sign-out',
        label: SYNC_COPY.accountSignOut,
        description: syncing ? SYNC_COPY.accountSignOutSyncHint : SYNC_COPY.accountSignOutHint,
        keywords: ACCOUNT_KEYWORDS,
        button: `${SYNC_COPY.accountSignOut}…`,
        destructive: true,
        confirm: {
          title: SYNC_COPY.accountSignOutTitle,
          description: syncing ? SYNC_COPY.accountSignOutDescription : SYNC_COPY.accountSignOutHint,
          action: SYNC_COPY.accountSignOut
        },
        onPress: () => {
          run('sync.accountSignOut', undefined)
          clearSyncSetup()
        }
      }
    ]
  }
}
