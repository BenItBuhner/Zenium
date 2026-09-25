import type { QuitHoldState, Tab } from '@shared/types'
import { ERROR_URL_PREFIX } from '@shared/url'
import { CRASH_ERROR_CODE } from '@shared/zenPages'

/**
 * Whether the tab's page can paint what the chrome posts to it – "Hold ⌘Q to quit" over a live
 * page is the page script's to draw (`shared/quitHoldPanel`; the view lies over the chrome and
 * hiding it would drop the key up the hold waits for) – which takes a renderer that is there
 * and answering. False while the renderer is gone or hung, when the chrome's twin takes the
 * page route's position instead (`ContentArea`'s `pageLive`; the design lead's C4 on #486): a
 * hold that quits without its notice is the one failure the notice exists to prevent.
 *
 * Gone: the crash mark is on the tab (`Tabs.onCrashed` sets `errorCode` to the crash code) while
 * the address is still the page's own – the crash page (`zen://error`, tabs-44) has not
 * committed yet; once it has, its own page script paints as any page's does, and the address
 * is the crash page's. Hung: the host's hang monitor said so – its own reading (`Tab.hung`),
 * which stands through the "Page unresponsive" prompt's Wait until the page answers again, or
 * the prompt's mark (`Tab.unresponsive`, tabs-45; the reading is set with it) – and a renderer
 * that answers nothing paints nothing.
 */
export function pageCanPaint(
  tab: Pick<Tab, 'url' | 'errorCode' | 'unresponsive' | 'hung'>
): boolean {
  if (tab.hung || tab.unresponsive) return false
  return tab.errorCode !== CRASH_ERROR_CODE || tab.url.startsWith(ERROR_URL_PREFIX)
}

/**
 * Whether the hold needs the frame for its notice: a hold runs in this window, over a page whose
 * renderer is hung. The chrome's twin is drawn where the page cannot paint, but on the desktop
 * the page's view composites above the chrome and a hung renderer keeps its last frame painted
 * there – over the twin – so for the hold's duration the view gives way to its picture, as it
 * does under the "Page unresponsive" prompt (`lib/quitHoldCover.ts`: the capture, then
 * `quitHoldCover` in the UI store → `overlayCoversContent` → the reporter's `contentHidden`), and
 * comes back at the hold's cancel or end. Only for a hung page: over a live one the view stays
 * (hiding it would drop the key up the hold waits for; a hung renderer's keys come through the
 * browser process either way, and the chrome takes the keyboard with the hide), and a crashed
 * one shows its crash page within the frame's next few frames.
 */
export function holdCoversPage(
  hold: QuitHoldState | null,
  tab: Pick<Tab, 'hung' | 'discarded'> | null
): boolean {
  return hold !== null && tab !== null && tab.hung === true && !tab.discarded
}
