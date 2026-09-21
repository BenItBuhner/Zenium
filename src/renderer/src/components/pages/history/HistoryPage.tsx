import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, EllipsisVertical, Globe, RotateCcw, X } from 'lucide-react'
import { internalPageOf, parseInternalPageUrl } from '@shared/internalPages'
import type { ClosedEntrySummary, HistoryDayGroup, HistoryVisit, Tab } from '@shared/types'
import { presentedUrl } from '@shared/url'
import { dayKeyOf } from '@shared/dayKey'
import { cmd, onEvent, run } from '@renderer/lib/api'
import { dayLabel } from '@renderer/lib/historyGroups'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { presentedHost, useExtensionList } from '@renderer/lib/extensions/pages'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { PAGE_GLYPHS } from '@renderer/lib/pageGlyphs'
import { openClearBrowsingData } from '@renderer/lib/ui'
import { PageColumn, PageEmpty, PageGroup, PageSearchField, PageTitleBlock } from '../PageFrame'
import { inTextField, walkRows } from '../rowKeys'
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
 * Selection is a mode (§9.6, §10.1 – as the phone list's long-press mode): at rest a row leads
 * with its favicon at the row's 16, no slot held for a checkbox. Ctrl- or Shift-click on a row,
 * "Select" in its ⋮ menu or Ctrl+A enters the mode: the checkbox column shows on every row while
 * it lasts (the favicons move once, at its start), a picked row sits on `--v2-selected`, a plain
 * click picks or drops a row, Shift-click picks the run from the last picked one, and the title
 * block's slot holds the count, Delete and Cancel. Cancel, Escape, dropping the last picked row
 * or deleting the selection leaves the mode and the column goes.
 * Keyboard (§9.22): the arrows walk the rows, Space picks, Enter opens, Delete removes the
 * focused row or the selection, Escape leaves the mode; Ctrl+F on the tab focuses the field.
 * "Clear browsing data…" is the services dialog through the frame dialog host (§9.23).
 */
export function HistoryPage({ tab }: { tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const [closed, setClosed] = useState<ClosedEntrySummary[]>([])
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  /** The last row picked or dropped: where a Shift-click's run starts. */
  const anchor = useRef<string | null>(null)

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

  // The row's menu asked for the row (the core's "Select"): picked into the list shown now.
  useEffect(
    () =>
      onEvent('history.select', ({ visitId }) => {
        anchor.current = visitId
        setPicked((current) => {
          const ids = new Set(current.text === text ? current.ids : EMPTY)
          ids.add(visitId)
          return { text, ids }
        })
      }),
    [text]
  )

  const open = (url: string, newTab: boolean): void => {
    run('urlbar.submit', { input: url, newTab, tabId: tab.id })
  }
  /** The visits' ids in the order the page shows them. */
  const shownIds = (): string[] =>
    [...(list.current?.querySelectorAll('[data-visit-id]') ?? [])].map(
      (row) => row.getAttribute('data-visit-id') ?? ''
    )
  const toggle = (id: string, checked: boolean): void => {
    anchor.current = id
    setSelected((current) => {
      if (current.has(id) === checked) return current
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  /** Shift-click: the run from the last picked row to this one joins the selection. */
  const extend = (id: string): void => {
    const ids = shownIds()
    const from = anchor.current ? ids.indexOf(anchor.current) : -1
    const to = ids.indexOf(id)
    if (from === -1 || to === -1) {
      toggle(id, true)
      return
    }
    const span = ids.slice(Math.min(from, to), Math.max(from, to) + 1)
    setSelected((current) => new Set([...current, ...span]))
  }
  const selectAll = (): void => {
    const ids = shownIds()
    if (ids.length === 0) return
    anchor.current = null
    setSelected(() => new Set(ids))
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

  // The mode lasts while anything is picked: dropping or deleting the last row leaves it.
  const selecting = selected.size > 0
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (inTextField(e.target)) return
    if (e.key === 'Escape' && selecting) {
      e.preventDefault()
      e.stopPropagation()
      setSelected(() => EMPTY)
      return
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      // Ctrl+A picks every visit shown, entering the mode (the field keeps its own select-all).
      e.preventDefault()
      selectAll()
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
        {closed.length > 0 && !text && <RecentlyClosed entries={closed} selecting={selecting} />}
        <VisitList
          // A new search starts over at the first page.
          key={text}
          text={text}
          selected={selected}
          selecting={selecting}
          onToggle={toggle}
          onExtend={extend}
          onOpen={open}
        />
      </div>
    </PageColumn>
  )
}

// ---------------------------------------------------------------------------
// The visit list: day groups, paging, selection
// ---------------------------------------------------------------------------

interface Loaded {
  groups: HistoryDayGroup[]
  /** When the list was fetched; the day headings ("Today") are relative to it. */
  now: number
}

/** What a row needs of the selection: whether the mode is on and how a row joins or leaves it. */
interface Selection {
  selected: ReadonlySet<string>
  selecting: boolean
  onToggle: (id: string, checked: boolean) => void
  onExtend: (id: string) => void
}

function VisitList({
  text,
  selected,
  selecting,
  onToggle,
  onExtend,
  onOpen
}: Selection & {
  text: string
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
          selecting={selecting}
          onToggle={onToggle}
          onExtend={onExtend}
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
  selecting,
  onToggle,
  onExtend,
  onOpen
}: Selection & {
  group: HistoryDayGroup
  now: number
  terms: string[]
  onOpen: (url: string, newTab: boolean) => void
}): JSX.Element {
  // "Today", "Yesterday", the weekday for the rest of the week, then the date: the phone
  // history list's vocabulary (`historyGroups.ts`), one across both platforms.
  const label = dayLabel(group.dayKey, dayKeyOf(now))
  return (
    <PageGroup
      heading={label}
      headingId={`zen-history-day-${group.dayKey}`}
      aside={group.visits.length}
      data-day={group.dayKey}
      control={
        // The day's ⋮ follows the rows' rule (§10.1): on approach, so at rest the heading is its
        // text and count, ending where the rows' times do (Chrome's date headers are text alone).
        <button
          type="button"
          className="zen-v2-icon-button zen-page-heading-reveal"
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
            selecting={selecting}
            onToggle={onToggle}
            onExtend={onExtend}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </PageGroup>
  )
}

// The locale's clock, as the phone list's `visitTime` ("9:41 AM", "09:41"), one formatter for the rows.
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function VisitRow({
  visit,
  terms,
  selected,
  selecting,
  onToggle,
  onExtend,
  onOpen
}: Omit<Selection, 'selected'> & {
  visit: HistoryVisit
  terms: string[]
  selected: boolean
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
      {/* The checkbox column is the mode's: on every row while it lasts, none at rest. */}
      {selecting && (
        <input
          type="checkbox"
          className="zen-v2-checkbox zen-page-row-check"
          checked={selected}
          aria-label={`Select ${title}`}
          onChange={(e) => onToggle(visit.id, e.target.checked)}
        />
      )}
      <span className="zen-page-row-lead" aria-hidden>
        <FaviconImage src={visit.favicon} />
      </span>
      <button
        type="button"
        className="zen-page-row-text"
        data-row-focus=""
        title={presentedUrl(visit.url)}
        onClick={(e) => {
          // Shift-click picks the run from the last picked row; Ctrl-click picks this one and
          // so enters the mode; inside the mode a plain click picks or drops the row (the
          // middle button and Enter still open it).
          if (e.shiftKey) onExtend(visit.id)
          else if (e.ctrlKey || e.metaKey || selecting) onToggle(visit.id, !selected)
          else onOpen(visit.url, false)
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

/**
 * The row's 16 px favicon: the visit's icon, a page tab's registered glyph where `url` names
 * one (a closed Settings, History, Bookmarks or Downloads tab fetches no icon; the glyph is
 * its mark in every favicon slot, v2 §10.1), the globe for a site with none or a broken one.
 */
function FaviconImage({ src, url }: { src: string | null; url?: string | null }): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const glyph = url ? internalPageOf(url)?.glyph : undefined
  if (glyph) {
    const Glyph = PAGE_GLYPHS[glyph]
    return <Glyph className="zen-page-row-favicon zen-page-row-glyph" aria-hidden />
  }
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
 * list (on approach, as the day headings' ⋮). A closed page tab (Settings, this page's siblings)
 * carries its glyph as its favicon. Its rows are not picked, but hold the checkbox column's
 * width while the mode lasts so every favicon on the page moves as one.
 */
function RecentlyClosed({
  entries,
  selecting
}: {
  entries: ClosedEntrySummary[]
  selecting: boolean
}): JSX.Element {
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
          className="zen-v2-icon-button zen-page-heading-reveal"
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
          // A page tab's second line is its zenium:// address (§10.1, what its pill and tooltip
          // say); the host line would only repeat the title ("Downloads" under "Downloads").
          const desc =
            entry.kind === 'window'
              ? entry.title
              : entry.url && internalPageOf(entry.url)
                ? presentedUrl(entry.url)
                : host
          return (
            <li key={entry.id} className="zen-v2-row zen-page-row" data-closed-id={entry.id}>
              {selecting && <span className="zen-page-row-check" aria-hidden />}
              <span className="zen-page-row-lead" aria-hidden>
                {entry.kind === 'window' ? (
                  <AppWindow className="zen-page-row-favicon zen-page-row-favicon-fallback" />
                ) : (
                  <FaviconImage src={entry.favicon} url={entry.url} />
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
                <span className="zen-page-row-desc">{desc}</span>
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
