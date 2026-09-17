import type { JSX } from 'react'
import { run } from '@renderer/lib/api'
import { requestDefaultBrowser } from '@renderer/lib/defaultBrowser'

/**
 * "Make Zenium your default browser": a 32px strip at the top of the content frame, on a
 * neutral card surface. Either answer takes it down; "Not now" keeps it away until the next
 * feature release, "Make default" runs the OS request (the Settings row shows how it went).
 */
export function DefaultBrowserBanner(): JSX.Element {
  const makeDefault = (): void => {
    void requestDefaultBrowser()
    run('defaultBrowser.dismissPrompt', undefined)
  }
  return (
    <div
      role="status"
      className="zen-default-browser-strip flex h-8 shrink-0 items-center gap-2 px-3 text-[13px]"
    >
      <span className="min-w-0 flex-1 truncate">Make Zenium your default browser</span>
      <button
        type="button"
        className="zen-protocol-btn zen-protocol-btn-primary"
        onClick={makeDefault}
      >
        Make default
      </button>
      <button
        type="button"
        className="zen-protocol-btn zen-protocol-btn-secondary"
        onClick={() => run('defaultBrowser.dismissPrompt', undefined)}
      >
        Not now
      </button>
    </div>
  )
}
