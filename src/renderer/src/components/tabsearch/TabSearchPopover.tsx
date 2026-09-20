import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, Volume2, VolumeX } from 'lucide-react'
import { searchHost, type MatchRange } from '@shared/tabSearch'
import type { TabSearchCandidate, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  placePopover,
  popoverStyle,
  toRect,
  useLightDismiss,
  viewportSize
} from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { buildRows, closeTabSearch, isOption, type Option } from '@renderer/lib/tabSearch'
import { browserStore, holdFloatingChrome, returnFocusToPage, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { usePopover } from '@renderer/hooks/usePopover'
import { useScrolled } from '../bookmarks/popover'
import { Favicon, type FaviconSource } from '../sidebar/Favicon'
import { V2_GLYPH } from '../v2/controls'

/**
 * The bar the popover hangs from (v2 draft §9.20): the sidebar's top row, the one the extension
 * popovers and the downloads bubble hang from too. Compact mode takes the row's `data-bar`
 * away with the sidebar; the popover then opens in the window's top leading corner.
 */
const NAV_ROW = '[data-zen-nav-row][data-bar]'
/** Where Escape hands the keyboard back (§9.22): the row's address, its one control that is always there. */
const ANCHOR_CONTROL = '[data-zen-nav-row] .zen-pill button'
/** Rows with a trailing close button (§9.20). */
const WIDTH = POPOVER_WIDTH.form

/** The popover, while a request is up. */
export function TabSearchLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.tabSearch)
  const state = browserStore.use((s) => s.state)
  if (!request || !state) return null
  return <TabSearchPopover state={state} keyboard={request.keyboard} />
}

/**
 * Chrome's tab search (tabs-17) as a desktop popover (v2 draft §9.20) 400 wide – rows with a
 * trailing close button – hanging from the sidebar's top row, start-aligned with it, placed by
 * `placePopover` (flip, slide, shrink, 8 px inside the window, its height capped by the
 * placement); on the 180 ms pop, radius 8, the panel shadow, no scrim (§9.5). Its title block
 * (§9.23) – "Search tabs" over the field, whose placeholder is example text, "Title or address"
 * (§9.12) – stays put while the rows scroll under it,
 * a hairline appearing at its edge only then (§9.7). The rows are the shared `.zen-v2-row`
 * (§9.34): the favicon on the title's line, the host under it in the small deemphasised type,
 * a 28 px icon button to close the tab trailing. It renders through the chrome layer
 * (`ChromePortal`) over a picture of the page (`holdFloatingChrome`), never inside the frame,
 * and the layer's light dismiss puts it away: a press anywhere else closes it on `pointerdown`
 * and reaches nothing beneath, a resize and another popover opening close it too.
 *
 * The keyboard (§9.22): focus lands in the field; typing filters; Down and Up move the
 * selection through every row of every section, the field keeping the caret (a combobox);
 * Enter switches to the selected tab – or reopens the closed entry – and closes; Tab wraps
 * inside; Escape closes it and hands the keyboard to the row it hangs from (the address), the
 * page keeping none of it. A press elsewhere or a switch gives the page the keyboard back,
 * unless a chrome control had it when the popover opened.
 */
function TabSearchPopover({
  state,
  keyboard
}: {
  state: UIState
  keyboard: boolean
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const scrolled = useScrolled(bodyRef)
  const titleId = useId()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<TabSearchCandidate[] | null>(null)
  /** The selected option, for the query it was picked under: a new query starts at the top. */
  const [selection, setSelection] = useState({ query: '', index: 0 })
  const [box, setBox] = useState<PopoverBox>(() => place(document.querySelector(NAV_ROW)))
  /** Where the keyboard goes when the popover leaves: the page, or nowhere (Escape, a chrome opener). */
  const focusOnClose = useRef<'page' | 'chrome'>(keyboard ? 'chrome' : 'page')
  /** The address in the row the popover hangs from, for Escape; a chrome opener keeps its own. */
  const [anchorControl] = useState<HTMLElement | null | undefined>(() =>
    keyboard ? undefined : document.querySelector<HTMLElement>(ANCHOR_CONTROL)
  )

  // The page's view gives way to its picture while the popover overhangs it; the popover holds
  // its first paint until the picture is in place. On release the page gets the keyboard back
  // unless Escape left it in the chrome or a chrome control opened the popover (§9.22).
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const current = browserStore.get().state
    const hold = holdFloatingChrome(current ? (activeTab(current)?.id ?? null) : null, {
      pageHadFocus: false
    })
    void hold.ready.then((held) => {
      if (held) setReady(true)
    })
    return () => {
      hold.release()
      if (focusOnClose.current === 'page') returnFocusToPage()
    }
  }, [])

  // The tabs of every window: fetched on open and again on every state push while the popover
  // is up, since titles, favicons and the tabs themselves change under it.
  useEffect(() => {
    let live = true
    void cmd('tab.searchCandidates', undefined).then((list) => {
      if (live) setCandidates(list)
    })
    return () => {
      live = false
    }
  }, [state])

  // The row is measured again on every state push, so the popover keeps its place on a row
  // whose controls came or went.
  useLayoutEffect(() => {
    const measure = (): void => {
      const next = place(document.querySelector(NAV_ROW))
      setBox((prev) => (sameBox(prev, next) ? prev : next))
    }
    measure()
  }, [state])

  const rows = useMemo(
    () => buildRows(candidates ?? [], state.recentlyClosed, query),
    [candidates, state.recentlyClosed, query]
  )
  const options = useMemo(() => rows.filter(isOption), [rows])
  // A list that shrank under the selection keeps it in range.
  const selected = Math.max(
    0,
    Math.min(selection.query === query ? selection.index : 0, options.length - 1)
  )
  const select = (index: number): void => setSelection({ query, index })
  useEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, options.length])

  const activate = useCallback((option: Option): void => {
    if (option.kind === 'tab') run('tab.switchTo', { tabId: option.ranked.tab.id })
    else run('session.restoreClosed', { id: option.ranked.entry.id })
    closeTabSearch()
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      select((selected + step + options.length) % options.length)
      return
    }
    if (e.key === 'Enter' && e.target === fieldRef.current) {
      e.preventDefault()
      const option = options[selected]
      if (option) activate(option)
    }
  }

  // Escape puts the popover away and the chrome keeps the keyboard, which `usePopover` hands
  // to the address in the row the popover hangs from (§9.22), or to the control that opened it.
  usePopover(panelRef, {
    onClose: () => {
      focusOnClose.current = 'chrome'
      closeTabSearch()
    },
    active: ready,
    initial: () => fieldRef.current,
    returnTo: anchorControl
  })
  // The chrome layer's light dismiss (§9.20 amended): a press anywhere else puts the popover
  // away; the page gets the keyboard back on release.
  useLightDismiss(panelRef, () => closeTabSearch())
  // A tablet's system back gesture closes it as Escape does.
  useBackSurface({ name: 'tab-search', onCommit: () => closeTabSearch() })

  if (!ready) return null
  const activeId = options[selected] ? optionDomId(listId, options[selected]) : undefined
  return (
    <ChromePortal>
      {/* A page surface (§9.29): the rows, the field and the buttons draw in the page family. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby={titleId}
        data-tab-search-popover=""
        data-surface="page"
        className="zen-animate-pop zen-bm-popover zen-tab-search fixed z-[70] flex flex-col outline-none"
        style={popoverStyle(box)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="zen-bm-title-block" data-scrolled={scrolled || undefined}>
          <h2 id={titleId} className="zen-bm-title">
            Search tabs
          </h2>
          <input
            ref={fieldRef}
            type="text"
            className="zen-v2-field mt-3"
            placeholder="Title or address"
            aria-label="Search tabs"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div
          ref={bodyRef}
          id={listId}
          role="listbox"
          aria-label="Tabs"
          className="zen-bm-popover-body flex flex-col pb-1"
        >
          {rows.map((row) => {
            switch (row.kind) {
              case 'heading':
                return (
                  <div
                    key={row.id}
                    className="zen-tab-search-heading zen-v2-heading"
                    role="presentation"
                  >
                    {row.label}
                  </div>
                )
              case 'empty':
                return (
                  <div key={row.id} className="zen-v2-row zen-tab-search-empty" data-static="">
                    <span className="zen-v2-row-text">
                      <span className="zen-v2-label truncate">No matching tabs</span>
                    </span>
                  </div>
                )
              case 'tab':
                return (
                  <TabRow
                    key={row.id}
                    id={optionDomId(listId, row)}
                    row={row}
                    selected={row.index === selected}
                    onSelect={() => select(row.index)}
                    onActivate={() => activate(row)}
                  />
                )
              case 'closed':
                return (
                  <ClosedRow
                    key={row.id}
                    id={optionDomId(listId, row)}
                    row={row}
                    selected={row.index === selected}
                    onSelect={() => select(row.index)}
                    onActivate={() => activate(row)}
                  />
                )
            }
          })}
        </div>
      </div>
    </ChromePortal>
  )
}

const optionDomId = (listId: string, option: Option): string => `${listId}-${option.index}`

interface RowProps<R extends Option> {
  id: string
  row: R
  selected: boolean
  onSelect: () => void
  onActivate: () => void
}

/** The title or host with the query's matches in the heading weight. */
function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }): JSX.Element {
  if (ranges.length === 0) return <>{text}</>
  const parts: JSX.Element[] = []
  let cursor = 0
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, start)}</span>)
    parts.push(<mark key={`m${i}`}>{text.slice(start, end)}</mark>)
    cursor = end
  })
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)
  return <>{parts}</>
}

/**
 * One open tab: the favicon on the title's line, the host under the title, the sound glyph
 * for a tab playing (or muted), the window glyph for a tab of another window, and the 28 px
 * close button, shown for the selected (hovered) row and when it has the focus. The whole row
 * is the target; the close button stops its press short of it.
 */
function TabRow({
  id,
  row,
  selected,
  onSelect,
  onActivate
}: RowProps<Extract<Option, { kind: 'tab' }>>): JSX.Element {
  const { tab, title, host } = row.ranked
  const hostText = searchHost(tab.url)
  const source: FaviconSource = {
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    customIcon: tab.customIcon,
    customTitle: null,
    loading: tab.loading,
    discarded: tab.discarded,
    containerId: tab.containerId
  }
  const label = [tab.title || hostText, hostText, tab.windowLabel && `in another window`]
    .filter(Boolean)
    .join(', ')
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={label}
      data-index={row.index}
      data-tab-search-row={tab.id}
      className="zen-v2-row zen-tab-search-row"
      onPointerMove={onSelect}
      onClick={onActivate}
    >
      <span className="zen-v2-row-body">
        <span className="zen-v2-row-lead">
          <Favicon tab={source} size={16} />
        </span>
        <span className="zen-v2-row-text">
          <span className="zen-v2-label truncate" title={tab.title}>
            <Highlighted text={tab.title || hostText} ranges={tab.title ? title : host} />
          </span>
          {hostText && (
            <span className="zen-v2-description truncate" dir="ltr">
              <Highlighted text={hostText} ranges={host} />
            </span>
          )}
        </span>
      </span>
      {(tab.audible || tab.muted) &&
        (tab.muted ? (
          <VolumeX className={cn(V2_GLYPH, 'zen-tab-search-glyph')} aria-hidden />
        ) : (
          <Volume2 className={cn(V2_GLYPH, 'zen-tab-search-glyph')} aria-hidden />
        ))}
      {tab.windowLabel && (
        <span
          className="zen-tab-search-glyph inline-flex"
          title={`In another window: ${tab.windowLabel}`}
          aria-hidden
        >
          <AppWindow className={V2_GLYPH} />
        </span>
      )}
      <button
        type="button"
        className="zen-v2-icon-button zen-tab-search-close"
        aria-label="Close tab"
        title="Close tab"
        // Tab from the field reaches the selected row's button alone (§9.22): the arrows pick
        // the row, Tab its control, Enter presses it.
        tabIndex={selected ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation()
          run('tab.close', { tabId: tab.id })
        }}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}

/** A recently closed tab or window: the favicon (a window glyph for a window), title, host or tab count. */
function ClosedRow({
  id,
  row,
  selected,
  onSelect,
  onActivate
}: RowProps<Extract<Option, { kind: 'closed' }>>): JSX.Element {
  const { entry, title, host } = row.ranked
  const hostText =
    entry.kind === 'window'
      ? `${entry.tabCount} ${entry.tabCount === 1 ? 'tab' : 'tabs'}`
      : searchHost(entry.url ?? '')
  const source: FaviconSource = {
    url: entry.url ?? '',
    title: entry.title,
    favicon: entry.favicon,
    customIcon: null,
    customTitle: null,
    loading: false,
    discarded: true,
    containerId: DEFAULT_CONTAINER_ID
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${entry.title || hostText}, ${hostText}, recently closed`}
      data-index={row.index}
      data-tab-search-closed={entry.id}
      className="zen-v2-row zen-tab-search-row"
      onPointerMove={onSelect}
      onClick={onActivate}
    >
      <span className="zen-v2-row-body">
        <span className="zen-v2-row-lead">
          {entry.kind === 'window' ? (
            <AppWindow className={V2_GLYPH} aria-hidden />
          ) : (
            <Favicon tab={source} size={16} />
          )}
        </span>
        <span className="zen-v2-row-text">
          <span className="zen-v2-label truncate" title={entry.title}>
            <Highlighted text={entry.title || hostText} ranges={entry.title ? title : []} />
          </span>
          {hostText && (
            <span className="zen-v2-description truncate" dir="ltr">
              <Highlighted text={hostText} ranges={entry.kind === 'window' ? [] : host} />
            </span>
          )}
        </span>
      </span>
    </div>
  )
}

/** The 16 px close glyph at the row's stroke: Lucide's X, drawn inline so the button owns its size. */
function CloseGlyph(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

/**
 * Where the popover goes: hanging from the sidebar's top row, start-aligned with its leading
 * control; without the row on screen (compact mode), in the window's top leading corner.
 */
function place(row: Element | null): PopoverBox {
  const viewport = viewportSize()
  if (row) {
    const bar = toRect(row.getBoundingClientRect())
    const anchor = { x: bar.x, y: bar.y, width: Math.min(28, bar.width), height: bar.height }
    return placePopover(anchor, bar, viewport, WIDTH)
  }
  const anchor = { x: POPOVER_MARGIN, y: POPOVER_MARGIN, width: 28, height: 28 }
  return placePopover(anchor, anchor, viewport, WIDTH)
}

function sameBox(a: PopoverBox, b: PopoverBox): boolean {
  if (a.left !== b.left || a.width !== b.width || a.maxHeight !== b.maxHeight) return false
  return a.side === 'below'
    ? b.side === 'below' && a.top === b.top
    : b.side === 'above' && a.bottom === b.bottom
}
