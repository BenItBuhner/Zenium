/**
 * Roll's keeper of the best score (ERR-03, design language v2 §9.17): "the best score is the
 * profile's, host-kept and synced like Chrome's `net.easter_egg_high_score`, never a document
 * origin's storage". The number is a synced setting (`Settings.gameBestScore`, `defaults.ts`,
 * sanitised at load in `state.ts`, carried by the settings sync record like any other key), so
 * it is one across the no-connection page and `zen://game` on every device of the profile.
 *
 * The page's inline runtime asks at mount and reports at a crash through the page script's
 * relay (`shared/game/bridge.ts` → `handlePageMessage` → here); the answer goes back through the
 * document's window (`window.zenGameBest(n)`, `executeJavaScript`, as the reader's preferences
 * reach `window.zenReaderApply`). Every message is answered with the profile's best as it stands
 * after it – a report of a lesser run gets the standing best back, a report that raised it gets
 * its own number – so a stage never shows less than the profile holds.
 *
 * The best only rises. A peer's lower number that wins a key-by-key sync round lands (the
 * record says so) and this device's higher one is written again a moment later as an edit of
 * its own (`raiseAfterApply`), stamped fresh by the engine, so every device converges on the
 * highest: the sync's last-writer-wins is kept for the record, the game's max for the number.
 */

import type { Browser } from './browser'
import { defer } from './platform'
import { gameBestScript, readGameMessage, sanitizeGameBestScore } from '../shared/game/bridge'

export class GameService {
  constructor(private readonly browser: Browser) {}

  /** The profile's best, as the settings hold it (always a whole number in the meter's range). */
  best(): number {
    return sanitizeGameBestScore(this.browser.state.settings.gameBestScore)
  }

  /**
   * A page message from the relay (`handlePageMessage`): a report raises the best if higher; the
   * ask and the report alike are answered with the standing best on the tab's document.
   */
  handleMessage(tabId: string, message: unknown): void {
    const game = readGameMessage(message)
    if (!game) return
    if ('best' in game) this.raise(game.best)
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    void view.executeJavaScript(gameBestScript(this.best())).catch(() => {
      // The document went away or refused the script: nothing to answer any more.
    })
  }

  /** A run's best, or a peer's: raises the profile's, never lowers it. True when it changed. */
  raise(best: number): boolean {
    const n = sanitizeGameBestScore(best)
    if (n <= this.best()) return false
    this.browser.state.settings.gameBestScore = n
    this.browser.state.commit()
    return true
  }

  /**
   * The sync landed a peer's lower best over this device's `own` (`applyRemote`): the higher one
   * is written back once the round has taken its snapshot – a macrotask later, when the
   * engine's `applying` guard is down and the landed value is what its metadata holds – so the
   * write is an edit of this device's, stamped now, and the peers take it next round.
   */
  raiseAfterApply(own: number): void {
    const n = sanitizeGameBestScore(own)
    if (n === 0) return
    defer(() => {
      this.raise(n)
    })
  }
}
