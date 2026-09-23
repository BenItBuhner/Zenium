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
 * it started that no earlier intent has taken – as many as it closed. An intent settles as soon
 * as its count is in, or {@link CLOSE_SETTLE_MS} after the core last had one of its tabs closing
 * (`closingTabIds`: a close of several goes one page after the other, `tab.closeMany`, and a
 * page may ask "Leave site?" for as long as the user takes; the toast waits as the card's exit
 * does), with what has come; a close that makes no entry (a blank tab never visited, a pinned
 * tab that only resets) has nothing to undo and gets no toast, as Firefox's "Recently closed"
 * skips such tabs too.
 */

/**
 * How long a close waits for its entries once the core has no tab of it closing any more, before
 * the toast shows with what has come: the last page's entry is one event away, and a close the
 * chrome hears nothing of (a host without an unload check) files its entries in the tick it is
 * asked. While the core lists one of the close's tabs as closing – its `beforeunload` handlers
 * running, one asking "Leave site?" for as long as the user takes, the next page of a
 * `tab.closeMany` in its turn – the wait does not run: the toast comes once the close is
 * through, never before it (a fixed wait settled a seven-tab close with the three entries in by
 * then and left the other four with no Undo).
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
  /**
   * The tabs whose close the core has in flight, as the chrome last heard (`UIState.closingTabIds`:
   * a `requestClose` from its start to its page's answer, "Leave site?" included).
   */
  closingTabIds: () => readonly string[]
  /** Hear the chrome's state change (`browserStore`); returns the unsubscribe. */
  onState: (listener: () => void) => () => void
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
  /** The tabs told to close: the intent holds while the core has any of them closing. */
  tabIds: ReadonlySet<string>
  /** How many entries the close can make at most; the intent settles once they are in. */
  expected: number
  /** The entries taken so far, oldest first. */
  entries: ClosedEntrySummary[]
  /** The closed tab that was active, if any: Undo brings it back as the active tab. */
  focus: string | null
  /** Whether the core had one of its tabs closing at the chrome's last look. */
  held: boolean
  /** The settle wait, running only while the intent is not held. */
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
export function createCloseUndo({
  invoke,
  on,
  toast,
  now,
  activeTabId,
  closingTabIds,
  onState
}: CloseUndoDeps): CloseUndo {
  const pending: Intent[] = []
  /** Entries an intent has taken, while they are on the list. */
  const claimed = new Set<string>()
  let watching = false
  /** The state subscription, held only while an intent is pending. */
  let unwatchState: (() => void) | null = null
  let syncing: Promise<void> | null = null
  let again = false

  const watch = (): void => {
    if (watching) return
    watching = true
    on('session.recentlyClosedChanged', () => void sync())
  }

  const watchState = (): void => {
    unwatchState ??= onState(look)
  }

  const unwatch = (): void => {
    if (pending.length > 0 || !unwatchState) return
    unwatchState()
    unwatchState = null
  }

  /** Start (or start over) the settle wait: the last entries get {@link CLOSE_SETTLE_MS} to come. */
  const arm = (intent: Intent): void => {
    if (intent.timer) clearTimeout(intent.timer)
    intent.timer = setTimeout(() => {
      intent.timer = null
      void sync().then(() => {
        // Held again while the list was read: the hold's end starts the wait over.
        if (!intent.held) settle(intent)
      })
    }, CLOSE_SETTLE_MS)
  }

  /**
   * The core's closing set as the chrome last heard it: an intent one of whose tabs is in it
   * holds, its wait cleared – the close is still on its way, one page after the other, or a
   * page is asking "Leave site?" – and one whose tabs have all left it gets a fresh wait for the
   * entries the last of them made.
   */
  const look = (): void => {
    const closing = closingTabIds()
    for (const intent of pending) {
      const held = closing.some((id) => intent.tabIds.has(id))
      if (held === intent.held) continue
      intent.held = held
      if (!held) arm(intent)
      else if (intent.timer) {
        clearTimeout(intent.timer)
        intent.timer = null
      }
    }
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
    intent.timer = null
    unwatch()
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
        tabIds: new Set(tabs.map((tab) => tab.id)),
        expected,
        entries: [],
        focus: active && tabs.some((tab) => tab.id === active) ? active : null,
        held: false,
        timer: null
      }
      pending.push(intent)
      watch()
      watchState()
      close()
      arm(intent)
      // A tab of this close the core has closing already (asked by an earlier close, its page
      // still being asked) holds the intent from the start.
      look()
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
  },
  closingTabIds: () => browserStore.get().state?.closingTabIds ?? [],
  onState: (listener) => browserStore.subscribe(listener)
})

/** Close `request.tabs` through `request.close` with Undo on the toast (see the module note). */
export function closeWithUndo(request: CloseRequest): void {
  closeUndo.close(request)
}
