import { useEffect, useRef } from 'react'
import { WifiOff } from 'lucide-react'
import { dismissBanner, pushToast, showBanner } from '@renderer/lib/ui'

/** The banner's words while the device is offline, and the toast's when it is back (ERR-07). */
export const OFFLINE_BANNER_TITLE = 'No internet connection'
export const BACK_ONLINE_TOAST = 'Back online'

/**
 * The device's connectivity on the phone's message cards (ERR-07, v2 §9.33): while the core's
 * settled word is offline (`UIState.network.online`, debounced by `core/connectivity.ts` so a
 * network switch never flashes it) a banner stands at the frame's top in the banner stack –
 * keyed, so it never doubles, with no clock and no action: the device coming back is what takes
 * it down – and the moment the word turns back a "Back online" toast runs the §9.33 toast clock.
 * Both cards are `role="status"` live regions, so TalkBack hears each change once. A chrome
 * that starts offline shows the banner at once; the toast alone needs a loss to have gone before.
 */
export function useConnectivityMessages(online: boolean): void {
  const wasOffline = useRef(false)
  useEffect(() => {
    if (!online) {
      wasOffline.current = true
      const id = showBanner({
        title: OFFLINE_BANNER_TITLE,
        icon: WifiOff,
        key: 'offline',
        duration: null
      })
      return () => dismissBanner(id)
    }
    if (wasOffline.current) {
      wasOffline.current = false
      pushToast(BACK_ONLINE_TOAST)
    }
    return undefined
  }, [online])
}
