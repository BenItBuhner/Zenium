import type { JSX } from 'react'
import { History } from 'lucide-react'
import type { CrashRestoreOffer } from '@shared/types'
import { run } from '@renderer/lib/api'

/**
 * "Restore pages?" after a run that did not shut down cleanly (Chrome's bubble): one row on a
 * flat card at the top of the content frame, on the same v2 strip as the default-browser one.
 * The last session's tabs are back in the sidebar with no page loaded; Restore loads the ones
 * that were showing, Dismiss starts on a fresh tab and leaves the rest unloaded.
 */
export function CrashRestoreBanner({ offer }: { offer: CrashRestoreOffer }): JSX.Element {
  const pages = offer.tabCount === 1 ? '1 page' : `${offer.tabCount} pages`
  const where = offer.windowCount > 1 ? ` in ${offer.windowCount} windows` : ''
  return (
    <div className="shrink-0 px-1.5 pt-1.5">
      <div role="status" className="zen-default-browser-card" data-crash-restore>
        <div className="zen-default-browser-row" data-control data-strip>
          <div className="zen-default-browser-body">
            <History
              className="zen-default-browser-glyph zen-default-browser-muted"
              strokeWidth={1.5}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              Zenium did not shut down correctly. Restore {pages}
              {where}?
            </span>
          </div>
          <button
            type="button"
            className="zen-v2-button"
            data-primary
            onClick={() => run('session.crashRestore', { restore: true })}
          >
            Restore
          </button>
          <button
            type="button"
            className="zen-v2-button"
            onClick={() => run('session.crashRestore', { restore: false })}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
