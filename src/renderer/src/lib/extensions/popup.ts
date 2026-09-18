import type { ExtensionPromptRequest } from '@shared/types'
import type { Anchor } from '../anchor'
import { run } from '../api'
import { activeTab } from '../selectors'
import { openPopover } from '../portals'
import {
  browserStore,
  captureActiveTab,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore
} from '../ui'
import { placePopup, type PopupPlacement } from './popupPlacement'

/** How long the frame waits for the document's size before opening at the default one. */
export const POPUP_SIZE_WAIT_MS = 700

/**
 * A popup whose document is loading while the page is being captured: its frame goes up once
 * the capture is in place, and a size main reports in the meantime is kept for it.
 */
interface PendingPopup {
  id: string
  size: { width: number; height: number } | null
}
let pending: PendingPopup | null = null
/** Takes the popup out of the chrome layer's popover registry once it is closed. */
let releasePopover: (() => void) | null = null
/** The frame's root while `PopupFrame` has it mounted: what a press inside the popup lands on. */
let frame: HTMLElement | null = null

/** `PopupFrame` binds its root here while it is mounted, and null when it goes. */
export function bindPopupFrame(el: HTMLElement | null): void {
  frame = el
}

/**
 * Open an action popup under its toolbar button. The renderer owns the frame and decides where
 * the document goes: main creates the view hidden at the default bounds and reports the
 * document's preferred size (`extension.popupSize`); the frame then pops in around that size and
 * shows the view (`extension.resizePopup`). Extensions without a popup still get the command so
 * main can fire `action.onClicked`.
 *
 * The frame overhangs the content frame, and the page's view composites above the chrome: the
 * page is captured first and its view hidden behind the capture while the popup is up
 * (`overlayCoversContent`), as for every other chrome overlay.
 */
export function openExtensionPopup(id: string, anchor: Anchor, hasPopup: boolean): void {
  const current = uiStore.get().extensionPopup
  if (current || pending) closeExtensionPopup()
  // Main takes the button's box alone; the bar is the frame's business.
  const box = { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
  if (!hasPopup) {
    run('extension.openPopup', { id, anchor: box })
    return
  }
  // The chrome layer's registry (lib/popoverStore.ts, §9.20 amended): registering closes
  // whatever popover is up, and from here on a press outside the frame – the page, the bar,
  // the button itself, which then does not reopen it – a scroll, a resize or another popover
  // opening closes the popup. Registered from the press rather than the frame's mount, so a
  // press while the page is still being captured closes the pending popup too. The document
  // is main's view above the chrome and keeps its own input. The button itself is the
  // registry's alone; the store holds the anchor's box and bar, plain data like the rest of it.
  const { element, ...placed } = anchor
  releasePopover = openPopover({
    element: () => frame,
    anchor: () => element ?? null,
    close: () => closeExtensionPopup()
  })
  const placement = placementFor(placed, null)
  run('extension.openPopup', {
    id,
    anchor: box,
    bounds: placement.inner,
    radius: placement.innerRadius
  })
  const mine: PendingPopup = { id, size: null }
  pending = mine
  const state = browserStore.get().state
  void captureActiveTab(state ? (activeTab(state)?.id ?? null) : null).then(() => {
    if (pending !== mine) return
    pending = null
    uiStore.set({
      extensionPopup: { id, anchor: placed, content: mine.size, shown: mine.size !== null }
    })
    if (mine.size) return
    window.setTimeout(() => {
      const popup = uiStore.get().extensionPopup
      if (popup && popup.id === id && !popup.shown)
        uiStore.set({ extensionPopup: { ...popup, shown: true } })
    }, POPUP_SIZE_WAIT_MS)
  })
}

/** Close the open popup; `notifyMain` is false when main already closed the view itself. */
export function closeExtensionPopup(notifyMain = true): void {
  const wasPending = pending !== null
  pending = null
  releasePopover?.()
  releasePopover = null
  if (!uiStore.get().extensionPopup) {
    if (wasPending && notifyMain) run('extension.closePopup', undefined)
    return
  }
  uiStore.set({ extensionPopup: null })
  if (notifyMain) run('extension.closePopup', undefined)
  invalidateSnapshot()
  returnFocusToPage()
}

/** Main reported the popup document's preferred size. */
export function popupSizeReported(id: string, width: number, height: number): void {
  if (pending?.id === id) {
    pending.size = { width, height }
    return
  }
  const popup = uiStore.get().extensionPopup
  if (!popup || popup.id !== id) return
  const content = { width, height }
  if (popup.content?.width === width && popup.content?.height === height && popup.shown) return
  uiStore.set({ extensionPopup: { ...popup, content, shown: true } })
}

/** Where the frame and the view go for the current window size. */
export function placementFor(
  anchor: Anchor,
  content: { width: number; height: number } | null
): PopupPlacement {
  return placePopup({
    anchor,
    content,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  })
}

// ---------------------------------------------------------------------------
// Install and permission prompts
// ---------------------------------------------------------------------------

/**
 * Main asked: queue the prompt behind any that are still open. The dialog covers the content
 * frame, so the page is captured first and the frame shows the dimmed capture while the
 * prompt is up (the same chassis as the external-protocol confirm).
 */
export async function enqueueExtensionPrompt(
  prompt: ExtensionPromptRequest,
  activeTabId: string | null
): Promise<void> {
  if (uiStore.get().extensionPrompts.length === 0) await captureActiveTab(activeTabId)
  uiStore.set((s) =>
    s.extensionPrompts.some((p) => p.requestId === prompt.requestId)
      ? {}
      : { extensionPrompts: [...s.extensionPrompts, prompt] }
  )
}

/** Answer the prompt at the front of the queue and drop it. */
export function answerExtensionPrompt(prompt: ExtensionPromptRequest, accept: boolean): void {
  uiStore.set((s) => ({
    extensionPrompts: s.extensionPrompts.filter((p) => p.requestId !== prompt.requestId)
  }))
  run(
    prompt.kind === 'permissions'
      ? 'extension.respondPermissionRequest'
      : 'extension.confirmInstall',
    { requestId: prompt.requestId, accept }
  )
  if (uiStore.get().extensionPrompts.length === 0) {
    invalidateSnapshot()
    returnFocusToPage()
  }
}
