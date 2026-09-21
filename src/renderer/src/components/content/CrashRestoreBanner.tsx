import type { JSX } from 'react'
import type { CrashRestoreOffer } from '@shared/types'
import { run } from '@renderer/lib/api'

/**
 * "Restore pages?" after a run that did not shut down cleanly (Chrome's bubble): the band the
 * default-browser strip draws (`DefaultBrowserBanner.tsx`, `.zen-frame-strip`) – a window surface
 * (v2 §9.29) flush with the content frame under the toolbar, 40 tall around its 32 px buttons
 * (§9.21) with 16 px gutters, the sentence at 15/20 in the full ink, no leading glyph (the words
 * carry the state), §9.7's hairline at its bottom edge. The buttons are the shared v2 button, 8
 * apart, the primary last (§9.11): Dismiss starts on a fresh tab and leaves the rest unloaded,
 * Restore loads the pages that were showing. The band states its own control + 8 height in its
 * rule, so nothing here sets `data-control` by hand (§9.34: only a row wrapper rendering a
 * control does). The last session's tabs are back in the sidebar with no page loaded meanwhile.
 * Under an open overlay the band keeps its height but is not painted (`ContentArea`'s
 * `data-under-overlay`); whether it is offered at all is the ask / always / never setting.
 */
export function CrashRestoreBanner({ offer }: { offer: CrashRestoreOffer }): JSX.Element {
  const pages = offer.tabCount === 1 ? '1 page' : `${offer.tabCount} pages`
  const where = offer.windowCount > 1 ? ` in ${offer.windowCount} windows` : ''
  return (
    <div role="status" className="zen-frame-strip" data-surface="window" data-crash-restore>
      <span className="zen-frame-strip-text">
        Zenium did not shut down correctly. Restore {pages}
        {where}?
      </span>
      <button
        type="button"
        className="zen-v2-button"
        onClick={() => run('session.crashRestore', { restore: false })}
      >
        Dismiss
      </button>
      <button
        type="button"
        className="zen-v2-button"
        data-primary
        onClick={() => run('session.crashRestore', { restore: true })}
      >
        Restore
      </button>
    </div>
  )
}
