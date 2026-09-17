import type { JSX, MouseEvent, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AppWindow,
  ExternalLink,
  Globe,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { ClosedEntrySummary, HistoryDayGroup, HistoryVisit, UIState } from '@shared/types'
import { getHost } from '@shared/url'
import { dayLabel } from '@shared/dayKey'
import { cmd, onEvent, run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { OverlayShell } from './OverlayShell'

/** Visits fetched per page; "Show more" adds another page. */
const PAGE_SIZE = 300
const SEARCH_DEBOUNCE_MS = 150

/**
 * The history page (`zen://history`, Ctrl+H): every visit grouped by day, newest first, with
 * search, multi-select deletion, per-day deletion and the recently closed tabs and windows on
 * top. Rendered through the overlay shell like the other page-like surfaces.
 */
export function HistoryPage({ state }: { state: UIState }): JSX.Element {
  const section = uiStore.use((s) => s.overlaySection)
  const hostFilter = section?.startsWith('host:') ? section.slice('host:'.length) : null
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [closed, setClosed] = useState<ClosedEntrySummary[]>([])
  const [hasVisits, setHasVisits] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setText(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void cmd('session.recentlyClosed', undefined)
        .then((list) => {
          if (!cancelled) setClosed(list)
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
    const tab = activeTab(state)
    run('urlbar.submit', { input: url, newTab: newTab || !tab, tabId: tab?.id ?? null })
    closeOverlay()
  }

  return (
    <OverlayShell
      title="History"
      variant="full"
      className="zen-history"
      actions={
        <button
          type="button"
          className="zen-history-btn"
          onClick={() => run('history.clear', undefined)}
          disabled={!hasVisits}
        >
          Clear all
        </button>
      }
    >
      <div className="zen-history flex min-h-full flex-col">
        <div className="flex items-center gap-3 px-6 pt-4 pb-2">
          <label className="relative block min-w-0 flex-1">
            <Search
              className="zen-history-soft pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2"
              aria-hidden
            />
            <input
              autoFocus
              className="zen-history-input"
              placeholder="Search history"
              aria-label="Search history"
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
          {hostFilter && (
            <button
              type="button"
              className="zen-history-btn"
              title="Show all sites"
              onClick={() => uiStore.set({ overlaySection: null })}
            >
              {hostFilter}
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        {closed.length > 0 && !text && !hostFilter && <RecentlyClosed entries={closed} />}

        <VisitList
          // A new search or site filter starts over: first page, nothing selected.
          key={`${text}\u0000${hostFilter ?? ''}`}
          text={text}
          host={hostFilter}
          onOpen={open}
          onCount={setHasVisits}
        />
      </div>
    </OverlayShell>
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

function VisitList({
  text,
  host,
  onOpen,
  onCount
}: {
  text: string
  host: string | null
  onOpen: (url: string, newTab: boolean) => void
  /** Whether the unfiltered list has any visit (the shell's "Clear all" needs to know). */
  onCount: (any: boolean) => void
}): JSX.Element | null {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void cmd('history.grouped', {
        query: { text: text || undefined, host: host ?? undefined, limit }
      })
        .then((groups) => {
          if (cancelled) return
          setLoaded({ groups, now: Date.now() })
          if (!text && !host) onCount(groups.length > 0)
        })
        .catch(() => undefined)
    }
    load()
    const off = onEvent('history.changed', load)
    return () => {
      cancelled = true
      off()
    }
  }, [text, host, limit, onCount])

  const terms = useMemo(() => text.toLowerCase().split(/\s+/).filter(Boolean), [text])
  const groups = loaded?.groups ?? null
  const visitCount = useMemo(
    () => (groups ?? []).reduce((n, g) => n + g.visits.length, 0),
    [groups]
  )
  const hasMore = visitCount >= limit
  const selecting = selected.size > 0

  const removeVisits = (ids: string[]): void => {
    if (ids.length === 0) return
    const gone = new Set(ids)
    // Optimistic: the delete event re-fetches, this keeps the list from jumping meanwhile.
    setLoaded((current) =>
      current
        ? {
            ...current,
            groups: current.groups
              .map((g) => ({ ...g, visits: g.visits.filter((v) => !gone.has(v.id)) }))
              .filter((g) => g.visits.length > 0)
          }
        : current
    )
    setSelected((current) => {
      if (![...current].some((id) => gone.has(id))) return current
      const next = new Set(current)
      for (const id of gone) next.delete(id)
      return next
    })
    run('history.deleteVisits', { ids })
  }

  const toggle = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  if (!loaded || !groups) return null
  if (groups.length === 0) return <EmptyState text={text} host={host} />
  return (
    <div className="flex flex-1 flex-col px-4 pb-4" data-selecting={selecting}>
      <div className="flex-1">
        {groups.map((group) => (
          <DayGroup
            key={group.dayKey}
            group={group}
            now={loaded.now}
            terms={terms}
            selected={selected}
            onToggle={toggle}
            onOpen={onOpen}
            onRemove={(id) => removeVisits([id])}
          />
        ))}
        {hasMore && (
          <div className="flex justify-center py-3">
            <button
              type="button"
              className="zen-history-btn"
              onClick={() => setLimit((n) => n + PAGE_SIZE)}
            >
              Show more
            </button>
          </div>
        )}
      </div>

      {selecting && (
        <div className="zen-history-actions">
          <span className="text-[13px]">{selected.size} selected</span>
          <button
            type="button"
            className="zen-history-btn"
            data-primary="true"
            onClick={() => removeVisits([...selected])}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete {selected.size}
          </button>
          <button type="button" className="zen-history-btn" onClick={() => setSelected(new Set())}>
            Cancel
          </button>
        </div>
      )}
    </div>
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
  onOpen,
  onRemove
}: {
  group: HistoryDayGroup
  now: number
  terms: string[]
  selected: ReadonlySet<string>
  onToggle: (id: string, checked: boolean) => void
  onOpen: (url: string, newTab: boolean) => void
  onRemove: (id: string) => void
}): JSX.Element {
  const label = dayLabel(group.dayKey, now)
  return (
    <section aria-label={label}>
      <header className="zen-history-heading px-2">
        <h3 className="flex-1 truncate">{label}</h3>
        <span className="zen-history-soft mr-1 text-[13px]">{group.visits.length}</span>
        <button
          type="button"
          className="zen-history-icon-btn"
          title="Options for this day"
          aria-label={`Options for ${label}`}
          onClick={() =>
            run('history.dayMenu', { dayKey: group.dayKey, count: group.visits.length })
          }
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <ul>
        {group.visits.map((visit) => (
          <VisitRow
            key={visit.id}
            visit={visit}
            terms={terms}
            selected={selected.has(visit.id)}
            onToggle={onToggle}
            onOpen={onOpen}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function VisitRow({
  visit,
  terms,
  selected,
  onToggle,
  onOpen,
  onRemove
}: {
  visit: HistoryVisit
  terms: string[]
  selected: boolean
  onToggle: (id: string, checked: boolean) => void
  onOpen: (url: string, newTab: boolean) => void
  onRemove: (id: string) => void
}): JSX.Element {
  const host = getHost(visit.url).replace(/^www\./, '') || visit.url
  const title = visit.title || host
  const contextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    run('history.contextMenu', { visitId: visit.id, url: visit.url })
  }
  return (
    <li className="zen-history-row group" data-selected={selected} onContextMenu={contextMenu}>
      <input
        type="checkbox"
        className={cn('zen-history-check', !selected && 'zen-history-hover')}
        checked={selected}
        aria-label={`Select ${title}`}
        onChange={(e) => onToggle(visit.id, e.target.checked)}
      />
      <FaviconImage src={visit.favicon} />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        title={visit.url}
        onClick={(e) => {
          if (e.shiftKey) onToggle(visit.id, !selected)
          else onOpen(visit.url, e.ctrlKey || e.metaKey)
        }}
        onAuxClick={(e) => e.button === 1 && onOpen(visit.url, true)}
      >
        <span className="truncate">{highlight(title, terms)}</span>
        <span className="zen-history-soft shrink truncate text-[13px]">
          {highlight(host, terms)}
        </span>
      </button>
      <span className="zen-history-hover flex items-center gap-0.5">
        <button
          type="button"
          className="zen-history-icon-btn"
          title="Open in new tab"
          aria-label="Open in new tab"
          onClick={() => onOpen(visit.url, true)}
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className="zen-history-icon-btn"
          title="Remove from history"
          aria-label="Remove from history"
          onClick={() => onRemove(visit.id)}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </span>
      <time
        className="zen-history-soft zen-history-time w-[72px] shrink-0 text-right whitespace-nowrap"
        dateTime={new Date(visit.visitTime).toISOString()}
      >
        {timeFormat.format(visit.visitTime)}
      </time>
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
        className="h-4 w-4 shrink-0 rounded-[3px]"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(src)}
      />
    )
  }
  return <Globe className="zen-history-soft h-4 w-4 shrink-0" aria-hidden />
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

function RecentlyClosed({ entries }: { entries: ClosedEntrySummary[] }): JSX.Element {
  return (
    <section aria-label="Recently closed" className="px-4 pb-2">
      <header className="zen-history-heading px-2">
        <h3 className="flex-1">Recently closed</h3>
        <button
          type="button"
          className="zen-history-icon-btn"
          title="Clear the recently closed list"
          aria-label="Clear the recently closed list"
          onClick={() => run('session.clearRecentlyClosed', undefined)}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <ul>
        {entries.map((entry) => {
          const host = entry.url ? getHost(entry.url).replace(/^www\./, '') : ''
          const restore = (): void => {
            run('session.restoreClosed', { id: entry.id })
            closeOverlay()
          }
          return (
            <li key={entry.id} className="zen-history-row group">
              {/* Keeps the icons in line with the visit rows, which lead with a checkbox. */}
              <span className="w-4 shrink-0" aria-hidden />
              {entry.kind === 'window' ? (
                <AppWindow className="zen-history-soft h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <FaviconImage src={entry.favicon} />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                title={entry.url ?? undefined}
                onClick={restore}
              >
                <span className="truncate">
                  {entry.kind === 'window'
                    ? `Window with ${entry.tabCount} ${entry.tabCount === 1 ? 'tab' : 'tabs'}`
                    : entry.title || host}
                </span>
                <span className="zen-history-soft shrink truncate text-[13px]">
                  {entry.kind === 'window' ? entry.title : host}
                </span>
              </button>
              <button
                type="button"
                className="zen-history-icon-btn zen-history-hover"
                title={entry.kind === 'window' ? 'Reopen window' : 'Restore tab'}
                aria-label={entry.kind === 'window' ? 'Reopen window' : 'Restore tab'}
                onClick={restore}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
              </button>
              <time
                className="zen-history-soft zen-history-time w-[72px] shrink-0 text-right whitespace-nowrap"
                dateTime={new Date(entry.closedAt).toISOString()}
              >
                {timeFormat.format(entry.closedAt)}
              </time>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function EmptyState({ text, host }: { text: string; host: string | null }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-16 text-center">
      <p className="text-[15px] font-medium">
        {text ? `No results for “${text}”` : host ? `Nothing from ${host} yet` : 'No history yet'}
      </p>
      <p className="zen-history-soft text-[13px]">
        {text || host ? 'Try a different search.' : 'Pages you visit will show up here.'}
      </p>
    </div>
  )
}
