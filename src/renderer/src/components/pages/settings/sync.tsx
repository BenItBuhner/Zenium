import { FolderX } from 'lucide-react'
import type { SyncDeviceTabs, SyncRemoteTab, SyncStatus } from '@shared/types'
import { displayUrl, getHost } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { downloadFolderLabel } from '@renderer/lib/downloadText'
import {
  remoteTabCount,
  remoteTabsStore,
  remoteTabsSummary,
  remoteTabsWanted
} from '@renderer/lib/remoteTabs'
import { SYNC_COPY, SYNC_SCOPES, syncSetupStore, syncStatusLine } from '@renderer/lib/syncSetup'
import { relativeTime } from '@renderer/lib/utils'
import { FaviconGlyph } from './blocks'
import type { RowGroup, SettingsRow } from './model'
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
 */
export function syncGroups({ state }: SectionContext): RowGroup[] {
  const sync = state.sync
  return sync.enabled ? connectedGroups(sync) : setupGroups(sync)
}

// ---------------------------------------------------------------------------
// Before setup
// ---------------------------------------------------------------------------

function setupGroups(sync: SyncStatus): RowGroup[] {
  const pending = syncSetupStore.get().folder
  return [
    {
      id: 'sync-setup',
      heading: 'Set up sync',
      description: SYNC_COPY.intro,
      rows: [
        {
          kind: 'action',
          id: 'sync-folder',
          label: SYNC_COPY.folder,
          description: pending ? downloadFolderLabel(pending) : SYNC_COPY.folderUnset,
          keywords: FOLDER_KEYWORDS,
          // The desktop's button (§10.5): the Downloads folder row's verb once a folder is set.
          button: pending ? 'Change…' : 'Choose…',
          onPress: () => {
            // A dismissed picker keeps the draft as it is.
            void cmd('sync.chooseFolder', undefined).then((folder) => {
              if (folder) syncSetupStore.set({ folder })
            })
          }
        },
        deviceNameRow(sync),
        {
          kind: 'action',
          id: 'sync-turn-on',
          label: SYNC_COPY.turnOn,
          description: pending ? SYNC_COPY.turnOnHint : SYNC_COPY.turnOnNeedsFolder,
          keywords: ['set up', 'enable', 'passphrase', 'encrypt'],
          button: 'Turn on…',
          // Nothing to set up without a folder: laid out at 40 %, not pressable (§10.4).
          disabled: pending === null,
          form: {
            title: SYNC_COPY.passphraseTitle,
            description: SYNC_COPY.passphraseDescription,
            render: (close) =>
              pending ? (
                <SyncPassphraseForm
                  folder={pending}
                  deviceName={sync.deviceName}
                  scope={sync.scope}
                  close={close}
                />
              ) : null
          }
        }
      ]
    },
    scopeGroup(sync)
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

function connectedGroups(sync: SyncStatus): RowGroup[] {
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
  if (sync.pendingMerge) {
    status.push({
      kind: 'action',
      id: 'sync-merge',
      label: SYNC_COPY.mergeRow,
      description: SYNC_COPY.mergeRowHint,
      keywords: ['merge', 'first sync', 'replace', 'combine'],
      button: 'Choose…',
      form: {
        title: SYNC_COPY.mergeTitle,
        description: SYNC_COPY.mergeDescription,
        render: (close) => <SyncMergeForm close={close} />
      }
    })
  }
  // The error the engine keeps is the folder-lost sentence while the folder is lost: the row
  // above says it, so the status line does not say it twice.
  const error = sync.folderLost ? null : sync.lastError
  status.push({
    kind: 'action',
    id: 'sync-now',
    label: SYNC_COPY.syncNow,
    description: error ?? syncStatusLine(sync),
    tone: error ? 'danger' : undefined,
    keywords: ['last synced', 'status', 'refresh'],
    button: SYNC_COPY.syncNow,
    busy: sync.syncing,
    // Nothing to sync to until the folder is chosen again or the merge is answered.
    disabled: sync.folderLost || sync.pendingMerge,
    onPress: () => run('sync.now', undefined)
  })
  return [
    { id: 'sync-status', heading: 'Status', rows: status },
    {
      id: 'sync-where',
      heading: 'Folder and device',
      rows: [
        {
          kind: 'action',
          id: 'sync-folder',
          label: SYNC_COPY.folder,
          description: sync.folderName ?? sync.folder ?? SYNC_COPY.folderUnset,
          keywords: FOLDER_KEYWORDS,
          button: 'Change…',
          onPress: () => {
            void cmd('sync.chooseFolder', undefined).then((folder) => {
              if (folder) run('sync.setFolder', { folder })
            })
          }
        },
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
        ...[...sync.devices]
          .sort((a, b) => b.lastSeen - a.lastSeen)
          .map(
            (device): SettingsRow => ({
              kind: 'info',
              id: `sync-device:${device.id}`,
              label: device.name,
              keywords: ['device', 'last seen'],
              // The last-seen age trails the name in the summary's 13 at 69 %, `tabular-nums` (§4).
              trailing: (
                <span className="zen-settings-summary">{relativeTime(device.lastSeen)}</span>
              )
            })
          ),
        // The devices' tabs follow the devices (§9.17: a group's next row is its action); with
        // no device there is nothing to list, so the row is not drawn disabled on the first
        // screen – it appears when its state does (§10.4).
        ...(sync.devices.length > 0 ? [remoteTabsRow(sync)] : [])
      ],
      empty: SYNC_COPY.noDevices
    },
    scopeGroup(sync),
    { id: 'sync-off', heading: null, rows: [turnOffRow()] }
  ]
}

/**
 * The one way off, the same row on every shell: Turn off sync, whose §9.23 prompt – a sheet on
 * the phone, the form dialog on the desktop, opened by the row's `button` in the danger ink
 * (§10.5) – holds the wipe as a checkbox row submitted with the destructive action ("Also
 * remove this device's data from the folder"). Never a row of its own: removing the data only
 * means something together with turning off.
 */
function turnOffRow(): SettingsRow {
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
      render: (close) => <SyncDisconnectForm close={close} />
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
 * "Tabs from other devices" (ID-28, Chrome's label): an item row whose description is the list's
 * summary ("12 tabs on 2 devices"), opening the sheet – the desktop's dialog – that lists each
 * device's open tabs under the device's name (§10.3 heading, its count as the aside) as §10.4
 * rows: favicon, title, host and when the tab was last in front; a tap opens the tab here. The
 * row is a dependent of the Open tabs switch in What you sync: with it off the row stays laid
 * out at 40 % and says so (§10.4), and with nothing to open it is disabled rather than left to
 * open an empty sheet (§9.17). The list is the store's (`remoteTabsStore`), asked of the core
 * once per `remoteTabsVersion` by the page's `useRemoteTabs`, never read here.
 */
function remoteTabsRow(sync: SyncStatus): SettingsRow {
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
    sheet: {
      title: SYNC_COPY.remoteTabs,
      groups: [...devices]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((device) => remoteDeviceGroup(device))
    }
  }
}

/** One device's tabs, newest activity first as the engine lists them, under the device's name. */
function remoteDeviceGroup(device: SyncDeviceTabs): RowGroup {
  return {
    id: `sync-remote-tabs:${device.deviceId}`,
    heading: device.deviceName,
    aside: device.tabs.length.toLocaleString(),
    rows: device.tabs.map((tab) => remoteTabRow(device, tab)),
    empty: SYNC_COPY.remoteTabsDeviceEmpty
  }
}

/**
 * A tab of another device: its title over "host · when it was last in front", the favicon
 * leading – every row of the list carries one, so the list keeps one glyph column (§10.4's
 * mixing rule). Opening it is an action that leaves the page: the sheet goes first and the tab
 * opens once it has gone (`closesSheet`), the new tab in front, as the history rows open theirs.
 */
function remoteTabRow(device: SyncDeviceTabs, tab: SyncRemoteTab): SettingsRow {
  const host = getHost(tab.url)
  const when = relativeTime(tab.lastActive)
  return {
    kind: 'action',
    id: `sync-remote-tab:${device.deviceId}:${tab.tabId}`,
    label: tab.title.trim() || displayUrl(tab.url),
    description: host ? `${host} · ${when}` : when,
    leading: <FaviconGlyph src={tab.favicon} />,
    closesSheet: true,
    onPress: () => run('tab.create', { url: tab.url, active: true })
  }
}

/** What you sync: one switch per data type, in Chrome's order (`SYNC_SCOPES`). */
function scopeGroup(sync: SyncStatus): RowGroup {
  return {
    id: 'sync-scope',
    heading: SYNC_COPY.scope,
    rows: SYNC_SCOPES.map(({ key, label, hint }) => ({
      kind: 'switch',
      id: `sync-scope:${key}`,
      label,
      description: hint,
      keywords: ['sync', 'data type'],
      checked: sync.scope[key],
      onChange: (checked) => run('sync.setScope', { [key]: checked })
    }))
  }
}
