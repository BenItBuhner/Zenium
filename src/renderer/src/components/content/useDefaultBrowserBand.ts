import { useEffect, useRef } from 'react'
import { Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { dismissBandByKey, showBand } from '@renderer/lib/band'
import {
  DEFAULT_BROWSER_PROMPT_TITLE,
  DEFAULT_BROWSER_WINDOWS_TITLE,
  dismissDefaultBrowserBanner,
  requestDefaultBrowser,
  wantsDefaultBrowserBanner
} from '@renderer/lib/defaultBrowser'

export const DEFAULT_BROWSER_BAND_KEY = 'default-browser'

/**
 * "Make Zenium your default browser" as the page-edge band's first desktop tenant (motion spec
 * §3.4, §4): a STATE about the window – it stands while the OS names another browser and the
 * user has not refused for this release (`wantsDefaultBrowserBanner`, the strip's own rule) –
 * on every page tab, with the Settings section's globe for its glyph (no alarm: the glyph keeps
 * the deemphasised ink). Its action is "Set as default", the one name for the act (§9.29), and
 * it asks the OS directly (`requestDefaultBrowser`, the Settings row's path; the dialog the
 * desktop showed before the hand-off is dropped, the Design Lead's ruling on item 8): the band
 * HOLDS through the request, which ends the state through the role – the core reads it again
 * once the OS has answered and on every return to the foreground – not through the band's own
 * dismissal. On Windows the hand-off opens Windows Settings, where only the user can finish, so
 * the band re-words itself in place – "Press Set default in Windows Settings", the same key, the
 * band's content cross-fading – and stands as that instruction, × only, until the role is
 * confirmed or the ×; a hand-off that failed on the spot (nothing opened, the request's toast
 * says so) takes the ask's words back.
 *
 * The × is "Dismiss", as on every band, and the × ALONE remembers the refusal for this feature
 * release (`dismissDefaultBrowserBanner`; the Lead's ruling, §3.2 / §9.6, one rule for both
 * hosts): a swipe up, Escape, the clock, a navigation or the tab leaving the front put the band
 * away for now and remember nothing – it may stand again at the next eligible moment – and the
 * band's going for any other reason (the window closing, a replacement) remembers nothing either.
 *
 * The strip across the frame's top (`content/DefaultBrowserBanner.tsx`) retired to this band in
 * W8-M2; the Settings row is as it was.
 */
export function useDefaultBrowserBand(state: UIState): void {
  const wants = wantsDefaultBrowserBanner(state)
  // What the dismissal writes is the version it was answered in: read at the moment, not the
  // version the effect saw.
  const version = state.version
  const windows = state.platform === 'win32'
  // Windows Settings is open on the hand-off: the band stands as the instruction. Kept across
  // the effect's re-runs and forgotten with the band (the role confirmed, the ×, a put-away).
  const handedOff = useRef(false)
  useEffect(() => {
    if (!wants) {
      handedOff.current = false
      return
    }
    // The band stands under this effect – until it went for anything but its own re-wording.
    let standing = true
    function stand(): void {
      const instruction = windows && handedOff.current
      showBand({
        key: DEFAULT_BROWSER_BAND_KEY,
        form: 'state',
        icon: Globe,
        title: instruction ? DEFAULT_BROWSER_WINDOWS_TITLE : DEFAULT_BROWSER_PROMPT_TITLE,
        action: instruction ? undefined : { label: 'Set as default', holds: true, onPick: pick },
        onDismiss: (reason) => {
          if (reason === 'replaced') return
          // Gone for now or for good: whatever the request out still answers changes nothing,
          // and the band asks afresh, in the ask's words, at its next eligible moment.
          standing = false
          handedOff.current = false
          if (reason === 'close') dismissDefaultBrowserBanner({ version })
        }
      })
    }
    function pick(): void {
      if (windows) {
        handedOff.current = true
        stand()
      }
      void requestDefaultBrowser('banner').then((role) => {
        // Refused on the spot: Windows Settings never opened, so the instruction is wrong.
        if (role === false && standing && handedOff.current) {
          handedOff.current = false
          stand()
        }
      })
    }
    stand()
    return () => dismissBandByKey(DEFAULT_BROWSER_BAND_KEY)
  }, [wants, version, windows])
}
