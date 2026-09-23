import { fullscreenExitHint, type PageHint } from '@shared/fullscreenHint'
import type { Settings } from '@shared/types'

/*
 * The exit hint for a page in fullscreen: the host reports the engine's fullscreen view going up
 * (`fullscreen.entered`, `Host.enterFullscreen`) with the page's word on what is fullscreen –
 * a video (`video: true`), an element without one (`false`: a game's canvas, a slide deck), or
 * nothing said yet (`null`) – and the chrome answers with the toast, drawn in the page's top
 * layer by the page script (`shared/pageHint.ts`), since the chrome itself is under the
 * fullscreen layer.
 *
 * A video's fullscreen has the hint the first time ever (GN-20), recorded in
 * `settings.fullscreenHintDone` as the gesture hint (FRE-07) records its own: the video's
 * controls carry their own way out. An element without a video has nothing of the kind, so the
 * hint stands every time (MED-03), as Chrome's toast does for a page's fullscreen; it counts as
 * the hint's showing too, so the first video after it does not repeat the same words. The record
 * is written before the hint is posted, so a second report inside the settings' round trip
 * cannot show it twice.
 */

/** The page's word on the fullscreen element: a video, none, or nothing said (yet). */
export type FullscreenVideoWord = boolean | null

/** Whether the hint is owed: always for an element without a video, else until it has had its showing. */
export function fullscreenHintDue(
  settings: Pick<Settings, 'fullscreenHintDone'>,
  video: FullscreenVideoWord = null
): boolean {
  return video === false || !settings.fullscreenHintDone
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

/** A page went fullscreen: the hint goes up if it is owed. Returns whether it did. */
export function onFullscreenEntered(
  io: FullscreenHintIo,
  video: FullscreenVideoWord = null
): boolean {
  if (!fullscreenHintDue(io.settings(), video)) return false
  if (!io.settings().fullscreenHintDone) io.markShown()
  io.post(fullscreenExitHint(io.dark()))
  return true
}
