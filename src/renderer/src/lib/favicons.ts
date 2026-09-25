import { useMemo } from 'react'
import { faviconSrc, openHosts, type FaviconIndex } from '@shared/favicons'
import type { Tab } from '@shared/types'
import { cmd, onEvent } from './api'
import { browserStore } from './browserStore'
import { createStore } from './store'

/**
 * The chrome's copy of the favicon cache's index (HB-47): which icon addresses the core has a
 * copy of, and under which content hash. Read once when the chrome starts (`favicons.index`)
 * and kept current from the core's `favicons.changed` deltas, so a history row, a bookmark or a
 * tab resolves its icon with one map lookup in state the chrome already holds – no hop to the
 * core per row, nothing per frame (§11).
 */
export const faviconStore = createStore<{ index: FaviconIndex }>({ index: new Map() }, 'favicons')

export function startFaviconSync(): void {
  const flags = globalThis as unknown as { __zenFaviconSyncStarted?: boolean }
  if (flags.__zenFaviconSyncStarted) return
  flags.__zenFaviconSyncStarted = true
  onEvent('favicons.changed', ({ added, removed }) => {
    faviconStore.set((prev) => {
      const index = new Map(prev.index)
      for (const url of removed) index.delete(url)
      for (const [url, hash] of added) index.set(url, hash)
      return { index }
    })
  })
  void cmd('favicons.index', undefined).then((entries) => {
    if (!Array.isArray(entries)) return
    // Deltas that arrived before the answer are newer than it: they win.
    faviconStore.set((prev) => {
      const index = new Map(entries)
      for (const [url, hash] of prev.index) index.set(url, hash)
      return { index }
    })
  })
}

const NO_TABS: Record<string, Tab> = {}
const hostsByTabs = new WeakMap<Record<string, Tab>, Set<string>>()

/** The hosts open in this window's tabs, computed once per state snapshot. */
function openHostsOf(tabs: Record<string, Tab>): Set<string> {
  let hosts = hostsByTabs.get(tabs)
  if (!hosts) {
    hosts = openHosts(Object.values(tabs))
    hostsByTabs.set(tabs, hosts)
  }
  return hosts
}

/**
 * The address an `<img>` shows for `favicon` (`shared/favicons.ts` `faviconSrc`), re-read as
 * the cache's index and the window's tabs change. `pageUrl` is the page the slot stands for
 * when it is a row for one – a history visit, a bookmark, an omnibox row – whose icon is drawn
 * live only while the page's site is open in a tab; left out for a slot that is no page's (a
 * tab's own row, a search engine's mark), where the live address stands as it always did.
 */
export function useFaviconSrc(
  favicon: string | null | undefined,
  pageUrl?: string | null
): string | null {
  const index = faviconStore.use((s) => s.index)
  const platform = browserStore.use((s) => s.state?.platform ?? null)
  const tabs = browserStore.use((s) => s.state?.tabs ?? NO_TABS)
  return useMemo(
    () =>
      faviconSrc(favicon, {
        index,
        platform,
        ...(pageUrl === undefined ? {} : { pageUrl, openHosts: openHostsOf(tabs) })
      }),
    [favicon, index, platform, tabs, pageUrl]
  )
}
