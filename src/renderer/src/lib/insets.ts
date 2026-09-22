import { noteInsetsSettling } from '@renderer/lib/fullscreenLanding'
import { contentAreaStore, uiStore, type Insets } from '@renderer/lib/ui'

/**
 * The host's `insets` event: the window's safe-area insets in CSS px, its word on the bars
 * (`settling`), and whether the chrome is to hold its layout as they stand (`held`).
 */
export type HostInsets = Insets & { settling?: boolean; held?: boolean }

/**
 * The host told the chrome its insets. Most reports say what the last did: Android dispatches
 * the window's insets again on every layout of its root – at each gesture's rest among them,
 * when the page's view is re-measured (PERF-1's seed: four writes to the root at every rest) –
 * so a report with the same four numbers writes nothing to the root (four custom properties
 * the whole chrome's style hangs on: a root write is a style recalc of the document) and sets
 * nothing in the store (a fresh object there is a render of every sheet and drawer reading
 * it). The landing's word is heard every time, as before: it judges the change itself.
 *
 * A report marked `held` is the system bars sliding away under a page's fullscreen layer
 * (`MainActivity.applyInsets`, MOT-32): the chrome under the layer keeps the layout it had, so
 * its bar translates off a frame that does not move (`lib/fullscreenHide.ts`) and nothing is
 * laid out in the enter; the numbers are not written. The event itself is delivered and heard
 * in order like every other (#277: nothing in the fullscreen path drops or reorders the host's
 * insets); the first report after the layer has gone carries the insets as they stand then and
 * is written as any change is. Returns whether the root's insets were written.
 */
export function applyHostInsets(insets: HostInsets): boolean {
  const was = uiStore.get().insets
  const changed =
    !insets.held &&
    (was.top !== insets.top ||
      was.right !== insets.right ||
      was.bottom !== insets.bottom ||
      was.left !== insets.left)
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
