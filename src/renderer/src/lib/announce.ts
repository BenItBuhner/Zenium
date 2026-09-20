import type { DownloadChangeKind, DownloadItem, FindResult, Tab, UIState } from '@shared/types'
import { formatZoom } from '@shared/pageControls'
import { activeSpace, tabOrderOf, tabTitle } from './selectors'
import { createStore } from './store'
import { browserStore } from './ui'

/*
 * What a screen reader is told about without the keyboard moving (v2 draft §9.30; parity row
 * a11y-27): the tab that came to the front, a download starting and finishing, the find bar's
 * count, a zoom step, a tab muted or unmuted. All of it goes through the chrome's one
 * `role="status"` region (`components/Announcer.tsx`) – polite, so it waits for what is being
 * read, and atomic, so a message is read whole. The words are composed here, as pure functions
 * of the state, so they can be tested; the region only renders what `announce` was given.
 */

export interface Announcement {
  text: string
  /** Bumped per message, so the same words can be said again later: the region re-renders. */
  seq: number
}

export const announcerStore = createStore<Announcement>({ text: '', seq: 0 }, 'announcer')

/** The same words twice within this window are said once (a step key held, an echoed event). */
export const ANNOUNCE_REPEAT_MS = 1500
/** The region is emptied this long after a message, so a reader landing on it later finds nothing stale. */
export const ANNOUNCE_CLEAR_MS = 7000

let lastText = ''
let lastAt = -Infinity
let clearTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Say `text` through the region. Empty text says nothing; the words said last within
 * `ANNOUNCE_REPEAT_MS` are not repeated (the window slides, so a key held down stays quiet).
 * Returns whether the region got the message.
 */
export function announce(text: string, now = Date.now()): boolean {
  const words = text.trim()
  if (!words) return false
  if (words === lastText && now - lastAt < ANNOUNCE_REPEAT_MS) {
    lastAt = now
    return false
  }
  lastText = words
  lastAt = now
  announcerStore.set((s) => ({ text: words, seq: s.seq + 1 }))
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = null
    announcerStore.set({ text: '' })
  }, ANNOUNCE_CLEAR_MS)
  return true
}

/** Forget what was said (tests; the region emptied itself). */
export function resetAnnouncer(): void {
  lastText = ''
  lastAt = -Infinity
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = null
  announcerStore.set({ text: '', seq: 0 })
}

/**
 * What two consecutive states say: the tab that came to the front (by any means – the strip,
 * Ctrl+Tab, a space change, a close that moved the front, a tab opened) and tabs muted or
 * unmuted. Only the focused window speaks: a background window's reader is not listening, and
 * an event that reaches every window would otherwise be said once per window.
 */
export function stateAnnouncements(prev: UIState, next: UIState): string[] {
  if (!next.window.focused) return []
  const words: string[] = []
  const front = frontTabId(next)
  if (front !== null && front !== frontTabId(prev)) {
    const switched = tabSwitchAnnouncement(next, front)
    if (switched) words.push(switched)
  }
  words.push(...muteAnnouncements(prev, next))
  return words
}

/** Follow the browser state for `stateAnnouncements`; returns the unsubscribe. */
export function startAnnouncer(): () => void {
  let prev = browserStore.get().state
  return browserStore.subscribe(() => {
    const next = browserStore.get().state
    const before = prev
    prev = next
    if (!next || !before || next === before) return
    for (const text of stateAnnouncements(before, next)) announce(text)
  })
}

/** A tab's name as the strip reads it: the user's title, the page's, else the address, else "New Tab". */
function nameOf(tab: Tab): string {
  return tabTitle(tab) || tab.url || 'New Tab'
}

/**
 * The tab that came to the front, as Chrome's tab strip has it: its place in the strip's order
 * (Essentials, pinned, the folders' rows, the loose rows – `tabOrderOf`) and its name:
 * "Tab 3 of 8, Example Domain". A tab the strip does not list (a popup window's) gives its name alone.
 */
export function tabSwitchAnnouncement(state: UIState, tabId: string): string | null {
  const tab = state.tabs[tabId]
  if (!tab) return null
  const order = tabOrderOf(state, activeSpace(state))
  const at = order.findIndex((t) => t.id === tabId)
  return at === -1 ? `Tab, ${nameOf(tab)}` : `Tab ${at + 1} of ${order.length}, ${nameOf(tab)}`
}

/**
 * A download's start and its end, by the file's name; progress ticks and removals from the
 * list say nothing. The end reads the item's state: finished, failed (interrupted), cancelled.
 */
export function downloadAnnouncement(item: DownloadItem, kind: DownloadChangeKind): string | null {
  const name = item.finalName || item.filename || 'file'
  if (kind === 'started') return `Download started: ${name}`
  if (kind !== 'done') return null
  switch (item.state) {
    case 'completed':
      return `Download finished: ${name}`
    case 'interrupted':
      return `Download failed: ${name}`
    case 'cancelled':
      return `Download cancelled: ${name}`
    default:
      return null
  }
}

/**
 * The find bar's count as words: "3 of 12 matches", "1 of 1 match", "No matches"; nothing while
 * the field is empty or the page has not answered yet.
 */
export function findAnnouncement(text: string, result: FindResult | null): string | null {
  if (!text || result === null) return null
  if (result.matches === 0) return 'No matches'
  return `${result.activeMatchOrdinal} of ${result.matches} ${result.matches === 1 ? 'match' : 'matches'}`
}

/** "Zoom 125%". */
export function zoomAnnouncement(factor: number): string {
  return `Zoom ${formatZoom(factor)}`
}

/**
 * Tabs whose sound was muted or unmuted between two states – one tab by name ("Tab muted,
 * Example Domain"), several as a count ("3 tabs muted", the site's tabs all at once); a mixed
 * change (some muted, others unmuted) reads as two messages, the muted ones first.
 */
export function muteAnnouncements(prev: UIState, next: UIState): string[] {
  const muted: Tab[] = []
  const unmuted: Tab[] = []
  for (const tab of Object.values(next.tabs)) {
    const before = prev.tabs[tab.id]
    if (!before || before.muted === tab.muted) continue
    ;(tab.muted ? muted : unmuted).push(tab)
  }
  const words = (tabs: Tab[], state: 'muted' | 'unmuted'): string | null => {
    if (tabs.length === 0) return null
    if (tabs.length === 1) return `Tab ${state}, ${nameOf(tabs[0])}`
    return `${tabs.length} tabs ${state}`
  }
  return [words(muted, 'muted'), words(unmuted, 'unmuted')].filter((w): w is string => w !== null)
}

/** The active tab of the active space, as the announcements follow it. */
export function frontTabId(state: UIState): string | null {
  return activeSpace(state).activeTabId
}
