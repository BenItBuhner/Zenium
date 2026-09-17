import type { JSX } from 'react'
import { useState } from 'react'
import { Download, FolderOpen, Search } from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import {
  downloadStatus,
  displayNameOf,
  engineFieldsOf,
  filterDownloads,
  groupDownloadsByDay,
  isActiveDownload,
  needsDangerDecision
} from '@shared/downloads'
import { displayUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import {
  DangerPills,
  DownloadActions,
  DownloadProgressBar,
  FileTypeGlyph
} from '../downloads/DownloadParts'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { OverlayShell } from './OverlayShell'

/**
 * `zen://downloads` (Ctrl+J): every download the browser remembers, grouped by day, with search
 * and the same per-row actions as the bubble. Finished files can be dragged out to the OS.
 */
export function DownloadsPanel({ state }: { state: UIState }): JSX.Element {
  const [query, setQuery] = useState('')
  const items = state.downloads
  const shown = filterDownloads(items, query)
  const groups = groupDownloadsByDay(shown)
  const files = state.platform !== 'android'
  const clearable = items.some((i) => !isActiveDownload(i))
  return (
    <OverlayShell
      title="Downloads"
      variant="full"
      actions={
        <>
          {files && (
            <Button
              variant="ghost"
              size="sm"
              title={state.downloadsDir}
              onClick={() => run('download.openFolder', undefined)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open downloads folder
            </Button>
          )}
          {clearable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => run('download.clearCompleted', undefined)}
            >
              Clear all
            </Button>
          )}
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 pb-6 pt-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--zen-muted)]"
            aria-hidden
          />
          <Input
            autoFocus
            aria-label="Search downloads"
            placeholder="Search downloads"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <Download className="h-6 w-6 text-[var(--zen-faint)]" strokeWidth={1.5} aria-hidden />
            <p className="text-[13px] text-[var(--zen-muted)]">
              {query ? 'No downloads match' : 'Files you download appear here'}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.day} className="flex flex-col gap-1">
              <h3 className="px-2 text-[13px] font-semibold tracking-[-0.006em]">{group.label}</h3>
              <ul>
                {group.items.map((item) => (
                  <PageRow key={item.id} item={item} files={files} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </OverlayShell>
  )
}

function PageRow({ item, files }: { item: DownloadItem; files: boolean }): JSX.Element {
  const status = downloadStatus(item)
  const active = isActiveDownload(item)
  const dangerous = needsDangerDecision(item)
  const extra = engineFieldsOf(item)
  const onDisk = item.state === 'completed' && extra.removed !== true && !needsDangerDecision(item)
  const source = displayUrl(extra.referrer || item.url)
  return (
    <li
      className={cn(
        'zen-download-row group/row flex items-center gap-3 rounded-[6px] px-2',
        active ? 'min-h-10 py-1' : 'h-10',
        onDisk && 'cursor-default'
      )}
      data-state={item.state}
      draggable={onDisk && files}
      onDragStart={(e) => {
        // The OS drag is the host's: hand the file over and drop the HTML5 one.
        e.preventDefault()
        run('download.dragOut', { id: item.id })
      }}
      onClick={() => onDisk && run('download.open', { id: item.id })}
      onKeyDown={(e) => {
        if (onDisk && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault()
          run('download.open', { id: item.id })
        }
      }}
      tabIndex={0}
      role={onDisk ? 'button' : undefined}
      aria-label={`${item.filename}. ${status.text}`}
    >
      <FileTypeGlyph item={item} size="compact" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 truncate text-[13px] font-medium leading-[1.25]',
              (item.state === 'cancelled' || extra.removed) &&
                'text-[var(--zen-muted)]'
            )}
            title={item.savePath || item.url}
          >
            {displayNameOf(item)}
          </span>
          {source && (
            <span className="hidden min-w-0 truncate text-[11.5px] leading-[1.25] text-[var(--zen-muted)] sm:inline">
              {source}
            </span>
          )}
        </div>
        <div
          className={cn(
            'truncate text-[11.5px] leading-[1.25] tabular-nums',
            status.tone === 'warn'
              ? 'text-[var(--zen-warn)]'
              : status.tone === 'danger'
                ? 'text-[var(--zen-danger)]'
                : 'text-[var(--zen-muted)]'
          )}
        >
          {status.text}
        </div>
        {active && (
          <div className="mt-1">
            <DownloadProgressBar item={item} />
          </div>
        )}
      </div>
      {dangerous ? (
        <DangerPills item={item} />
      ) : (
        <div className="zen-download-actions flex shrink-0 items-center gap-0.5">
          {files && (
            <DownloadActions item={item} retry={false} />
          )}
        </div>
      )}
    </li>
  )
}
