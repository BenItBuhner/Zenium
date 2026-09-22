import { fullscreenExitHint, type PageHint } from '@shared/fullscreenHint'
import type { Settings } from '@shared/types'

/*
 * The exit hint for a page in fullscreen (GN-20, MED-03): the host reports the engine's
 * fullscreen view going up (`fullscreen.entered`, `Host.enterFullscreen`) with the page's word
 * on what is in it – a video, or any other element (a canvas, a slide deck, an embed without
 * one) – and the chrome answers with the toast, "Swipe down or press back to exit full screen",
 * drawn in the page's top layer by the page script (`shared/pageHint.ts`), since the chrome
 * itself is under the fullscreen layer. A video's fullscreen shows it the first time ever (GN-20),
 * recorded in `settings.fullscreenHintDone` as the gesture hint (FRE-07) records its own; any
 * other element's shows it every time (MED-03, as Chrome for Android's toast does), and counts
 * as the first showing too – the way out has been shown. The record is written before the hint
 * is posted, so a second report inside the settings' round trip cannot show it twice.
 */

/** Whether the first-time hint is still owed: it has not had its showing. */
export function fullscreenHintDue(settings: Pick<Settings, 'fullscreenHintDone'>): boolean {
  return !settings.fullscreenHintDone
}

/** What the decision reads and does; the platform hands in the core's, the tests their own. */
export interface FullscreenHintIo {
  settings(): Pick<Settings, 'fullscreenHintDone'>
  dark(): boolean
  /** Record the showing (`settings.update`). */
  markShown(): void
  /** Draw the hint over the page (`view.postMessage`, a `hint` page message). */
  post(hint: PageHint): void
}

/**
 * A page went fullscreen, on a video (`video`) or on any other element: the toast goes up if
 * the element is not a video's, or if the first-time hint is still owed. Returns whether it did.
 */
export function onFullscreenEntered(io: FullscreenHintIo, video: boolean): boolean {
  const due = fullscreenHintDue(io.settings())
  if (video && !due) return false
  if (due) io.markShown()
  io.post(fullscreenExitHint(io.dark()))
  return true
}
