import { useEffect, useState } from 'react'
import type { UIState } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, holdFloatingChrome } from '@renderer/lib/ui'

/**
 * For a popover that may overhang the content frame: while the component is mounted the page's
 * view is hidden behind its capture (`holdFloatingChrome`). Returns true once the capture is in
 * place, so the popover can hold its first paint until the view would no longer cover it.
 *
 * `pageHadFocus` (default true) is whether the page had keyboard focus when the popover opened –
 * false for one opened from a focused chrome control (`openedFromKeyboard`) – and decides whether
 * the page gets focus back on release (§9.22). Callers pass a value fixed at mount.
 */
export function useFloatingChrome({
  pageHadFocus = true
}: { pageHadFocus?: boolean } = {}): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const state: UIState | null = browserStore.get().state
    const hold = holdFloatingChrome(state ? (activeTab(state)?.id ?? null) : null, {
      pageHadFocus
    })
    void hold.ready.then((held) => {
      if (held) setReady(true)
    })
    return hold.release
  }, [pageHadFocus])
  return ready
}
