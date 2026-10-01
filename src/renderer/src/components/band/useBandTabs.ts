import { useEffect, useRef } from 'react'
import type { Tab, UIState } from '@shared/types'
import { dismissTabBands } from '@renderer/lib/band'

/**
 * A tab's document, as the band tells one from the next: the generation the core counts up at
 * every committed navigation of a new document, as the host reports it (`Tab.documentGeneration`,
 * `TabViewEvents.onNavigated` with `inPage` false) – never the URL, which a `pushState` or a
 * fragment moves while the document stays. 0 for a tab that committed no document yet.
 */
export function bandDocumentOf(tab: Pick<Tab, 'documentGeneration'>): number {
  return tab.documentGeneration ?? 0
}

/**
 * The tabs' word to the band model (motion spec §3.2's dismissals): a tab that closes takes its
 * bands with it, and a tab whose document changes dismisses them on `navigation`. Only a new
 * document counts (the Design Lead's ruling on #740): a same-document navigation – a `pushState`
 * to another path, a `replaceState`, a hash change – moves the address and dismisses nothing;
 * the committed navigation of a new document – a load, a reload, a link, back to another page –
 * does, whatever the address. Host-free: both hosts pass the state they render, and the core
 * stamps the generation for both from the host's own commit report.
 */
export function useBandTabs(state: UIState): void {
  const seen = useRef<Map<string, number> | null>(null)
  useEffect(() => {
    const before = seen.current
    const now = new Map<string, number>()
    for (const tab of Object.values(state.tabs)) now.set(tab.id, bandDocumentOf(tab))
    seen.current = now
    if (!before) return
    for (const [id, doc] of before) {
      const next = now.get(id)
      if (next === undefined) dismissTabBands(id, 'program')
      else if (next !== doc) dismissTabBands(id, 'navigation')
    }
  }, [state.tabs])
}
