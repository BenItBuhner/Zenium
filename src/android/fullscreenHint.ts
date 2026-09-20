import { fullscreenExitHint, type PageHint } from '@shared/fullscreenHint'
import type { Settings } from '@shared/types'

/*
 * The first-time exit hint for a page in fullscreen (GN-20): the host reports the engine's
 * fullscreen view going up (`fullscreen.entered`, `Host.enterFullscreen` – a video's, a canvas's
 * or an embed's alike, since every fullscreen is left the same way) and, the first time ever,
 * the chrome answers with the toast – drawn in the page's top layer by the page script
 * (`shared/pageHint.ts`), since the chrome itself is under the fullscreen layer – and records
 * the showing in `settings.fullscreenHintDone`, as the gesture hint (FRE-07) records its own.
 * The record is written before the hint is posted, so a second report inside the settings'
 * round trip cannot show it twice.
 */

/** Whether the hint is still owed: it has not had its showing. */
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

/** A page went fullscreen: the hint goes up if it is still owed. Returns whether it did. */
export function onFullscreenEntered(io: FullscreenHintIo): boolean {
  if (!fullscreenHintDue(io.settings())) return false
  io.markShown()
  io.post(fullscreenExitHint(io.dark()))
  return true
}
