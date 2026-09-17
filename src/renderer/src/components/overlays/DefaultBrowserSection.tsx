import type { JSX } from 'react'
import { Check, Globe } from 'lucide-react'
import type { UIState } from '@shared/types'
import { requestDefaultBrowser } from '@renderer/lib/defaultBrowser'

/**
 * Settings → Default Browser: which browser the OS hands web links to, and the request to make
 * it Zenium. Built on the v2 draft (flat card, the shared v2 button); the status follows
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
      ? 'Make default opens Windows Settings. Pick Zenium under Apps > Default apps and choose Set default.'
      : null
  return (
    <section className="zen-default-browser-card p-4" aria-labelledby="zen-default-browser-title">
      <h3
        id="zen-default-browser-title"
        className="flex items-center gap-2 text-[17px] font-semibold leading-6"
      >
        <Globe className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Default browser
      </h3>
      <div className="mt-3 flex items-start gap-3">
        {isDefault === true ? (
          <Check
            className="zen-default-browser-ok mt-0.5 h-4 w-4 shrink-0"
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <Globe
            className="zen-default-browser-muted mt-0.5 h-4 w-4 shrink-0"
            strokeWidth={1.5}
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-5" role="status">
            {label}
          </div>
          {note && (
            <div className="zen-default-browser-muted mt-0.5 text-[13px] leading-[18px]">
              {note}
            </div>
          )}
        </div>
        {isDefault !== true && (
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
