import type {
  ClosedEntrySummary,
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  Settings,
  Tab
} from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { isEmptyTabUrl } from '@shared/url'
import { cmd, onEvent } from './api'
import { activeTab } from './selectors'
import { browserStore, pushToast, type MessageAction } from './ui'

/**
 * Undo for closing tabs on the phone (v2 draft §9.33; matrix TAB-05, TAB-07, GN-16): the close
 * goes through at once – the card leaves the grid as it always did – and the toast that follows
 * ("Closed <title>", "N tabs closed") offers to bring the tabs back from the core's own
 * "Recently closed" store, through `session.restoreClosed`, which puts each tab back into its
 * space, its group and its position with its back/forward stack. Nothing is deferred and no
 * closed-tab state is kept here beyond the entries' ids: the restore is the undo.
 *
 * The chrome learns which entries a close made from the list itself: the core files a closed
 * tab (`captureClosed`) once the page's `beforeunload` handlers have let it go, which is after
 * the command has returned, so each close is an intent that waits for the
 * `session.recentlyClosedChanged` it causes and takes, oldest first, the tab entries filed since
 * it started that no earlier intent has taken – as many as it closed. Intents settle as soon as
 * their count is in, or after {@link CLOSE_SETTLE_MS} with what has come; a close that makes no
 * entry (a blank tab never visited, a pinned tab that only resets) has nothing to undo and gets
 * no toast, as Firefox's "Recently closed" skips such tabs too.
 */

/**
 * How long a close waits for its entries before the toast shows with what has come: a page's
 * `beforeunload` handlers run first, one round trip to the page; a page that asks "Leave site?"
 * holds its close for as long as the user takes, and such a close gets no toast.
 */
export const CLOSE_SETTLE_MS = 1500

/** The typed bridge to the core (`cmd`); tests hand in their own. */
export type Invoke = <K extends CommandName>(
  name: K,
  args: CommandArgs<K>
) => Promise<CommandResult<K>>
/** The typed event subscription (`onEvent`); returns the unsubscribe. */
export type Subscribe = <K extends EventName>(
  name: K,
  listener: (payload: Events[K]) => void
) => () => void

export interface CloseUndoDeps {
  invoke: Invoke
  on: Subscribe
  /** Show the toast with its one action. */
  toast: (message: string, action: MessageAction) => void
  now: () => number
  /** The tab the user is on right now (Undo keeps them there unless it brings back their tab). */
  activeTabId: () => string | null
}

export interface CloseRequest {
  /** The tabs told to close. */
  tabs: readonly Tab[]
  settings: Pick<Settings, 'pinnedCloseBehavior'>
  /** The tab that was active as the close was asked for. */
  activeTabId: string | null
  /** Issue the close (`tab.close`, `space.closeUnpinned`, …); called at once. */
  close: () => void
}

export interface CloseUndo {
  /** Close tabs and, once the core has filed them, offer their undo on a toast. */
  close(request: CloseRequest): void
}

interface Intent {
  /** The clock as the close was issued: only entries filed since can be its. */
  startedAt: number
  /** How many entries the close can make at most; the intent settles once they are in. */
  expected: number
  /** The entries taken so far, oldest first. */
  entries: ClosedEntrySummary[]
  /** The closed tab that was active, if any: Undo brings it back as the active tab. */
  focus: string | null
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Whether closing `tab` leaves an entry on the recently closed list, as far as the chrome can
 * tell (`captureClosed`'s rule): a pinned or essential tab closes only under the "Close the
 * tab" behaviour; a private tab is never kept; a tab still on the blank page or the new tab
 * page with nothing behind or ahead of it is not worth keeping.
 */
export function leavesClosedEntry(
  tab: Tab,
  settings: Pick<Settings, 'pinnedCloseBehavior'>
): boolean {
  if ((tab.pinned || tab.essential) && settings.pinnedCloseBehavior !== 'close') return false
  if (tab.containerId === PRIVATE_CONTAINER_ID) return false
  return !isEmptyTabUrl(tab.url) || tab.canGoBack || tab.canGoForward
}

/** The toast's text (§9.33, sentence case): the one tab by name, several by their count. */
export function closedMessage(entries: readonly ClosedEntrySummary[]): string {
  return entries.length === 1 ? `Closed ${entries[0].title}` : `${entries.length} tabs closed`
}

/** An undo over `invoke` and `on`; the app uses {@link closeUndo}, tests build their own. */
export function createCloseUndo({ invoke, on, toast, now, activeTabId }: CloseUndoDeps): CloseUndo {
  const pending: Intent[] = []
  /** Entries an intent has taken, while they are on the list. */
  const claimed = new Set<string>()
  let watching = false
  let syncing: Promise<void> | null = null
  let again = false

  const watch = (): void => {
    if (watching) return
    watching = true
    on('session.recentlyClosedChanged', () => void sync())
  }

  /** Read the list and hand out what is new; a change during the read reads again. */
  const sync = (): Promise<void> => {
    if (syncing) {
      again = true
      return syncing
    }
    syncing = (async () => {
      try {
        do {
          again = false
          const list = await invoke('session.recentlyClosed', undefined).catch(
            () => [] as ClosedEntrySummary[]
          )
          attribute(list)
        } while (again)
      } finally {
        syncing = null
      }
    })()
    return syncing
  }

  const attribute = (list: readonly ClosedEntrySummary[]): void => {
    const present = new Set(list.map((e) => e.id))
    for (const id of claimed) if (!present.has(id)) claimed.delete(id)
    // The list is newest first; the intents were made in order and each takes the oldest.
    const fresh = [...list].reverse().filter((e) => e.kind === 'tab' && !claimed.has(e.id))
    for (const intent of [...pending]) {
      for (const entry of fresh) {
        if (intent.entries.length >= intent.expected) break
        if (claimed.has(entry.id) || entry.closedAt < intent.startedAt) continue
        claimed.add(entry.id)
        intent.entries.push(entry)
      }
      if (intent.entries.length >= intent.expected) settle(intent)
    }
  }

  const settle = (intent: Intent): void => {
    const i = pending.indexOf(intent)
    if (i === -1) return
    pending.splice(i, 1)
    if (intent.timer) clearTimeout(intent.timer)
    if (intent.entries.length === 0) return
    toast(closedMessage(intent.entries), { label: 'Undo', onPick: () => void undo(intent) })
  }

  /**
   * Bring the tabs back, newest first: each goes to the index it held as it closed, which is
   * its old place once the tabs closed after it stand in theirs again. The core activates each
   * restored tab; the user ends on the closed tab they were on, or stays where they are.
   */
  const undo = async (intent: Intent): Promise<void> => {
    const focus = intent.focus ?? activeTabId()
    for (const entry of [...intent.entries].reverse()) {
      await invoke('session.restoreClosed', { id: entry.id }).catch(() => undefined)
    }
    if (focus) await invoke('tab.activate', { tabId: focus }).catch(() => undefined)
  }

  return {
    close({ tabs, settings, activeTabId: active, close }) {
      const expected = tabs.filter((tab) => leavesClosedEntry(tab, settings)).length
      if (expected === 0) {
        close()
        return
      }
      const intent: Intent = {
        startedAt: now(),
        expected,
        entries: [],
        focus: active && tabs.some((tab) => tab.id === active) ? active : null,
        timer: null
      }
      pending.push(intent)
      watch()
      close()
      intent.timer = setTimeout(() => {
        intent.timer = null
        void sync().then(() => settle(intent))
      }, CLOSE_SETTLE_MS)
    }
  }
}

/** The app's undo, over the chrome's bridge to the core and the message cards. */
export const closeUndo: CloseUndo = createCloseUndo({
  invoke: cmd,
  on: onEvent,
  toast: (message, action) => pushToast(message, 'info', { action }),
  now: () => Date.now(),
  activeTabId: () => {
    const state = browserStore.get().state
    return state ? (activeTab(state)?.id ?? null) : null
  }
})

/** Close `request.tabs` through `request.close` with Undo on the toast (see the module note). */
export function closeWithUndo(request: CloseRequest): void {
  closeUndo.close(request)
}
