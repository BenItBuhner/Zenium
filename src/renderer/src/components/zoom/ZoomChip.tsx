import type { JSX } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { formatZoom } from '@shared/pageControls'
import { closeZoomBubble, openZoomBubble, uiStore } from '@renderer/lib/ui'
import { PillChip } from '../urlbar/PillChip'
import { defaultZoomFor, isZoomed } from './bubble'

/**
 * Chrome's zoom icon in the address bar: a magnifier with a plus (zoomed in) or a minus (zoomed
 * out) that stands in the pill while the page is away from its default zoom and goes as soon as
 * it is back. Pressing it opens the zoom bubble, which then stays until it is put away;
 * pressing it again puts the bubble away. The percentage itself is in the chip's name and
 * tooltip; the bubble shows it large.
 */
export function ZoomChip({ state, tab }: { state: UIState; tab: Tab }): JSX.Element | null {
  const open = uiStore.use((s) => s.zoomBubble?.tabId === tab.id)
  const { pageControls } = state.settings
  // The host with the page-controls sheet (Android) shows the zoom there, as Chrome does.
  if (state.capabilities.pageControls) return null
  if (!isZoomed(tab, pageControls, state.pageEnvironment)) return null
  const zoomedIn = tab.zoom > defaultZoomFor(tab.url, pageControls, state.pageEnvironment)
  const label = `Zoom: ${formatZoom(tab.zoom)}`
  // One of the pill's chips (`PillChip`, v2 draft §9.22): a 20px chip like Reader View's, whose
  // popup is the bubble; `aria-expanded` follows the bubble. `data-zoom-chip` is what the bubble
  // hangs from and what its Escape hands the keyboard back to.
  return (
    <PillChip
      label={label}
      title={label}
      popup="dialog"
      expanded={open}
      data-zoom-chip=""
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--zen-element-bg-hover)]"
      onActivate={() => {
        // The chip that put the bubble away keeps the keyboard, as the anchor does after
        // Escape (§9.22).
        if (open) closeZoomBubble({ keepFocus: true })
        else void openZoomBubble(tab.id, tab.zoom)
      }}
    >
      {zoomedIn ? <ZoomIn className="h-3.5 w-3.5" /> : <ZoomOut className="h-3.5 w-3.5" />}
    </PillChip>
  )
}
