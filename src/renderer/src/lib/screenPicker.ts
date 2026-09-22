import type { ScreenCaptureRequest, ScreenCaptureSource, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'

/**
 * How long the picker waits for the page's picture before it shows over a blank one: the page
 * keeps painting behind a `getDisplayMedia` call, so the capture is quick; a page that will not
 * answer does not hold the picker.
 */
const SNAPSHOT_WAIT_MS = 250

/** The picker's three panes, in Chrome's order (its tab pane leads since M107). */
export type PickerPane = ScreenCaptureSource['kind']

export const PICKER_PANES: ReadonlyArray<{ id: PickerPane; label: string }> = [
  { id: 'tab', label: 'Zenium tab' },
  { id: 'window', label: 'Window' },
  { id: 'screen', label: 'Entire screen' }
]

/**
 * The panes this request shows, in the picker's order: a page's call has all three; an
 * extension's (`chrome.desktopCapture`) the kinds it asked for, as Chrome hides the rest.
 */
export function panesOf(
  request: ScreenCaptureRequest
): ReadonlyArray<{ id: PickerPane; label: string }> {
  return PICKER_PANES.filter((p) => request.kinds.includes(p.id))
}

/** The pane the picker opens on: the first on offer – the tab pane, as Chrome's does. */
export function initialPane(request: ScreenCaptureRequest): PickerPane {
  return panesOf(request)[0]?.id ?? 'tab'
}

/**
 * The picker this window shows now: the request of its active tab (a page's call is tab-modal,
 * like Chrome's), else an extension's request modal to this window – Chrome's
 * `chooseDesktopMedia` picker is modal to the target's browser window, so it shows over
 * whichever tab is active there and stays up while the tabs change.
 */
export function currentScreenCaptureRequest(state: UIState): ScreenCaptureRequest | null {
  const tabId = activeTab(state)?.id ?? null
  if (!tabId) return null
  return (
    state.screenCaptureRequests.find((r) => r.tabId === tabId) ??
    state.screenCaptureRequests.find((r) => r.extension && r.windowId === state.window.id) ??
    null
  )
}

/** Chrome's title line and the line under it. */
export const PICKER_TITLE = 'Choose what to share'

/**
 * Who is asking: the site, or the extension – and, when the extension captures for a site's
 * tab (`chooseDesktopMedia`'s `targetTab`), whom it shares with, as Chrome's picker says.
 */
export function pickerDescription(request: ScreenCaptureRequest): string {
  if (!request.extension) return `${request.origin} wants to share the contents of your screen`
  const who = `${request.extension.name} wants to share the contents of your screen`
  return request.origin ? `${who} with ${request.origin}` : who
}

/** The sources of one pane, in the core's order (the calling tab first in the tab pane). */
export function sourcesIn(request: ScreenCaptureRequest, pane: PickerPane): ScreenCaptureSource[] {
  return request.sources.filter((s) => s.kind === pane)
}

/** A pane that has nothing to offer says so in Chrome's terms. */
export function emptyPaneText(pane: PickerPane): string {
  switch (pane) {
    case 'tab':
      return 'No tabs to share'
    case 'window':
      return 'No open windows to share'
    case 'screen':
      return 'No screens to share'
  }
}

/**
 * What the pane has picked: its own choice, else – on the screen pane with exactly one screen –
 * that screen, as Chrome picks the only screen there is so Share is a press away.
 */
export function effectiveSelection(
  pane: PickerPane,
  sources: ScreenCaptureSource[],
  chosen: string | null
): string | null {
  if (chosen && sources.some((s) => s.id === chosen)) return chosen
  if (pane === 'screen' && sources.length === 1) return sources[0]!.id
  return null
}

/** Columns of the pane's grid: the only screen fills the width; anything else is two across. */
export function paneColumns(pane: PickerPane, count: number): 1 | 2 {
  return pane === 'screen' && count === 1 ? 1 : 2
}

/**
 * Where the arrow keys take a roving focus in a grid of `count` tiles `columns` across: Left and
 * Right step, Up and Down jump a row, Home and End go to the ends; null for any other key or a
 * step off the grid.
 */
export function gridMove(
  key: string,
  index: number,
  count: number,
  columns: number
): number | null {
  let next: number
  switch (key) {
    case 'ArrowRight':
      next = index + 1
      break
    case 'ArrowLeft':
      next = index - 1
      break
    case 'ArrowDown':
      next = index + columns
      break
    case 'ArrowUp':
      next = index - columns
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default:
      return null
  }
  return next >= 0 && next < count && next !== index ? next : null
}

/** The picker is about to show over `tabId`: the page gives way to its picture, the chrome takes the keyboard. */
export async function openScreenPicker(tabId: string): Promise<void> {
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  run('focus.chrome', undefined)
  uiStore.set({ screenPickerOpen: true })
}

export function closeScreenPicker(): void {
  if (uiStore.get().screenPickerOpen) uiStore.set({ screenPickerOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}
