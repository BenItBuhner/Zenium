/**
 * The `chrome.sessions` data model over Zenium's recently-closed list (`core/session`): Chrome's
 * `Session` shape for a closed tab or window, the argument checks of `getRecentlyClosed` and
 * `restore`, and the field scrubbing an extension without `tabs` access gets. Pure; the host
 * module resolves the model's entries and the live tabs a restore brings back.
 */
import type { ClosedEntry, ClosedTabEntry, ClosedWindowEntry } from '../../../shared/types'
import { displayUrl } from '../../../shared/url'
import { TAB_GROUP_NONE, type ChromeTab } from './tabs'
import type { ChromeWindow } from './windows'

/** Chrome's `sessions.MAX_SESSION_RESULTS`: the most entries one `getRecentlyClosed` returns. */
export const MAX_SESSION_RESULTS = 25

export const ERROR_NO_PERMISSION = "The extension does not have the 'sessions' permission."
export const ERROR_NO_RECENTLY_CLOSED = 'There are no recently closed sessions.'
export const ERROR_NO_WINDOW = 'There are no browser windows to restore the session.'
export const ERROR_INVALID_FILTER = 'Invalid filter'

export class SessionsError extends Error {}

export function invalidSessionId(sessionId: string): string {
  return `Invalid session id: "${sessionId}".`
}

/**
 * A closed tab as Chrome lists it: no `id` (it has no live page), `sessionId` instead, and the
 * window fields at their defaults (`windowId` 0, nothing highlighted or selected).
 */
export interface SessionTab {
  sessionId: string
  index: number
  windowId: number
  active: boolean
  highlighted: boolean
  selected: boolean
  pinned: boolean
  incognito: boolean
  discarded: boolean
  autoDiscardable: boolean
  frozen: boolean
  groupId: number
  url?: string
  title?: string
  favIconUrl?: string
}

/** A closed window as Chrome lists it: no `id` or bounds, `sessionId` and its tabs. */
export interface SessionWindow {
  sessionId: string
  tabs: SessionTab[]
  incognito: boolean
  alwaysOnTop: boolean
  focused: boolean
  type: 'normal'
  state: 'normal'
}

export interface ChromeSession {
  /** Seconds since the epoch (Chrome's `time_t`), not milliseconds. */
  lastModified: number
  tab?: SessionTab | ChromeTab
  window?: SessionWindow | ChromeWindow
}

/** Whether the extension may see a closed tab's URL, title and favicon. */
export type UrlVisibility = (url: string) => boolean

export function sessionTab(
  entry: ClosedTabEntry,
  active: boolean,
  visible: UrlVisibility
): SessionTab {
  const tab = entry.tab
  const record: SessionTab = {
    sessionId: entry.id,
    index: entry.index,
    windowId: 0,
    active,
    highlighted: false,
    selected: false,
    pinned: tab.pinned || tab.essential,
    incognito: false,
    discarded: false,
    autoDiscardable: false,
    frozen: false,
    groupId: TAB_GROUP_NONE
  }
  if (visible(tab.url)) {
    record.url = tab.url
    record.title = tab.customTitle ?? (tab.title || displayUrl(tab.url))
    if (tab.favicon) record.favIconUrl = tab.favicon
  }
  return record
}

export function sessionWindow(entry: ClosedWindowEntry, visible: UrlVisibility): SessionWindow {
  const activeId = entry.activeTabId ?? entry.tabs[0]?.tab.id ?? null
  return {
    sessionId: entry.id,
    tabs: entry.tabs.map((tab) => sessionTab(tab, tab.tab.id === activeId, visible)),
    incognito: false,
    alwaysOnTop: false,
    focused: false,
    type: 'normal',
    state: 'normal'
  }
}

export function toChromeSession(entry: ClosedEntry, visible: UrlVisibility): ChromeSession {
  const lastModified = toSeconds(entry.closedAt)
  return entry.kind === 'tab'
    ? { lastModified, tab: sessionTab(entry, false, visible) }
    : { lastModified, window: sessionWindow(entry, visible) }
}

/** The `Session` for what a restore brought back: a live tab or window, stamped now. */
export function restoredSession(
  live: { tab: ChromeTab } | { window: ChromeWindow },
  nowMs: number
): ChromeSession {
  return { lastModified: toSeconds(nowMs), ...live }
}

export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000)
}

/** `getRecentlyClosed(filter)`: `maxResults` is an integer within 0..MAX_SESSION_RESULTS. */
export function normalizeSessionFilter(raw: unknown): { maxResults: number } {
  if (raw === undefined || raw === null) return { maxResults: MAX_SESSION_RESULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new SessionsError(ERROR_INVALID_FILTER)
  const { maxResults } = raw as { maxResults?: unknown }
  if (maxResults === undefined) return { maxResults: MAX_SESSION_RESULTS }
  if (
    typeof maxResults !== 'number' ||
    !Number.isInteger(maxResults) ||
    maxResults < 0 ||
    maxResults > MAX_SESSION_RESULTS
  ) {
    throw new SessionsError(
      `Invalid value for argument 1. Property 'maxResults': Value must be between 0 and ${MAX_SESSION_RESULTS}.`
    )
  }
  return { maxResults }
}

/** `restore(sessionId)`: absent picks the newest entry; anything else must be a string. */
export function normalizeSessionId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new SessionsError(invalidSessionId(String(raw)))
  return raw
}
