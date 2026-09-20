import type { SyncScope, SyncStatus } from '@shared/types'
import { cmd } from './api'
import { createStore } from './store'
import { browserStore, forgetToast, uiStore } from './ui'
import { relativeTime } from './utils'

/**
 * What the Sync settings share between the phone page (`pages/settings/sync.tsx`) and the desktop
 * pane (`overlays/SyncSection.tsx`): the words, the setup draft the phone keeps between its rows,
 * and the setup call turned into a form's answer.
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
  folder: 'Sync folder',
  folderUnset: 'Choose a folder that your cloud drive keeps in sync',
  device: 'This device',
  deviceHint: 'The name other devices show for this one.',
  turnOn: 'Turn on sync',
  turnOnHint: 'Create the passphrase every device will share.',
  turnOnNeedsFolder: 'Choose a sync folder first.',
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
  scope: 'What you sync',
  turnOff: 'Turn off sync',
  turnOffHint: 'This device stops syncing and keeps what it has.',
  turnOffTitle: 'Turn off sync?',
  turnOffDescription:
    'This device stops syncing and keeps everything it has. Other devices keep syncing with each other.',
  wipeRemote: 'Also remove this device’s data from the folder',
  wipeRemoteHint: 'Other devices forget what this one synced; what they have of their own stays.',
  turnOffAction: 'Turn off'
} as const

/**
 * The data types in Chrome's "Manage what you sync" order – Bookmarks, Open tabs, Passwords,
 * Settings – then Zenium's own: Spaces, folders, pinned tabs, Essentials, containers, shortcuts,
 * Boosts. Every key of `SyncScope` is here once (the engine's toggles are the page's).
 */
export const SYNC_SCOPES: ReadonlyArray<{ key: keyof SyncScope; label: string; hint?: string }> = [
  { key: 'bookmarks', label: 'Bookmarks' },
  { key: 'openTabs', label: 'Open tabs', hint: 'Unpinned tabs arrive unloaded on other devices.' },
  {
    key: 'passwords',
    label: 'Passwords',
    hint: 'Saved passwords and passkey records, encrypted with your sync passphrase.'
  },
  { key: 'settings', label: 'Settings' },
  { key: 'spaces', label: 'Spaces', hint: 'Names, icons, themes and order.' },
  { key: 'folders', label: 'Folders' },
  { key: 'pinnedTabs', label: 'Pinned tabs' },
  { key: 'essentials', label: 'Essentials' },
  { key: 'containers', label: 'Containers' },
  { key: 'shortcuts', label: 'Keyboard shortcuts' },
  { key: 'boosts', label: 'Boosts' }
]

/** The one-line status of a connected device: syncing, the last sync's age, or the wait for the first. */
export function syncStatusLine(sync: SyncStatus, now = Date.now()): string {
  if (sync.syncing) return SYNC_COPY.syncing
  if (sync.lastSyncAt) return `Last synced ${relativeTime(sync.lastSyncAt, now)}`
  return SYNC_COPY.firstSync
}

/**
 * The folder the phone's setup rows have chosen but not set up yet (`sync.chooseFolder` ran,
 * `sync.setup` has not): the page is rebuilt from the browser state on every render and the
 * engine knows nothing of a folder until setup, so the draft lives here between the rows.
 * Cleared once sync is on, or turned off.
 */
export const syncSetupStore = createStore<{ folder: string | null }>({ folder: null }, 'syncSetup')

/**
 * Turn sync on with what the form collected, and answer as a form does: `null` when sync is on,
 * else the sentence to show under the passphrase. The engine reports its refusals – a
 * passphrase that does not open the folder's data, a folder that cannot be read – as error
 * toasts, which would land under the sheet's scrim (§9.33: messages sit below sheets); the
 * first one raised while the call runs is taken off the message layer and becomes the form's
 * §9.12 validation line instead (§9.30: a refusal shows its reason under the field).
 */
export async function turnOnSync(opts: {
  folder: string
  passphrase: string
  deviceName: string
  scope: SyncScope
}): Promise<string | null> {
  const seen = new Set(uiStore.get().toasts.map((t) => t.id))
  let refusal: string | null = null
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
    await cmd('sync.setup', opts)
  } catch (error) {
    refusal ??= (error instanceof Error && error.message) || SYNC_COPY.notTurnedOn
  } finally {
    // A desktop host sends the toast event ahead of the command's reply on the same channel;
    // one turn of the loop lets a trailing one land before the listener is let go.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    unsubscribe()
  }
  if (refusal) return refusal
  return browserStore.get().state?.sync.enabled ? null : SYNC_COPY.notTurnedOn
}
