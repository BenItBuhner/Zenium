import { useEffect, useRef } from 'react'
import type { UIState } from '@shared/types'
import { dismissTabBands } from '@renderer/lib/band'

/** A tab's document, as the band tells one from the next: its URL less the fragment. */
export function bandDocumentOf(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

/**
 * The tabs' word to the band model (motion spec §3.2's dismissals): a tab that closes takes its
 * bands with it, and a tab whose document changes – a navigation, not a fragment's move –
 * dismisses them on `navigation`. Host-free: both hosts pass the state they render; a tab is
 * read by its URL less the fragment, so a `pushState` to another path reads as a new document
 * (the chrome has no finer word on the commit than its URL).
 */
export function useBandTabs(state: UIState): void {
  const seen = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const before = seen.current
    const now = new Map<string, string>()
    for (const tab of Object.values(state.tabs)) now.set(tab.id, bandDocumentOf(tab.url))
    seen.current = now
    if (!before) return
    for (const [id, doc] of before) {
      const next = now.get(id)
      if (next === undefined) dismissTabBands(id, 'program')
      else if (next !== doc) dismissTabBands(id, 'navigation')
    }
  }, [state.tabs])
}
