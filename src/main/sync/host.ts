import { dialog } from 'electron'
import { hostname } from 'node:os'
import type { SyncPlatformHost, SyncTransport } from '../../core/platform'
import type { SyncDeviceKind } from '../../shared/types'
import type { ZenWindow } from '../../core/window'
import type { ElectronWindow } from '../platform/window'
import { nodeScrypt } from './scrypt'
import { FolderTransport } from './transport'

export { nodeScrypt }

/** `hostname (Mac)`: what the desktop calls itself in the other devices' lists until renamed. */
export function defaultDeviceName(): string {
  const host = hostname().replace(/\.local$/, '')
  const os =
    process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows PC' : 'Linux'
  return host ? `${host} (${os})` : os
}

/** The Electron pieces of sync: the system folder dialog, the hostname, node:fs, node's scrypt. */
export class ElectronSyncHost implements SyncPlatformHost {
  readonly scrypt = nodeScrypt

  async chooseFolder(win: ZenWindow): Promise<string | null> {
    const result = await dialog.showOpenDialog((win.host as ElectronWindow).win, {
      title: 'Choose a folder that is synced between your devices',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder'
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }

  deviceNameDefault(): string {
    return defaultDeviceName()
  }

  /**
   * Every desktop OS is one kind, as Chrome's `DeviceFormFactor` has it (`kDesktop` for Windows,
   * macOS and Linux alike, one computer glyph). Electron has no reliable has-a-battery signal:
   * `powerMonitor.isOnBatteryPower()` and `on-battery` / `on-ac` say whether the machine runs on
   * battery right now (a laptop on mains reads like a desktop, and Linux has neither), so no
   * desktop is called a laptop on a guess.
   */
  deviceKind(): SyncDeviceKind {
    return 'desktop'
  }

  createTransport(folder: string): SyncTransport {
    return new FolderTransport(folder)
  }
}
