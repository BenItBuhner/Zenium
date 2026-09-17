import type { JSX } from 'react'
import { Globe } from 'lucide-react'
import { run } from '@renderer/lib/api'
import { requestDefaultBrowser } from '@renderer/lib/defaultBrowser'
import { Button } from '../ui/button'

/**
 * "Make Zenium your default browser": a 36px strip at the top of the content frame, on the
 * panel tint. Either answer takes it down; "Not now" keeps it away until the next feature
 * release, "Make default" runs the OS request (the Settings row shows how it went).
 */
export function DefaultBrowserBanner(): JSX.Element {
  const makeDefault = (): void => {
    void requestDefaultBrowser()
    run('defaultBrowser.dismissPrompt', undefined)
  }
  return (
    <div
      role="status"
      className="flex h-9 shrink-0 items-center gap-3 bg-[var(--zen-panel-bg)] pl-4 pr-2 text-[13px]"
    >
      <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--zen-muted)]" />
      <span className="min-w-0 flex-1 truncate">Make Zenium your default browser</span>
      <Button size="sm" className="rounded-full px-3.5" onClick={makeDefault}>
        Make default
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="rounded-full px-3.5"
        onClick={() => run('defaultBrowser.dismissPrompt', undefined)}
      >
        Not now
      </Button>
    </div>
  )
}
