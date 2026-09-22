import { useEffect, useMemo, useState } from 'react'
import type { UIState } from '@shared/types'
import { historyAdapter, type ClosedEntrySummary } from '@renderer/lib/historyAdapter'
import {
  hiddenDevicesStore,
  remoteTabsListed,
  remoteTabsSection,
  type RemoteTabMatch
} from '@renderer/lib/otherDevices'
import { tabMatchesQuery } from '@renderer/lib/overviewSearch'
import { remoteTabsStore, useRemoteTabs } from '@renderer/lib/remoteTabs'

/** What a query finds beyond the pane's cards. */
export interface SearchReach {
  /** This device's recently closed tabs whose title or address holds the query, newest first. */
  closed: ClosedEntrySummary[]
  /** The other devices' tabs that do, in the History group's order, each with its device. */
  remote: RemoteTabMatch[]
}

const NO_REACH: SearchReach = { closed: [], remote: [] }

/**
 * The tab search's reach (TAB-21; the #316 gate: Recently closed and the other devices' tabs
 * are History's groups, and the search reaches them – Chrome's tab search lists its recently
 * closed matches the same way): while a query stands on the Tabs pane, the recently closed tabs
 * (`session.recentlyClosed`, read as the search opens and again whenever the core says the list
 * changed) and the other devices' tabs the History page lists (`remoteTabsStore`, asked of the
 * core once per `remoteTabsVersion` while `active`, the hidden devices held back as there) are
 * looked through with the cards' own match (`tabMatchesQuery`). Nothing while `active` is off:
 * the Private pane's search reaches neither (a private tab is never filed, Chrome's Incognito
 * switcher has no Recent tabs), and the lists are not asked for until a query needs them. The
 * rows are `OverviewSearchReach`'s.
 */
export function useSearchReach(state: UIState, query: string, active: boolean): SearchReach {
  const [closedAll, setClosedAll] = useState<ClosedEntrySummary[]>([])
  useEffect(() => {
    if (!active) return
    let live = true
    const read = (): void => {
      void historyAdapter
        .recentlyClosed()
        .then((list) => {
          if (live) setClosedAll(list)
        })
        .catch(() => undefined)
    }
    read()
    const off = historyAdapter.onRecentlyClosedChanged(read)
    return () => {
      live = false
      off()
    }
  }, [active])
  useRemoteTabs(state.sync, active)
  const lists = remoteTabsStore.use((s) => s.devices)
  const hidden = hiddenDevicesStore.use((s) => s.hidden)
  const { enabled, scope } = state.sync
  const openTabs = scope.openTabs
  return useMemo(() => {
    if (!active || !query) return NO_REACH
    const closed = closedAll.filter(
      (entry) =>
        entry.kind === 'tab' && tabMatchesQuery({ title: entry.title, url: entry.url ?? '' }, query)
    )
    const listed = remoteTabsListed(
      remoteTabsSection({ enabled, scope: { openTabs } }, lists, hidden)
    )
    const remote = listed.filter(({ tab }) => tabMatchesQuery(tab, query))
    return { closed, remote }
  }, [active, query, closedAll, lists, hidden, enabled, openTabs])
}
