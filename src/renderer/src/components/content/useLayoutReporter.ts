import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LayoutReport, Rect, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { run } from '@renderer/lib/api'
import {
  chromeUnderPages,
  COVER_WAIT_MS,
  coverStatus,
  coverStore,
  decideHidden,
  hideFollowsCover
} from '@renderer/lib/cover'
import { useViewport } from '@renderer/lib/formFactor'
import { landingStore, notePlacements } from '@renderer/lib/fullscreenLanding'
import {
  glanceRect,
  placementsFor,
  SPLIT_GAP,
  SPLIT_GAP_TOUCH,
  viewCover
} from '@renderer/lib/layout'
import { layoutRectUnder } from '@renderer/lib/layoutRect'
import { subscribePageRecede } from '@renderer/lib/motion/recede'
import { pageOffScreen, pageViewStore } from '@renderer/lib/pageView'
import { usePrivateCoverUp } from '@renderer/lib/privateLock'
import { activeTab, isEmptySplitPane, visibleTabIds } from '@renderer/lib/selectors'
import { contentAreaStore, coverBandStore, pageHidden, type UiState } from '@renderer/lib/ui'

export interface LayoutInfo {
  /** Viewport rect in window coordinates (null before first measure). */
  area: Rect | null
  /**
   * Whether chrome covers the content area, so the chrome paints the page's picture there. The
   * host is told to hide the page views a little later than this turns true: once that picture
   * is painted (see `lib/cover.ts`); on Android it also stays true a little after the chrome has
   * uncovered the page: until the host has drawn the live view back (`lib/pageView.ts`), so the
   * picture never leaves before the page is there to take its place.
   */
  contentHidden: boolean
}

/**
 * Measures the viewport element and tells the main process where every visible tab view goes.
 * Runs after paint so the report always matches what the chrome is showing.
 *
 * The measure is the viewport's LAYOUT box, not its painted one: under a phone sheet the content
 * frame (`frameRef`) stands receded – scaled to .97 about its centre (main.css on `--zen-recede`,
 * v2 §11.1) – and a `getBoundingClientRect()` taken through it read the page 20 to 24 CSS px
 * short whenever something measured with a sheet up (a setting written from its picker, the
 * keyboard rising under a sheet's field), with nothing measuring again once the sheet had gone:
 * the page stood laid out short until the next hide or return (PERF-4's audit, the stale `page
 * 783 vs 805` of every bar-hide run). The painted box is run back through the frame's computed
 * transform (`lib/layoutRect.ts`), and the frame is measured once more the moment the recede
 * returns to 0, so a measure that missed anything is put right at the rest.
 */
function sameRect(prev: Rect | null, next: Rect | null): boolean {
  if (prev === null || next === null) return prev === next
  return (
    prev.x === next.x &&
    prev.y === next.y &&
    prev.width === next.width &&
    prev.height === next.height
  )
}

export function useLayoutReporter(
  viewportRef: RefObject<HTMLDivElement | null>,
  frameRef: RefObject<HTMLElement | null>,
  sidePanelRef: RefObject<HTMLDivElement | null>,
  state: UIState,
  ui: UiState,
  glanceActive: boolean
): LayoutInfo {
  const [area, setArea] = useState<Rect | null>(null)
  const [panelArea, setPanelArea] = useState<Rect | null>(null)
  const lastSent = useRef<string>('')
  const { coarse, formFactor } = useViewport()
  const gap = coarse ? SPLIT_GAP_TOUCH : SPLIT_GAP
  const panelOpen = state.sidePanel !== null

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = (): void => {
      // The layout box: the painted one run back through the receded frame's transform.
      const next = layoutRectUnder(el, frameRef.current)
      // Chrome that stands in for the page (the phone's gesture stage) lays out against it.
      if (!sameRect(contentAreaStore.get().area, next)) contentAreaStore.set({ area: next })
      setArea((prev) => (sameRect(prev, next) ? prev : next))
    }
    measure()
    // Measured again over the next two frames: a move the ResizeObserver never sees (the bar
    // changing edges slides the viewport by the bar's band without resizing it) may land a
    // frame or two after the effect measures – an inset variable arriving with the frame, a
    // style the host writes late. The column's own padding is not among those: it is laid out
    // the moment the edge changes, and never transitioned – under reduced motion main.css
    // removes every transition rather than shortening one, since a shortened one would be held
    // at the old edge by a slow compositor for longer than any fixed number of frames covers.
    let frame = requestAnimationFrame(() => {
      measure()
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    // The frame at its rest once more: whatever was measured while it stood receded is measured
    // again, now that nothing scales it (the sheet's landing, not its request – the value is 0
    // only once the spring or the finger has brought the frame back).
    const unsubscribeRecede = subscribePageRecede((page) => {
      if (page === 0) measure()
    })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', measure)
      unsubscribeRecede()
    }
  }, [
    viewportRef,
    frameRef,
    formFactor,
    panelOpen,
    state.settings.sidebarSide,
    state.settings.toolbarLayout,
    state.settings.compactMode.enabled,
    // The phone bar changing edges slides the viewport without resizing it.
    state.settings.phoneBarPosition
  ])

  // The extension side panel's strip: its body is where the panel's view goes.
  useLayoutEffect(() => {
    const el = sidePanelRef.current
    if (!el || !panelOpen) {
      setPanelArea(null)
      return
    }
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const next = { x: r.left, y: r.top, width: r.width, height: r.height }
      setPanelArea((prev) => (sameRect(prev, next) ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [sidePanelRef, panelOpen, formFactor, state.settings.sidebarSide])

  // Under a chrome overlay, a revealed compact sidebar or toolbar, or a frame dialog host that
  // keeps the page behind its capture while a panel it placed is still on its way out, after
  // the dialog's own flag has cleared (`holdFrameDialogCover`); or under the lock cover of a
  // locked private tab (INC-05, `PrivateLockCover`), until the cover has lifted.
  const lockCover = usePrivateCoverUp(state)
  const contentHidden = pageHidden(ui) || lockCover
  // The strips the chrome's message cards cover at the frame's edges (see `coverBandStore`).
  const band = coverBandStore.use()
  // The live page is swapped for its cover, so the hide follows the cover's paint on every host
  // (`hideFollowsCover`: on Electron too, the view composites above the chrome and its hide is
  // not ordered after the chrome's frame carrying the picture).
  const waitsForCover = hideFollowsCover()
  // Where the chrome lies under the pages – the Android chassis, whatever its form factor – the
  // cover also stays until the host has drawn the live page back where it was.
  const followsCover = chromeUnderPages(state.platform)
  const activeTabId = activeTab(state)?.id ?? null
  const pageAway = pageViewStore.use((s) => followsCover && pageOffScreen(s, activeTabId))
  /** What the last report said about the page views (the latch of `decideHidden`). */
  const reportedHidden = useRef(false)
  /** When the current wait for a cover began, or null outside one. */
  const waitingSince = useRef<number | null>(null)
  // A page's element in fullscreen (MOT-32): the chrome stays mounted and laid out under the
  // host's fullscreen layer, and nothing it lays out meanwhile is a placement – the core puts
  // the fullscreen tab's view over the whole window itself and keeps the layout from before
  // the fullscreen to put it back by at the exit; a report made under the layer (the bars
  // gone, the frame taller by the insets) would stand in for that layout and lay the page out
  // once more at the exit, and the frame it names is not the one the page comes back to. So
  // nothing is reported while a fullscreen is on, and the first layout after it is reported
  // whatever the last one said: the return fade waits on that report's placement
  // (`lib/fullscreenLanding.ts`), so a layout the same as before the fullscreen must still be
  // named – as it was when the chrome was remounted at every exit.
  const fullscreenTabId = state.window.htmlFullscreenTabId
  const wasFullscreen = useRef(fullscreenTabId !== null)

  useEffect(() => {
    if (wasFullscreen.current && fullscreenTabId === null) lastSent.current = ''
    wasFullscreen.current = fullscreenTabId !== null
    let deadline: ReturnType<typeof setTimeout> | null = null
    const evaluate = (): void => {
      let hidden = contentHidden
      // The lock cover never waits for its picture: a locked private page is hidden the moment
      // the cover is asked for, a frame of the cover's base ahead of the blurred picture being
      // the trade (the picture is decoration on the lock; the live page over the cover would be
      // the leak, INC-05). Every other cover waits for its paint as before.
      if (waitsForCover && !lockCover) {
        const cover = coverStatus(coverStore.get(), activeTab(state)?.id)
        const waitedOut =
          waitingSince.current !== null && Date.now() - waitingSince.current >= COVER_WAIT_MS
        hidden = decideHidden(contentHidden, reportedHidden.current, cover, waitedOut)
        if (contentHidden && !hidden) {
          // Waiting for the cover: it reports its paint through the store; the deadline ends a
          // wait that nothing would end otherwise.
          waitingSince.current ??= Date.now()
          if (deadline === null) {
            const left = Math.max(0, COVER_WAIT_MS - (Date.now() - waitingSince.current))
            deadline = setTimeout(() => {
              deadline = null
              evaluate()
            }, left)
          }
        } else {
          waitingSince.current = null
        }
      } else {
        waitingSince.current = null
      }
      reportedHidden.current = hidden
      send(hidden)
    }
    const send = (hidden: boolean): void => {
      if (fullscreenTabId !== null || !area) return
      const tab = activeTab(state)
      const group = tab?.splitGroupId ? (state.splitGroups[tab.splitGroupId] ?? null) : null
      const radius =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--zen-content-radius')
        ) || 0
      let placements = placementsFor(area, visibleTabIds(state), group, radius, gap).map((p) => {
        const c = viewCover(area, p.rect, band)
        return c ? { ...p, cover: c } : p
      })
      // The phone draws its new tab page in the chrome (`NewTabPage`); the blank page's view
      // would only cover it.
      if (formFactor === 'phone')
        placements = placements.filter((p) => state.tabs[p.tabId]?.url !== BLANK_URL)
      // An empty pane of a split is chrome too (`EmptyPane`, split-04): its field, its "Choose
      // a tab" button and the URL bar floating in it draw where the blank view would be.
      if (group) placements = placements.filter((p) => !isEmptySplitPane(state, p.tabId))
      let glance: LayoutReport['glance'] = null
      if (state.glance) {
        // The parent is frozen behind the glance card; the card itself appears once its open
        // animation has run.
        if (glanceActive) {
          placements = placements.filter(
            (p) =>
              p.tabId !== state.glance!.parentTabId && !(group && group.tabIds.includes(p.tabId))
          )
          if (ui.glanceReady) {
            const rect = glanceRect(area)
            const c = viewCover(area, rect, band)
            glance = { tabId: state.glance.tabId, rect, radius: 12, ...(c ? { cover: c } : {}) }
          }
        }
      }
      const report: LayoutReport = {
        placements,
        glance,
        contentHidden: hidden,
        sidePanel: panelOpen ? panelArea : null
      }
      const key = JSON.stringify(report)
      if (key === lastSent.current) return
      lastSent.current = key
      run('layout.report', report)
      // The return from a page's fullscreen (lib/fullscreenLanding.ts) lands on a placement
      // laid out on settled insets, drawn by the host at its size.
      notePlacements(report.placements, landingStore.get().settling)
    }
    evaluate()
    const unsubscribe = waitsForCover ? coverStore.subscribe(evaluate) : null
    return () => {
      unsubscribe?.()
      if (deadline !== null) clearTimeout(deadline)
    }
  }, [
    area,
    panelArea,
    panelOpen,
    state,
    ui.glanceReady,
    glanceActive,
    contentHidden,
    lockCover,
    gap,
    band,
    waitsForCover,
    formFactor,
    fullscreenTabId
  ])

  return { area, contentHidden: contentHidden || pageAway }
}
