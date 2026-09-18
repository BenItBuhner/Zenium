import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { formatZoom, siteKey, siteZoom } from '@shared/pageControls'
import { run } from '@renderer/lib/api'
import { useBackDismissal } from '@renderer/lib/back'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { activeTab } from '@renderer/lib/selectors'
import { closeZoom, uiStore } from '@renderer/lib/ui'
import { ZoomStepper } from '../ZoomStepper'

/**
 * Chrome's page zoom sheet, docked under the page the way the find bar is: the page stays live
 * and shrinks by the sheet's height, so every move of the slider is seen at once. The factor is
 * the tab's site's, remembered per site; Reset goes back to the Accessibility default.
 */
export function ZoomSheet({ state, tabId }: { state: UIState; tabId: string }): JSX.Element | null {
  const tab = state.tabs[tabId]
  const url = tab?.url ?? ''
  const pc = state.settings.pageControls
  const site = siteKey(url)
  const factor = siteZoom(pc, url)
  const remembered = site !== null && pc.siteZooms[site] !== undefined
  const scale = pc.zoomIncludesOsFontSize ? state.pageEnvironment.fontScale || 1 : 1
  const ref = useRef<HTMLDivElement>(null)

  // The sheet belongs to one page: it goes when that tab closes or another one comes forward.
  const present = tab !== undefined
  const activeId = activeTab(state)?.id ?? null
  useEffect(() => {
    if (!present || activeId !== tabId) closeZoom()
  }, [present, activeId, tabId])

  // In on a spring; the back gesture slides it out again with the finger (v1 §7).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const spring = new SpringAnimation(
      SPRING_SNAPPY,
      (y) => {
        el.style.transform = `translateY(${y}px)`
      },
      () => {
        el.style.transform = ''
      }
    )
    spring.start(el.offsetHeight, 0, 0)
    return () => {
      spring.stop()
    }
  }, [])

  useBackDismissal('zoom', {
    render: (value) => {
      const el = ref.current
      if (el) el.style.transform = `translateY(${value * el.offsetHeight}px)`
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
      closeZoom()
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
      className="zen-zoom-sheet shrink-0 px-2 pb-2"
      role="dialog"
      aria-label="Page zoom"
    >
      <div className="zen-zoom-header flex items-center gap-2 pl-2">
        <span className="zen-zoom-title">Zoom</span>
        <span className="flex-1" />
        <span className="zen-zoom-value">{formatZoom(factor)}</span>
        <button
          type="button"
          className="zen-toolbar-button zen-v2-zoom-close"
          aria-label="Close"
          onClick={closeZoom}
        >
          <X />
        </button>
      </div>
      <ZoomStepper
        value={factor}
        disabled={!site}
        className="zen-zoom-row"
        stepClassName="zen-v2-zoom-step"
        sliderClassName="zen-zoom-slider"
        onChange={(next) => run('tab.setZoomFactor', { tabId, factor: next })}
      />
      <div className="zen-zoom-row flex items-center gap-2 pl-2">
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
