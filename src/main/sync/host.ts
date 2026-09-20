import { dialog } from 'electron'
import { hostname } from 'node:os'
import type { SyncPlatformHost, SyncTransport } from '../../core/platform'
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

  createTransport(folder: string): SyncTransport {
    return new FolderTransport(folder)
  }
}
