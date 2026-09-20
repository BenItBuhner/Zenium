import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LayoutReport, Rect, UIState } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import { run } from '@renderer/lib/api'
import {
  chromeUnderPages,
  COVER_WAIT_MS,
  coverStatus,
  coverStore,
  decideHidden
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
import { pageOffScreen, pageViewStore } from '@renderer/lib/pageView'
import { usePrivateCoverUp } from '@renderer/lib/privateLock'
import { activeTab, isEmptySplitPane, visibleTabIds } from '@renderer/lib/selectors'
import { contentAreaStore, coverBandStore, pageHidden, type UiState } from '@renderer/lib/ui'

export interface LayoutInfo {
  /** Viewport rect in window coordinates (null before first measure). */
  area: Rect | null
  /**
   * Whether chrome covers the content area, so the chrome paints the page's picture there. On
   * Android the host is told to hide the page views a little later than this turns true: once
   * that picture is painted (see `lib/cover.ts`); and it stays true a little after the chrome
   * has uncovered the page: until the host has drawn the live view back (`lib/pageView.ts`), so
   * the picture never leaves before the page is there to take its place.
   */
  contentHidden: boolean
}

/**
 * Measures the viewport element and tells the main process where every visible tab view goes.
 * Runs after paint so the report always matches what the chrome is showing.
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
      const r = el.getBoundingClientRect()
      const next = { x: r.left, y: r.top, width: r.width, height: r.height }
      // Chrome that stands in for the page (the phone's gesture stage) lays out against it.
      if (!sameRect(contentAreaStore.get().area, next)) contentAreaStore.set({ area: next })
      setArea((prev) => (sameRect(prev, next) ? prev : next))
    }
    measure()
    // Measured again over the next two frames: a move the ResizeObserver never sees (the bar
    // changing edges slides the viewport by the bar's band without resizing it) can still be
    // under way when the effect measures – under `prefers-reduced-motion` every property change
    // is a 0.01 ms transition (main.css), and a transition is at its start until the frame after
    // it is made, so the shell's padding reads as it was; on the frame after that it has moved.
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
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [
    viewportRef,
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
  // Where the chrome lies under the pages – the Android chassis, whatever its form factor – the
  // live page is swapped for its cover, so the hide follows the cover's paint. The desktop hosts
  // report the hide the moment it is wanted, as they always have.
  const followsCover = chromeUnderPages(state.platform)
  // ... and the cover stays until the host has drawn the live page back where it was.
  const activeTabId = activeTab(state)?.id ?? null
  const pageAway = pageViewStore.use((s) => followsCover && pageOffScreen(s, activeTabId))
  /** What the last report said about the page views (the latch of `decideHidden`). */
  const reportedHidden = useRef(false)
  /** When the current wait for a cover began, or null outside one. */
  const waitingSince = useRef<number | null>(null)

  useEffect(() => {
    let deadline: ReturnType<typeof setTimeout> | null = null
    const evaluate = (): void => {
      let hidden = contentHidden
      // The lock cover never waits for its picture: a locked private page is hidden the moment
      // the cover is asked for, a frame of the cover's base ahead of the blurred picture being
      // the trade (the picture is decoration on the lock; the live page over the cover would be
      // the leak, INC-05). Every other cover waits for its paint as before.
      if (followsCover && !lockCover) {
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
      let report: LayoutReport
      const fullscreenTabId = state.window.htmlFullscreenTabId
      if (fullscreenTabId && state.tabs[fullscreenTabId]) {
        report = {
          placements: [
            {
              tabId: fullscreenTabId,
              rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
              radius: 0
            }
          ],
          glance: null,
          contentHidden: false,
          sidePanel: null
        }
      } else if (!area) {
        return
      } else {
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
        report = {
          placements,
          glance,
          contentHidden: hidden,
          sidePanel: panelOpen ? panelArea : null
        }
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
    const unsubscribe = followsCover ? coverStore.subscribe(evaluate) : null
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
    followsCover,
    formFactor
  ])

  return { area, contentHidden: contentHidden || pageAway }
}
