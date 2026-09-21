import { useEffect } from 'react'
import type { FormFactor } from '@shared/types'
import { dismissSpacesDrawer } from '@renderer/lib/gestures/drawer'
import { dismissStage } from '@renderer/lib/gestures/stage'
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
 */
export function useStageContinuity(formFactor: FormFactor): void {
  useEffect(() => {
    reconcileStageFor(formFactor)
  }, [formFactor])
}

/** The hook's effect as a function: what the layout `formFactor` cannot draw is dropped. */
export function reconcileStageFor(formFactor: FormFactor): void {
  if (formFactor === 'desktop') {
    dismissStage()
    dismissSpacesDrawer()
  }
  if (formFactor !== 'tablet') dismissTabletDrawer()
}
