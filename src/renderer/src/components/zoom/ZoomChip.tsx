import type { JSX } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { formatZoom } from '@shared/pageControls'
import { closeZoom, closeZoomBubble, openZoom, openZoomBubble, uiStore } from '@renderer/lib/ui'
import { PillChip } from '../urlbar/PillChip'
import { defaultZoomFor, isZoomed } from './bubble'

/**
 * Chrome's zoom icon in the address bar: a magnifier with a plus (zoomed in) or a minus (zoomed
 * out) that stands in the pill while the page is away from its default zoom and goes as soon as
 * it is back. Pressing it opens the zoom's panel, which then stays until it is put away;
 * pressing it again puts the panel away. The percentage itself is in the chip's name and
 * tooltip; the panel shows it large.
 *
 * The panel is the host's: the desktop's is the zoom bubble under the chip (§9.20); the host
 * with the page-controls sheet (Android, `capabilities.pageControls`) has §9.13's zoom sheet,
 * docked under the page (`openZoom`), and the chip opens that. The chip itself stands on both –
 * §9.29's tier, which §9.36's tablet pill takes – and on Android it is the whole of the
 * feedback under Ctrl+wheel: the chrome lies under the page views, so a bubble over the page
 * would cost the page's cover for a number (the design gate for #494), and `zoom.changed`
 * announces the level to the reader instead (`useMainEvents`).
 */
export function ZoomChip({
  state,
  tab,
  collapsed = false
}: {
  state: UIState
  tab: Tab
  /**
   * The pill cannot hold the chip beside its address (`pillChipTiers.ts`, §9.29): it stays
   * away – the zoom is in the app menu and on the keyboard – unless its panel is up, which
   * keeps its anchor (§9.20).
   */
  collapsed?: boolean
}): JSX.Element | null {
  const sheetHost = state.capabilities.pageControls
  const open = uiStore.use((s) =>
    sheetHost ? s.zoomTabId === tab.id : s.zoomBubble?.tabId === tab.id
  )
  const { pageControls } = state.settings
  if (!isZoomed(tab, pageControls, state.pageEnvironment)) return null
  if (collapsed && !open) return null
  const zoomedIn = tab.zoom > defaultZoomFor(tab.url, pageControls, state.pageEnvironment)
  const label = `Zoom: ${formatZoom(tab.zoom)}`
  // One of the pill's chips (`PillChip`, v2 draft §9.22): a 20px chip like Reader View's, whose
  // popup is the panel; `aria-expanded` follows it. `data-zoom-chip` is what the bubble hangs
  // from and what its Escape hands the keyboard back to.
  return (
    <PillChip
      label={label}
      title={label}
      popup="dialog"
      expanded={open}
      data-zoom-chip=""
      className="zen-pill-chip flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-[var(--v2-control-fill-hover)]"
      onActivate={() => {
        // The chip that put the panel away keeps the keyboard, as the anchor does after
        // Escape (§9.22).
        if (sheetHost) {
          if (open) closeZoom({ keepFocus: true })
          else openZoom(tab.id)
        } else if (open) closeZoomBubble({ keepFocus: true })
        else void openZoomBubble(tab.id, tab.zoom)
      }}
    >
      {zoomedIn ? <ZoomIn className="h-3.5 w-3.5" /> : <ZoomOut className="h-3.5 w-3.5" />}
    </PillChip>
  )
}
