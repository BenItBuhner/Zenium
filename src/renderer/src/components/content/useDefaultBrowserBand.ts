import { useEffect } from 'react'
import { Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { dismissBandByKey, showBand, type BandDismissReason } from '@renderer/lib/band'
import {
  askDefaultBrowser,
  DEFAULT_BROWSER_PROMPT_TITLE,
  dismissDefaultBrowserBanner,
  wantsDefaultBrowserBanner
} from '@renderer/lib/defaultBrowser'

export const DEFAULT_BROWSER_BAND_KEY = 'default-browser'

/** The refusals: the ×, a swipe up, Escape – each remembers the answer for this feature release. */
const REFUSALS: ReadonlySet<BandDismissReason> = new Set(['close', 'swipe', 'escape'])

/**
 * "Make Zenium your default browser" as the page-edge band's first desktop tenant (motion spec
 * §3.4, §4): a STATE about the window – it stands while the OS names another browser and the
 * user has not answered for this release (`wantsDefaultBrowserBanner`, the strip's own rule) –
 * on every page tab, with the Settings section's globe for its glyph (no alarm: the glyph keeps
 * the deemphasised ink). Its action is "Set as default", the one name for the act (§9.29): it
 * raises the prompt that says what the OS will do before the hand-off (`askDefaultBrowser`,
 * `DefaultBrowserPrompt.tsx`), and the band HOLDS through it – the prompt's own "Set as default"
 * ends the state through the settings, its Not now or Escape leaves the band standing, as the
 * strip stood. The × is the strip's "Not now", by that name: it, a swipe up or Escape remembers
 * the refusal for this feature release (`dismissDefaultBrowserBanner`). The band's going for
 * any other reason – the window closing, a replacement – remembers nothing.
 *
 * The strip across the frame's top (`content/DefaultBrowserBanner.tsx`) retired to this band;
 * the prompt's flow and the Settings row are as they were.
 */
export function useDefaultBrowserBand(state: UIState): void {
  const wants = wantsDefaultBrowserBanner(state)
  // What the dismissal writes is the version it was answered in: read at the moment, not the
  // version the effect saw.
  const version = state.version
  useEffect(() => {
    if (!wants) return
    showBand({
      key: DEFAULT_BROWSER_BAND_KEY,
      form: 'state',
      icon: Globe,
      title: DEFAULT_BROWSER_PROMPT_TITLE,
      action: { label: 'Set as default', holds: true, onPick: () => askDefaultBrowser('banner') },
      closeLabel: 'Not now',
      onDismiss: (reason) => {
        if (REFUSALS.has(reason)) dismissDefaultBrowserBanner({ version })
      }
    })
    return () => dismissBandByKey(DEFAULT_BROWSER_BAND_KEY)
  }, [wants, version])
}
