import type { OverviewMenuRequest } from '@shared/types'
import { createStore } from './store'

/**
 * The chrome's word to `app.menu` while the tab overview stands (tab overview cleanup spec §1,
 * §4): the bar's ⋯ – and the keyboard's `menu.app`, the shortcut's `openAppMenu` – asks the core
 * for the OVERVIEW's menu in place of the app menu's, saying which view the overview shows and,
 * in the select-tabs mode (§5), how many cards are picked of how many. With no overview up the
 * request is empty and the app menu comes, as before. The overview is "up" once it is heading
 * open (`overviewInteractive`: taps work from then), and not while it leaves – a ⋯ tapped as a
 * card is picked opens the page's app menu, which is where the user is heading.
 *
 * The word is the mounted overview's, PUBLISHED per commit (`publishOverviewMenu`) and withdrawn
 * as the overview leaves or unmounts – this module reads nothing of the overview's own: the
 * desktop's `openAppMenu` asks it too, and must not pull the phone's stage, back stack and
 * cover into its bundle (nor into a desktop test's module graph) for a request that is empty
 * there.
 */

/** What the overview tells the bar's ⋯: nothing while it is down. */
export interface OverviewMenuWord {
  /** The view the overview shows while it is up, else null – no request. */
  view: OverviewMenuRequest['view'] | null
  /** The select-tabs mode's picked / on-offer counts while it stands (§5), else null. */
  selection: { selected: number; total: number } | null
}

export const OVERVIEW_MENU_OFF: OverviewMenuWord = { view: null, selection: null }

export const overviewMenuStore = createStore<OverviewMenuWord>(OVERVIEW_MENU_OFF, 'overview-menu')

/** The mounted overview's word, set when it differs (at rest, not per frame). */
export function publishOverviewMenu(word: OverviewMenuWord): void {
  const was = overviewMenuStore.get()
  if (
    was.view === word.view &&
    was.selection?.selected === word.selection?.selected &&
    was.selection?.total === word.selection?.total
  )
    return
  overviewMenuStore.set(word)
}

/** The `overview` of an `app.menu` request: the overview's view and selection, or nothing. */
export function overviewMenuRequest(): { overview?: OverviewMenuRequest } {
  const { view, selection } = overviewMenuStore.get()
  if (view === null) return {}
  return { overview: selection ? { view, selection } : { view } }
}
