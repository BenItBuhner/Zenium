import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { UIState } from '@shared/types'
import { isActiveDownload } from '@shared/downloadsShell'
import { displayUrl } from '@shared/url'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import { filterDownloads, groupDownloadsByDay, hasClearable } from '@renderer/lib/downloadsView'
import { FrameDialogHost, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { useEscapeTrap } from '../bookmarks/escape'
import { wrapTab } from '../bookmarks/popover'
import { DlButton, DownloadRow } from '../downloads/DownloadParts'
import { OverlayShell } from './OverlayShell'

/**
 * `zen://downloads` (Ctrl+J; shown to users as `zenium://downloads`): every download the
 * browser remembers, grouped by day, with search and the same rows as the bubble. Finished
 * files can be dragged out to the OS; the folder they land in opens from here; Clear all asks
 * first. Desktop hosts manage the files; single-window hosts show the list only.
 */
export function DownloadsPanel({ state }: { state: UIState }): JSX.Element {
  const [query, setQuery] = useState('')
  /** "Clear all" asks first: how many rows go, while the question is up. */
  const [clearing, setClearing] = useState<number | null>(null)
  const items = downloadsEngine.list(state)
  const groups = groupDownloadsByDay(filterDownloads(items, query))
  const files = state.platform !== 'android'
  const clearable = items.filter((i) => !isActiveDownload(i)).length
  return (
    <>
      <OverlayShell title="Downloads" variant="full" className="zen-dl-surface zen-dl-page">
        <div className="zen-dl-page-body">
          <div className="zen-dl-page-tools">
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
                className="zen-dl-input h-8 w-full pl-9 pr-3 outline-none"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.stopPropagation()
                    setQuery('')
                  }
                }}
              />
            </label>
            {files && (
              <DlButton
                data-zen-dl-action="open-folder"
                onClick={() => downloadsEngine.openFolder()}
              >
                Open downloads folder
              </DlButton>
            )}
            <DlButton
              data-zen-dl-action="clear-all"
              disabled={!hasClearable(items)}
              onClick={() => setClearing(clearable)}
            >
              Clear all
            </DlButton>
          </div>
          {groups.length === 0 ? (
            <p className="zen-dl-empty zen-dl-page-empty">
              {query ? 'No downloads match your search' : 'Files you download appear here'}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.day} className="zen-dl-day">
                <h3 className="zen-dl-day-title">{group.label}</h3>
                <ul className="zen-dl-list">
                  {group.items.map((item) => (
                    <DownloadRow
                      key={item.id}
                      item={item}
                      source={displayUrl(item.referrer || item.url) || undefined}
                      draggable={files}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </OverlayShell>
      {/* The page's own question, over it in the frame's box, on its own host. */}
      <FrameDialogHost>
        {clearing !== null && (
          <ClearAllDialog
            count={clearing}
            onCancel={() => setClearing(null)}
            onConfirm={() => {
              setClearing(null)
              downloadsEngine.removeCompleted()
            }}
          />
        )}
      </FrameDialogHost>
    </>
  )
}

/**
 * "Clear all" asks before it empties the list, saying what goes and that the files stay (the
 * engine's `removeCompleted` leaves transfers still running alone). A v2 dialog (draft §9.23)
 * on a `FrameDialogHost` whose scrim dims the page: Escape, the scrim and Cancel keep the list,
 * Enter and the primary clear it; focus starts on Cancel so a stray Enter does no harm.
 */
function ClearAllDialog({
  count,
  onCancel,
  onConfirm
}: {
  count: number
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  useEscapeTrap(true, onCancel)
  useFrameDialog({ onScrimPress: onCancel })
  const rows = count === 1 ? '1 download' : `${count} downloads`
  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="zen-dl-clear-title"
      aria-describedby="zen-dl-clear-desc"
      data-zen-downloads-clear-dialog
      className="zen-animate-pop zen-bm-dialog zen-dl-surface flex max-w-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => wrapTab(e, dialogRef.current)}
    >
      <div className="zen-bm-title-block">
        <h2 id="zen-dl-clear-title" className="zen-bm-title">
          Clear all downloads?
        </h2>
        <p id="zen-dl-clear-desc" className="zen-bm-title-desc">
          {rows} will be removed from the list. The files stay where they were saved, and downloads
          still running are not touched.
        </p>
      </div>
      <form
        className="zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          onConfirm()
        }}
      >
        <div className="zen-bm-footer justify-end">
          <button ref={cancelRef} type="button" className="zen-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="zen-button" data-variant="primary">
            Clear all
          </button>
        </div>
      </form>
    </div>
  )
}
