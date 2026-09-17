import type { DownloadItem, UIState } from '@shared/types'
import { isActiveDownload } from '@shared/downloads'

/** How long the toolbar button (and the auto-opened bubble) stay once everything finished. */
export const DOWNLOAD_LINGER_MS = 5000
/** The bubble's pop animation, played forwards on open and backwards on close. */
export const BUBBLE_POP_MS = 180

export interface DownloadsUi {
  /** The bubble is up (or playing its exit while `closing`). */
  open: boolean
  closing: boolean
  /** Ids the partial bubble shows (null → the whole list). */
  partial: string[] | null
  /** The bubble opened by itself and leaves again after five idle seconds. */
  autoClose: boolean
  /** Row to draw attention to (a notification was clicked). */
  highlightId: string | null
  /** Finished while the bubble was closed; the button's badge counts them. */
  unseen: string[]
  /** Bumped once per started download: the button pulses. */
  pulse: number
  /** The button stays until this time after the last transfer finished (0 → no hold). */
  lingerUntil: number
}

/** Whether the toolbar shows the downloads button right now (`lingerUntil` resets when it ends). */
export function downloadButtonVisible(browser: UIState, ui: DownloadsUi): boolean {
  return (
    browser.settings.downloads.alwaysShowButton ||
    browser.downloads.some(isActiveDownload) ||
    ui.open ||
    ui.lingerUntil > 0
  )
}

/** The records the bubble lists: the partial set while it exists, else everything. */
export function bubbleItems(items: DownloadItem[], partial: string[] | null): DownloadItem[] {
  if (!partial) return items
  const shown = items.filter((i) => partial.includes(i.id))
  return shown.length > 0 ? shown : items
}

/** Chrome 112+: open the partial bubble once the last in-progress download finishes. */
export function shouldAutoOpenPartialBubble(options: {
  finishedState: 'completed' | 'cancelled' | 'interrupted'
  stillActive: number
  openPanelOnComplete: boolean
  bubbleOpen: boolean
  overlayIsDownloads: boolean
  phone: boolean
  finishedCount: number
}): boolean {
  return (
    options.stillActive === 0 &&
    options.finishedState === 'completed' &&
    options.openPanelOnComplete &&
    !options.phone &&
    !options.bubbleOpen &&
    !options.overlayIsDownloads &&
    options.finishedCount > 0
  )
}
