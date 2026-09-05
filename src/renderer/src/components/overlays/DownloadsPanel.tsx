import type { JSX } from 'react'
import { FileDown, FolderOpen, Pause, Play, Trash2, X } from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { formatBytes, relativeTime } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { EmptyNote, OverlayShell } from './OverlayShell'

export function DownloadsPanel({ state }: { state: UIState }): JSX.Element {
  const items = state.downloads
  return (
    <OverlayShell
      title="Downloads"
      actions={
        items.some((i) => i.state !== 'progressing' && i.state !== 'paused') ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => run('download.clearCompleted', undefined)}
          >
            Clear list
          </Button>
        ) : null
      }
    >
      {items.length === 0 ? (
        <EmptyNote>Files you download will appear here.</EmptyNote>
      ) : (
        <ul className="p-2">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </OverlayShell>
  )
}

function DownloadRow({ item }: { item: DownloadItem }): JSX.Element {
  const inFlight = item.state === 'progressing' || item.state === 'paused'
  const pct =
    item.totalBytes > 0
      ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
      : null
  const status =
    item.state === 'completed'
      ? `${item.totalBytes ? formatBytes(item.totalBytes) : 'Done'} · ${relativeTime(item.startedAt)}`
      : item.state === 'cancelled'
        ? 'Cancelled'
        : item.state === 'interrupted'
          ? 'Failed'
          : item.state === 'paused'
            ? `Paused · ${formatBytes(item.receivedBytes)}${item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ''}`
            : `${formatBytes(item.receivedBytes)}${item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ''}`
  return (
    <li className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--zen-element-bg)]">
      <FileDown className="h-5 w-5 shrink-0 opacity-60" />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block max-w-full truncate text-left text-[13px] disabled:opacity-60"
          disabled={item.state !== 'completed'}
          onClick={() => run('download.open', { id: item.id })}
          title={item.savePath || item.url}
        >
          {item.filename}
        </button>
        <div className="truncate text-[11.5px] text-[var(--zen-muted)]">{status}</div>
        {inFlight && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--zen-element-bg-active)]">
            <div
              className="h-full bg-[var(--zen-accent)] transition-[width]"
              style={{ width: pct === null ? '40%' : `${pct}%` }}
            />
          </div>
        )}
      </div>
      {item.state === 'progressing' && (
        <button
          type="button"
          className="zen-toolbar-button h-7 w-7"
          title="Pause"
          onClick={() => run('download.pause', { id: item.id })}
        >
          <Pause className="h-3.5 w-3.5" />
        </button>
      )}
      {item.state === 'paused' && (
        <button
          type="button"
          className="zen-toolbar-button h-7 w-7"
          title="Resume"
          onClick={() => run('download.resume', { id: item.id })}
        >
          <Play className="h-3.5 w-3.5" />
        </button>
      )}
      {inFlight ? (
        <button
          type="button"
          className="zen-toolbar-button h-7 w-7"
          title="Cancel"
          onClick={() => run('download.cancel', { id: item.id })}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <>
          {item.state === 'completed' && (
            <button
              type="button"
              className="zen-toolbar-button h-7 w-7"
              title="Show in folder"
              onClick={() => run('download.showInFolder', { id: item.id })}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="zen-toolbar-button h-7 w-7 opacity-0 group-hover:opacity-100"
            title="Remove from list"
            onClick={() => run('download.remove', { id: item.id })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </li>
  )
}
