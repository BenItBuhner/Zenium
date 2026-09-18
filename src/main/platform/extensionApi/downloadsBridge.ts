import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { ElectronDownloads } from '../downloads'
import { downloadDir } from '../downloads'
import type { DownloadBridge } from './downloads'

/** The `chrome.downloads` bridge over the platform's download host, the file system and the shell. */
export function electronDownloadBridge(downloads: ElectronDownloads): DownloadBridge {
  return {
    startDownload: (request) => downloads.startDownload(request),
    setFilenameDeterminer: (determiner) => downloads.setFilenameDeterminer(determiner),
    targetPath: (id) => downloads.targetPath(id),
    fileExists: (path) => existsSync(path),
    async deleteFile(path) {
      try {
        await rm(path)
        return true
      } catch {
        return false
      }
    },
    async fileIcon(path, size) {
      try {
        const icon = await app.getFileIcon(path, { size: size === 16 ? 'small' : 'normal' })
        if (icon.isEmpty()) return null
        const { width, height } = icon.getSize()
        const sized =
          width === size && height === size ? icon : icon.resize({ width: size, height: size })
        return sized.toDataURL()
      } catch {
        return null
      }
    },
    showDefaultFolder: () => void shell.openPath(downloadDir())
  }
}
