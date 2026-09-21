import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, EllipsisVertical, Globe, RotateCcw, X } from 'lucide-react'
import { parseInternalPageUrl } from '@shared/internalPages'
import type { ClosedEntrySummary, HistoryDayGroup, HistoryVisit, Tab } from '@shared/types'
import { presentedUrl } from '@shared/url'
import { dayLabel } from '@shared/dayKey'
import { cmd, onEvent, run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { presentedHost, useExtensionList } from '@renderer/lib/extensions/pages'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { openClearBrowsingData } from '@renderer/lib/ui'
import { PageColumn, PageEmpty, PageGroup, PageSearchField, PageTitleBlock } from '../PageFrame'
import { usePageSearch } from '../usePageSearch'

/** Visits fetched per page; "Show more" adds another page. */
const PAGE_SIZE = 300
const EMPTY: ReadonlySet<string> = new Set()

/** The picked rows and the search they were picked in. */
interface Picked {
  text: string
  ids: ReadonlySet<string>
}

/**
 * The History page (`zen://history`, Ctrl+H; Chrome's `chrome://history`): a chrome page tab
 * (design language v2 §10.1) on the shared page frame (`PageFrame.tsx`) – the "History" title
 * block with "Clear browsing data…" in its trailing slot, the search field under it, then every
 * visit grouped by day under §9.27 headings ("Today", "Yesterday", the weekday, the date) as
 * §9.21 two-line rows: the favicon on the first line, the title 15/20 over the host 13/20
 * deemphasised, the visit's time at the trailing edge and the row's ⋮ menu (the core's history
 * menu, the same as a right click's). Recently closed tabs and windows are the page's first group
 * while nothing is searched.
 *
 * The search (§9.12) filters as History's did (every term in the title or URL); the tab's URL
 * follows it as `zen://history?q=<text>` without a history entry, so the address says what the
 * page shows and a restored tab comes back searching, and a query the URL brings – Chrome's
 * "More from this site", the omnibox's `@history <text>`, back and forward – fills the field.
 * Rows select per §9.6: the checkbox on the first line, the row on `--v2-selected` while it is
 * picked; while anything is selected the title block's slot holds the count, Delete and Cancel.
 * Keyboard (§9.22): the arrows walk the rows, Space picks, Enter opens, Delete removes the
 * focused row or the selection, Escape clears the selection; Ctrl+F on the tab focuses the field.
 * "Clear browsing data…" is the services dialog through the frame dialog host (§9.23).
 */
export function HistoryPage({ tab }: { tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const [closed, setClosed] = useState<ClosedEntrySummary[]>([])
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // The URL and the field, kept as one (`usePageSearch`): the tab's URL follows a settled search
  // as `zen://history?q=<text>` without a history entry.
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
  // The selection belongs to the list it was made in: a new search – typed or brought by the
  // URL – starts over with nothing selected.
  const [picked, setPicked] = useState<Picked>({ text, ids: EMPTY })
  const selected = picked.text === text ? picked.ids : EMPTY
  const setSelected = (update: (current: ReadonlySet<string>) => ReadonlySet<string>): void =>
    setPicked((current) => {
      const ids = update(current.text === text ? current.ids : EMPTY)
      return ids === current.ids && current.text === text ? current : { text, ids }
    })

  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    field.current?.focus()
    field.current?.select()
    return true
  })

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void cmd('session.recentlyClosed', undefined)
        .then((entries) => {
          if (!cancelled) setClosed(entries)
        })
        .catch(() => undefined)
    }
    refresh()
    const off = onEvent('session.recentlyClosedChanged', refresh)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const open = (url: string, newTab: boolean): void => {
    run('urlbar.submit', { input: url, newTab, tabId: tab.id })
  }
  const toggle = (id: string, checked: boolean): void => {
    setSelected((current) => {
      if (current.has(id) === checked) return current
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const remove = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    setSelected((current) => {
      if (!ids.some((id) => current.has(id))) return current
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
    run('history.deleteVisits', { ids: [...ids] })
  }

  const selecting = selected.size > 0
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (inTextField(e.target)) return
    if (e.key === 'Escape' && selecting) {
      e.preventDefault()
      e.stopPropagation()
      setSelected(() => EMPTY)
      return
    }
    if (e.key === 'Delete') {
      // The selection when there is one, else the row the key came from.
      const row = e.target instanceof HTMLElement ? e.target.closest('[data-visit-id]') : null
      const id = row?.getAttribute('data-visit-id')
      if (selecting) remove([...selected])
      else if (id) remove([id])
      else return
      e.preventDefault()
    }
  }

  return (
    <PageColumn
      testId="history-page"
      className="zen-history-page"
      onKeyDown={onKeyDown}
      header={
        <>
          <PageTitleBlock
            title="History"
            actions={
              selecting ? (
                <>
                  <span className="zen-page-title-count" role="status">
                    {selected.size} selected
                  </span>
                  <button
                    type="button"
                    className="zen-v2-button"
                    data-danger=""
                    data-testid="history-delete-selected"
                    onClick={() => remove([...selected])}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="zen-v2-button"
                    onClick={() => setSelected(() => EMPTY)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="zen-v2-button"
                  data-testid="history-clear-browsing-data"
                  onClick={() => void openClearBrowsingData(tab.id)}
                >
                  Clear browsing data…
                </button>
              )
            }
          />
          <PageSearchField
            value={query}
            onChange={setQuery}
            placeholder="Search history"
            field={field}
            testId="history-search"
            autoFocus={!urlQuery}
          />
        </>
      }
    >
      <div ref={list} data-selecting={selecting || undefined} onKeyDown={(e) => walkRows(e, list)}>
        {closed.length > 0 && !text && <RecentlyClosed entries={closed} />}
        <VisitList
          // A new search starts over at the first page.
          key={text}
          text={text}
          selected={selected}
          onToggle={toggle}
          onOpen={open}
        />
      </div>
    </PageColumn>
  )
}

/** Whether a key came from a text field (the search field), whose keys are its own. */
function inTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type !== 'checkbox'
}

/**
 * The arrows walk the rows' primary buttons (`data-row-focus`) across every group, Home and End
 * jump to the first and last (§9.22); a key from inside the search field is the field's.
 */
function walkRows(e: KeyboardEvent<HTMLDivElement>, list: { current: HTMLElement | null }): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const target = e.target
  if (!(target instanceof HTMLElement) || inTextField(target)) return
  const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row-focus]') ?? [])]
  if (rows.length === 0) return
  const row = target.closest<HTMLElement>('.zen-v2-row')
  const at = rows.findIndex((r) => r === target || (row !== null && row.contains(r)))
  let next: number
  if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = rows.length - 1
  else if (at === -1) next = e.key === 'ArrowDown' ? 0 : rows.length - 1
  else next = Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
  e.preventDefault()
  rows[next]?.focus()
}

// ---------------------------------------------------------------------------
// The visit list: day groups, paging, selection
// ---------------------------------------------------------------------------

interface Loaded {
  groups: HistoryDayGroup[]
  /** When the list was fetched; the day headings ("Today") are relative to it. */
  now: number
}

function VisitList({
  text,
  selected,
  onToggle,
  onOpen
}: {
  text: string
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  onOpen: (url: string, newTab: boolean) => void
}): JSX.Element | null {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void cmd('history.grouped', { query: { text: text || undefined, limit } })
        .then((groups) => {
          if (!cancelled) setLoaded({ groups, now: Date.now() })
        })
        .catch(() => undefined)
    }
    load()
    const off = onEvent('history.changed', load)
    return () => {
      cancelled = true
      off()
    }
  }, [text, limit])

  const terms = useMemo(() => text.toLowerCase().split(/\s+/).filter(Boolean), [text])
  const groups = loaded?.groups ?? null
  const visitCount = useMemo(
    () => (groups ?? []).reduce((n, g) => n + g.visits.length, 0),
    [groups]
  )
  const hasMore = visitCount >= limit

  if (!loaded || !groups) return null
  if (groups.length === 0) {
    return (
      <PageEmpty testId="history-empty">
        {text ? `No history matches “${text}”` : 'Pages you visit will show up here'}
      </PageEmpty>
    )
  }
  return (
    <>
      {groups.map((group) => (
        <DayGroup
          key={group.dayKey}
          group={group}
          now={loaded.now}
          terms={terms}
          selected={selected}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
      {hasMore && (
        <div className="zen-page-more">
          <button
            type="button"
            className="zen-v2-button"
            onClick={() => setLimit((n) => n + PAGE_SIZE)}
          >
            Show more
          </button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Day groups and rows
// ---------------------------------------------------------------------------

function DayGroup({
  group,
  now,
  terms,
  selected,
  onToggle,
  onOpen
}: {
  group: HistoryDayGroup
  now: number
  terms: string[]
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  onOpen: (url: string, newTab: boolean) => void
}): JSX.Element {
  const label = dayLabel(group.dayKey, now)
  return (
    <PageGroup
      heading={label}
      headingId={`zen-history-day-${group.dayKey}`}
      aside={group.visits.length}
      data-day={group.dayKey}
      control={
        <button
          type="button"
          className="zen-v2-icon-button"
          title="Options for this day"
          aria-label={`Options for ${label}`}
          aria-haspopup="menu"
          onClick={() =>
            run('history.dayMenu', { dayKey: group.dayKey, count: group.visits.length })
          }
        >
          <EllipsisVertical aria-hidden />
        </button>
      }
    >
      <ul className="zen-page-rows">
        {group.visits.map((visit) => (
          <VisitRow
            key={visit.id}
            visit={visit}
            terms={terms}
            selected={selected.has(visit.id)}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </PageGroup>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function VisitRow({
  visit,
  terms,
  selected,
  onToggle,
  onOpen
}: {
  visit: HistoryVisit
  terms: string[]
  selected: boolean
  onToggle: (id: string, checked: boolean) => void
  onOpen: (url: string, newTab: boolean) => void
}): JSX.Element {
  const extensions = useExtensionList()
  const host = presentedHost(visit.url, extensions) || presentedUrl(visit.url)
  const title = visit.title || host
  const menu = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    run('history.contextMenu', { visitId: visit.id, url: visit.url, ...contextMenuAnchor(e) })
  }
  return (
    <li
      className="zen-v2-row zen-page-row"
      data-selected={selected || undefined}
      data-visit-id={visit.id}
      onContextMenu={menu}
    >
      <input
        type="checkbox"
        className="zen-v2-checkbox zen-page-row-check zen-page-row-reveal"
        checked={selected}
        aria-label={`Select ${title}`}
        onChange={(e) => onToggle(visit.id, e.target.checked)}
      />
      <span className="zen-page-row-lead" aria-hidden>
        <FaviconImage src={visit.favicon} />
      </span>
      <button
        type="button"
        className="zen-page-row-text"
        data-row-focus=""
        title={presentedUrl(visit.url)}
        onClick={(e) => {
          if (e.shiftKey) onToggle(visit.id, !selected)
          else onOpen(visit.url, e.ctrlKey || e.metaKey)
        }}
        onAuxClick={(e) => e.button === 1 && onOpen(visit.url, true)}
        onKeyDown={(e) => {
          // Space picks the row (Enter, the button's own, opens it).
          if (e.key === ' ') {
            e.preventDefault()
            onToggle(visit.id, !selected)
          }
        }}
      >
        <span className="zen-page-row-label">{highlight(title, terms)}</span>
        <span className="zen-page-row-desc">{highlight(host, terms)}</span>
      </button>
      <time
        className="zen-page-row-time"
        dateTime={new Date(visit.visitTime).toISOString()}
        aria-label={`Visited at ${timeFormat.format(visit.visitTime)}`}
      >
        {timeFormat.format(visit.visitTime)}
      </time>
      <button
        type="button"
        className="zen-v2-icon-button zen-page-row-reveal"
        title="More actions"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          run('history.contextMenu', {
            visitId: visit.id,
            url: visit.url,
            x: Math.round(box.right),
            y: Math.round(box.bottom),
            keyboard: e.detail === 0
          })
        }}
      >
        <EllipsisVertical aria-hidden />
      </button>
    </li>
  )
}

function FaviconImage({ src }: { src: string | null }): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  if (src && broken !== src) {
    return (
      <img
        src={src}
        alt=""
        className="zen-page-row-favicon"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(src)}
      />
    )
  }
  return <Globe className="zen-page-row-favicon zen-page-row-favicon-fallback" aria-hidden />
}

/** Wrap every occurrence of a search term in `<mark>`. */
function highlight(text: string, terms: string[]): ReactNode {
  if (terms.length === 0 || !text) return text
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const probe = new RegExp(`^(?:${terms.map(escapeRegExp).join('|')})$`, 'i')
  const parts = text.split(pattern)
  if (parts.length === 1) return text
  return parts.map((part, i) => (probe.test(part) ? <mark key={i}>{part}</mark> : part))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Recently closed
// ---------------------------------------------------------------------------

/**
 * The window's recently closed tabs and windows (Chrome's "Recently closed" on its history
 * page) as the page's first group: a row restores its entry; the heading's control clears the
 * list. A closed page tab (Settings, this page's siblings) carries its glyph as its favicon.
 */
function RecentlyClosed({ entries }: { entries: ClosedEntrySummary[] }): JSX.Element {
  const extensions = useExtensionList()
  return (
    <PageGroup
      heading="Recently closed"
      headingId="zen-history-recently-closed"
      aside={entries.length}
      data-testid="history-recently-closed"
      control={
        <button
          type="button"
          className="zen-v2-icon-button"
          title="Clear the recently closed list"
          aria-label="Clear the recently closed list"
          onClick={() => run('session.clearRecentlyClosed', undefined)}
        >
          <X aria-hidden />
        </button>
      }
    >
      <ul className="zen-page-rows">
        {entries.map((entry) => {
          const host = entry.url ? presentedHost(entry.url, extensions) : ''
          const restore = (): void => run('session.restoreClosed', { id: entry.id })
          const label =
            entry.kind === 'window'
              ? `Window with ${entry.tabCount} ${entry.tabCount === 1 ? 'tab' : 'tabs'}`
              : entry.title || host
          return (
            <li key={entry.id} className="zen-v2-row zen-page-row" data-closed-id={entry.id}>
              {/* Keeps the favicons in line with the visit rows, which lead with a checkbox. */}
              <span className="zen-page-row-check" aria-hidden />
              <span className="zen-page-row-lead" aria-hidden>
                {entry.kind === 'window' ? (
                  <AppWindow className="zen-page-row-favicon zen-page-row-favicon-fallback" />
                ) : (
                  <FaviconImage src={entry.favicon} />
                )}
              </span>
              <button
                type="button"
                className="zen-page-row-text"
                data-row-focus=""
                title={entry.url ? presentedUrl(entry.url) : undefined}
                onClick={restore}
              >
                <span className="zen-page-row-label">{label}</span>
                <span className="zen-page-row-desc">
                  {entry.kind === 'window' ? entry.title : host}
                </span>
              </button>
              <time
                className="zen-page-row-time"
                dateTime={new Date(entry.closedAt).toISOString()}
                aria-label={`Closed at ${timeFormat.format(entry.closedAt)}`}
              >
                {timeFormat.format(entry.closedAt)}
              </time>
              <button
                type="button"
                className="zen-v2-icon-button zen-page-row-reveal"
                title={entry.kind === 'window' ? 'Reopen window' : 'Restore tab'}
                aria-label={entry.kind === 'window' ? 'Reopen window' : 'Restore tab'}
                onClick={restore}
              >
                <RotateCcw aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
    </PageGroup>
  )
}
