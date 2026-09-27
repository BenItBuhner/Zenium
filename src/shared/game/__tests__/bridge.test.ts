import { describe, expect, it } from 'vitest'
import {
  GAME_BEST_CALLBACK,
  GAME_BEST_MAX,
  GAME_MESSAGE_KEY,
  gameBestScript,
  gameMessageOf,
  gameWindowMessage,
  readGameMessage,
  sanitizeGameBestScore
} from '../bridge'

describe("Roll's bridge (§9.17 (i)): the best score between the page and the browser", () => {
  it('reads a best from anywhere untrusted as a whole number in the meter’s range, else 0', () => {
    expect(GAME_BEST_MAX).toBe(99999)
    expect(sanitizeGameBestScore(420)).toBe(420)
    expect(sanitizeGameBestScore(12.9)).toBe(12)
    expect(sanitizeGameBestScore(0)).toBe(0)
    expect(sanitizeGameBestScore(-1)).toBe(0)
    expect(sanitizeGameBestScore(1e9)).toBe(99999)
    expect(sanitizeGameBestScore(Number.NaN)).toBe(0)
    expect(sanitizeGameBestScore(Infinity)).toBe(0)
    expect(sanitizeGameBestScore('420')).toBe(0)
    expect(sanitizeGameBestScore(null)).toBe(0)
    expect(sanitizeGameBestScore(undefined)).toBe(0)
    expect(sanitizeGameBestScore({ best: 3 })).toBe(0)
  })

  it('posts under its own key and reads back its two messages alone', () => {
    expect(GAME_MESSAGE_KEY).toBe('zeniumGame')
    expect(gameWindowMessage({ ask: 'best' })).toEqual({ zeniumGame: { ask: 'best' } })
    expect(gameWindowMessage({ best: 42 })).toEqual({ zeniumGame: { best: 42 } })
    expect(gameMessageOf(gameWindowMessage({ ask: 'best' }))).toEqual({ ask: 'best' })
    expect(gameMessageOf(gameWindowMessage({ best: 42 }))).toEqual({ best: 42 })
    // Not the game's: the warning pages' relay message, a string, nothing, another key.
    expect(gameMessageOf({ zeniumInterstitial: { action: 'back' } })).toBeNull()
    expect(gameMessageOf('zeniumGame')).toBeNull()
    expect(gameMessageOf(null)).toBeNull()
    expect(gameMessageOf(undefined)).toBeNull()
    expect(gameMessageOf({ zeniumGame: 'mount' })).toBeNull()
    expect(gameMessageOf({ zeniumGame: { ask: 'everything' } })).toBeNull()
  })

  it('sanitises a report as the core reads it, and refuses what is neither ask nor report', () => {
    expect(readGameMessage({ ask: 'best' })).toEqual({ ask: 'best' })
    expect(readGameMessage({ best: 77.7 })).toEqual({ best: 77 })
    expect(readGameMessage({ best: -5 })).toEqual({ best: 0 })
    expect(readGameMessage({ best: 123456 })).toEqual({ best: 99999 })
    expect(readGameMessage({ best: '77' })).toBeNull()
    expect(readGameMessage({ best: Number.NaN })).toBeNull()
    expect(readGameMessage({})).toBeNull()
    expect(readGameMessage(null)).toBeNull()
    expect(readGameMessage(42)).toBeNull()
  })

  it("writes the answer as a call of the document's callback, the number sanitised", () => {
    expect(GAME_BEST_CALLBACK).toBe('zenGameBest')
    expect(gameBestScript(123)).toBe('window.zenGameBest&&window.zenGameBest(123)')
    expect(gameBestScript(0)).toBe('window.zenGameBest&&window.zenGameBest(0)')
    expect(gameBestScript(12.5)).toBe('window.zenGameBest&&window.zenGameBest(12)')
    expect(gameBestScript(Number.NaN)).toBe('window.zenGameBest&&window.zenGameBest(0)')
    expect(gameBestScript(1e12)).toBe('window.zenGameBest&&window.zenGameBest(99999)')
  })
})
