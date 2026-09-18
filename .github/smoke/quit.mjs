// The parts of the smoke's graceful quit that need no running app.
//
// Once the app is quitting, Playwright's connections to it – the Node inspector session behind
// electronApplication.evaluate and the DevTools session behind every page call – close before the
// process exits; on a slow runner (windows-11-arm) several seconds before. A call in flight at
// that moment rejects with "Target page, context or browser has been closed". That is the quit
// happening, not a failure, and it says nothing about whether the process is gone yet: the exit
// event of the process is the only evidence the quit finished (#148, #157).

/** Playwright's message for a call whose page, context or browser closed under it. */
export const TARGET_CLOSED_MESSAGE = 'Target page, context or browser has been closed'

/**
 * Is `err` Playwright's closed-target rejection? The message carries the API name before it
 * (`electronApplication.evaluate: …`, `locator.waitFor: …`) and, from the main-process session,
 * the browser log after it.
 */
export function isTargetClosedError(err) {
  const message =
    err !== null && typeof err === 'object' && 'message' in err
      ? String(err.message)
      : String(err ?? '')
  return message.includes(TARGET_CLOSED_MESSAGE)
}

/**
 * `promise`, a Playwright call made while the app may already be quitting, except that losing
 * its target resolves it to `fallback`: the quit taking the target away is the outcome the call
 * was after, and the exit event is what confirms it. Any other rejection propagates.
 */
export function unlessTargetClosed(promise, fallback = undefined) {
  return promise.catch((e) => {
    if (isTargetClosedError(e)) return fallback
    throw e
  })
}

/**
 * The process exit `exitPromise` resolves with, or null once `budgetMs` have passed since
 * `since` without it. An exit that has already happened wins over a budget that has already run
 * out; the timer never keeps the event loop alive past the exit.
 */
export function exitWithin(exitPromise, budgetMs, since = Date.now()) {
  const left = Math.max(0, since + budgetMs - Date.now())
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), left)
  })
  return Promise.race([exitPromise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * What `probe`, an evaluate in the app's main process, says about it: 'responsive' when it
 * answered, 'blocked' when it had not within `timeoutMs` (a modal native dialog holds the event
 * loop), 'gone' when Playwright lost the target (the app is quitting, or has quit without the
 * process exiting yet), otherwise the error.
 */
export function mainProcessState(probe, timeoutMs) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('blocked'), timeoutMs)
  })
  const answer = probe.then(
    () => 'responsive',
    (e) => (isTargetClosedError(e) ? 'gone' : `error: ${e && e.message ? e.message : e}`)
  )
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer))
}
