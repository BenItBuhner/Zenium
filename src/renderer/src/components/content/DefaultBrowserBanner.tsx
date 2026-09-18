import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { dismissDefaultBrowserBanner, requestDefaultBrowser } from '@renderer/lib/defaultBrowser'

/**
 * "Make Zenium your default browser": one row on a flat card at the top of the content frame,
 * shown while the OS names another browser (`state.defaultBrowser`, read by the core's
 * DefaultBrowserService). Either answer takes it down for this feature release; "Make default"
 * runs the OS request (the Settings section shows how it went). The row grows around its 32 px
 * buttons to 40 (§9.21), the glyph sits on the text line (§9.2), the buttons are 8 px apart.
 */
export function DefaultBrowserBanner({ state }: { state: UIState }): JSX.Element {
  const makeDefault = (): void => {
    void requestDefaultBrowser('banner')
    dismissDefaultBrowserBanner(state)
  }
  return (
    <div className="shrink-0 px-1.5 pt-1.5">
      <div role="status" className="zen-default-browser-card">
        <div className="zen-default-browser-row" data-control data-strip>
          <div className="zen-default-browser-body">
            <Globe
              className="zen-default-browser-glyph zen-default-browser-muted"
              strokeWidth={1.5}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">Make Zenium your default browser</span>
          </div>
          <button type="button" className="zen-v2-button" data-primary onClick={makeDefault}>
            Make default
          </button>
          <button
            type="button"
            className="zen-v2-button"
            onClick={() => dismissDefaultBrowserBanner(state)}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
