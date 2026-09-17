import type { JSX } from 'react'
import { useState } from 'react'
import { Download, Search } from 'lucide-react'
import type { DownloadItem, UIState } from '@shared/types'
import { displayName, isActiveDownload } from '@shared/downloadsShell'
import { displayUrl } from '@shared/url'
import { downloadsEngine, showsDangerDecision } from '@renderer/lib/downloadsEngine'
import {
  filterDownloads,
  groupDownloadsByDay,
  hasClearable,
  isOnDisk
} from '@renderer/lib/downloadsView'
import { cn } from '@renderer/lib/utils'
import {
  DangerActions,
  DlButton,
  DownloadActions,
  DownloadProgressBar,
  FileTypeGlyph,
  StatusLine
} from '../downloads/DownloadParts'
import { OverlayShell } from './OverlayShell'

/**
 * `zen://downloads`: every download the browser remembers, grouped by day, with search and the
 * same per-row actions as the bubble. Finished files can be dragged out to the OS; the folder
 * they land in opens from here. Desktop hosts manage the files; single-window hosts show the
 * list only.
 */
export function DownloadsPanel({ state }: { state: UIState }): JSX.Element {
  const [query, setQuery] = useState('')
  const items = downloadsEngine.list(state)
  const groups = groupDownloadsByDay(filterDownloads(items, query))
  const files = state.platform !== 'android'
  return (
    <OverlayShell title="Downloads" variant="full" className="zen-dl-surface zen-dl-page">
      <div className="mx-auto flex w-full max-w-[664px] flex-col gap-6 px-8 pb-8 pt-6">
        <div className="flex items-center gap-3">
          <label className="zen-dl-field relative flex min-w-0 flex-1 items-center">
            <Search
              className="zen-dl-deemph pointer-events-none absolute left-2.5 h-4 w-4"
              strokeWidth={1.5}
              aria-hidden
            />
            <input
              autoFocus
              type="search"
              aria-label="Search downloads"
              placeholder="Search downloads"
              data-zen-downloads-search
              className="zen-dl-input h-8 w-full pl-9 pr-3 text-[15px] outline-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {files && (
            <DlButton onClick={() => downloadsEngine.openFolder()}>Open downloads folder</DlButton>
          )}
          {hasClearable(items) && (
            <DlButton onClick={() => downloadsEngine.removeCompleted()}>Clear all</DlButton>
          )}
        </div>
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <Download className="zen-dl-deemph h-4 w-4" strokeWidth={1.5} aria-hidden />
            <p className="zen-dl-deemph text-[15px] leading-5">
              {query ? 'No downloads match' : 'Files you download appear here'}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.day} className="flex flex-col gap-2">
              <h3 className="px-2 text-[15px] font-semibold leading-5">{group.label}</h3>
              <ul className="-mx-2">
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
  const active = isActiveDownload(item)
  const openable = isOnDisk(item)
  const name = displayName(item)
  const source = displayUrl(item.referrer || item.url)
  const open = (): void => {
    if (openable) downloadsEngine.open(item.id)
  }
  return (
    <li
      className="zen-dl-row group/row flex min-h-[52px] items-start gap-3 px-2 py-[6px]"
      data-state={item.state}
      data-download-id={item.id}
      draggable={openable && files}
      onDragStart={(e) => {
        // The OS drag is the host's: hand the file over and drop the HTML5 one.
        e.preventDefault()
        downloadsEngine.dragOut(item.id)
      }}
      onDoubleClick={open}
      onKeyDown={(e) => {
        if (openable && e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault()
          open()
        }
      }}
      tabIndex={0}
      aria-label={`${name}. ${item.state}`}
    >
      <FileTypeGlyph item={item} />
      <div className="min-w-0 flex-1">
        {openable ? (
          <button
            type="button"
            className="zen-dl-name block max-w-full truncate text-left text-[15px] leading-5"
            title={item.savePath || item.url}
            onClick={open}
          >
            {name}
          </button>
        ) : (
          <div
            className={cn(
              'zen-dl-name truncate text-[15px] leading-5',
              item.state === 'cancelled' && 'zen-dl-deemph'
            )}
            title={item.savePath || item.url}
          >
            {name}
          </div>
        )}
        <StatusLine item={item} suffix={source || undefined} />
        {active && (
          <div className="mt-1.5 pb-0.5">
            <DownloadProgressBar item={item} />
          </div>
        )}
      </div>
      {showsDangerDecision(item) ? (
        <DangerActions item={item} />
      ) : (
        <div className="zen-dl-actions -mr-1 flex shrink-0 items-center">
          <DownloadActions item={item} />
        </div>
      )}
    </li>
  )
}
