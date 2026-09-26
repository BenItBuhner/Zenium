import type { HostCapabilities, MenuItemDescriptor, SharePanelRequest } from '@shared/types'

/**
 * The menu-to-panel seam (v2 draft §9.38, its last sentence): below Android 14 the app menu's
 * Share row does not leave first and let the panel rise over a bare page; the menu holds its
 * sheet while the host gathers the panel's row (`Share.openPanel`, off the main thread), and
 * when the request arrives the menu's chassis becomes the panel's – one §9.16 chassis, the
 * content crossfading while the sheet re-detents to the panel's height (`MenuSheet.tsx`). The
 * seam's states, as data, so the sheet and `lib/ui.ts` agree on them:
 *
 * - `gathering`: the Share row was picked; the menu stands, its rows inert, for the request.
 * - `hosting`: the request arrived and the menu's sheet draws the panel under the request's id.
 *
 * Every other moment is `null`. The steps are pure (`shareSeamStep`); `lib/ui.ts` runs them.
 */

/** The phone app menu's Share row, by the name it keeps across openings (`menus.ts`, `keyed('row.share', …)`). */
export const SHARE_ROW_KEY = 'row.share'

/**
 * How long the menu stands for a request that does not come – a share the host refused, a host
 * whose panel did not open – before it leaves on its own, as a pick would have had it (the
 * emulator's gather runs 0.3–1.5 s; a real device's is shorter).
 */
export const SHARE_SEAM_GUARD_MS = 4000

/** The outgoing content's fade (§11's leave, 120 ms); the incoming rises over 250 ms (`main.css`). */
export const SHARE_SEAM_OUT_MS = 120

/**
 * How long the gather runs before the tapped Share row says so – §9.30's busy form: the row at
 * full opacity, the 16 spinner in its trailing slot, `aria-busy` – so a menu standing for up to
 * a second is seen to be working, not stuck (a second tap would do nothing). A fast device's
 * gather is over before it and shows nothing; the other rows stay as they are, inert and never
 * dimmed (.4 would say disabled); the guard above stands.
 */
export const SHARE_SEAM_BUSY_MS = 150

export type ShareSeam =
  | { phase: 'gathering'; menuId: string; itemId: string }
  | { phase: 'hosting'; menuId: string; panelId: string }

export type ShareSeamEvent =
  /** The host's `share.panel` request arrived; `menuId` is the menu up at that moment, if any. */
  | { type: 'panel'; request: SharePanelRequest; menuId: string | null }
  /** The guard ran out for the menu named. */
  | { type: 'guard'; menuId: string }
  /** The hosted panel was answered (an app, More, a chip, the dismissal). */
  | { type: 'answered'; panelId: string }

export type ShareSeamEffect =
  /** The menu's sheet takes the request: draw the panel in the menu's chassis. */
  | 'host'
  /** The request is not the menu's: the panel rises on its own (the menu, if it was gathering, leaves). */
  | 'standalone'
  /** The menu waited for nothing: let it leave as a pick would have. */
  | 'dismissMenu'
  /** The hosted panel is done: the menu's sheet goes with it. */
  | 'closeMenu'
  | 'none'

export interface ShareSeamStep {
  seam: ShareSeam | null
  effect: ShareSeamEffect
}

/**
 * Whether a menu row hands its sheet over to the share panel instead of leaving before its
 * action runs: the app menu's Share row, on a host whose panel stands in for the system sheet
 * (`capabilities.sharePanel`; Android below 14). Everywhere else the row is picked as any other –
 * on Android 14 the system sheet comes up over the page, and the menu leaves first as it does
 * for every pick.
 */
export function handsOverToSharePanel(
  item: MenuItemDescriptor,
  capabilities: Pick<HostCapabilities, 'sharePanel'> | null | undefined
): boolean {
  return item.key === SHARE_ROW_KEY && !item.submenu && capabilities?.sharePanel === true
}

/** One step of the seam: the state after `event`, and what `lib/ui.ts` does about it. */
export function shareSeamStep(seam: ShareSeam | null, event: ShareSeamEvent): ShareSeamStep {
  switch (event.type) {
    case 'panel': {
      // The menu's own share, arriving while the menu it came from still stands: the hand-off.
      if (
        seam?.phase === 'gathering' &&
        seam.menuId === event.menuId &&
        event.request.source === 'menu'
      ) {
        return {
          seam: { phase: 'hosting', menuId: seam.menuId, panelId: event.request.id },
          effect: 'host'
        }
      }
      // A page's share, or a request the menu did not ask for (a newer share superseded the
      // menu's at the host): the panel rises on its own, and a menu still gathering is let go.
      return { seam: null, effect: 'standalone' }
    }
    case 'guard':
      if (seam?.phase === 'gathering' && seam.menuId === event.menuId) {
        return { seam: null, effect: 'dismissMenu' }
      }
      return { seam, effect: 'none' }
    case 'answered':
      if (seam?.phase === 'hosting' && seam.panelId === event.panelId) {
        return { seam: null, effect: 'closeMenu' }
      }
      return { seam, effect: 'none' }
  }
}
