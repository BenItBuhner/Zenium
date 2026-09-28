/**
 * Roll's markup (ERR-03, §9.17): the fragment the no-connection page and `zen://game` carry,
 * and the words the runtime (`runtime.ts`) reads back. Kept apart from the runtime so the page
 * builder (`zenPages.ts`) carries no canvas code and the runtime no HTML beyond these few names.
 *
 * The fragment is inert until the runtime mounts it: a region (`role="application"`, so the
 * arrow keys and Space are the game's while it has focus – Chrome's desktop role,
 * `offline.ts:519-537`; its mobile `button` is not used, since the card inside holds a real
 * button) with the stage, the start hint, the game-over card and an assertive live region for
 * the score. The runtime finds the fragment by `GAME_MOUNT_ATTRIBUTE` and marks it mounted, so a
 * document that carries it twice mounts each stage once.
 */

/** The attribute on the game's root by which the runtime finds it. */
export const GAME_MOUNT_ATTRIBUTE = 'data-zen-game'

/** The attribute the runtime sets on a root it has mounted. */
export const GAME_MOUNTED_ATTRIBUTE = 'data-zen-game-mounted'

/**
 * The attribute on the inline runtime's script tag (`inlineRuntime.ts`), by which a test pins
 * the runtime's presence on the two documents and its absence on every other, and by which the
 * preview host swaps in its posing stand-in.
 */
export const GAME_RUNTIME_ATTRIBUTE = 'data-zen-game-runtime'

/** The game's name, as the verdict fixed it: capitalised wherever it stands. */
export const GAME_NAME = 'Roll'

/** The title of `zen://game` and of the game's tab. */
export const GAME_TITLE = GAME_NAME

/**
 * The region's label: the game by name and how it is played, for a screen reader arriving on
 * it (§9.17: the label names the game and its inputs).
 */
export const GAME_ARIA_LABEL =
  'Roll, an offline game. Space or a tap starts and jumps, Down ducks, Enter plays again after a crash.'

/** The card's words. */
export const GAME_OVER_TITLE = 'Game over'
export const GAME_PLAY_AGAIN_LABEL = 'Play again'

/** The label of the meter's best (Chrome's `HI`), on the stage and on the card. */
export const GAME_BEST_LABEL = 'Best'

/**
 * The fragment. The stage's size is the runtime's to set (it fits the content column, at most
 * 600 by 150); the hint's words too (they name the device's input). The card is hidden until a
 * crash; the live region is empty until then. The region carries no theme of its own until the
 * night, when the runtime sets `data-theme` on it alone (`zenPages.ts` restates the tokens under
 * that attribute), so the page around it keeps its colours.
 */
export function gameMarkupHtml(): string {
  return (
    `<div class="zen-game" ${GAME_MOUNT_ATTRIBUTE} data-phase="waiting" role="application" tabindex="0" aria-label="${GAME_ARIA_LABEL}">` +
    '<canvas class="zen-game-stage" width="600" height="150" aria-hidden="true"></canvas>' +
    '<p class="zen-game-hint" aria-hidden="true"></p>' +
    `<div class="zen-game-over" hidden><h2 class="zen-game-over-title">${GAME_OVER_TITLE}</h2>` +
    '<p class="zen-game-over-score"></p>' +
    `<button type="button" class="zen-v2-button" data-primary data-zen-game-again>${GAME_PLAY_AGAIN_LABEL}</button></div>` +
    '<div class="zen-game-live" aria-live="assertive" aria-atomic="true"></div>' +
    '</div>'
  )
}
