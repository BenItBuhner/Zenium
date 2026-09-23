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
 *
 * The host waits on the page's word up to a cap (`FullscreenHintCue.CAP_MS`) and cues without
 * one past it, taken as a video's: GN-20's once, never a toast over a second video's fullscreen
 * for a slow page. A `false` that trails the cap – the element had no video after all – comes
 * as a second cue marked `late`, and the toast the cap withheld goes up then (`FullscreenHintCues`),
 * unless the wordless cue's own already stands for this fullscreen: one hint per fullscreen.
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

/**
 * The cues per tab as the host sends them: a fresh cue (`fullscreen.entered`) decides as
 * `onFullscreenEntered` does and its outcome is kept for the tab; the late cue that a trailing
 * `false` brings shows the toast only when the fresh one showed nothing – the hint stands once
 * per fullscreen. A fresh cue always comes first for a fullscreen, so the memory needs no
 * clearing at the exit: the next fullscreen's own cue writes it over.
 */
export class FullscreenHintCues {
  /** The tabs whose last fresh cue showed the hint. */
  private readonly shown = new Set<string>()

  constructor(private readonly io: (tabId: string) => FullscreenHintIo) {}

  /** A cue for the tab; returns whether the hint went up. */
  entered(tabId: string, video: FullscreenVideoWord, late = false): boolean {
    if (late && this.shown.has(tabId)) return false
    const shown = onFullscreenEntered(this.io(tabId), video)
    if (shown) this.shown.add(tabId)
    else this.shown.delete(tabId)
    return shown
  }
}
