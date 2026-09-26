import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import { Check, EllipsisVertical, Globe, RotateCcw } from 'lucide-react'
import { parseInternalPageUrl } from '@shared/internalPages'
import { filterReadingList, isUnread, unreadReadingCount } from '@shared/readingList'
import type { ReadingListEntry, Tab, UIState } from '@shared/types'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { relativeTime } from '@renderer/lib/utils'
import { IconAction } from '../../downloads/DownloadParts'
import { PageColumn, PageEmpty, PageGroup, PageSearchField, PageTitleBlock } from '../PageFrame'
import { walkRows } from '../rowKeys'
import { usePageSearch } from '../usePageSearch'

/**
 * The Reading List page (`zen://reading-list`; W6-1, bookmarks-33; Chrome's reading list): a
 * chrome page tab (design language v2 §10.1) on the shared page frame (`PageFrame.tsx`) – the
 * "Reading List" title block with "Mark all as read" in its trailing slot, the search field
 * under it, then the entries under two §9.27 headings, Unread (its count as the aside) and Read,
 * in the model's one order (`shared/readingList.ts`: unread first, newest first), as §9.21
 * two-line rows: the 16 favicon carrying §9.29's unread dot at its corner, the title 15/20
 * over the host and when it was added 13/20, and in the trailing slot on approach the state's
 * verb – Mark as read, or Mark as unread once read – and the ⋮ that hangs the core's row menu
 * (Open, Open in New Tab, Mark as read / unread, Copy Link, Remove) from itself.
 *
 * Opening a row (a click, Enter, a double click) opens the page in this tab and marks the entry
 * read; a middle or Ctrl click is §10.1's one meaning on every page row – the page in a tab
 * behind this one, marked read the same. The search (§9.12) filters on the title and the host;
 * the tab's URL follows it as `zen://reading-list?q=<text>` without a history entry, so a
 * restored tab comes back searching. Keyboard (§9.22): the arrows walk the rows, Enter opens,
 * Delete removes, the Menu key opens the row's menu, Ctrl+F on the tab focuses the field.
 */
export function ReadingListPage({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const entries = state.readingList
  const unread = unreadReadingCount(entries ?? [])

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
  const shown = useMemo(() => filterReadingList(entries ?? [], text), [entries, text])
  const waiting = shown.filter(isUnread)
  const done = shown.filter((e) => !isUnread(e))

  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    field.current?.focus()
    field.current?.select()
    return true
  })

  return (
    <PageColumn
      testId="reading-list-page"
      className="zen-reading-list-page"
      header={
        <>
          <PageTitleBlock
            title="Reading List"
            actions={
              <button
                type="button"
                className="zen-v2-button"
                data-testid="reading-list-mark-all"
                disabled={unread === 0}
                onClick={() => run('readingList.markAllRead', undefined)}
              >
                Mark all as read
              </button>
            }
          />
          <PageSearchField
            value={query}
            onChange={setQuery}
            placeholder="Search reading list"
            field={field}
            testId="reading-list-search"
            autoFocus={!urlQuery}
          />
        </>
      }
    >
      <div ref={list} className="zen-page-list" onKeyDown={(e) => walkRows(e, list)}>
        {shown.length === 0 ? (
          <PageEmpty testId="reading-list-empty">
            {text ? `No pages match “${text}”` : 'Pages you save to read later appear here'}
          </PageEmpty>
        ) : (
          <>
            {waiting.length > 0 && (
              <EntryGroup
                heading="Unread"
                id="unread"
                aside={waiting.length}
                entries={waiting}
                tabId={tab.id}
              />
            )}
            {done.length > 0 && (
              <EntryGroup heading="Read" id="read" entries={done} tabId={tab.id} />
            )}
          </>
        )}
      </div>
    </PageColumn>
  )
}

// ---------------------------------------------------------------------------
// Groups and rows
// ---------------------------------------------------------------------------

function EntryGroup({
  heading,
  id,
  aside,
  entries,
  tabId
}: {
  heading: string
  id: string
  aside?: number
  entries: ReadingListEntry[]
  tabId: string
}): JSX.Element {
  return (
    <PageGroup
      heading={heading}
      headingId={`zen-reading-list-${id}`}
      aside={aside}
      data-reading-group={id}
    >
      <ul className="zen-page-rows" aria-labelledby={`zen-reading-list-${id}`}>
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} tabId={tabId} />
        ))}
      </ul>
    </PageGroup>
  )
}

/**
 * One saved page: the shared `.zen-v2-row` as the page's §9.21 two-line row, focusable as a
 * whole for the arrows (§9.22). The row's text is a button that opens the page here; a middle
 * or Ctrl click anywhere on the row opens it in a tab behind. The favicon seat carries §9.29's
 * dot while the entry is unread. A right click or the Menu key asks the core for the row's menu.
 */
function EntryRow({ entry, tabId }: { entry: ReadingListEntry; tabId: string }): JSX.Element {
  const unread = isUnread(entry)
  const host = displayHost(entry.url) || entry.url
  const title = entry.title || host
  const id = entry.id
  const open = (background: boolean): void => {
    run('readingList.open', { id, tabId, newTab: background, background })
  }
  const menu = (ev: ReactMouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    run('readingList.contextMenu', { id, ...contextMenuAnchor(ev) })
  }
  const keys = (ev: ReactKeyboardEvent): void => {
    if (ev.target !== ev.currentTarget) return
    if (ev.key === 'Enter') {
      ev.preventDefault()
      open(ev.ctrlKey || ev.metaKey)
    } else if (ev.key === 'Delete') {
      ev.preventDefault()
      run('readingList.remove', { id })
    }
  }
  return (
    <li
      className="zen-v2-row zen-page-row zen-rl-page-row"
      data-reading-id={id}
      data-unread={unread || undefined}
      data-row-focus=""
      tabIndex={0}
      aria-label={`${title}. ${unread ? 'Unread' : 'Read'}`}
      onClick={(ev) => {
        if ((ev.target as HTMLElement).closest('button')) return
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault()
          open(true)
        }
      }}
      onAuxClick={(ev) => {
        if (ev.button !== 1 || (ev.target as HTMLElement).closest('.zen-rl-page-actions')) return
        ev.preventDefault()
        open(true)
      }}
      onContextMenu={menu}
      onKeyDown={keys}
    >
      <span className="zen-page-row-lead zen-rl-favicon-seat" data-unread={unread || undefined}>
        <EntryFavicon entry={entry} />
        {unread && <span className="zen-rl-unread-dot" aria-hidden />}
      </span>
      <button
        type="button"
        className="zen-page-row-text"
        title={entry.url}
        onClick={(ev) => {
          ev.stopPropagation()
          open(ev.ctrlKey || ev.metaKey)
        }}
        onAuxClick={(ev) => {
          if (ev.button !== 1) return
          ev.preventDefault()
          ev.stopPropagation()
          open(true)
        }}
      >
        <span className="zen-page-row-label">{title}</span>
        <span className="zen-page-row-desc">
          <span className="zen-rl-host">{host}</span>
          {' · '}
          <time dateTime={new Date(entry.addedAt).toISOString()}>
            {`Added ${relativeTime(entry.addedAt).replace(/^Just now$/, 'just now')}`}
          </time>
        </span>
      </button>
      <div className="zen-rl-page-actions">
        <IconAction
          title={unread ? 'Mark as read' : 'Mark as unread'}
          icon={unread ? Check : RotateCcw}
          action={unread ? 'mark-read' : 'mark-unread'}
          className="zen-page-row-reveal"
          onClick={() => run('readingList.setRead', { id, read: unread })}
        />
        <IconAction
          title="More actions"
          icon={EllipsisVertical}
          action="menu"
          menu
          className="zen-page-row-reveal"
          onClick={(ev) => {
            // The menu hangs from the button; a keyboard press (Enter and Space report a
            // `detail` of 0) starts the menu with its first item selected.
            const box = ev.currentTarget.getBoundingClientRect()
            run('readingList.contextMenu', {
              id,
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

/**
 * The entry's 16 px favicon from the core's cache when it holds a copy (`useFaviconSrc`: a
 * closed page's row never asks the network), the globe for a site with none or a broken one.
 */
function EntryFavicon({ entry }: { entry: ReadingListEntry }): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const resolved = useFaviconSrc(entry.favicon ?? null, entry.url)
  if (resolved && broken !== resolved) {
    return (
      <img
        src={resolved}
        alt=""
        className="zen-page-row-favicon"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(resolved)}
      />
    )
  }
  return <Globe className="zen-page-row-favicon zen-page-row-favicon-fallback" aria-hidden />
}
