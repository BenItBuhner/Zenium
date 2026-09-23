import type { TabAlert } from '@shared/captureState'
import type { Tab } from '@shared/types'

/*
 * What a tab row tells a screen reader beyond its name (parity matrix a11y-31; Chrome's tab
 * strip says "Audio playing", "Audio muted", "Camera or microphone recording" after the title).
 * The row's name stays the title; its states ride in its description, and its place in the
 * list in `aria-posinset` / `aria-setsize` (the platform reads those as "3 of 12" in its own
 * words – Chromium computes them for a tab in a tablist anyway, so a text copy would be heard
 * twice). The strip and the sidebar share the row, so they share this.
 */

/**
 * The states a row announces, one short word each, what the user cannot otherwise see first:
 * an alert (recording, sharing, picture-in-picture), the audio (muted, else playing), the
 * page's sleep (sleeping, else the governor's frozen or throttled), and last that it is pinned.
 * A row under the private lock announces nothing of the page (`masked`).
 */
export function tabRowStates(tab: Tab, alert: TabAlert | null, masked = false): string[] {
  if (masked) return []
  const states: string[] = []
  if (alert === 'recording') states.push('recording')
  else if (alert === 'capturing') states.push('sharing')
  else if (alert === 'pip') states.push('picture in picture')
  if (tab.muted) states.push('muted')
  else if (tab.audible) states.push('playing')
  if (tab.discarded) states.push('sleeping')
  else if (tab.frozen) states.push('frozen')
  else if (tab.cpuThrottle > 1) states.push('throttled')
  if (tab.pinned) states.push('pinned')
  return states
}

/**
 * The row's description: its pane of a split group first ("Split view, pane 1 of 2", §9.35),
 * then its states, comma-joined – or nothing, for a plain row.
 */
export function tabRowDescription(
  states: readonly string[],
  segment: { index: number; count: number } | null | undefined
): string | null {
  const parts = segment ? [`Split view, pane ${segment.index + 1} of ${segment.count}`] : []
  parts.push(...states)
  return parts.length > 0 ? parts.join(', ') : null
}

/** The id of the hidden text that carries a row's description (`aria-describedby`). */
export function tabRowDescriptionId(tabId: string): string {
  return `zen-tab-desc-${tabId}`
}

/**
 * A row's place in its list (`aria-posinset` / `aria-setsize`): one-based, or nothing when the
 * row is drawn outside a list this module knows.
 */
export function tabRowPosition(
  tabIds: readonly string[] | null,
  tabId: string
): { pos: number; size: number } | null {
  if (!tabIds) return null
  const at = tabIds.indexOf(tabId)
  return at < 0 ? null : { pos: at + 1, size: tabIds.length }
}
