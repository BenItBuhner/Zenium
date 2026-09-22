import type { JSX } from 'react'
import type { UIState } from '@shared/types'
import { askDefaultBrowser, dismissDefaultBrowserBanner } from '@renderer/lib/defaultBrowser'

/**
 * "Make Zenium your default browser": a strip across the top of the content frame, under the
 * toolbar, shown while the OS names another browser (`state.defaultBrowser`, read by the core's
 * DefaultBrowserService). A window surface (v2 §9.29, `data-surface="window"`): the theme's ink
 * on the frame's solid (the strip paints no fill of its own – a band of the window fill under
 * "Not now" stacked the same fill on itself), its hairline at its bottom edge (§9.7), 40 tall
 * around its 32 px buttons (§9.21) with 16 px gutters, the sentence at 15/20 in the full ink, no
 * leading glyph (the row in Settings carries the status; a globe here repeated it). The buttons
 * are the shared v2 button, 8 apart, the primary last (§9.11): "Make default" raises the prompt
 * that says what the OS will do before the hand-off (`DefaultBrowserPrompt.tsx`); "Not now"
 * takes the strip down for this feature release (`dismissDefaultBrowserBanner`). Under an open
 * overlay the strip keeps its height but is not painted (`ContentArea`'s `data-under-overlay`).
 */
export function DefaultBrowserBanner({ state }: { state: UIState }): JSX.Element {
  return (
    <div role="status" className="zen-frame-strip" data-surface="window" data-default-browser>
      <span className="zen-frame-strip-text">Make Zenium your default browser</span>
      <button
        type="button"
        className="zen-v2-button"
        onClick={() => dismissDefaultBrowserBanner(state)}
      >
        Not now
      </button>
      <button
        type="button"
        className="zen-v2-button"
        data-primary
        onClick={() => askDefaultBrowser('banner')}
      >
        Make default
      </button>
    </div>
  )
}
