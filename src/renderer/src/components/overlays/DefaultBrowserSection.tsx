import type { JSX } from 'react'
import { Check, Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { requestDefaultBrowser } from '@renderer/lib/defaultBrowser'

/**
 * Settings → Default Browser: which browser the OS hands web links to, and the request to make
 * it Zenium. Built on the v2 draft: a flat card with a title block (§9.23) over one row that
 * grows around its control (§9.21: 40 with the 32 px button, 52 with the Windows note under the
 * label, 32 once Zenium holds the role and only the glyph is left). The status follows
 * `state.defaultBrowser`, which the core's DefaultBrowserService refreshes at start, on window
 * focus and when the OS answers the request.
 */
export function DefaultBrowserSection({ state }: { state: UIState }): JSX.Element {
  const isDefault = state.defaultBrowser.isDefault
  const label =
    isDefault === true
      ? 'Zenium is your default browser'
      : isDefault === false
        ? 'Zenium is not your default browser'
        : 'Checking which browser opens your links'
  // Windows 10 and later let only the user pick, in Settings; say where the request leads.
  const note =
    state.platform === 'win32' && isDefault !== true
      ? 'Make default opens Windows Settings, where you press Set default.'
      : null
  const control = isDefault !== true
  return (
    <section className="zen-default-browser-card p-4" aria-labelledby="zen-default-browser-title">
      <h3 id="zen-default-browser-title" className="zen-default-browser-title">
        Default browser
      </h3>
      <div
        className="zen-default-browser-row"
        data-control={control || undefined}
        data-two-line={note ? true : undefined}
      >
        <div className="zen-default-browser-body">
          {isDefault === true ? (
            <Check
              className="zen-default-browser-glyph zen-default-browser-ok"
              strokeWidth={2}
              aria-hidden
            />
          ) : (
            <Globe
              className="zen-default-browser-glyph zen-default-browser-muted"
              strokeWidth={1.5}
              aria-hidden
            />
          )}
          <div className="min-w-0 flex-1">
            <div role="status">{label}</div>
            {note && <div className="zen-default-browser-description">{note}</div>}
          </div>
        </div>
        {control && (
          <button
            type="button"
            className="zen-v2-button shrink-0"
            data-primary
            onClick={() => void requestDefaultBrowser('settings')}
          >
            Make default
          </button>
        )}
      </div>
    </section>
  )
}
