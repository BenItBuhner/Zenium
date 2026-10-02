import type {
  ClosedEntrySummary,
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  Events,
  Settings,
  Tab,
  UIState,
  UndoableTabClose
} from '@shared/types'
import { isDefaultGroupName } from '@shared/groupNames'
import { TOAST_UNDO_MS } from '@shared/toastCard'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { isEmptyTabUrl } from '@shared/url'
import { cmd, onEvent, run } from './api'
import { isTouchLayout } from './formFactor'
import { tabsOnPane } from './privateTabs'
import { activeTab, regularOf } from './selectors'
import { browserStore, pushToast, type MessageAction } from './ui'

/**
 * Undo for closing tabs on the phone (v2 draft §9.33; matrix TAB-05, TAB-07, GN-16): the close
 * goes through at once – the card leaves the grid as it always did – and the toast that follows
 * ("Closed <title>", "N tabs closed"; a group's close reads "<Name> tab group closed and saved",
 * TAB-16, on the phone and the tablet alike) offers to bring the tabs back from the core's own
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
  /**
   * The group the tabs close as ("Close Group (N Tabs)": the phone's sheet, the tablet's menu
   * through `folder.closeUndoable`; TAB-16): the toast takes the group's words
   * ({@link groupClosedMessage}) in place of the tabs' – the group stays, saved with the pages,
   * and Undo brings the tabs back into it. Left out, the toast counts the tabs.
   */
  group?: { name: string }
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
  /** The group the tabs closed as, for the toast's words; null for a close of tabs. */
  group: { name: string } | null
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

/**
 * The toast's text for a group's close (TAB-16, the Design Lead's option C; the phone and the
 * tablet alike): a group the user named is called by that name, "<Name> tab group closed and
 * saved"; a group still wearing a default name (`isDefaultGroupName`: no name, the touch hosts'
 * default, a legacy "New Folder" – the Lead's addendum) is not called by it, "Tab group closed
 * and saved". The name is read through the shared module and nowhere else.
 */
export function groupClosedMessage(group: { name: string }): string {
  return isDefaultGroupName(group.name)
    ? 'Tab group closed and saved'
    : `${group.name.trim()} tab group closed and saved`
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
    const message = intent.group ? groupClosedMessage(intent.group) : closedMessage(intent.entries)
    toast(message, { label: 'Undo', onPick: () => void undo(intent) })
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
    close({ tabs, settings, activeTabId: active, close, group }) {
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
        timer: null,
        group: group ? { name: group.name } : null
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

let appCloseUndo: CloseUndo | null = null

/**
 * The app's undo, over the chrome's bridge to the core and the message cards. Its toast offers
 * Undo, so it stands §9.33's Undo clock (`TOAST_UNDO_MS`, 8 s) – the one shared constant, never
 * the action default by omission – for the whole close family: "Closed <title>", "N tabs closed",
 * "<Name> tab group closed and saved".
 *
 * Built on the first close, not at import: `lib/back.ts` brings this module into every surface's
 * module graph, and the bridge is wanted only once a close goes through (the undo's own
 * subscriptions start on that first close as well).
 */
function closeUndo(): CloseUndo {
  appCloseUndo ??= createCloseUndo({
    invoke: cmd,
    on: onEvent,
    toast: (message, action) => pushToast(message, 'info', { action, duration: TOAST_UNDO_MS }),
    now: () => Date.now(),
    activeTabId: () => {
      const state = browserStore.get().state
      return state ? (activeTab(state)?.id ?? null) : null
    },
    closingTabIds: () => browserStore.get().state?.closingTabIds ?? [],
    onState: (listener) => browserStore.subscribe(listener)
  })
  return appCloseUndo
}

/** Close `request.tabs` through `request.close` with Undo on the toast (see the module note). */
export function closeWithUndo(request: CloseRequest): void {
  closeUndo().close(request)
}

/**
 * The chrome's own close of one tab – a row's ×, a middle-click, the strip's Delete, the tab
 * search's × (`tab.close` with `args`). On a touch layout it comes with Undo on the toast, as the
 * overview's cards' closes do (§9.23, OS-40 part B: on a touch host a page objecting under a
 * close is let go, and the toast's Undo is the protection "Leave site?" was); on the desktop the
 * close is as it was, its page free to ask. A tab the chrome's state does not hold (gone
 * already) is closed plainly: there is nothing to count.
 */
export function closeTabFromChrome(
  tabId: string,
  args: Omit<CommandArgs<'tab.close'>, 'tabId'> = {}
): void {
  const close = (): void => run('tab.close', { tabId, ...args })
  const state = browserStore.get().state
  const tab = state?.tabs[tabId]
  if (!isTouchLayout() || !state || !tab) {
    close()
    return
  }
  closeWithUndo({
    tabs: [tab],
    settings: args.force ? FORCED_CLOSE_SETTINGS : state.settings,
    activeTabId: activeTab(state)?.id ?? null,
    close
  })
}

/**
 * The core's close a touch host's menu row asked the chrome to run with Undo on the toast
 * (`tab.closeUndoable`, §9.23): `tabIds` are the tabs the close takes, as the core's own rule
 * read them, `close` the command that closes them (`UndoableTabClose`). Tabs the chrome's state
 * no longer holds are not counted.
 */
export function closeUndoable(tabIds: readonly string[], close: UndoableTabClose): void {
  const state = browserStore.get().state
  if (!state) return
  closeWithUndo({
    tabs: tabIds.flatMap((id) => state.tabs[id] ?? []),
    settings: close.command === 'tab.close' && close.force ? FORCED_CLOSE_SETTINGS : state.settings,
    activeTabId: activeTab(state)?.id ?? null,
    close: () => runUndoableClose(close)
  })
}

/**
 * A forced close (Remove Tab) closes a pinned or essential tab outright, whatever the
 * pinned-close behaviour, so its entry is expected: the count reads it under "Close the tab".
 */
const FORCED_CLOSE_SETTINGS: Pick<Settings, 'pinnedCloseBehavior'> = {
  pinnedCloseBehavior: 'close'
}

/** Run `close` as the core command it names, with the args that are its own. */
function runUndoableClose(close: UndoableTabClose): void {
  switch (close.command) {
    case 'tab.close':
      run('tab.close', { tabId: close.tabId, force: close.force })
      return
    case 'tab.closeMany':
      run('tab.closeMany', { tabIds: close.tabIds })
      return
    default:
      run(close.command, { tabId: close.tabId })
  }
}

/**
 * Close a group's tabs with Undo on the toast (TAB-16; the core's `folder.closeUndoable` event
 * from the tablet's group row menu, the tablet's group editor bubble's Close row on the touch
 * layout, TABLET-22): the group's live members as the phone's overview reads them for its own
 * Close Group (the space's regular tabs in the group, a private one none of them), the close
 * the core's `folder.close` – the group stays, saved with their pages – and the toast the
 * group's words.
 */
export function closeGroupUndoable(folderId: string): void {
  const state: UIState | null = browserStore.get().state
  const folder = state?.folders[folderId]
  if (!state || !folder) return
  const space = state.spaces.find((s) => s.id === folder.spaceId)
  if (!space) return
  const tabs = tabsOnPane(regularOf(state, space), 'tabs').filter((t) => t.folderId === folderId)
  closeWithUndo({
    tabs,
    settings: state.settings,
    activeTabId: activeTab(state)?.id ?? null,
    close: () => run('folder.close', { folderId }),
    group: folder
  })
}
