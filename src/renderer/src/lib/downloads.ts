import type { DownloadItem, UIState } from '@shared/types'
import { isActiveDownload } from '@shared/downloads'
import { run } from './api'
import { isPhone } from './formFactor'
import { reducedMotion } from './motion/spring'
import { activeTab } from './selectors'
import { createStore } from './store'
import {
  browserStore,
  captureActiveTab,
  invalidateSnapshot,
  openOverlay,
  returnFocusToPage,
  uiStore
} from './ui'

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

export const downloadsUi = createStore<DownloadsUi>(
  {
    open: false,
    closing: false,
    partial: null,
    autoClose: false,
    highlightId: null,
    unseen: [],
    pulse: 0,
    lingerUntil: 0
  },
  'downloads-ui'
)

let exitTimer: ReturnType<typeof setTimeout> | null = null
let lingerTimer: ReturnType<typeof setTimeout> | null = null

function bubbleIsOpen(): boolean {
  const ui = downloadsUi.get()
  return ui.open && !ui.closing
}

/**
 * Open the bubble. The live page is captured first so its snapshot can stand in behind the
 * panel (hosts hide page views under chrome overlays). `takeFocus` is for opens the user asked
 * for; the auto-open leaves the keyboard where it was.
 */
export async function openDownloadBubble(
  options: {
    partial?: string[]
    autoClose?: boolean
    highlightId?: string | null
    takeFocus?: boolean
  } = {}
): Promise<void> {
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
  const state = browserStore.get().state
  await captureActiveTab(state ? (activeTab(state)?.id ?? null) : null)
  if (options.takeFocus) run('focus.chrome', undefined)
  uiStore.set({ downloadsOpen: true, drawerOpen: false })
  downloadsUi.set({
    open: true,
    closing: false,
    partial: options.partial ?? null,
    autoClose: options.autoClose ?? false,
    highlightId: options.highlightId ?? null,
    unseen: []
  })
  // The list has been looked at: a failed transfer no longer needs the taskbar's error state.
  run('download.acknowledge', undefined)
}

/** Close with the exit animation (Escape, outside click, the auto-close timer). */
export function closeDownloadBubble(): void {
  if (!bubbleIsOpen()) return
  if (reducedMotion()) {
    finishClose()
    return
  }
  downloadsUi.set({ closing: true })
  exitTimer = setTimeout(() => {
    exitTimer = null
    finishClose()
  }, BUBBLE_POP_MS)
}

/** Drop the bubble at once: another surface took over. */
export function dismissDownloadBubble(): void {
  if (!downloadsUi.get().open) return
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
  finishClose()
}

function finishClose(): void {
  downloadsUi.set({ open: false, closing: false, partial: null, autoClose: false })
  if (uiStore.get().downloadsOpen) uiStore.set({ downloadsOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/** The toolbar button was clicked: phones go to the page, desktops toggle the bubble. */
export function toggleDownloadBubble(activeTabId: string | null): void {
  if (isPhone()) {
    void openOverlay('downloads', activeTabId)
    return
  }
  if (bubbleIsOpen()) closeDownloadBubble()
  else void openDownloadBubble({ takeFocus: true })
}

/** A transfer began: the button appears (if it was not there) and pulses. */
export function onDownloadStarted(): void {
  holdButton(0)
  downloadsUi.set((s) => ({ pulse: s.pulse + 1 }))
}

/**
 * A transfer ended. Finished items count on the badge while the bubble is closed; when nothing
 * is left in flight the button lingers for five seconds and, if Settings say so, the partial
 * bubble opens with the items that finished since the user last looked (Chrome 112+).
 */
export function onDownloadFinished(
  id: string,
  state: 'completed' | 'cancelled' | 'interrupted',
  stillActive: number,
  browser: UIState
): void {
  const open = bubbleIsOpen()
  if (state !== 'cancelled' && !open) {
    downloadsUi.set((s) => ({ unseen: s.unseen.includes(id) ? s.unseen : [...s.unseen, id] }))
  }
  if (stillActive > 0) return
  holdButton(Date.now() + DOWNLOAD_LINGER_MS)
  const finished = downloadsUi.get().unseen
  if (
    state === 'completed' &&
    browser.settings.downloads.openPanelOnComplete &&
    !isPhone() &&
    !open &&
    uiStore.get().overlay !== 'downloads' &&
    finished.length > 0
  ) {
    void openDownloadBubble({ partial: finished, autoClose: true })
  }
}

/** A notification was clicked: show the list with `id` marked. */
export function showDownload(id: string | null): void {
  if (isPhone()) {
    void openOverlay('downloads', null)
    return
  }
  void openDownloadBubble({ highlightId: id, takeFocus: true })
}

function holdButton(until: number): void {
  if (lingerTimer) {
    clearTimeout(lingerTimer)
    lingerTimer = null
  }
  downloadsUi.set({ lingerUntil: until })
  if (until <= 0) return
  lingerTimer = setTimeout(
    () => {
      lingerTimer = null
      // Once the button is gone its badge has nothing to sit on.
      const stays = browserStore.get().state?.settings.downloads.alwaysShowButton ?? false
      downloadsUi.set((s) => ({ lingerUntil: 0, unseen: s.open || stays ? s.unseen : [] }))
    },
    Math.max(0, until - Date.now())
  )
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

const flags = globalThis as unknown as { __zenDownloadsWired?: boolean }
if (!flags.__zenDownloadsWired) {
  flags.__zenDownloadsWired = true
  // Another chrome surface (URL bar, panel, drawer, menu, site info) replaces the bubble outright.
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if (
      (ui.urlbar.open || ui.overlay !== 'none' || ui.drawerOpen || ui.menu || ui.siteInfoOpen) &&
      downloadsUi.get().open
    )
      dismissDownloadBubble()
  })
}
