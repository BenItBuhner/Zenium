/**
 * Roll's bridge to the browser (ERR-03, §9.17): the one thing the game asks of its host is the
 * profile's best score – Chrome keeps its runner's in the profile's prefs
 * (`net.easter_egg_high_score`, `offline.ts:1520-1560`), never in a document origin's storage,
 * and so does Zenium: the number is a synced setting (`Settings.gameBestScore`), one across the
 * no-connection page and `zen://game` on every device.
 *
 * The page's runtime is inline in the document (`inlineRuntime.ts`) and has no channel of its
 * own, so it speaks through the page script's relay as the warning pages do
 * (`installInterstitialRelay`): a window message under `GAME_MESSAGE_KEY`, which the page script
 * forwards as a `game` page message when the document is Zenium's (`zen:`). The core answers
 * through the document's window (`window.zenGameBest(n)`, run with `executeJavaScript`, as the
 * reader's preferences reach `window.zenReaderApply`). Two messages: the ask at mount, and the
 * report at a crash. Pure, so every side is a unit test.
 */

/** The key of the window message the runtime posts (`{ zeniumGame: … }`). */
export const GAME_MESSAGE_KEY = 'zeniumGame'

/** The global the core calls on the document with the profile's best. */
export const GAME_BEST_CALLBACK = 'zenGameBest'

/** The meter has five digits (Chrome's `MAX_DISTANCE_UNITS`); a best past it is not a score. */
export const GAME_BEST_MAX = 99999

/** The runtime asks for the profile's best (at mount). */
export interface GameBestAsk {
  ask: 'best'
}

/** The runtime reports a run's best (at a crash), for the profile to keep if higher. */
export interface GameBestReport {
  best: number
}

export type GameWindowMessage = GameBestAsk | GameBestReport

/** A best score read from anywhere untrusted: a whole number in the meter's range, else 0. */
export function sanitizeGameBestScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(GAME_BEST_MAX, Math.floor(value)))
}

/** The game's message in a window message's data, or null for anything else the window hears. */
export function gameMessageOf(data: unknown): GameWindowMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const message = (data as Record<string, unknown>)[GAME_MESSAGE_KEY]
  return readGameMessage(message)
}

/** A `game` page message's payload as the core reads it, or null when it is not one. */
export function readGameMessage(message: unknown): GameWindowMessage | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  if (m.ask === 'best') return { ask: 'best' }
  if (typeof m.best === 'number' && Number.isFinite(m.best))
    return { best: sanitizeGameBestScore(m.best) }
  return null
}

/** The window message's data for a message. */
export function gameWindowMessage(message: GameWindowMessage): Record<string, GameWindowMessage> {
  return { [GAME_MESSAGE_KEY]: message }
}

/** The script the core runs in the document to hand it the profile's best. */
export function gameBestScript(best: number): string {
  const n = sanitizeGameBestScore(best)
  return `window.${GAME_BEST_CALLBACK}&&window.${GAME_BEST_CALLBACK}(${n})`
}
