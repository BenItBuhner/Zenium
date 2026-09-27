/**
 * The offline game's markup (ERR-03): the fragment the no-connection page and `zen://game`
 * carry, and the words the page script's runtime (`runtime.ts`) reads back. Kept apart from the
 * runtime so the page builder (`zenPages.ts`) carries no canvas code and the page script no
 * HTML beyond these few names.
 *
 * The fragment is inert until the runtime mounts it: a region (`role="application"`, so the
 * arrow keys and Space are the game's while it has focus – Chrome's desktop role,
 * `offline.ts:519-537`; its mobile `button` is not used, since the card inside holds a real
 * button) with the stage, the start hint, the game-over card and an assertive live region for
 * the score. The runtime finds the fragment by `GAME_MOUNT_ATTRIBUTE` and marks it mounted, so a
 * document that carries it twice, or is written twice, mounts each stage once.
 */

/** The attribute on the game's root by which the runtime finds it. */
export const GAME_MOUNT_ATTRIBUTE = 'data-zen-game'

/** The attribute the runtime sets on a root it has mounted. */
export const GAME_MOUNTED_ATTRIBUTE = 'data-zen-game-mounted'

/**
 * The key of the window message a document posts after writing the fragment in place (the
 * desktop's `chrome-error:` document, `inPlaceErrorPageScript`), so the page script mounts it
 * without watching the tree.
 */
export const GAME_MOUNT_MESSAGE_KEY = 'zeniumGame'

/** The message's value. */
export const GAME_MOUNT_MESSAGE = 'mount'

/** The region's label: what it is and how it is played, for a screen reader arriving on it. */
export const GAME_ARIA_LABEL =
  'Offline game. Press Space or tap to start; Space or Up jumps, Down ducks.'

/** The title of `zen://game` and of the game's tab. */
export const GAME_TITLE = 'Offline game'

/** The card's words. */
export const GAME_OVER_TITLE = 'Game over'
export const GAME_RETRY_LABEL = 'Retry'

/**
 * The fragment. The stage's size is the runtime's to set (it fits the content column, at most
 * 600 by 150); the hint's words too (they name the device's input). The card is hidden until a
 * crash; the live region is empty until then.
 */
export function gameMarkupHtml(): string {
  return (
    `<div class="zen-game" ${GAME_MOUNT_ATTRIBUTE} data-phase="waiting" role="application" tabindex="0" aria-label="${GAME_ARIA_LABEL}">` +
    '<canvas class="zen-game-stage" width="600" height="150" aria-hidden="true"></canvas>' +
    '<p class="zen-game-hint" aria-hidden="true"></p>' +
    `<div class="zen-game-over" hidden><h2 class="zen-game-over-title">${GAME_OVER_TITLE}</h2>` +
    '<p class="zen-game-over-score"></p>' +
    `<button type="button" class="zen-v2-button" data-primary data-zen-game-retry>${GAME_RETRY_LABEL}</button></div>` +
    '<div class="zen-game-live" aria-live="assertive" aria-atomic="true"></div>' +
    '</div>'
  )
}

/** The inline script that tells the page script the fragment is in the document. */
export function gameMountMessageScript(): string {
  return `window.postMessage({${GAME_MOUNT_MESSAGE_KEY}:${JSON.stringify(GAME_MOUNT_MESSAGE)}},'*')`
}

/** True for the mount message (`gameMountMessageScript`'s), whatever else the window hears. */
export function isGameMountMessage(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[GAME_MOUNT_MESSAGE_KEY] === GAME_MOUNT_MESSAGE
  )
}
