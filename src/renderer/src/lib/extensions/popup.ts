import type { ExtensionPromptRequest, Rect } from '@shared/types'
import { run } from '../api'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '../ui'
import { placePopup, type PopupPlacement } from './popupPlacement'

/** How long the frame waits for the document's size before opening at the default one. */
export const POPUP_SIZE_WAIT_MS = 700

/**
 * Open an action popup under its toolbar button. The renderer owns the frame and decides where
 * the document goes: main creates the view hidden at the default bounds and reports the
 * document's preferred size (`extension.popupSize`); the frame then pops in around that size and
 * shows the view (`extension.resizePopup`). Extensions without a popup still get the command so
 * main can fire `action.onClicked`.
 */
export function openExtensionPopup(id: string, anchor: Rect, hasPopup: boolean): void {
  const current = uiStore.get().extensionPopup
  if (current) closeExtensionPopup()
  if (!hasPopup) {
    run('extension.openPopup', { id, anchor })
    return
  }
  const placement = placementFor(anchor, null)
  uiStore.set({ extensionPopup: { id, anchor, content: null, shown: false } })
  run('extension.openPopup', {
    id,
    anchor,
    bounds: placement.inner,
    radius: placement.innerRadius
  })
  window.setTimeout(() => {
    const popup = uiStore.get().extensionPopup
    if (popup && popup.id === id && !popup.shown)
      uiStore.set({ extensionPopup: { ...popup, shown: true } })
  }, POPUP_SIZE_WAIT_MS)
}

/** Close the open popup; `notifyMain` is false when main already closed the view itself. */
export function closeExtensionPopup(notifyMain = true): void {
  if (!uiStore.get().extensionPopup) return
  uiStore.set({ extensionPopup: null })
  if (notifyMain) run('extension.closePopup', undefined)
}

/** Main reported the popup document's preferred size. */
export function popupSizeReported(id: string, width: number, height: number): void {
  const popup = uiStore.get().extensionPopup
  if (!popup || popup.id !== id) return
  const content = { width, height }
  if (popup.content?.width === width && popup.content?.height === height && popup.shown) return
  uiStore.set({ extensionPopup: { ...popup, content, shown: true } })
}

/** Where the frame and the view go for the current window size. */
export function placementFor(
  anchor: Rect,
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
