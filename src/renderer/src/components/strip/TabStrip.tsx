import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, VenetianMask } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { useCaptionOverlay } from '@renderer/hooks/useCaptionOverlay'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { dropStore, listMotions } from '@renderer/lib/drag'
import { groupsOf } from '@renderer/lib/groups'
import { isPrivateGroup, regularMembers } from '@renderer/lib/groupRows'
import { contextMenuAnchor } from '@renderer/lib/menuKeys'
import { SlideMotion } from '@renderer/lib/motion/slide'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { isPrivateTab } from '@renderer/lib/privateTabs'
import {
  activeSpace,
  isPrivateWindow,
  pinnedOf,
  regularOf,
  rowKey,
  stripRows
} from '@renderer/lib/selectors'
import { toggleTabSearch } from '@renderer/lib/tabSearch'
import {
  STRIP_BAND,
  STRIP_DRAG_SPRING,
  STRIP_FADE,
  STRIP_HOLD_MS,
  STRIP_LEADING_INSET,
  STRIP_MAC_INSET,
  STRIP_TAB_MAX,
  hasStateGlyph,
  heldTabWidth,
  stripSlot,
  stripTabRoom,
  stripTabWidth,
  type StripSlot
} from '@renderer/lib/tabStripLayout'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { ListMotionContext } from '../sidebar/listMotion'
import { FolderRow, NewTabButton, StripRowItem } from '../sidebar/SpacePanel'
import { StripAxisContext } from '../sidebar/stripAxis'
import { TOOLBAR_STROKE } from '../v2/controls'
import { WindowControls } from '../WindowControls'

/** More rows than this arriving in one commit is a restore, placed without motion. */
const ENTER_BATCH = 6

/** The CSS property every regular tab in the strip draws its width from (main.css). */
const WIDTH_PROPERTY = '--zen-strip-tab-width'

/** The rows the regular region lays out at the shared width: a tab's own row, or a split row. */
const ROWS = '.zen-tab:not([data-tab-folder], .zen-split-seg), .zen-split-row'

interface Props {
  state: UIState
  /** Controls at the trailing end, ahead of the window controls (the fullscreen way out). */
  trailing?: ReactNode
}

interface Layout {
  /** The width every regular tab draws at. */
  width: number
  /** The tabs at the floor no longer fit: the region scrolls and the All tabs button is up. */
  overflow: boolean
}

/**
 * The horizontal tab strip (design language v2 §9.37): the sidebar's tab row laid along the
 * caption band. It sits on the window family – theme ink on the space gradient, no surface of
 * its own, no hairline under it – in the 38 band (6 inset + the 32 row), and every tab is the
 * sidebar's `.zen-tab` with its axis turned (`StripAxisContext`): 32 tall at radius 8, the
 * favicon, the title, the one trailing slot. Pinned tabs are 32 × 32 favicon-only ahead of the
 * space's tabs; the regular tabs share one width – 240 at the most, shrinking evenly to the
 * 120 floor as they come and holding there, past which the region scrolls (24 px edge fades, no
 * arrows, the active tab brought into view on activation) and an All tabs button opens tab
 * search at the trailing end; the + is a 28 toolbar button 4 after the last tab; a drag spring
 * of at least 24 keeps it off the window controls, which sit inline at the trailing end
 * (Linux's three §9.3 boxes inset 8; Windows' caption buttons drawn over the band, the strip
 * keeping their footprint clear; the macOS lights leading, the strip inset 84 – and 8 at its
 * start elsewhere, the window's gutter). After a close the widths hold while the pointer stays
 * in the band and re-lay out 120 ms after it leaves; a width change runs on `SPRING_SNAPPY`
 * (§11.4's FLIP set), reorders on the rows' slide. The rows' other interactions are the
 * sidebar's with their axis turned: the hover card hangs under the band (`lib/hoverCard.ts`),
 * a drag reorders along the strip with the caret upright in the gap, autoscrolls the region at
 * its edges and tears off 16 past the band (`lib/drag.ts`). The strip is the tab strip pane of
 * the F6 rotation (`data-pane="tabs"`); the rail beside the frame is the same pane's other root.
 */
export function TabStrip({ state, trailing }: Props): JSX.Element {
  const space = activeSpace(state)
  const drag = uiStore.use((s) => s.drag)
  const dropKey = dropStore.use((s) => s.key)
  const zones = dropStore.use((s) => s.zones)
  const searchUp = uiStore.use((s) => s.tabSearch?.from === 'strip')
  const pinned = pinnedOf(state, space)
  const regular = regularOf(state, space)
  // The rows are the space panel's (SpacePanel.tsx): a regular surface lists no private group
  // and no private member among a group's rows; a private window lists its own groups whole.
  const regularSurface = !isPrivateWindow(state)
  const liveOf = (folderId: string): Tab[] => regular.filter((t) => t.folderId === folderId)
  const membersOf = (folderId: string): Tab[] =>
    regularSurface ? regularMembers(liveOf(folderId)) : liveOf(folderId)
  const folders = groupsOf(state, space.id).filter(
    (f) => !regularSurface || !isPrivateGroup(f, liveOf(f.id))
  )
  const listed = new Set(folders.map((f) => f.id))
  const loose = regular.filter(
    (t) => !t.folderId || !listed.has(t.folderId) || (regularSurface && isPrivateTab(t))
  )
  const activeTabId = space.activeTabId
  const isMac = state.platform === 'darwin'
  const isPrivate = isPrivateWindow(state)
  const overlay = useCaptionOverlay()

  // ---- the widths (lib/tabStripLayout.ts) ----
  // The room the regular tabs have is what the region shows plus whatever the drag spring holds
  // beyond its 24 (the region is content-sized until the tabs fill it) plus the All tabs slot,
  // so the button's coming and going never changes the room it is judged against. Measured on
  // every commit that changes the rows and on every resize of the region or the spring.
  const scrollerEl = useRef<HTMLDivElement | null>(null)
  const listEl = useRef<HTMLDivElement | null>(null)
  const springEl = useRef<HTMLDivElement>(null)
  const allTabsEl = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout>({ width: STRIP_TAB_MAX, overflow: false })
  /** The width the rows draw at now (the spring's, mid-flight). */
  const drawnWidth = useRef(STRIP_TAB_MAX)
  /** The width held after a close while the pointer stays in the band; null once released. */
  const held = useRef<number | null>(null)
  const pointerInBand = useRef(false)
  const holdTimer = useRef<number | null>(null)
  /** The first measurement draws its width outright; every later change runs on the spring. */
  const measured = useRef(false)
  const relayout = useCallback((): void => {
    const scroller = scrollerEl.current
    const list = listEl.current
    const spring = springEl.current
    if (!scroller || !list || !spring) return
    const chips = list.querySelectorAll<HTMLElement>('[data-strip-group]')
    let fixed = 0
    chips.forEach((chip) => {
      fixed += chip.offsetWidth
    })
    const count = list.querySelectorAll(ROWS).length
    const room =
      scroller.clientWidth +
      Math.max(0, spring.offsetWidth - STRIP_DRAG_SPRING) +
      (allTabsEl.current?.offsetWidth ?? 0)
    const natural = stripTabWidth(stripTabRoom(room, fixed, chips.length, count), count)
    const width = heldTabWidth(held.current, pointerInBand.current, natural.width)
    if (held.current !== null && pointerInBand.current) list.dataset.widthHeld = 'true'
    else delete list.dataset.widthHeld
    setLayout((prev) =>
      prev.width === width && prev.overflow === natural.overflow
        ? prev
        : { width, overflow: natural.overflow }
    )
  }, [])
  const release = useCallback((): void => {
    holdTimer.current = null
    held.current = null
    relayout()
  }, [relayout])
  const onBandEnter = useCallback((): void => {
    pointerInBand.current = true
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [])
  const onBandLeave = useCallback((): void => {
    pointerInBand.current = false
    if (held.current === null) return
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(release, STRIP_HOLD_MS)
  }, [release])
  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    },
    []
  )

  // The active tab comes into view on activation and once a width change has settled, clear of
  // the edge fades.
  const activeRef = useRef(activeTabId)
  useLayoutEffect(() => {
    activeRef.current = activeTabId
  }, [activeTabId])
  const scrollActiveIntoView = useCallback((): void => {
    const el = scrollerEl.current
    const id = activeRef.current
    if (!el || !id) return
    const row = el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
    if (!row) return
    const box = el.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    const start = box.left + (el.scrollLeft > 0 ? STRIP_FADE : 0)
    const end = box.right - STRIP_FADE
    if (r.left < start) el.scrollBy({ left: r.left - start, behavior: 'smooth' })
    else if (r.right > end) el.scrollBy({ left: r.right - end, behavior: 'smooth' })
  }, [])
  useLayoutEffect(scrollActiveIntoView, [scrollActiveIntoView, activeTabId])

  // A width change is §11.4's FLIP on the snappy spring: the shared width runs from where it
  // was to where it goes, every row and the + following in layout. The first measurement after
  // the strip comes up draws its width outright.
  const widthSpring = useRef<SpringAnimation | null>(null)
  useLayoutEffect(() => {
    const list = listEl.current
    if (!list) return
    const to = layout.width
    if (drawnWidth.current === to) return
    const draw = (x: number): void => {
      drawnWidth.current = x
      list.style.setProperty(WIDTH_PROPERTY, `${x}px`)
    }
    if (!measured.current) {
      measured.current = true
      draw(to)
      return
    }
    const spring = (widthSpring.current ??= new SpringAnimation(SPRING_SNAPPY, draw, (x) => {
      draw(x)
      scrollActiveIntoView()
    }))
    const from = spring.running ? spring.stop() : { x: drawnWidth.current, v: 0 }
    spring.start(from.x, from.v, to)
  }, [layout.width, scrollActiveIntoView])
  useEffect(
    () => () => {
      widthSpring.current?.stop()
    },
    []
  )

  // Every regular tab's trailing slot follows the shared width (`lib/tabStripLayout.ts`).
  const width = layout.width
  const slot = useCallback(
    (tab: Tab, active: boolean): StripSlot => stripSlot(width, active, hasStateGlyph(tab)),
    [width]
  )

  // The rows' motion (§11.4), along the strip's axis: one list for the pinned tabs, one for the
  // regular region, each keyed by its scroller so lib/drag.ts finds it from a row.
  const [pinnedMotion] = useState(() => new SlideMotion('x'))
  const [motion] = useState(() => new SlideMotion('x', { enter: true, batch: ENTER_BATCH }))
  useEffect(
    () => () => {
      pinnedMotion.dispose()
      motion.dispose()
    },
    [pinnedMotion, motion]
  )
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'x', size: STRIP_FADE })
  const scroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerEl.current = el
      const teardown = fade(el)
      motion.setScroller(el)
      if (el) listMotions.set(el, motion)
      return () => {
        if (typeof teardown === 'function') teardown()
        motion.setScroller(null)
        scrollerEl.current = null
      }
    },
    [fade, motion]
  )
  const list = useCallback((el: HTMLDivElement | null) => {
    listEl.current = el
    if (el) el.style.setProperty(WIDTH_PROPERTY, `${drawnWidth.current}px`)
  }, [])
  const pinnedScroller = useCallback(
    (el: HTMLDivElement | null) => {
      pinnedMotion.setScroller(el)
      if (el) listMotions.set(el, pinnedMotion)
      return () => pinnedMotion.setScroller(null)
    },
    [pinnedMotion]
  )
  const orderKey = [
    ...pinned.map((t) => t.id),
    ...folders.map((f) => `${f.id}${f.collapsed ? '-' : '+'}`),
    ...regular.map((t) => `${t.id}${t.folderId ?? ''}`)
  ].join('|')
  // A close with the pointer in the band holds the widths the tabs had (Chrome's rule, so the
  // next × lands under the pointer); a tab arriving, or the pointer leaving, releases them. The
  // space's tab count decides it, not the rows drawn: a group's fold takes rows away and closes
  // nothing, so its members' width goes to the others on the spring at once.
  const tabCount = regular.length
  const lastTabCount = useRef(tabCount)
  useLayoutEffect(() => {
    if (tabCount < lastTabCount.current && pointerInBand.current && held.current === null) {
      held.current = drawnWidth.current
    } else if (tabCount > lastTabCount.current) {
      held.current = null
    }
    lastTabCount.current = tabCount
  }, [tabCount])
  useLayoutEffect(() => {
    const lifted = uiStore.get().drag?.tabId ?? null
    pinnedMotion.flip(lifted, true)
    motion.flip(lifted, true)
    relayout()
  }, [pinnedMotion, motion, relayout, orderKey, zones])
  // The region, its list and the spring change size with the window, the rows' fold and slide
  // and the rows a group's fold takes away after its spring (no commit of the strip's own).
  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => relayout())
    if (scrollerEl.current) observer.observe(scrollerEl.current)
    if (listEl.current) observer.observe(listEl.current)
    if (springEl.current) observer.observe(springEl.current)
    return () => observer.disconnect()
  }, [relayout])

  // The wheel over the region scrolls it along the strip (Chrome's, Firefox's): a vertical
  // wheel is the tab strip's horizontal scroll; a trackpad's sideways swipe scrolls natively.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    const el = e.currentTarget
    if (el.scrollWidth <= el.clientWidth) return
    el.scrollLeft += e.deltaY
  }

  // The strip's own menu on its empty room (the sidebar scroller's rule): a row that opened its
  // own menu has claimed the event by now.
  const onEmptyContextMenu = (e: React.MouseEvent): void => {
    if (e.isDefaultPrevented()) return
    e.preventDefault()
    run('newtab.contextMenu', contextMenuAnchor(e))
  }

  return (
    <StripAxisContext.Provider value="x">
      <div
        className="zen-tab-strip zen-drag relative flex shrink-0 items-stretch"
        style={{ height: STRIP_BAND, paddingLeft: isMac ? STRIP_MAC_INSET : STRIP_LEADING_INSET }}
        data-tab-strip
        data-surface="window"
        data-pane="tabs"
        data-strip-axis="x"
        data-overflow={layout.overflow || undefined}
        data-testid="tab-strip"
        onPointerEnter={onBandEnter}
        onPointerLeave={onBandLeave}
      >
        {isPrivate && (
          <VenetianMask
            className="ml-2 mt-[6px] h-8 w-4 shrink-0 self-start opacity-70"
            aria-label="Private window"
          />
        )}
        {/* The window's Tabs navigation landmark (a11y-02), the sidebar's: the tab lists and the
            + after them. Each run of rows is its own horizontal tablist (a11y-07, a11y-31) – the
            pinned rows, the loose rows, and under each chip the group's rows (FolderRow). */}
        <nav aria-label="Tabs" className="flex min-w-0 items-stretch" style={{ flex: '0 1 auto' }}>
          <div
            className="zen-no-drag flex min-w-0 items-stretch gap-1"
            style={{ flex: '0 1 auto' }}
          >
            {pinned.length > 0 && (
              <ListMotionContext.Provider value={pinnedMotion}>
                <div
                  ref={pinnedScroller}
                  className="flex h-full shrink-0 items-end gap-1"
                  role="tablist"
                  aria-orientation="horizontal"
                  aria-label={`${space.name} pinned tabs`}
                  data-strip-pinned
                  data-tab-scroller
                  data-active="true"
                  data-tab-list="pinned"
                >
                  {stripRows(pinned, state.splitGroups).map((row) => (
                    <StripRowItem key={rowKey(row)} row={row} activeTabId={activeTabId} compact />
                  ))}
                </div>
              </ListMotionContext.Provider>
            )}
            <ListMotionContext.Provider value={motion}>
              <div
                ref={scroller}
                className="zen-strip-scroller flex h-full min-w-0 items-end overflow-x-auto overflow-y-hidden"
                style={{ flex: '0 1 auto' }}
                data-strip-scroller
                data-tab-scroller
                data-active="true"
                onWheel={onWheel}
                onContextMenu={onEmptyContextMenu}
              >
                <div
                  ref={list}
                  className="flex h-full items-end gap-1"
                  role="tablist"
                  aria-orientation="horizontal"
                  aria-label={`${space.name} tabs`}
                  data-tab-list="regular"
                >
                  {folders.map((folder) => (
                    <FolderRow
                      key={folder.id}
                      folder={folder}
                      tabs={membersOf(folder.id)}
                      activeTabId={activeTabId}
                      compact={false}
                      dropKey={dropKey}
                      dragging={Boolean(drag)}
                      live={Boolean(state.liveFolders[folder.id])}
                      liveError={state.liveFolders[folder.id]?.lastError ?? null}
                      splitGroups={state.splitGroups}
                      slot={slot}
                    />
                  ))}
                  {stripRows(loose, state.splitGroups).map((row) => (
                    <StripRowItem
                      key={rowKey(row)}
                      row={row}
                      activeTabId={activeTabId}
                      compact={false}
                      slot={slot}
                    />
                  ))}
                </div>
              </div>
            </ListMotionContext.Provider>
          </div>
          <div className="zen-no-drag flex shrink-0 items-end pb-[2px] pl-1">
            <NewTabButton
              compact={false}
              spaced={false}
              dropInto={dropKey === `newtab:${space.id}`}
              button
            />
          </div>
        </nav>
        {/* The drag spring: at least 24 of caption between the + and the window controls. */}
        <div
          ref={springEl}
          className="zen-drag"
          style={{ flex: `1 0 ${STRIP_DRAG_SPRING}px` }}
          data-strip-spring
        />
        {layout.overflow && (
          <div ref={allTabsEl} className="zen-no-drag flex shrink-0 items-end pb-[2px] pr-1">
            <button
              type="button"
              className="zen-toolbar-button shrink-0"
              title="All tabs"
              aria-label="All tabs"
              aria-haspopup="dialog"
              aria-expanded={searchUp}
              data-strip-all-tabs
              onClick={() => toggleTabSearch('strip')}
            >
              <ChevronDown className="h-4 w-4" strokeWidth={TOOLBAR_STROKE} />
            </button>
          </div>
        )}
        <div
          className={cn('zen-no-drag flex shrink-0 items-end gap-1 pb-[2px]')}
          style={{ paddingRight: overlay.width > 0 ? overlay.width : 8 }}
          data-strip-controls
        >
          {trailing}
          <WindowControls />
        </div>
      </div>
    </StripAxisContext.Provider>
  )
}
