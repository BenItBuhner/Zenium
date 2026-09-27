import { describe, expect, it } from 'vitest'
import {
  GAME_ARIA_LABEL,
  GAME_BEST_LABEL,
  GAME_MOUNT_ATTRIBUTE,
  GAME_MOUNTED_ATTRIBUTE,
  GAME_NAME,
  GAME_OVER_TITLE,
  GAME_PLAY_AGAIN_LABEL,
  GAME_RUNTIME_ATTRIBUTE,
  GAME_TITLE,
  gameMarkupHtml
} from '../page'

describe('the game fragment', () => {
  it('is a region with the stage, the hint, the card and the live region, unmounted', () => {
    const html = gameMarkupHtml()
    expect(
      html.startsWith(`<div class="zen-game" ${GAME_MOUNT_ATTRIBUTE} data-phase="waiting"`)
    ).toBe(true)
    expect(html).toContain(`role="application" tabindex="0" aria-label="${GAME_ARIA_LABEL}"`)
    expect(html).not.toContain(GAME_MOUNTED_ATTRIBUTE)
    expect(html).not.toContain(GAME_RUNTIME_ATTRIBUTE)
    expect(html).toContain('<canvas class="zen-game-stage"')
    expect(html).toContain('aria-hidden="true"></canvas>')
    expect(html).toContain('<p class="zen-game-hint" aria-hidden="true"></p>')
    expect(html).toContain('<div class="zen-game-over" hidden>')
    expect(html).toContain(`<h2 class="zen-game-over-title">${GAME_OVER_TITLE}</h2>`)
    expect(html).toContain('<p class="zen-game-over-score"></p>')
    expect(html).toContain(
      '<button type="button" class="zen-v2-button" data-primary data-zen-game-again>Play again</button>'
    )
    expect(html).toContain('aria-live="assertive" aria-atomic="true"')
    // No script of its own: the inline runtime (`inlineRuntime.ts`) brings it to life.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
  })

  it("is named Roll wherever it stands, and the card's primary reads 'Play again' (§9.17 (e))", () => {
    expect(GAME_NAME).toBe('Roll')
    expect(GAME_TITLE).toBe('Roll')
    expect(GAME_PLAY_AGAIN_LABEL).toBe('Play again')
    expect(GAME_OVER_TITLE).toBe('Game over')
    expect(GAME_BEST_LABEL).toBe('Best')
    expect(gameMarkupHtml()).not.toMatch(/Retry|Offline game|HI\b/)
  })

  it('names the game and its inputs in the label for a screen reader (§9.17 (j))', () => {
    expect(GAME_ARIA_LABEL.startsWith('Roll, ')).toBe(true)
    expect(GAME_ARIA_LABEL).toMatch(/Space/)
    expect(GAME_ARIA_LABEL).toMatch(/tap/)
    expect(GAME_ARIA_LABEL).toMatch(/Down ducks/)
    expect(GAME_ARIA_LABEL).toMatch(/Enter plays again/)
  })
})
