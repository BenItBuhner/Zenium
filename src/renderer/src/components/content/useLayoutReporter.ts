import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LayoutReport, Rect, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { glanceRect, placementsFor } from '@renderer/lib/layout'
import { activeTab, visibleTabIds } from '@renderer/lib/selectors'
import { overlayCoversContent, type UiState } from '@renderer/lib/ui'

export interface LayoutInfo {
  /** Viewport rect in window coordinates (null before first measure). */
  area: Rect | null
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

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const next = { x: r.left, y: r.top, width: r.width, height: r.height }
      setArea((prev) =>
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next
      )
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
    state.settings.sidebarSide,
    state.settings.toolbarLayout,
    state.settings.compactMode.enabled
  ])

  const contentHidden = overlayCoversContent(ui) || ui.compactHover

  useEffect(() => {
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
      let placements = placementsFor(area, visibleTabIds(state), group, radius)
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
      report = { placements, glance, contentHidden }
    }
    const key = JSON.stringify(report)
    if (key === lastSent.current) return
    lastSent.current = key
    run('layout.report', report)
  }, [area, state, ui.glanceReady, glanceActive, contentHidden])

  return { area, contentHidden }
}
