/** How long a key may stay down before what waits for its release runs anyway. */
export const KEY_RELEASE_TIMEOUT_MS = 300

/**
 * Runs `fn` once the key being pressed is released (its `keyup` reaches `target`), or after
 * `timeoutMs` should the release go elsewhere. The find bar closing on Escape hands the page
 * the keyboard this way: were the page focused while the key is still down, its release would
 * reach the page, and the engine leaves a page's fullscreen on any Escape event it is given.
 */
export function afterKeyRelease(
  fn: () => void,
  target: EventTarget = window,
  timeoutMs = KEY_RELEASE_TIMEOUT_MS
): void {
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    target.removeEventListener('keyup', finish, true)
    fn()
  }
  target.addEventListener('keyup', finish, true)
  setTimeout(finish, timeoutMs)
}
