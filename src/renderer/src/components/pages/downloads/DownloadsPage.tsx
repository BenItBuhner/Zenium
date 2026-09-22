import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { EllipsisVertical, ExternalLink, FolderOpen, Pause, Play, RotateCw, X } from 'lucide-react'
import {
  canResumeDownload,
  canRetryDownload,
  displayName,
  isActiveDownload
} from '@shared/downloadsShell'
import { parseInternalPageUrl } from '@shared/internalPages'
import type { DownloadItem, Tab, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { browserStore } from '@renderer/lib/browserStore'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { downloadsEngine, showsDangerDecision } from '@renderer/lib/downloadsEngine'
import {
  downloadStatus,
  filterDownloads,
  groupDownloadsByDay,
  hasClearable,
  isDeletedRow,
  isOnDisk,
  type DownloadDayGroup
} from '@renderer/lib/downloadsView'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { cn } from '@renderer/lib/utils'
import {
  DangerActions,
  DownloadProgressBar,
  FileName,
  FileTypeGlyph,
  IconAction,
  StatusText
} from '../../downloads/DownloadParts'
import { PageColumn, PageEmpty, PageGroup, PageSearchField, PageTitleBlock } from '../PageFrame'
import { walkRows } from '../rowKeys'
import { SheetActions } from '../settings/blocks'
import { SettingsDialog } from '../settings/dialogs'
import { usePageSearch } from '../usePageSearch'

/**
 * The Downloads page (`zen://downloads`, Ctrl+J; Chrome's `chrome://downloads`): a chrome page
 * tab (design language v2 §10.1) on the shared page frame (`PageFrame.tsx`) – the "Downloads"
 * title block with "Open downloads folder" and "Clear all" in its trailing slot, the search
 * field under it, then every download the browser remembers grouped by day under §9.27 headings
 * as §9.21 two-line rows: the file-type glyph on the first line, the name 15/20 truncating in
 * its middle over the source host and the status 13/20 – #166's states: `Done · 2 MB`, `Failed
 * · <reason>` in the danger ink, `Deleted` on the greyed row, a flagged file's `Blocked` with
 * its sentence – a transfer's own 3 px progress bar under them while it runs, and the row's
 * actions as §9.3 icon buttons in the trailing slot: the state's verb at rest (Pause or
 * Resume and Cancel while it runs, Retry once it failed, was cancelled or its file went, the
 * Keep / Delete pair for a flagged file), and on approach Open, Show in folder and the ⋮ that
 * hangs the core's row menu (Copy download link, Delete file, Remove from list, Retry, Open when
 * done) from itself.
 *
 * The search (§9.12) filters on the name and the source; the tab's URL follows it as
 * `zen://downloads?q=<text>` without a history entry, so a restored tab comes back searching.
 * Keyboard (§9.22): the arrows walk the rows, Enter opens a finished file, the Menu key opens
 * the row's menu, Ctrl+F on the tab focuses the field. Desktop hosts manage the files (a
 * finished file can be dragged out to the OS, its folder opens from here); single-window hosts
 * show the list only. As the page opens, the finished files are checked for being on disk
 * (Chrome does the same), so a row whose file went since reads Deleted. "Clear all" asks first,
 * in a v2 prompt over the content frame (§9.23).
 */
export function DownloadsPage({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  /** "Clear all" asks first: how many rows go, while the question is up. */
  const [clearing, setClearing] = useState<number | null>(null)
  const items = downloadsEngine.list(state)
  const files = state.platform !== 'android'

  const { query, setQuery, text } = usePageSearch({
    urlQuery,
    push: (value) =>
      run('page.navigate', {
        tabId: tab.id,
        section: null,
        replace: true,
        query: value ? { q: value } : undefined
      })
  })
  const groups = groupDownloadsByDay(filterDownloads(items, text))
  const clearable = items.filter((i) => !isActiveDownload(i)).length

  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    field.current?.focus()
    field.current?.select()
    return true
  })

  // Chrome checks its finished files as the page opens; a row whose file went reads Deleted.
  useEffect(() => {
    const current = browserStore.get().state
    if (current) downloadsEngine.refreshFiles(downloadsEngine.list(current))
  }, [])

  return (
    <>
      <PageColumn
        testId="downloads-page"
        className="zen-downloads-page"
        header={
          <>
            <PageTitleBlock
              title="Downloads"
              actions={
                <>
                  {files && (
                    <button
                      type="button"
                      className="zen-v2-button"
                      data-testid="downloads-open-folder"
                      onClick={() => downloadsEngine.openFolder()}
                    >
                      Open downloads folder
                    </button>
                  )}
                  <button
                    type="button"
                    className="zen-v2-button"
                    data-testid="downloads-clear-all"
                    disabled={!hasClearable(items)}
                    onClick={() => setClearing(clearable)}
                  >
                    Clear all
                  </button>
                </>
              }
            />
            <PageSearchField
              value={query}
              onChange={setQuery}
              placeholder="Search downloads"
              field={field}
              testId="downloads-search"
              autoFocus={!urlQuery}
            />
          </>
        }
      >
        <div ref={list} className="zen-page-list" onKeyDown={(e) => walkRows(e, list)}>
          {groups.length === 0 ? (
            <PageEmpty testId="downloads-empty">
              {text ? `No downloads match “${text}”` : 'Files you download appear here'}
            </PageEmpty>
          ) : (
            groups.map((group) => (
              <DayGroup key={group.day} group={group} files={files} tabId={tab.id} />
            ))
          )}
        </div>
      </PageColumn>
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
    </>
  )
}

// ---------------------------------------------------------------------------
// Day groups and rows
// ---------------------------------------------------------------------------

function DayGroup({
  group,
  files,
  tabId
}: {
  group: DownloadDayGroup
  files: boolean
  tabId: string
}): JSX.Element {
  return (
    <PageGroup
      heading={group.label}
      headingId={`zen-downloads-day-${group.day}`}
      aside={group.items.length}
      data-day={group.day}
    >
      <ul className="zen-page-rows">
        {group.items.map((item) => (
          <DownloadPageRow key={item.id} item={item} files={files} tabId={tabId} />
        ))}
      </ul>
    </PageGroup>
  )
}

/**
 * One download on the page: the shared `.zen-v2-row` as the page's §9.21 two-line row (the
 * `.zen-dl-page-row` modifier adds the two-line floor and the greyed Deleted row), focusable as
 * a whole for the arrows (§9.22) with the name a button that opens a finished file (the row's
 * Enter and a double click open it too). A middle or Ctrl click anywhere on the row – the name
 * included – is §10.1's one meaning on every page row: it opens the download's page (the page
 * it was taken from, else its own address) in a tab behind this one, the file left alone. A
 * right click or the Menu key asks the core for the row's menu; on desktop hosts a finished
 * file can be dragged out to the OS.
 */
function DownloadPageRow({
  item,
  files,
  tabId
}: {
  item: DownloadItem
  files: boolean
  tabId: string
}): JSX.Element {
  const e = downloadsEngine
  const id = item.id
  const active = isActiveDownload(item)
  const openable = isOnDisk(item)
  const flagged = showsDangerDecision(item)
  const deleted = isDeletedRow(item)
  const name = displayName(item)
  const status = downloadStatus(item)
  const page = item.referrer || item.url
  const host = displayHost(page)
  const inFlight = item.state === 'progressing' || item.state === 'paused'
  const resumable = canResumeDownload(item)
  const retryable = !resumable && canRetryDownload(item)
  const open = (): void => {
    if (openable) e.open(id)
  }
  const openPageBehind = (): void => {
    run('urlbar.submit', { input: page, newTab: true, tabId, background: true })
  }
  /**
   * A click with Ctrl or ⌘ held – on the row or its name – is the page behind, not the file;
   * a double click's second click (`detail` 2) opens nothing more. True when the click was one.
   */
  const behindOn = (ev: ReactMouseEvent): boolean => {
    if (!ev.ctrlKey && !ev.metaKey) return false
    ev.preventDefault()
    if (ev.detail <= 1) openPageBehind()
    return true
  }
  const menu = (ev: ReactMouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    e.contextMenu(id, contextMenuAnchor(ev))
  }
  return (
    <li
      className="zen-v2-row zen-page-row zen-dl-page-row"
      data-state={item.state}
      data-download-id={id}
      data-flagged={flagged || undefined}
      data-deleted={deleted || undefined}
      data-row-focus=""
      tabIndex={0}
      aria-label={`${name}. ${status.text}`}
      draggable={files && openable}
      onDragStart={(ev) => {
        // The OS drag is the host's: hand the file over and drop the HTML5 one.
        ev.preventDefault()
        e.dragOut(id)
      }}
      onClick={(ev) => {
        if ((ev.target as HTMLElement).closest('button, input')) return
        behindOn(ev)
      }}
      onAuxClick={(ev) => {
        if (ev.button !== 1 || (ev.target as HTMLElement).closest('.zen-dl-page-actions')) return
        ev.preventDefault()
        openPageBehind()
      }}
      onDoubleClick={(ev) => {
        // A Ctrl-double-click's first click opened the page behind already.
        if (!ev.ctrlKey && !ev.metaKey) open()
      }}
      onContextMenu={menu}
      onKeyDown={(ev) => {
        if (openable && ev.key === 'Enter' && ev.target === ev.currentTarget) {
          ev.preventDefault()
          open()
        }
      }}
    >
      <FileTypeGlyph item={item} />
      <div className="zen-page-row-text zen-dl-page-text">
        <FileName
          name={name}
          title={item.savePath || item.url}
          dim={item.state === 'cancelled' || deleted}
          // The name's own click stops at the button: its Ctrl-click is the page behind here.
          onOpen={
            openable
              ? (ev) => {
                  if (!behindOn(ev)) open()
                }
              : undefined
          }
        />
        <span className="zen-page-row-desc tabular-nums">
          {host && <span className="zen-dl-page-host">{host}</span>}
          {host && status.text && ' · '}
          <StatusText item={item} />
        </span>
        {status.detail && <span className="zen-dl-detail">{status.detail}</span>}
        {active && <DownloadProgressBar item={item} />}
      </div>
      <div className="zen-dl-page-actions">
        {flagged ? (
          <DangerActions item={item} />
        ) : (
          <>
            {item.state === 'progressing' && (
              <IconAction title="Pause" icon={Pause} action="pause" onClick={() => e.pause(id)} />
            )}
            {resumable && (
              <IconAction title="Resume" icon={Play} action="resume" onClick={() => e.resume(id)} />
            )}
            {inFlight && (
              <IconAction title="Cancel" icon={X} action="cancel" onClick={() => e.cancel(id)} />
            )}
            {retryable && (
              <IconAction
                title="Retry"
                icon={RotateCw}
                action="retry"
                onClick={() => e.retry(id)}
              />
            )}
            {openable && (
              <IconAction
                title="Open"
                icon={ExternalLink}
                action="open"
                className="zen-page-row-reveal"
                onClick={open}
              />
            )}
            {openable && files && (
              <IconAction
                title="Show in folder"
                icon={FolderOpen}
                action="show-in-folder"
                className="zen-page-row-reveal"
                onClick={() => e.showInFolder(id)}
              />
            )}
          </>
        )}
        <IconAction
          title="More actions"
          icon={EllipsisVertical}
          action="menu"
          menu
          className={cn(!flagged && 'zen-page-row-reveal')}
          onClick={(ev) => {
            // The menu hangs from the button; a keyboard press (Enter and Space report a
            // `detail` of 0) starts the menu with its first item selected.
            const box = ev.currentTarget.getBoundingClientRect()
            e.contextMenu(id, {
              x: Math.round(box.right),
              y: Math.round(box.bottom),
              keyboard: ev.detail === 0
            })
          }}
        />
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Clear all
// ---------------------------------------------------------------------------

/**
 * "Clear all" asks before it empties the list, saying what goes and that the files stay (the
 * engine's `removeCompleted` leaves transfers still running alone): a v2 prompt (§9.23) over
 * the content frame on the frame's dialog host – Escape, the scrim and Cancel keep the list,
 * the destructive action clears it; focus starts on Cancel so a stray Enter does no harm.
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
  const rows = count === 1 ? '1 download' : `${count} downloads`
  return (
    <SettingsDialog
      name="downloads:clear-all"
      title="Clear all downloads?"
      description={`${rows} will be removed from the list. The files stay where they were saved, and downloads still running are not touched.`}
      under={false}
      onClose={onCancel}
      className="zen-settings-dialog-prompt"
    >
      <SheetActions action="Clear all" destructive onCancel={onCancel} onAction={onConfirm} />
    </SettingsDialog>
  )
}
