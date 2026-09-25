import type { Tab } from '@shared/types'
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
 * is the crash page's. Hung: the host's hang monitor said so (`Tab.unresponsive`, tabs-45), and
 * a renderer that answers nothing paints nothing.
 */
export function pageCanPaint(tab: Pick<Tab, 'url' | 'errorCode' | 'unresponsive'>): boolean {
  if (tab.unresponsive) return false
  return tab.errorCode !== CRASH_ERROR_CODE || tab.url.startsWith(ERROR_URL_PREFIX)
}
