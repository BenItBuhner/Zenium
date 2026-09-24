import type {
  DownloadChangeKind,
  DownloadItem,
  FindResult,
  FormFactor,
  Tab,
  UIState
} from '@shared/types'
import { formatZoom } from '@shared/pageControls'
import { activeSpace, tabOrderOf, tabTitle } from './selectors'
import { createStore } from './store'
import { browserStore } from './ui'

/*
 * What a screen reader is told about without the keyboard moving (v2 draft §9.30; parity row
 * a11y-27): the tab that came to the front, a download starting and finishing, a zoom step, a
 * tab muted or unmuted. All of it goes through the chrome's one `role="status"` region
 * (`components/Announcer.tsx`) – polite, so it waits for what is being read, and atomic, so a
 * message is read whole. The words are composed here, as pure functions of the state, so they
 * can be tested; the region only renders what `announce` was given. The find bar's count has a
 * status region of its own in the bar (a11y-35), with `findAnnouncement`'s words as its text.
 *
 * On Android (A11Y-02) the same region is the bridge to TalkBack: Chromium's Android
 * accessibility bridge speaks a node appearing inside a live region as a `TYPE_ANNOUNCEMENT`
 * event (`WebContentsAccessibilityImpl.announceLiveRegionText`, the mechanism #237's device
 * driver caught for the toasts) – the event `View.announceForAccessibility` would send, from
 * the route Android 15 keeps (the method is deprecated in API 35 in favour of live regions).
 * The phone's voice puts the name first, as its overview cards do (`overviewLabels.ts`), and
 * adds the front tab's load finishing; toasts and banners have regions of their own
 * (`ToastCard`, `BannerCard`) and are never repeated here.
 */

/**
 * How the words are ordered: the desktop's strip reads place then name ("Tab 3 of 8, Example
 * Domain", a11y-27); the phone name then place ("Example Domain, tab 3 of 8"), the order its
 * overview cards carry (Chrome's grid switcher), and it hears the front tab's load finish.
 */
export type AnnouncementVoice = 'desktop' | 'phone'

/** The voice for a form factor: the phone's for the phone, the desktop's for the rest (the tablet's strip reads as the desktop's). */
export function announcementVoice(formFactor: FormFactor): AnnouncementVoice {
  return formFactor === 'phone' ? 'phone' : 'desktop'
}

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
 * unmuted; in the phone's voice, the front tab's load finishing as well. Only the focused window
 * speaks: a background window's reader is not listening, and an event that reaches every window
 * would otherwise be said once per window.
 */
export function stateAnnouncements(
  prev: UIState,
  next: UIState,
  voice: AnnouncementVoice = 'desktop'
): string[] {
  if (!next.window.focused) return []
  const words: string[] = []
  const front = frontTabId(next)
  if (front !== null && front !== frontTabId(prev)) {
    const switched = tabSwitchAnnouncement(next, front, voice)
    if (switched) words.push(switched)
  } else if (voice === 'phone') {
    const loaded = loadCompleteAnnouncement(prev, next)
    if (loaded) words.push(loaded)
  }
  words.push(...muteAnnouncements(prev, next))
  return words
}

/**
 * Follow the browser state for `stateAnnouncements`; returns the unsubscribe. `voice` is read
 * per change, so a layout that moves (a phone docked into DeX) speaks in the voice it is in.
 */
export function startAnnouncer(voice: () => AnnouncementVoice = () => 'desktop'): () => void {
  let prev = browserStore.get().state
  return browserStore.subscribe(() => {
    const next = browserStore.get().state
    const before = prev
    prev = next
    if (!next || !before || next === before) return
    for (const text of stateAnnouncements(before, next, voice())) announce(text)
  })
}

/** A tab's name as the strip reads it: the user's title, the page's, else the address, else "New Tab". */
function nameOf(tab: Tab): string {
  return tabTitle(tab) || tab.url || 'New Tab'
}

/**
 * The tab that came to the front, as Chrome's tab strip has it: its place in the strip's order
 * (Essentials, pinned, the folders' rows, the loose rows – `tabOrderOf`) and its name:
 * "Tab 3 of 8, Example Domain" on the desktop; "Example Domain, tab 3 of 8" in the phone's voice,
 * the order the overview's cards carry (`tabCardLabel`). A tab the strip does not list (a popup
 * window's) gives its name alone.
 */
export function tabSwitchAnnouncement(
  state: UIState,
  tabId: string,
  voice: AnnouncementVoice = 'desktop'
): string | null {
  const tab = state.tabs[tabId]
  if (!tab) return null
  const order = tabOrderOf(state, activeSpace(state))
  const at = order.findIndex((t) => t.id === tabId)
  const name = nameOf(tab)
  if (voice === 'phone')
    return at === -1 ? `${name}, tab` : `${name}, tab ${at + 1} of ${order.length}`
  return at === -1 ? `Tab, ${name}` : `Tab ${at + 1} of ${order.length}, ${name}`
}

/**
 * The front tab's load finished between two states (A11Y-02, the phone): "Example Domain loaded"
 * – the page's title once it has one, the address before that. Said for the tab that was already
 * in front (a switch to a tab is the switch's announcement, whatever its load is doing) and
 * only as `loading` goes off; a load that started, progress ticks and a title changing on a
 * page that is not loading say nothing.
 */
export function loadCompleteAnnouncement(prev: UIState, next: UIState): string | null {
  const front = frontTabId(next)
  if (front === null || front !== frontTabId(prev)) return null
  const before = prev.tabs[front]
  const after = next.tabs[front]
  if (!before || !after || !before.loading || after.loading) return null
  return `${nameOf(after)} loaded`
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
