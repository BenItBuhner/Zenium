import type { Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { run } from './api'
import { activeTab } from './selectors'
import { createStore } from './store'
import type { LocalMenuItem } from './ui'

/**
 * Private tabs on the phone (INC-01 … INC-08, TAB-02/03). The core models private browsing as a
 * container (`PRIVATE_CONTAINER_ID`); on a host without windows that container's tabs live in
 * the one window next to the regular ones, and the chrome keeps the two apart: the overview shows
 * them on a pane of their own, the pill's swipe stays on the track of the mode it started in, and
 * the window surfaces blend to the private theme while a private tab is the one in view.
 */

/**
 * The overview's panes: the space's tabs, its tab groups – open and saved, as rows (Chrome's
 * "Tab groups" pane, TAB-16) – and the private tabs (TAB-02).
 */
export type OverviewPane = 'tabs' | 'groups' | 'private'

interface PrivateTabsState {
  /**
   * The pane the user picked with the segment while the overview was up; null follows the tab in
   * view (a private tab opens the overview on its own pane, as Chrome's switcher does). Reset when
   * the overview goes, so the next one opens where the user is.
   */
  pane: OverviewPane | null
}

export const privateTabsStore = createStore<PrivateTabsState>({ pane: null }, 'private-tabs')

export function isPrivateTab(tab: Pick<Tab, 'containerId'>): boolean {
  return tab.containerId === PRIVATE_CONTAINER_ID
}

/** The tab in view is a private one. */
export function activeTabIsPrivate(state: UIState): boolean {
  const tab = activeTab(state)
  return tab !== null && isPrivateTab(tab)
}

/**
 * The host keeps private browsing in TABS (`capabilities.privateTabs`: Android, one window): a
 * space holds its private tabs among the regular ones, so every regular surface that lists a
 * space's tabs – the tablet sidebar, the overview's Tabs pane – sets the private ones aside.
 * The desktop keeps a private window instead, whose surfaces are private mode whole.
 */
export function privateInTabs(state: Partial<Pick<UIState, 'capabilities'>>): boolean {
  // A snapshot without capabilities (a partial state in a component test) is a desktop's.
  return state.capabilities?.privateTabs === true
}

/**
 * The sidebar's two POSES on a host that keeps private browsing in tabs (the tablet; W4-11):
 * REGULAR while a regular tab is in view – the space's regular tabs and never a private one, no
 * row, no count, no hint that one exists – and PRIVATE while a private tab is, the window on
 * the private theme (§9.29 / §11.6): the private session's tabs alone, across the spaces in the
 * Private pane's order, under the mask. The phone's chrome re-inks the same way as the tab in
 * view changes mode; on the tablet the sidebar changes what it lists with the ink, so a private
 * tab is never a row of the regular sidebar (Chrome's own-window rule, kept in one window). The
 * desktop's sidebar is regular always: its private tabs live in a private window, whose sidebar
 * lists them whole under its own header.
 */
export type SidebarPose = 'regular' | 'private'

export function sidebarPose(state: UIState): SidebarPose {
  return privateInTabs(state) && activeTabIsPrivate(state) ? 'private' : 'regular'
}

/**
 * The private tabs of the window, in the order of the private pane: the private session is one
 * across the spaces (a private tab opens in the space it was asked for in), so the pane walks
 * the spaces in their order and each space's tabs in theirs.
 */
export function privateTabsOf(state: UIState): Tab[] {
  const listed = new Set<string>()
  const order: Tab[] = []
  for (const space of state.spaces)
    for (const id of space.tabIds) {
      const tab = state.tabs[id]
      if (tab && isPrivateTab(tab) && !listed.has(id)) {
        listed.add(id)
        order.push(tab)
      }
    }
  // A private tab no space lists (it should not happen) still shows rather than being lost.
  for (const tab of Object.values(state.tabs))
    if (isPrivateTab(tab) && !listed.has(tab.id)) order.push(tab)
  return order
}

/** The pane the overview shows: the one picked, else the one the tab in view belongs to. */
export function overviewPane(
  state: UIState,
  picked: OverviewPane | null = privateTabsStore.get().pane
): OverviewPane {
  if (picked) return picked
  return activeTabIsPrivate(state) ? 'private' : 'tabs'
}

export function pickOverviewPane(pane: OverviewPane): void {
  privateTabsStore.set({ pane })
}

/** The overview went away: the next one follows the tab in view again. */
export function resetOverviewPane(): void {
  privateTabsStore.set({ pane: null })
}

/** `tabs` on `pane`: private cards never show in the regular pane, nor regular ones in the private pane. */
export function tabsOnPane(tabs: readonly Tab[], pane: OverviewPane): Tab[] {
  const wanted = pane === 'private'
  return tabs.filter((tab) => isPrivateTab(tab) === wanted)
}

/**
 * The tabs of `tab`'s own mode, in the given order: the track the pill's swipe moves along, so a
 * swipe from a private tab lands on the next private tab and never crosses into the regular ones
 * (and back), the way Chrome's strip swipe stays in its own mode.
 */
export function sameModeAs(tab: Pick<Tab, 'containerId'>, order: readonly Tab[]): Tab[] {
  return tabsOnPane(order, isPrivateTab(tab) ? 'private' : 'tabs')
}

/**
 * Open each of `urls` in a private tab of its own (INC-08): the core's `tab.newPrivate`, which
 * makes each the tab in view as it comes, so the last one opened is the one in view – the
 * private session starting, if it was not on, with the first.
 */
export function openInPrivateTabs(urls: readonly string[]): void {
  for (const url of urls) if (url) run('tab.newPrivate', { url })
}

/**
 * The "Open in Private Tab" row of a phone panel's row or selection menu (INC-08: the history
 * and bookmark panels), for `urls`: one item, in Title Case as the panels' menus are (§9.1) –
 * "Open All in Private (N)" for several – or none at all on a host without private tabs, or with
 * nothing to open. `after` runs once the tabs are asked for (the panel leaving its selection).
 */
export function openInPrivateItems(
  capabilities: Pick<UIState['capabilities'], 'privateTabs'>,
  urls: readonly string[],
  after?: () => void
): LocalMenuItem[] {
  const open = urls.filter(Boolean)
  if (!capabilities.privateTabs || open.length === 0) return []
  return [
    {
      label: open.length === 1 ? 'Open in Private Tab' : `Open All in Private (${open.length})`,
      onSelect: () => {
        openInPrivateTabs(open)
        after?.()
      }
    }
  ]
}

/**
 * Whether the chrome stands on a private surface: a private tab is the one in view, or the
 * overview is up (or on its way up) on the private pane, whose cards are private pages. What the
 * theme blend (MOT-14), the status bar and the window's screenshot guard follow (§9.29: the
 * private theme is the window surfaces' look, not a page's).
 */
export function privateSurfaceActive(
  state: UIState,
  overviewUp: boolean,
  pane: OverviewPane = overviewPane(state)
): boolean {
  if (overviewUp) return pane === 'private'
  return activeTabIsPrivate(state)
}
