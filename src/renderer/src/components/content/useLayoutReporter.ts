import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LayoutReport, Rect, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  chromeUnderPages,
  COVER_WAIT_MS,
  coverStatus,
  coverStore,
  decideHidden
} from '@renderer/lib/cover'
import { useViewport } from '@renderer/lib/formFactor'
import { glanceRect, placementsFor, SPLIT_GAP, SPLIT_GAP_TOUCH } from '@renderer/lib/layout'
import { activeTab, visibleTabIds } from '@renderer/lib/selectors'
import { contentAreaStore, overlayCoversContent, type UiState } from '@renderer/lib/ui'

export interface LayoutInfo {
  /** Viewport rect in window coordinates (null before first measure). */
  area: Rect | null
  /**
   * Whether chrome covers the content area, so the chrome paints the page's picture there. On
   * Android the host is told to hide the page views a little later than this turns true: once
   * that picture is painted (see `lib/cover.ts`).
   */
  contentHidden: boolean
}

/**
 * Measures the viewport element and tells the main process where every visible tab view goes.
 * Runs after paint so the report always matches what the chrome is showing.
 */
export function useLayoutReporter(
  viewportRef: RefObject<HTMLDivElement | null>,
  state: UIState,
  ui: UiState,
  glanceActive: boolean
): LayoutInfo {
  const [area, setArea] = useState<Rect | null>(null)
  const lastSent = useRef<string>('')
  const { coarse, formFactor } = useViewport()
  const gap = coarse ? SPLIT_GAP_TOUCH : SPLIT_GAP

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const next = { x: r.left, y: r.top, width: r.width, height: r.height }
      const same = (prev: Rect | null): boolean =>
        prev !== null &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
      // Chrome that stands in for the page (the phone's gesture stage) lays out against it.
      if (!same(contentAreaStore.get().area)) contentAreaStore.set({ area: next })
      setArea((prev) => (same(prev) ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [
    viewportRef,
    formFactor,
    state.settings.sidebarSide,
    state.settings.toolbarLayout,
    state.settings.compactMode.enabled,
    // The phone bar changing edges slides the viewport without resizing it.
    state.settings.phoneBarPosition
  ])

  const contentHidden = overlayCoversContent(ui) || ui.compactHover
  // Where the chrome lies under the pages – the Android chassis, whatever its form factor – the
  // live page is swapped for its cover, so the hide follows the cover's paint. The desktop hosts
  // report the hide the moment it is wanted, as they always have.
  const followsCover = chromeUnderPages(state.platform)
  /** What the last report said about the page views (the latch of `decideHidden`). */
  const reportedHidden = useRef(false)
  /** When the current wait for a cover began, or null outside one. */
  const waitingSince = useRef<number | null>(null)

  useEffect(() => {
    let deadline: ReturnType<typeof setTimeout> | null = null
    const evaluate = (): void => {
      let hidden = contentHidden
      if (followsCover) {
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
          contentHidden: false
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
        let placements = placementsFor(area, visibleTabIds(state), group, radius, gap)
        let glance: LayoutReport['glance'] = null
        if (state.glance) {
          // The parent is frozen behind the glance card; the card itself appears once its open
          // animation has run.
          if (glanceActive) {
            placements = placements.filter(
              (p) =>
                p.tabId !== state.glance!.parentTabId && !(group && group.tabIds.includes(p.tabId))
            )
            if (ui.glanceReady)
              glance = { tabId: state.glance.tabId, rect: glanceRect(area), radius: 12 }
          }
        }
        report = { placements, glance, contentHidden: hidden }
      }
      const key = JSON.stringify(report)
      if (key === lastSent.current) return
      lastSent.current = key
      run('layout.report', report)
    }
    evaluate()
    const unsubscribe = followsCover ? coverStore.subscribe(evaluate) : null
    return () => {
      unsubscribe?.()
      if (deadline !== null) clearTimeout(deadline)
    }
  }, [area, state, ui.glanceReady, glanceActive, contentHidden, gap, followsCover])

  return { area, contentHidden }
}
