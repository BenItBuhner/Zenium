import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { formatZoom, siteZoom, zoomSiteKey } from '@shared/pageControls'
import { run } from '@renderer/lib/api'
import { useBackDismissal } from '@renderer/lib/back'
import { activeTab } from '@renderer/lib/selectors'
import { closeZoom, uiStore } from '@renderer/lib/ui'
import { ZoomStepper } from '../ZoomStepper'
import { DockedPanelMotion } from './dockedMotion'

/**
 * Chrome's page zoom sheet, docked under the page the way the find bar is (v2 §9.32): the page
 * stays live and shrinks by the sheet's height, so every move of the slider is seen at once –
 * which is why it is a docked panel on the frame's bottom edge and not a sheet on the chassis
 * (a chassis sheet dims the page under a scrim, recedes it and, on Android, shows it as a
 * snapshot). It takes the one docked slot the find bar uses, one of the two at a time. The
 * factor is the tab's site's, remembered per site; Reset goes back to the Accessibility default.
 *
 * A page surface (§9.29): its root carries `data-surface="page"` and everything in it draws in
 * the page family. No tooltips: the controls are named for the reader, never for a hover (§9.31).
 */
export function ZoomSheet({ state, tabId }: { state: UIState; tabId: string }): JSX.Element | null {
  const tab = state.tabs[tabId]
  const url = tab?.url ?? ''
  const pc = state.settings.pageControls
  const site = zoomSiteKey(url)
  const factor = siteZoom(pc, url)
  const remembered = site !== null && pc.siteZooms[site] !== undefined
  const scale = pc.zoomIncludesOsFontSize ? state.pageEnvironment.fontScale || 1 : 1
  const ref = useRef<HTMLDivElement>(null)
  const motion = useRef<DockedPanelMotion | null>(null)

  // The sheet belongs to one page: it goes when that tab closes or another one comes forward.
  const present = tab !== undefined
  const activeId = activeTab(state)?.id ?? null
  useEffect(() => {
    if (!present || activeId !== tabId) closeZoom()
  }, [present, activeId, tabId])

  // In on a spring from under the frame's edge and out the same way (v1 §7); with motion
  // reduced, a 120 ms fade in place both ways (§11.3). The back gesture slides it with the finger.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const m = new DockedPanelMotion(el)
    motion.current = m
    m.enter()
    return () => {
      m.dispose()
      motion.current = null
    }
  }, [])

  const leave = (): void => {
    if (motion.current) motion.current.leave(closeZoom)
    else closeZoom()
  }

  useBackDismissal('zoom', {
    render: (value) => {
      const el = ref.current
      if (!el) return
      el.style.transform = `translateY(${value * el.offsetHeight}px)`
      if (value > 0) el.dataset.moving = ''
      else delete el.dataset.moving
    },
    dismissed: closeZoom,
    travel: 160
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const ui = uiStore.get()
      // Escape closes the topmost piece of chrome; those are handled by their own layers.
      if (ui.urlbar.open || ui.menu || ui.overlay !== 'none') return
      leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!present) return null

  let note: string
  if (!site) note = 'Zoom applies to web pages.'
  else if (remembered) note = `Remembered for ${site}`
  else note = 'Default zoom'
  if (site && scale !== 1) note += ` · ${formatZoom(factor * scale)} with the system font size`

  return (
    <div
      ref={ref}
      className="zen-zoom-sheet shrink-0 pb-2"
      role="dialog"
      aria-label="Page zoom"
      data-surface="page"
    >
      {/* A bar header (§9.23): the title at the 16 gutter, the value, then the 44 px close at 2 (§9.16). */}
      <div className="zen-zoom-header flex items-center gap-2 pl-4 pr-0.5">
        <span className="zen-zoom-title">Zoom</span>
        <span className="flex-1" />
        <span className="zen-zoom-value">{formatZoom(factor)}</span>
        <button type="button" className="zen-v2-icon-button" aria-label="Close" onClick={leave}>
          <X />
        </button>
      </div>
      {/* The stepper's icon buttons sit at 2 like the header's, their glyphs on the gutter's line. */}
      <ZoomStepper
        value={factor}
        disabled={!site}
        className="zen-zoom-row px-0.5"
        stepClassName="zen-v2-icon-button"
        sliderClassName="zen-zoom-slider"
        onChange={(next) => run('tab.setZoomFactor', { tabId, factor: next })}
      />
      <div className="zen-zoom-row flex items-center gap-2 px-4">
        <span className="zen-zoom-note min-w-0 flex-1 truncate">{note}</span>
        <button
          type="button"
          className="zen-zoom-reset zen-v2-zoom-reset shrink-0"
          disabled={!remembered}
          onClick={() => run('tab.setZoom', { tabId, delta: null })}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
