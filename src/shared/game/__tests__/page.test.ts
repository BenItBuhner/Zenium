import { describe, expect, it } from 'vitest'
import {
  GAME_ARIA_LABEL,
  GAME_MOUNT_ATTRIBUTE,
  GAME_MOUNT_MESSAGE,
  GAME_MOUNT_MESSAGE_KEY,
  GAME_MOUNTED_ATTRIBUTE,
  gameMarkupHtml,
  gameMountMessageScript,
  isGameMountMessage
} from '../page'

describe('the game fragment', () => {
  it('is a region with the stage, the hint, the card and the live region, unmounted', () => {
    const html = gameMarkupHtml()
    expect(
      html.startsWith(`<div class="zen-game" ${GAME_MOUNT_ATTRIBUTE} data-phase="waiting"`)
    ).toBe(true)
    expect(html).toContain(`role="application" tabindex="0" aria-label="${GAME_ARIA_LABEL}"`)
    expect(html).not.toContain(GAME_MOUNTED_ATTRIBUTE)
    expect(html).toContain('<canvas class="zen-game-stage"')
    expect(html).toContain('aria-hidden="true"></canvas>')
    expect(html).toContain('<p class="zen-game-hint" aria-hidden="true"></p>')
    expect(html).toContain('<div class="zen-game-over" hidden>')
    expect(html).toContain('<h2 class="zen-game-over-title">Game over</h2>')
    expect(html).toContain('<p class="zen-game-over-score"></p>')
    expect(html).toContain(
      '<button type="button" class="zen-v2-button" data-primary data-zen-game-retry>Retry</button>'
    )
    expect(html).toContain('aria-live="assertive" aria-atomic="true"')
    // No script: the page script's runtime brings it to life.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
  })

  it('names its input in the label for a screen reader', () => {
    expect(GAME_ARIA_LABEL).toMatch(/Space/)
    expect(GAME_ARIA_LABEL).toMatch(/tap/)
    expect(GAME_ARIA_LABEL).toMatch(/Down ducks/)
  })
})

describe('the mount message', () => {
  it('is posted on the window under its key and read back by it alone', () => {
    expect(gameMountMessageScript()).toBe(
      `window.postMessage({${GAME_MOUNT_MESSAGE_KEY}:"mount"},'*')`
    )
    expect(isGameMountMessage({ [GAME_MOUNT_MESSAGE_KEY]: GAME_MOUNT_MESSAGE })).toBe(true)
    expect(isGameMountMessage({ [GAME_MOUNT_MESSAGE_KEY]: 'unmount' })).toBe(false)
    expect(isGameMountMessage({ zeniumInterstitial: { action: 'back' } })).toBe(false)
    expect(isGameMountMessage(null)).toBe(false)
    expect(isGameMountMessage('mount')).toBe(false)
  })
})
