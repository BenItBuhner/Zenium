import { app, shell } from 'electron'
import type { ElectronDownloads } from '../downloads'
import { downloadDir } from '../downloads'
import type { DownloadBridge } from './downloads'

/**
 * The `chrome.downloads` bridge over the platform's download host and the shell. File state
 * (`exists`, `removeFile`) is the model's own, through the host's `exists` / `deleteFile`.
 */
export function electronDownloadBridge(downloads: ElectronDownloads): DownloadBridge {
  return {
    startDownload: (request) => downloads.startDownload(request),
    setFilenameDeterminer: (determiner) => downloads.setFilenameDeterminer(determiner),
    targetPath: (id) => downloads.targetPath(id),
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
