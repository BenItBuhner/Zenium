import { noteInsetsSettling } from '@renderer/lib/fullscreenLanding'
import { contentAreaStore, uiStore, type Insets } from '@renderer/lib/ui'

/** The host's `insets` event: the window's safe-area insets in CSS px, and its word on the bars. */
export type HostInsets = Insets & { settling?: boolean }

/**
 * The host told the chrome its insets. Most reports say what the last did: Android dispatches
 * the window's insets again on every layout of its root – at each gesture's rest among them,
 * when the page's view is re-measured (PERF-1's seed: four writes to the root at every rest) –
 * so a report with the same four numbers writes nothing to the root (four custom properties
 * the whole chrome's style hangs on: a root write is a style recalc of the document) and sets
 * nothing in the store (a fresh object there is a render of every sheet and drawer reading
 * it). The landing's word is heard every time, as before: it judges the change itself.
 */
export function applyHostInsets(insets: HostInsets): boolean {
  const was = uiStore.get().insets
  const changed =
    was.top !== insets.top ||
    was.right !== insets.right ||
    was.bottom !== insets.bottom ||
    was.left !== insets.left
  if (changed) {
    uiStore.set({
      insets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left }
    })
    const root = document.documentElement.style
    root.setProperty('--zen-inset-top', `${insets.top}px`)
    root.setProperty('--zen-inset-right', `${insets.right}px`)
    root.setProperty('--zen-inset-bottom', `${insets.bottom}px`)
    root.setProperty('--zen-inset-left', `${insets.left}px`)
  }
  // The bars' way back from a page's fullscreen (lib/fullscreenLanding.ts): the content area's
  // rect, set as it is measured, is the layout's mark; the chrome's return fade waits for the
  // settled insets to have had their layout.
  noteInsetsSettling(insets.settling, () => contentAreaStore.get().area)
  return changed
}
