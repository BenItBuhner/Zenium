import type { JSX } from 'react'
import { internalPageOf, parseInternalPageUrl } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { SettingsPage } from './settings/SettingsPage'

/**
 * The content area's stand-in for a page view: a chrome page tab (`shared/internalPages.ts`,
 * `render: 'chrome'`) has no WebView, so the chrome draws the page itself where the page would
 * be – an opaque `--v2-page` surface filling the content frame edge to edge at the frame's own
 * radius (v2 §10.1), nothing behind it. One component per registered chrome page id; a document
 * page renders nothing here, its view shows it. `data-surface="page"` puts the page family of
 * tokens (§9.29) on the root, for every chip, badge and icon button drawn inside.
 *
 * `hidden` keeps the page mounted but out of sight and out of reach (the phone's gesture stage
 * draws its own cards where the page was).
 */
export function InternalPageHost({
  state,
  tab,
  hidden = false
}: {
  state: UIState
  tab: Tab
  hidden?: boolean
}): JSX.Element | null {
  const ref = parseInternalPageUrl(tab.url)
  if (!ref || internalPageOf(tab.url)?.render !== 'chrome') return null
  switch (ref.id) {
    case 'settings':
      return (
        <div
          className={cn('zen-page-host absolute inset-0', hidden && 'invisible')}
          data-page={ref.id}
          data-surface="page"
          inert={hidden || undefined}
        >
          <SettingsPage state={state} tab={tab} />
        </div>
      )
    default:
      return null
  }
}
