import type { JSX } from 'react'
import { useState } from 'react'
import { CloudOff, FolderOpen, RefreshCw } from 'lucide-react'
import type { SyncScope, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { relativeTime } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Group, Row } from './SettingsPrimitives'

const SCOPE_LABELS: Array<{ key: keyof SyncScope; label: string; hint?: string }> = [
  { key: 'spaces', label: 'Spaces', hint: 'Names, icons, themes and order' },
  { key: 'folders', label: 'Folders' },
  { key: 'pinnedTabs', label: 'Pinned tabs' },
  { key: 'essentials', label: 'Essentials' },
  { key: 'openTabs', label: 'Open tabs', hint: 'Unpinned tabs arrive unloaded on other devices' },
  { key: 'containers', label: 'Containers' },
  { key: 'bookmarks', label: 'Bookmarks' },
  { key: 'settings', label: 'Settings' },
  { key: 'shortcuts', label: 'Keyboard shortcuts' },
  { key: 'boosts', label: 'Boosts' }
]

/**
 * Zen 1.22: "Sync your Spaces across devices". A Mozilla account is not available to a Chromium
 * port, so devices share end-to-end encrypted records through a folder that a cloud drive or
 * Syncthing keeps in sync.
 */
export function SyncSection({ state }: { state: UIState }): JSX.Element {
  const sync = state.sync
  return (
    <>
      <section className="px-2.5">
        <h3 className="zen-settings-heading px-0">Sync</h3>
        <p className="zen-settings-hint">
          Keep your Spaces, folders, pinned tabs, Essentials and settings the same on every
          computer. Pick a folder that is already synced between your devices (Dropbox, iCloud
          Drive, Google Drive, OneDrive, Nextcloud, Syncthing…) and a passphrase. Everything is
          encrypted on this device before it is written – the folder only ever holds ciphertext.
        </p>
      </section>
      {sync.enabled ? <Connected state={state} /> : <Setup state={state} />}
    </>
  )
}

function Setup({ state }: { state: UIState }): JSX.Element {
  const [folder, setFolder] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [deviceName, setDeviceName] = useState(state.sync.deviceName)
  const [busy, setBusy] = useState(false)
  const mismatch = confirm.length > 0 && confirm !== passphrase
  const ready = Boolean(folder) && passphrase.length >= 8 && confirm === passphrase && !busy
  return (
    <div className="flex flex-col gap-4 px-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Label>Sync folder</Label>
          <div className="zen-settings-hint truncate">
            {folder ?? 'Choose a folder that your cloud drive keeps in sync'}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void cmd('sync.chooseFolder', undefined).then((f) => f && setFolder(f))}
        >
          <FolderOpen className="h-3.5 w-3.5" /> Choose…
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sync-pass">Passphrase</Label>
          <Input
            id="sync-pass"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sync-confirm">Confirm passphrase</Label>
          <Input
            id="sync-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
            className={
              mismatch ? 'outline-2 outline-offset-2 outline-[var(--zen-danger)]' : undefined
            }
          />
        </div>
      </div>
      <p className="zen-settings-hint">
        Use the same passphrase on every device. It is never stored in the folder and cannot be
        recovered – without it the synced data is unreadable.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sync-device">This device</Label>
        <Input
          id="sync-device"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!ready}
          onClick={() => {
            if (!folder) return
            setBusy(true)
            void cmd('sync.setup', {
              folder,
              passphrase,
              deviceName,
              scope: state.sync.scope
            }).finally(() => setBusy(false))
          }}
        >
          Sync your Spaces across devices
        </Button>
      </div>
    </div>
  )
}

function Connected({ state }: { state: UIState }): JSX.Element {
  const sync = state.sync
  const [deviceName, setDeviceName] = useState(sync.deviceName)
  return (
    <>
      {sync.pendingMerge && (
        <div className="zen-squircle flex flex-col gap-3 rounded-[12px] bg-[rgb(var(--zen-accent-rgb)/0.16)] p-4">
          <div className="zen-settings-label font-medium">
            This folder already contains synced data
          </div>
          <p className="zen-settings-hint">
            Merge it with the Spaces on this device, or keep only this device&apos;s data and
            replace what the other devices have.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => run('sync.confirmMerge', { merge: false })}
            >
              Keep this device&apos;s data
            </Button>
            <Button size="sm" onClick={() => run('sync.confirmMerge', { merge: true })}>
              Merge
            </Button>
          </div>
        </div>
      )}
      <Group title="This device">
        <div className="zen-settings-row">
          <div className="zen-settings-text">
            <div className="zen-settings-label">
              {sync.syncing
                ? 'Syncing…'
                : sync.lastSyncAt
                  ? `Last synced ${relativeTime(sync.lastSyncAt)}`
                  : 'Waiting for first sync'}
            </div>
            <div className="zen-settings-hint truncate" title={sync.folder ?? ''}>
              {sync.lastError ? (
                <span className="text-[var(--zen-danger)]">{sync.lastError}</span>
              ) : (
                sync.folder
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={sync.syncing || sync.pendingMerge}
            onClick={() => run('sync.now', undefined)}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${sync.syncing ? 'zen-spin' : ''}`} /> Sync now
          </Button>
        </div>
        <Row label="Device name">
          <Input
            id="sync-device-name"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            onBlur={() =>
              deviceName.trim() !== sync.deviceName &&
              run('sync.setDeviceName', { name: deviceName })
            }
          />
        </Row>
      </Group>
      <Group title="Other devices">
        {sync.devices.length === 0 ? (
          <div className="zen-settings-hint px-2.5 py-1">
            No other device has synced to this folder yet. Set up sync there with the same folder
            and passphrase.
          </div>
        ) : (
          sync.devices.map((d) => (
            <Row key={d.id} label={d.name}>
              <span className="zen-settings-hint tabular-nums">{relativeTime(d.lastSeen)}</span>
            </Row>
          ))
        )}
      </Group>
      <Group title="What to sync">
        {SCOPE_LABELS.map((item) => (
          <Row key={item.key} label={item.label} hint={item.hint}>
            <Switch
              checked={sync.scope[item.key]}
              onCheckedChange={(v) => run('sync.setScope', { [item.key]: v })}
            />
          </Row>
        ))}
      </Group>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run('sync.disconnect', { wipeRemote: false })}
        >
          <CloudOff className="h-3.5 w-3.5" /> Turn off sync
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => run('sync.disconnect', { wipeRemote: true })}
        >
          Turn off and remove this device&apos;s data
        </Button>
      </div>
    </>
  )
}
