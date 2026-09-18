import type { PageDialog, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'

/**
 * How long a page dialog waits for the page's picture before it shows over a blank one. The
 * page's renderer is blocked inside `alert()` and paints nothing new; the capture returns the
 * last frame it composited, which is exactly what the user was looking at.
 */
const SNAPSHOT_WAIT_MS = 250

/** The dialog this window shows now: the oldest one of its active tab (tab-modal, like Chrome). */
export function currentPageDialog(state: UIState): PageDialog | null {
  const tabId = activeTab(state)?.id ?? null
  if (!tabId) return null
  return state.pageDialogs.find((d) => d.tabId === tabId) ?? null
}

/**
 * Chrome's title line for a page's dialog: "example.com says", "This page says" for pages
 * without a host (files, `data:` documents), and "An embedded page at example.com says" when a
 * frame of another site opened it, so a page cannot pose as the one whose address is shown.
 */
export function pageDialogTitle(dialog: PageDialog): string {
  if (dialog.kind === 'beforeunload') {
    return dialog.message === 'reload' ? 'Reload site?' : 'Leave site?'
  }
  if (dialog.embedded) {
    return dialog.site ? `An embedded page at ${dialog.site} says` : 'An embedded page says'
  }
  return dialog.site ? `${dialog.site} says` : 'This page says'
}

/** The label of the button that accepts the dialog (Chrome's wording). */
export function pageDialogAcceptLabel(dialog: PageDialog): string {
  if (dialog.kind !== 'beforeunload') return 'OK'
  return dialog.message === 'reload' ? 'Reload' : 'Leave'
}

/** The page dialog is about to show over `tabId`: the page gives way to its picture. */
export async function openPageDialog(tabId: string): Promise<void> {
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  run('focus.chrome', undefined)
  uiStore.set({ pageDialogOpen: true })
}

export function closePageDialog(): void {
  if (uiStore.get().pageDialogOpen) uiStore.set({ pageDialogOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}
