import type { ArchivedTabSummary } from '@shared/types'
import { cmd, onEvent } from './api'
import type { Invoke, Subscribe } from './historyAdapter'

/**
 * The seam between the switcher's Inactive tabs surface and the core's archive (TAB-20,
 * `InactiveTabsService`): the list of archived tabs, most recently used first; restore one (it
 * comes back at the start of its space and to the front, as Chrome's does), or every one;
 * close one (it goes to the recently closed list) or all; and the `inactiveTabs.changed` event
 * that says when to read the list again – a pass archived more, a restore or a close happened
 * elsewhere, the sweep took some.
 */

export type { ArchivedTabSummary }

export interface InactiveTabsAdapter {
  /** Every archived tab, most recently used first. */
  list(): Promise<ArchivedTabSummary[]>
  /** Bring one back into its space, in front, and show it. */
  restore(id: string): Promise<void>
  /** Bring every one back, behind the tab in view. */
  restoreAll(): Promise<void>
  /** Close one: it joins the recently closed list. */
  close(id: string): Promise<void>
  /** Close every one. */
  closeAll(): Promise<void>
  /** The archive changed: the list should be read again. */
  onChanged(listener: () => void): () => void
}

/** An adapter over `invoke` and `on`; the app uses {@link inactiveTabsAdapter}, tests build their own. */
export function createInactiveTabsAdapter(invoke: Invoke, on: Subscribe): InactiveTabsAdapter {
  return {
    list: () => invoke('inactiveTabs.list', undefined),
    restore: (id) => invoke('inactiveTabs.restore', { id }),
    restoreAll: () => invoke('inactiveTabs.restoreAll', undefined),
    close: (id) => invoke('inactiveTabs.close', { id }),
    closeAll: () => invoke('inactiveTabs.closeAll', undefined),
    onChanged: (listener) => on('inactiveTabs.changed', () => listener())
  }
}

/** The app's adapter, over the chrome's bridge to the core. */
export const inactiveTabsAdapter: InactiveTabsAdapter = createInactiveTabsAdapter(cmd, onEvent)
