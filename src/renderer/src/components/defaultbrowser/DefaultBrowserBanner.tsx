import type { JSX } from 'react'
import { useState } from 'react'
import { X } from 'lucide-react'
import { cmd, run } from '@renderer/lib/api'

/**
 * The lighter reminder (DEF-02): a v2 panel above the page in the sessions between promo
 * sheets, with the one action and a close. It is a sibling of the content frame, so the page
 * simply gets a little shorter while it is up; the core decides when it is due and takes it
 * down the moment Zenium holds the browser role.
 *
 * Minimal on purpose: #72's `showBanner` is the top-message surface (swipe-away, stacking, the
 * host clipping); once it lands this becomes one `showBanner({...})` call keyed
 * `default-browser` and this panel goes.
 */
export function DefaultBrowserBanner(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const request = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await cmd('defaultBrowser.request', { source: 'banner' })
    } catch {
      // The host could not open the role dialog; the Settings row offers it again.
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="status" className="zen-banner zen-animate-in">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-[20px]">Open links in Zenium</p>
        <p className="truncate text-[13px] leading-[20px] text-[var(--v2-text-deemphasized)]">
          Make it your default browser
        </p>
      </div>
      <button
        type="button"
        className="zen-v2-button shrink-0"
        data-primary
        disabled={busy}
        onClick={() => void request()}
      >
        Set as default
      </button>
      <button
        type="button"
        className="zen-toolbar-button shrink-0"
        aria-label="Not now"
        onClick={() => run('defaultBrowser.dismiss', { prompt: 'banner' })}
      >
        <X className="h-5 w-5" strokeWidth={1.75} />
      </button>
    </div>
  )
}
