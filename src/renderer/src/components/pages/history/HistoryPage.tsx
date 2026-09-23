import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, ChevronRight, EllipsisVertical, Globe, RotateCcw, X } from 'lucide-react'
import { internalPageOf, parseInternalPageUrl } from '@shared/internalPages'
import type {
  ClosedEntrySummary,
  HistoryDayGroup,
  HistoryVisit,
  SyncDeviceTabs,
  SyncRemoteTab,
  SyncStatus,
  Tab,
  UIState
} from '@shared/types'
import { presentedUrl } from '@shared/url'
import { dayKeyOf } from '@shared/dayKey'
import { cmd, onEvent, run } from '@renderer/lib/api'
import { dayLabel } from '@renderer/lib/historyGroups'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { presentedHost, useExtensionList } from '@renderer/lib/extensions/pages'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { PAGE_GLYPHS } from '@renderer/lib/pageGlyphs'
import { hiddenDeviceCount, OTHER_DEVICES_COPY } from '@renderer/lib/otherDevices'
import { openSettings } from '@renderer/lib/pages'
import { remoteTabsStore, remoteTabsWanted, useRemoteTabs } from '@renderer/lib/remoteTabs'
import { createStore, type Store } from '@renderer/lib/store'
import { SYNC_COPY, syncScopeRowId } from '@renderer/lib/syncSetup'
import { openClearBrowsingData } from '@renderer/lib/ui'
import { relativeTime } from '@renderer/lib/utils'
import { PageColumn, PageEmpty, PageGroup, PageSearchField, PageTitleBlock } from '../PageFrame'
import { inTextField, walkRows } from '../rowKeys'
import { usePageSearch } from '../usePageSearch'

/** Visits fetched per page; "Show more" adds another page. */
const PAGE_SIZE = 300
const EMPTY: ReadonlySet<string> = new Set()

/** The search's terms, as the core's history search reads them: every term in the title or URL. */
function searchTerms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whether a page named by `title` and `url` matches every term, as `searchVisits` reads a visit. */
function matchesTerms(title: string, url: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${title} ${url}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/**
 * A set of other devices (their ids) the page keeps for the session – the folded groups, and
 * the devices hidden through a heading's menu: a History tab closed and opened again, or a
 * second window's, finds them folded or hidden still; a restart unfolds and shows them all
 * (Chrome's synced-device cards start open too, its "Hide for now" lasts the run). Each set is
 * the core's (`history.foldedDevices`, `history.hiddenDevices`) – each window's chrome is a
 * renderer of its own, so a store here alone would be the window's – mirrored into this
 * document the first time a device group mounts (`asked`) and kept current for the document's
 * life by its changed event (`startBrowserSync`'s pattern: the listener outlives the page, so a
 * fold made in another window while this one shows no History tab is here when the tab comes
 * back); a change made on the page lands here first so the chevron turns on the click.
 */
interface SessionDeviceSet {
  store: Store<{ ids: ReadonlySet<string>; asked: boolean }>
  /** The set, mirrored from the core: the hook a device group reads it through. */
  useIds: () => ReadonlySet<string>
}

function sessionDeviceSet(
  key: string,
  query: 'history.foldedDevices' | 'history.hiddenDevices',
  changed: 'history.foldedDevicesChanged' | 'history.hiddenDevicesChanged'
): SessionDeviceSet {
  const store = createStore<{ ids: ReadonlySet<string>; asked: boolean }>(
    { ids: new Set(), asked: false },
    key
  )
  const useIds = (): ReadonlySet<string> => {
    useEffect(() => {
      if (store.get().asked) return
      store.set({ asked: true })
      onEvent(changed, (ids) => store.set({ ids: new Set(ids) }))
      void cmd(query, undefined).then((ids) => store.set({ ids: new Set(ids) }))
    }, [])
    return store.use((s) => s.ids)
  }
  return { store, useIds }
}

const collapsedDevices = sessionDeviceSet(
  'historyCollapsedDevices',
  'history.foldedDevices',
  'history.foldedDevicesChanged'
)
const hiddenDevices = sessionDeviceSet(
  'historyHiddenDevices',
  'history.hiddenDevices',
  'history.hiddenDevicesChanged'
)

/** Fold or unfold a device's group: here at once, and the core's for the session. */
function foldDevice(deviceId: string, folded: boolean): void {
  collapsedDevices.store.set((s) => {
    const ids = new Set(s.ids)
    if (folded) ids.add(deviceId)
    else ids.delete(deviceId)
    return { ids }
  })
  run('history.foldDevice', { deviceId, folded })
}

/** The "Show hidden devices" row: every hidden device listed again, here at once and in the core. */
function showHiddenDevices(): void {
  hiddenDevices.store.set({ ids: new Set() })
  run('history.showHiddenDevices', undefined)
}

/** The page's sentences for the other devices' tabs (ID-28), beside Settings › Sync's `SYNC_COPY`. */
const REMOTE_COPY = {
  heading: SYNC_COPY.remoteTabs,
  syncOff: 'Turn on sync to see tabs from your other devices',
  scopeOff: 'Turn on Open tabs in What you sync to see them',
  /**
   * The row under that line names the action, not the group (§9.1: "Manage what you sync" two
   * lines under "…in What you sync…" cast the group's name two ways) – Firefox's label.
   */
  chooseScope: 'Choose what to sync',
  /** The aside of a device's heading: "Last active 5 min ago", "Last active just now". */
  lastActive: (updatedAt: number): string => {
    const when = relativeTime(updatedAt)
    return `Last active ${when.charAt(0).toLowerCase()}${when.slice(1)}`
  }
} as const

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
 * while nothing is searched, and the other devices' open tabs (ID-28, Chrome's
 * `chrome://history/syncedTabs`) follow it as §10.1 rules: each synced device its own group
 * headed by its name with "Last active …" as its aside, newest first, folding on its heading's
 * chevron for the session; while a setting is the way out (sync off, the scope off), the one
 * group "Tabs from other devices" with its §9.17 line and the row to Settings › Sync, and with
 * sync on and nothing published no group at all, as Recently closed when empty. A remote tab's
 * row opens the page in a new tab (a middle or Ctrl click behind this one), or brings the tab to
 * the front when this device already holds it; its menu is the history menu less the visit's
 * items (`RemoteTabs`). A device's heading line has a menu of its own – Open All Tabs, Hide
 * Device (the lead's #326 ruling; a hidden device stays hidden for the session and comes back
 * through the "Show hidden devices" row, the phone's #316 answer).
 *
 * The search (§9.12) filters as History's did (every term in the title or URL) – the other
 * devices' rows too, a device with no match stepping aside with Recently closed; the tab's URL
 * follows it as `zen://history?q=<text>` without a history entry, so the address says what the
 * page shows and a restored tab comes back searching, and a query the URL brings – Chrome's
 * "More from this site", the omnibox's `@history <text>`, back and forward – fills the field.
 * Selection is a mode (§9.6, §10.1 – as the phone list's long-press mode): at rest a row leads
 * with its favicon at the row's 16, no slot held for a checkbox. Shift-click on a row, "Select"
 * in its ⋮ menu or Ctrl+A enters the mode – never Ctrl-click, which on every page row means one
 * thing (§10.1 as amended): open it behind this tab, as a middle click does – a visit as a tab
 * behind, a remote tab likewise, a Recently closed entry restored behind. In the mode the
 * checkbox column shows on every row while it lasts (the favicons move once, at its start), a
 * picked row sits on `--v2-selected`, a plain click picks or drops a row, Shift-click picks the
 * run from the last picked one, and the title block's slot holds the count, Delete and Cancel.
 * Cancel, Escape, dropping the last picked row or deleting the selection leaves the mode and
 * the column goes.
 * Keyboard (§9.22): the arrows walk the rows, Space picks, Enter opens, Delete removes the
 * focused row or the selection, Escape leaves the mode; Ctrl+F on the tab focuses the field.
 * "Clear browsing data…" is the services dialog through the frame dialog host (§9.23).
 */
export function HistoryPage({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const [closed, setClosed] = useState<ClosedEntrySummary[]>([])
  // The other devices' tabs: the one reader (#314's `useRemoteTabs`, as the Settings pages call
  // it) keeps the shared store at the status's version; the page draws the store, never fetching
  // on its own.
  useRemoteTabs(state.sync)
  const devices = remoteTabsStore.use((s) => s.devices)
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

  /**
   * A visit opens in this tab, or – a middle or Ctrl click, §10.1's one meaning – as a new tab
   * behind it, through the page's own open path.
   */
  const open = (url: string, behind: boolean): void => {
    run('urlbar.submit', { input: url, newTab: behind, tabId: tab.id, background: behind })
  }
  /**
   * A tab from another device opens as a new tab of this window – in front, or behind this one
   * on a middle or Ctrl click – through the page's own open path. The Open tabs scope also
   * carries the tab records (ID-10), so a tab another device lists may already sit in this
   * sidebar under the same id: a click then brings that tab to the front rather than opening a
   * second one (as Settings › Sync's rows do); a click asking for a tab behind still gets one.
   */
  const openRemote = (remote: SyncRemoteTab, background: boolean): void => {
    if (!background && remote.tabId in state.tabs) run('tab.activate', { tabId: remote.tabId })
    else run('urlbar.submit', { input: remote.url, newTab: true, tabId: tab.id, background })
  }
  const terms = useMemo(() => searchTerms(text), [text])
  // The devices the user hid (a heading's Hide Device) are listed nowhere – a search does not
  // reach them either – until "Show hidden devices" brings them back.
  const hidden = hiddenDevices.useIds()
  const hiddenCount = hiddenDeviceCount(devices, hidden)
  // The devices with a tab to show for this search, newest activity first (the core lists them
  // so; a search keeps the order and drops the devices left with nothing).
  const remote = useMemo(
    () =>
      devices
        .filter((d) => !hidden.has(d.deviceId))
        .map((d) => ({ ...d, tabs: d.tabs.filter((t) => matchesTerms(t.title, t.url, terms)) }))
        .filter((d) => d.tabs.length > 0),
    [devices, hidden, terms]
  )
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
      <div
        ref={list}
        className="zen-page-list"
        data-selecting={selecting || undefined}
        onKeyDown={(e) => walkRows(e, list)}
      >
        {closed.length > 0 && !text && <RecentlyClosed entries={closed} selecting={selecting} />}
        {state.capabilities.sync && (
          <RemoteTabs
            sync={state.sync}
            devices={remote}
            hiddenCount={hiddenCount}
            searching={Boolean(text)}
            terms={terms}
            selecting={selecting}
            onOpen={openRemote}
          />
        )}
        <VisitList
          // A new search starts over at the first page.
          key={text}
          text={text}
          terms={terms}
          // A search the other devices' tabs answer is answered: no "No history matches" under them.
          quiet={remote.length > 0}
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
  terms,
  quiet,
  selected,
  selecting,
  onToggle,
  onExtend,
  onOpen
}: Selection & {
  text: string
  terms: string[]
  /** Another group answers the search: with no visit matching, say nothing rather than "No history matches". */
  quiet: boolean
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

  const groups = loaded?.groups ?? null
  const visitCount = useMemo(
    () => (groups ?? []).reduce((n, g) => n + g.visits.length, 0),
    [groups]
  )
  const hasMore = visitCount >= limit

  if (!loaded || !groups) return null
  if (groups.length === 0) {
    if (quiet && text) return null
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
          // Shift-click picks the run from the last picked row (this one alone with nothing
          // picked yet, entering the mode); Ctrl-click opens the page behind – §10.1's one
          // meaning on every page row, never a pick; inside the mode a plain click picks or
          // drops the row (the middle button and Enter still open it).
          if (e.shiftKey) onExtend(visit.id)
          else if (e.ctrlKey || e.metaKey) onOpen(visit.url, true)
          else if (selecting) onToggle(visit.id, !selected)
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
 * page) as the page's first group: a row restores its entry – a middle or Ctrl click restores a
 * tab behind this one (§10.1's one meaning; a window entry comes back as a window either way);
 * the heading's control clears the list (on approach, as the day headings' ⋮). A closed page
 * tab (Settings, this page's siblings) carries its glyph as its favicon. Its rows are not
 * picked, but hold the checkbox column's width while the mode lasts so every favicon on the
 * page moves as one.
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
          const restore = (behind = false): void =>
            run('session.restoreClosed', { id: entry.id, background: behind })
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
                onClick={(e) => restore(e.ctrlKey || e.metaKey)}
                onAuxClick={(e) => e.button === 1 && restore(true)}
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
                onClick={() => restore()}
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

// ---------------------------------------------------------------------------
// Tabs from other devices (ID-28)
// ---------------------------------------------------------------------------

/**
 * The other devices' open tabs after Recently closed (v2 §10.1; Chrome's
 * `chrome://history/syncedTabs`, its side list's second entry – this page has one column, so
 * the section is a run of groups where Chrome has a view). Each synced device is its own §10.3
 * group headed by its name with "Last active …" as its aside – Chrome's Recent tabs and
 * Firefox's Synced Tabs list devices as headings directly; a second 15/600 level under an
 * umbrella heading would read as a sibling – newest activity first, as the core lists them
 * (`sortDeviceTabs`: a device with no tabs or none published for 30 days is not listed).
 * Only while a setting stands between the user and the list does one group headed "Tabs from
 * other devices" stand there: its §9.17 line where its rows would be and the way out as
 * §10.4's action row to Settings › Sync (the chevron, since it leaves the page) – sync off,
 * "Turn on sync", the section from its top; sync on with Open tabs off in What you sync,
 * "Choose what to sync", the section with the Open tabs switch's group on screen (`?row=
 * sync-scope:openTabs`, the door the phone's row takes; `SettingsPage` scrolls the row's group
 * to the top before the paint, as Privacy's `?site=` brings a site's group up). With
 * sync on, the scope on and nothing published the group steps aside as Recently closed does
 * when it is empty (§10.1 as the lead amended it): a sentence with no way out would be a
 * permanent two lines of nothing for every single-device user, and §9.17's "reads 0" is for a
 * count on a group that is otherwise there, not for a group whose only content is its absence.
 * A state the user makes keeps the group with a way back (the lead's #316 addendum to §10.1,
 * the phone's `remoteTabsSection`): every device hidden through its heading's menu is the
 * umbrella group over "You've hidden every device" with "Show hidden devices" as its row; with
 * some hidden and the rest listed, that row alone follows the last device's group, as the
 * phone's follows its last device. While anything is searched the empty group steps aside too,
 * and the row with it – a search shows matches, not the state of a setting.
 */
function RemoteTabs({
  sync,
  devices,
  hiddenCount,
  searching,
  terms,
  selecting,
  onOpen
}: {
  sync: SyncStatus
  /** The devices with a tab to show (the search applied, the hidden left out), newest activity first. */
  devices: SyncDeviceTabs[]
  /** How many devices with tabs the user hid. */
  hiddenCount: number
  searching: boolean
  terms: string[]
  selecting: boolean
  onOpen: (tab: SyncRemoteTab, background: boolean) => void
}): JSX.Element | null {
  const showHidden = (
    <li className="zen-v2-row zen-page-row">
      <button
        type="button"
        className="zen-page-row-text"
        data-row-focus=""
        data-testid="history-devices-show-hidden"
        onClick={showHiddenDevices}
      >
        <span className="zen-page-row-label">{OTHER_DEVICES_COPY.showHidden}</span>
      </button>
    </li>
  )
  if (devices.length > 0) {
    return (
      <>
        {devices.map((device) => (
          <DeviceGroup
            key={device.deviceId}
            device={device}
            terms={terms}
            selecting={selecting}
            onOpen={onOpen}
          />
        ))}
        {hiddenCount > 0 && !searching && (
          <ul className="zen-page-rows" data-testid="history-hidden-devices">
            {showHidden}
          </ul>
        )}
      </>
    )
  }
  if (searching) return null
  if (hiddenCount > 0) {
    return (
      <PageGroup
        heading={REMOTE_COPY.heading}
        headingId="zen-history-remote-tabs"
        data-testid="history-remote-tabs"
        data-state="hidden"
      >
        <p className="zen-page-group-empty" role="status" data-testid="history-remote-tabs-empty">
          {OTHER_DEVICES_COPY.allHidden}
        </p>
        <ul className="zen-page-rows" data-testid="history-hidden-devices">
          {showHidden}
        </ul>
      </PageGroup>
    )
  }
  // Sync on, Open tabs in the scope, nothing published: the group steps aside.
  if (sync.enabled && remoteTabsWanted(sync)) return null
  const line = sync.enabled ? REMOTE_COPY.scopeOff : REMOTE_COPY.syncOff
  const action = sync.enabled ? REMOTE_COPY.chooseScope : SYNC_COPY.turnOn
  // Scope off: the Open tabs switch is the row's subject; sync off: the section's top is.
  const landing = sync.enabled ? { row: syncScopeRowId('openTabs') } : undefined
  return (
    <PageGroup
      heading={REMOTE_COPY.heading}
      headingId="zen-history-remote-tabs"
      data-testid="history-remote-tabs"
      data-state={sync.enabled ? 'scope-off' : 'sync-off'}
    >
      <p className="zen-page-group-empty" role="status" data-testid="history-remote-tabs-empty">
        {line}
      </p>
      <ul className="zen-page-rows">
        <li className="zen-v2-row zen-page-row">
          <button
            type="button"
            className="zen-page-row-text"
            data-row-focus=""
            data-testid="history-remote-tabs-settings"
            onClick={() => openSettings('sync', landing)}
          >
            <span className="zen-page-row-label">{action}</span>
          </button>
          <ChevronRight className="zen-page-row-chevron" aria-hidden />
        </li>
      </ul>
    </PageGroup>
  )
}

/**
 * One device's group: its name as the §9.27 heading, "Last active …" (the list's own time,
 * `updatedAt`) as the aside, and in the heading's control slot the disclosure – a §9.3 icon
 * button standing over the rows' ⋮ slot like the day headings' ⋮, but painted at rest: it shows
 * a state (Chrome's synced-device card's expand button), and a folded group with no chevron
 * would read as an empty one. The chevron points at the rows – right while they are folded
 * away, turned down while they show, as the bookmarks tree's twisty. Folded, the rows leave
 * the DOM (the arrows walk what is shown, §9.22) and the group keeps its heading line; the
 * fold is the session's (`collapsedDevices`). The device's actions – Open All Tabs, Hide
 * Device – are the heading line's native context menu (the lead's #326 ruling: a right-click
 * on the line or the menu key with the focus in it, as Firefox's Synced Tabs; the heading's
 * one trailing slot holds the disclosure alone, and the disclosure stays one – `aria-expanded`
 * for the rows, no `aria-haspopup`, so it takes no pressed fill, §9.20).
 */
function DeviceGroup({
  device,
  terms,
  selecting,
  onOpen
}: {
  device: SyncDeviceTabs
  terms: string[]
  selecting: boolean
  onOpen: (tab: SyncRemoteTab, background: boolean) => void
}): JSX.Element {
  const collapsed = collapsedDevices.useIds().has(device.deviceId)
  const toggle = (): void => foldDevice(device.deviceId, !collapsed)
  const safeId = device.deviceId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const menu = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    run('history.deviceMenu', { deviceId: device.deviceId, ...contextMenuAnchor(e) })
  }
  return (
    <PageGroup
      heading={device.deviceName}
      headingId={`zen-history-device-${safeId}`}
      aside={REMOTE_COPY.lastActive(device.updatedAt)}
      data-testid="history-remote-device"
      data-device-id={device.deviceId}
      data-collapsed={collapsed || undefined}
      onHeadingContextMenu={menu}
      control={
        <button
          type="button"
          className="zen-v2-icon-button zen-page-heading-twisty"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Show' : 'Hide'} tabs from ${device.deviceName}`}
          title={collapsed ? 'Show tabs' : 'Hide tabs'}
          onClick={toggle}
        >
          <ChevronRight data-open={!collapsed || undefined} aria-hidden />
        </button>
      }
    >
      {!collapsed && (
        <ul className="zen-page-rows">
          {device.tabs.map((remote) => (
            <RemoteTabRow
              key={remote.tabId}
              device={device}
              remote={remote}
              terms={terms}
              selecting={selecting}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </PageGroup>
  )
}

/**
 * A tab from another device as the page's §9.21 two-line row: its favicon (the globe for none,
 * `FaviconImage`), the title over the host, the ⋮ on approach hanging the history menu less the
 * visit's items (Select, Remove from History, Forget About This Page: the row names a page,
 * not a visit – `history.contextMenu` with no `visitId`). A click opens the page in a new tab
 * in front; a middle or Ctrl click one behind (§10.1's one meaning on every page row). Not
 * picked in the mode, but holding the checkbox column's width while it lasts, as Recently
 * closed's rows do, so every favicon moves as one.
 */
function RemoteTabRow({
  device,
  remote,
  terms,
  selecting,
  onOpen
}: {
  device: SyncDeviceTabs
  remote: SyncRemoteTab
  terms: string[]
  selecting: boolean
  onOpen: (tab: SyncRemoteTab, background: boolean) => void
}): JSX.Element {
  const extensions = useExtensionList()
  const host = presentedHost(remote.url, extensions) || presentedUrl(remote.url)
  const title = remote.title.trim() || host
  const menu = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    run('history.contextMenu', { visitId: null, url: remote.url, ...contextMenuAnchor(e) })
  }
  return (
    <li
      className="zen-v2-row zen-page-row"
      data-remote-tab={`${device.deviceId}:${remote.tabId}`}
      onContextMenu={menu}
    >
      {selecting && <span className="zen-page-row-check" aria-hidden />}
      <span className="zen-page-row-lead" aria-hidden>
        <FaviconImage src={remote.favicon} url={remote.url} />
      </span>
      <button
        type="button"
        className="zen-page-row-text"
        data-row-focus=""
        title={presentedUrl(remote.url)}
        onClick={(e) => onOpen(remote, e.ctrlKey || e.metaKey)}
        onAuxClick={(e) => e.button === 1 && onOpen(remote, true)}
      >
        <span className="zen-page-row-label">{highlight(title, terms)}</span>
        <span className="zen-page-row-desc">{highlight(host, terms)}</span>
      </button>
      <button
        type="button"
        className="zen-v2-icon-button zen-page-row-reveal"
        title="More actions"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          run('history.contextMenu', {
            visitId: null,
            url: remote.url,
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
