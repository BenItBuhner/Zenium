import type { JSX } from 'react'
import { internalPageOf, parseInternalPageUrl } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { cn } from '@renderer/lib/utils'
import { BookmarkManager } from '../bookmarks/BookmarkManager'
import { DownloadsPanel } from '../overlays/DownloadsPanel'
import { HistoryPage } from './history/HistoryPage'
import { SettingsPage } from './settings/SettingsPage'

/**
 * The content area's stand-in for a page view: a chrome page tab (`shared/internalPages.ts`,
 * `render: 'chrome'`) has no WebView, so the chrome draws the page itself where the page would
 * be – an opaque `--v2-page` surface filling the content frame edge to edge at the frame's own
 * radius (v2 §10.1), nothing behind it. One component per registered chrome page id – Settings,
 * History, the bookmarks manager, Downloads – each reading its section and query from
 * `tab.url`; a document page renders nothing here, its view shows it. `data-surface="page"`
 * puts the page family of tokens (§9.29) on the root, for every chip, badge and icon button
 * drawn inside.
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
  const page = pageFor(ref.id, state, tab)
  if (!page) return null
  return (
    <div
      className={cn('zen-page-host absolute inset-0', hidden && 'invisible')}
      data-page={ref.id}
      data-surface="page"
      inert={hidden || undefined}
    >
      {page}
    </div>
  )
}

function pageFor(id: string, state: UIState, tab: Tab): JSX.Element | null {
  switch (id) {
    case 'settings':
      return <SettingsPage state={state} tab={tab} />
    case 'history':
      return <HistoryPage tab={tab} />
    case 'bookmarks':
      return <BookmarkManager state={state} />
    case 'downloads':
      return <DownloadsPanel state={state} />
    default:
      return null
  }
}
