import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { dismissDefaultBrowserBanner, requestDefaultBrowser } from '@renderer/lib/defaultBrowser'

/**
 * "Make Zenium your default browser": one row on a flat card at the top of the content frame,
 * shown while the OS names another browser (`state.defaultBrowser`, read by the core's
 * DefaultBrowserService). Either answer takes it down for this feature release; "Make default"
 * runs the OS request (the Settings section shows how it went). The v2 button is the shared
 * 32 px control, so the card is 40 tall.
 */
export function DefaultBrowserBanner({ state }: { state: UIState }): JSX.Element {
  const makeDefault = (): void => {
    void requestDefaultBrowser('banner')
    dismissDefaultBrowserBanner(state)
  }
  return (
    <div className="shrink-0 px-1.5 pt-1.5">
      <div
        role="status"
        className="zen-default-browser-card flex h-10 items-center gap-3 pl-3 pr-1 text-[13px]"
      >
        <Globe className="zen-default-browser-muted h-4 w-4 shrink-0" strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate">Make Zenium your default browser</span>
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
  )
}
