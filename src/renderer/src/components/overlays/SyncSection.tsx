import type { JSX } from 'react'
import { useState } from 'react'
import { CloudOff, FolderOpen, FolderX, RefreshCw } from 'lucide-react'
import type { UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { SYNC_COPY, SYNC_SCOPES } from '@renderer/lib/syncSetup'
import { relativeTime } from '@renderer/lib/utils'
import { V2Button, V2Row } from '../extensions/v2'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'

/**
 * Zen 1.22: "Sync your Spaces across devices". A Mozilla account is not available to a Chromium
 * port, so devices share end-to-end encrypted records through a folder that a cloud drive or
 * Syncthing keeps in sync.
 */
export function SyncSection({ state }: { state: UIState }): JSX.Element {
  const sync = state.sync
  return (
    <>
      <section>
        <h3 className="mb-1 text-[15px] font-semibold">Sync</h3>
        <p className="text-[12.5px] text-[var(--zen-muted)]">
          Keep your Spaces, folders, pinned tabs, Essentials, bookmarks, passwords and settings the
          same on every device, including your phone. Pick a folder that is already synced between
          your devices (Dropbox, iCloud Drive, Google Drive, OneDrive, Nextcloud, Syncthing…) and a
          passphrase. Everything is encrypted on this device before it is written – the folder only
          ever holds ciphertext.
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
    <div className="zen-squircle flex flex-col gap-4 rounded-xl border border-[var(--zen-border)] p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Label>Sync folder</Label>
          <div className="truncate text-[12px] text-[var(--zen-muted)]">
            {folder ?? 'Choose a folder that your cloud drive keeps in sync'}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void cmd('sync.chooseFolder', undefined).then((f) => f && setFolder(f))}
        >
          <FolderOpen className="mr-1.5 h-3.5 w-3.5" /> Choose…
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
            className={mismatch ? 'ring-1 ring-red-500' : undefined}
          />
        </div>
      </div>
      <p className="text-[11.5px] text-[var(--zen-muted)]">
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
  const chooseFolder = (): void =>
    void cmd('sync.chooseFolder', undefined).then(
      (folder) => folder && run('sync.setFolder', { folder })
    )
  // The engine keeps the folder-lost sentence as its error while the folder is lost; the notice
  // row says it, so the status card shows the folder's name as it does at rest.
  const error = sync.folderLost ? null : sync.lastError
  return (
    <>
      {sync.folderLost && (
        // The folder went away (an unmounted drive, a revoked tree): the §9.17 / §9.33 message row
        // on the shared static row – the state's glyph in the danger ink on the label's line, the
        // way out as the description in the same ink, one trailing secondary action that chooses
        // the folder again – no card, no hue of its own; the phone draws the same row.
        <div className="zen-v2" data-testid="sync-folder-lost">
          <V2Row
            lead={FolderX}
            tone="danger"
            label={SYNC_COPY.folderLost}
            description={SYNC_COPY.folderLostHint}
          >
            <V2Button disabled={sync.syncing} onClick={chooseFolder}>
              {SYNC_COPY.chooseAgain}
            </V2Button>
          </V2Row>
        </div>
      )}
      {sync.pendingMerge && (
        <div className="zen-squircle flex flex-col gap-3 rounded-xl border border-[var(--zen-accent)]/50 bg-[var(--zen-accent)]/10 p-4">
          <div className="text-[13.5px] font-medium">This folder already contains synced data</div>
          <p className="text-[12.5px] text-[var(--zen-muted)]">
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
      <section className="zen-squircle overflow-hidden rounded-xl border border-[var(--zen-border)]">
        <div className="flex items-center gap-3 border-b border-[var(--zen-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">
              {sync.syncing
                ? 'Syncing…'
                : sync.lastSyncAt
                  ? `Last synced ${relativeTime(sync.lastSyncAt)}`
                  : 'Waiting for first sync'}
            </div>
            <div
              className="truncate text-[11.5px] text-[var(--zen-muted)]"
              title={sync.folder ?? ''}
            >
              {error ? (
                <span className="text-[var(--v2-danger)]">{error}</span>
              ) : (
                (sync.folderName ?? sync.folder)
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            // Nothing to sync to while the folder is lost or the first sync waits on the merge.
            disabled={sync.syncing || sync.pendingMerge || sync.folderLost}
            onClick={() => run('sync.now', undefined)}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${sync.syncing ? 'zen-spin' : ''}`} /> Sync
            now
          </Button>
        </div>
        <div className="flex items-center gap-3 border-b border-[var(--zen-border)] px-4 py-3">
          <Label htmlFor="sync-device-name" className="w-28 shrink-0">
            This device
          </Label>
          <Input
            id="sync-device-name"
            className="h-8"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            onBlur={() =>
              deviceName.trim() !== sync.deviceName &&
              run('sync.setDeviceName', { name: deviceName })
            }
          />
        </div>
        <div className="px-4 py-3">
          <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--zen-muted)]">
            Devices
          </div>
          {sync.devices.length === 0 ? (
            <div className="text-[12.5px] text-[var(--zen-muted)]">
              No other device has synced to this folder yet. Set up sync there with the same folder
              and passphrase.
            </div>
          ) : (
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {sync.devices.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{d.name}</span>
                  <span className="shrink-0 text-[var(--zen-muted)]">
                    {relativeTime(d.lastSeen)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--zen-muted)]">
          What to sync
        </h4>
        <div className="zen-squircle overflow-hidden rounded-xl border border-[var(--zen-border)]">
          {SYNC_SCOPES.map((item) => (
            <div
              key={item.key}
              className="flex min-h-11 items-center gap-4 border-b border-[var(--zen-border)] px-4 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px]">{item.label}</div>
                {item.hint && (
                  <div className="text-[11.5px] text-[var(--zen-muted)]">{item.hint}</div>
                )}
              </div>
              <Switch
                checked={sync.scope[item.key]}
                onCheckedChange={(v) => run('sync.setScope', { [item.key]: v })}
              />
            </div>
          ))}
        </div>
      </section>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run('sync.disconnect', { wipeRemote: false })}
        >
          <CloudOff className="mr-1.5 h-3.5 w-3.5" /> Turn off sync
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-red-500"
          onClick={() => run('sync.disconnect', { wipeRemote: true })}
        >
          Turn off and remove this device&apos;s data
        </Button>
      </div>
    </>
  )
}
