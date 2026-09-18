import type { DownloadItem } from '../types'

/** A complete engine record (PR #69's shape) with every field the desktop UI reads. */
export function downloadItem(over: Partial<DownloadItem> & { id: string }): DownloadItem {
  const filename = over.filename ?? `${over.id}.bin`
  return {
    url: `https://files.test/${over.id}.bin`,
    referrer: '',
    filename,
    finalName: filename,
    savePath: `/tmp/${filename}`,
    totalBytes: 10,
    receivedBytes: 10,
    state: 'completed',
    startedAt: 1_000,
    completedAt: 2_000,
    endedAt: 2_000,
    mimeType: '',
    canResume: false,
    danger: { level: 'safe', reason: 'none', message: '' },
    dangerAccepted: false,
    openWhenDone: false,
    bytesPerSecond: 0,
    etaMs: null,
    private: false,
    containerId: 'default',
    etag: '',
    lastModified: '',
    ...over
  }
}
