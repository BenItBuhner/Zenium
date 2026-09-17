import type { UIState } from '@shared/types'
import { isActiveDownload, type DownloadChange, type DownloadRecord } from '@shared/downloadsShell'
import { onEvent, run } from './api'
import { downloadsEngine, onDownloadChanged } from './downloadsEngine'
import { isPhone } from './formFactor'
import { reducedMotion } from './motion/spring'
import { activeTab } from './selectors'
import { createStore } from './store'
import {
  browserStore,
  captureActiveTab,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore
} from './ui'

/*
 * The desktop's downloads chrome (Chrome 112+): the toolbar button and the bubble under it.
 * State lives here so the button, the bubble and the event handlers share one story; the list
 * itself is the engine's (`downloadsEngine`).
 */

/** How long the toolbar button (and the auto-opened bubble) stay once everything finished. */
export const DOWNLOAD_LINGER_MS = 5000
/** The bubble's pop animation, played forwards on open and backwards on close. */
export const BUBBLE_POP_MS = 180

export interface DownloadsUi {
  /** The bubble is up (or playing its exit while `closing`). */
  open: boolean
  closing: boolean
  /** Ids the partial bubble shows (null: the whole list). */
  partial: string[] | null
  /** The bubble opened by itself and leaves again after five idle seconds. */
  autoClose: boolean
  /** Row to draw attention to (a notification was clicked). */
  highlightId: string | null
  /** Finished while the bubble was closed; the button's badge counts them. */
  unseen: string[]
  /** Bumped once per started download: the button pulses. */
  pulse: number
  /** The button stays until this time after the last transfer finished (0: no hold). */
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
  // Nothing left in flight: the button leaves a little after the bubble did.
  const state = browserStore.get().state
  if (state && !state.downloads.some(isActiveDownload)) holdButton(Date.now() + DOWNLOAD_LINGER_MS)
}

/** The toolbar button was clicked: phones go to the page, desktops toggle the bubble. */
export function toggleDownloadBubble(activeTabId: string | null): void {
  if (isPhone()) {
    downloadsEngine.openPanel(activeTabId)
    return
  }
  if (bubbleIsOpen()) closeDownloadBubble()
  else void openDownloadBubble({ takeFocus: true })
}

/** Leave the bubble for the full page. */
export function showAllDownloads(state: UIState): void {
  dismissDownloadBubble()
  downloadsEngine.openPanel(activeTab(state)?.id ?? null)
}

/** A notification was clicked: show the list with `id` marked. */
export function revealDownload(id: string | null): void {
  if (isPhone()) {
    downloadsEngine.openPanel(null)
    return
  }
  void openDownloadBubble({ highlightId: id, takeFocus: true })
}

/**
 * One `download.changed` event. A start makes the button appear and pulse (and opens the bubble
 * when Settings ask for the Firefox behaviour). Finished items count on the badge while the
 * bubble is closed; when nothing is left in flight the button lingers for five seconds and, if
 * Settings say so and this window has focus, the partial bubble opens with the items that
 * finished since the user last looked (Chrome 112+).
 */
export function handleDownloadChange(change: DownloadChange, state: UIState): void {
  const { item, kind } = change
  const settings = state.settings.downloads
  const desktop = !isPhone()
  const focused = state.window.focused
  const clear = (): boolean => uiStore.get().overlay === 'none' && !bubbleIsOpen()
  switch (kind) {
    case 'started':
      holdButton(0)
      downloadsUi.set((s) => ({ pulse: s.pulse + 1 }))
      if (desktop && settings.openPanelOnStart && focused && clear()) void openDownloadBubble()
      return
    case 'removed':
      downloadsUi.set((s) => ({ unseen: s.unseen.filter((id) => id !== item.id) }))
      return
    case 'done': {
      if (item.state !== 'cancelled' && !bubbleIsOpen()) {
        downloadsUi.set((s) => ({
          unseen: s.unseen.includes(item.id) ? s.unseen : [...s.unseen, item.id]
        }))
      }
      if (state.downloads.some(isActiveDownload)) return
      holdButton(Date.now() + DOWNLOAD_LINGER_MS)
      const finished = downloadsUi.get().unseen
      if (
        desktop &&
        item.state === 'completed' &&
        settings.openPanelOnComplete &&
        focused &&
        clear() &&
        finished.length > 0
      ) {
        void openDownloadBubble({ partial: finished, autoClose: true })
      }
      return
    }
    case 'progress':
      return
  }
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
      downloadsUi.set({ lingerUntil: 0 })
    },
    Math.max(0, until - Date.now())
  )
}

/** Whether the toolbar shows the downloads button right now. */
export function downloadButtonVisible(state: UIState, ui: DownloadsUi): boolean {
  return (
    state.settings.downloads.alwaysShowButton ||
    state.downloads.some(isActiveDownload) ||
    ui.open ||
    ui.unseen.length > 0 ||
    ui.lingerUntil > 0
  )
}

/** The records the bubble lists: the partial set while it exists, else everything. */
export function bubbleItems(items: DownloadRecord[], partial: string[] | null): DownloadRecord[] {
  if (!partial) return items
  const shown = items.filter((i) => partial.includes(i.id))
  return shown.length > 0 ? shown : items
}

/**
 * Wire the bubble to the engine's events and the rest of the chrome. Another surface (URL bar,
 * panel, drawer, menu, site info) replaces the bubble outright.
 */
export function startDownloadsUi(): () => void {
  const offs = [
    onDownloadChanged(handleDownloadChange),
    onEvent('downloads.reveal', ({ id }) => revealDownload(id)),
    uiStore.subscribe(() => {
      const ui = uiStore.get()
      if (
        (ui.urlbar.open || ui.overlay !== 'none' || ui.drawerOpen || ui.menu || ui.siteInfoOpen) &&
        downloadsUi.get().open
      )
        dismissDownloadBubble()
    })
  ]
  return () => offs.forEach((off) => off())
}
