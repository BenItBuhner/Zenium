import { captureActiveTab, invalidateSnapshot, uiStore } from './ui'

/*
 * The page's way under "Hold ⌘Q to quit" when its renderer is hung (session-08; the design
 * lead's C4 on #486 and the first line's R3). Over a live page the page script paints the notice
 * itself and the view stays where it is – hiding it would drop the key up the hold waits for.
 * A hung renderer paints nothing new, so the chrome's twin takes the notice over
 * (`lib/quitHoldRoute.ts` `pageCanPaint`); but on the desktop the page's view composites above
 * the chrome and keeps its last frame painted there, over the twin, so for the hold's duration
 * the view gives way to its picture the way it does under the "Page unresponsive" prompt
 * (`lib/unresponsive.ts`): the page is captured – the compositor's last frame of it, what the
 * user was looking at when the page stopped – and the view hides behind the capture while
 * `quitHoldCover` stands (`overlayCoversContent` → the layout reporter's `contentHidden`; the
 * core gives the keyboard to the chrome with the hide and back to the page with the show, so the
 * chord's key up is heard either way). The twin draws over the picture with no dim, as the page
 * route's panel has no scrim. `ContentArea` opens the cover as a hold begins over a hung page
 * (`holdCoversPage`) and closes it as the hold is cancelled or ends.
 */

/**
 * How long the cover waits for the page's picture before the view hides over a blank frame: the
 * prompt's own wait. A hold is 1500 ms long; the notice must be on screen for most of it.
 */
const SNAPSHOT_WAIT_MS = 250

/**
 * Which open is current: an open that finishes after a close (the hold was released within the
 * wait for the picture) must not hide the page under a cover that has gone.
 */
let generation = 0

/** A hold began over the hung page `tabId`, in front: its picture, then the view gives way. */
export async function openQuitHoldCover(tabId: string): Promise<void> {
  const current = ++generation
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  if (current !== generation) return
  uiStore.set({ quitHoldCover: true })
}

/** The hold was released or ended: the live view comes back where its picture stood. */
export function closeQuitHoldCover(): void {
  generation++
  if (uiStore.get().quitHoldCover) uiStore.set({ quitHoldCover: false })
  invalidateSnapshot()
}
