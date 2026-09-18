import type { JSX } from 'react'
import { parseInternalPageUrl } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { SettingsPage } from './settings/SettingsPage'

/**
 * The content area's stand-in for a page view: an internal page tab (`shared/internalPages.ts`)
 * has no WebView, so the chrome draws the page itself where the page would be – an opaque
 * `--v2-page` surface filling the content frame edge to edge at the frame's own radius (v2
 * §10.1), nothing behind it. One component per registered page id.
 */
export function InternalPageHost({ state, tab }: { state: UIState; tab: Tab }): JSX.Element | null {
  const ref = parseInternalPageUrl(tab.url)
  if (!ref) return null
  switch (ref.id) {
    case 'settings':
      return (
        <div className="zen-page-host absolute inset-0" data-page={ref.id}>
          <SettingsPage state={state} tab={tab} />
        </div>
      )
  }
}
