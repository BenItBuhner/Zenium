import { useEffect } from 'react'
import type { FormFactor } from '@shared/types'
import { dismissSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { dismissStage } from '@renderer/lib/gestures/stage'
import { closeOverlay, openOverlay, overlayAvailable, uiStore } from '@renderer/lib/ui'
import { dismissTabletDrawer } from '../components/tablet/tabletChrome'

/**
 * What survives a shell swap, and what does not (TABLET-08). The gesture stage – the tab
 * overview, a tab switch in flight – belongs to the touch layouts and lives in `stageStore`, not
 * in a shell: a tablet window narrowed into the phone chrome (or widened back) swaps its shell
 * with the overview still open, drawn by the next shell's stage at the next frame. Only the
 * desktop layout, which has no stage, takes it down – with the Spaces drawer, which both touch
 * shells mount over the overview. The tablet's sidebar drawer is the tablet shell's alone (the
 * phone has no sidebar), so the phone and the desktop drop it, without motion – else the stale
 * one would be a back surface with nothing on screen.
 *
 * Everything else the swap must keep is already outside the shells: the page and its scroll
 * are the host's views (a shell only places them), the URL bar, the menus, the dialogs and the
 * find bar are `uiStore`'s and the sidebar's expanded / rail state is the core's setting.
 *
 * One `uiStore` surface changes form rather than staying or dropping: a page's overlay – the
 * phone's History panel, Bookmarks, Downloads – up as the window widens into a layout that
 * holds the page as a tab becomes that tab (`handOverlayToPageTab`), the way the core turns a
 * tablet's `zen://history` tab into the phone's panel when the window narrows
 * (`PageService.reconcileLayout`): the page follows the window's class in both directions.
 */
export function useStageContinuity(formFactor: FormFactor): void {
  useEffect(() => {
    reconcileStageFor(formFactor)
  }, [formFactor])
}

/** The hook's effect as a function: what the layout `formFactor` cannot draw is dropped or re-formed. */
export function reconcileStageFor(formFactor: FormFactor): void {
  if (formFactor === 'desktop') {
    dismissStage()
    dismissSpacesDrawer()
  }
  if (formFactor !== 'tablet') dismissTabletDrawer()
  handOverlayToPageTab()
}

/**
 * The page's overlay up in `uiStore` gives way to the page's tab where the layout holds the
 * page as one: the phone's History panel (Bookmarks with its folder, Downloads) up when the
 * window widens into the tablet class becomes the `zen://history` tab, through the core's one
 * route (`openOverlay` runs `page.open` for a kind that is no overlay on this layout –
 * `overlayAvailable`, which reads the viewport's class as the hook's argument does). The
 * reverse of the core's hand-over on the class change (`PageService.reconcileLayout`: a tablet's
 * page tab narrowed into the phone class becomes the overlay), so neither shell draws the other's
 * surface. Nothing happens with no overlay up, with one that is an overlay on every layout (a
 * space's editor, the theme picker), or on a host whose window never changes class (the desktop).
 * The open is marked the hand-back it is (`handedBack`): the core kept the slot the tab had when
 * it closed it for the narrowing (`ZenWindow.handedPage`), and the tab comes back there while
 * that still fits – not beside whichever tab is active now, as a page opened by hand does.
 */
function handOverlayToPageTab(): void {
  const { overlay, overlayFolderId, overlaySection } = uiStore.get()
  if (overlay === 'none' || overlayAvailable(overlay)) return
  closeOverlay()
  void openOverlay(overlay, null, null, overlayFolderId, overlaySection, { handedBack: true })
}
