/**
 * The smoke's navigation helpers: the way a URL goes into a tab of its own, and the one-shot
 * navigation retry.
 *
 * A single `did-fail-load` with a network error (a TLS handshake reset on example.com,
 * `ERR_CONNECTION_RESET` -101) on a GitHub runner is a network hiccup, not a regression: the same
 * run then loads the same site in well under a second. The boot step therefore retries the
 * navigation ONCE when the tab it opened fails its main-frame load with a net error, and reports
 * the retry in the step's detail so the artifacts still show it. A second failure fails the step.
 */

/** The new tab page's URL as the core has it (`shared/url.ts`: NEW_TAB_URL). */
export const NEW_TAB_URL = 'zen://newtab'

/** `shared/url.ts`'s isNewTabUrl: a new tab page's URL, bare or with a path or a query. */
export function isNewTabUrl(url) {
  return (
    typeof url === 'string' &&
    (url === NEW_TAB_URL || url.startsWith(`${NEW_TAB_URL}/`) || url.startsWith(`${NEW_TAB_URL}?`))
  )
}

/**
 * How `openUrlInNewTab` gets its URL into a tab, from what the URL bar shows as it starts:
 * `barVisible` (the field is on screen) and `submitTabUrl`, the URL of the tab a submit acts on
 * in place – the field's `data-zen-menu-tab`, which Urlbar.tsx sets exactly when a submit does
 * not open a new tab (`submitsToNewTab`: in edit mode over a page, or in new-tab mode over a new
 * tab page) – null when a submit opens a new tab, '' for a tab the app state does not list.
 *
 *   way `use`            the bar is up: its field is focused and takes the URL, Enter. Over the
 *                        blank tab the onboarding or a fresh window leaves (`rowsAfter: 'same'`)
 *                        that tab loads the page in place; with no tab of its own
 *                        (`'one-more'`) the submit opens one.
 *   way `close-then-new` the bar is up over a page's own address (a submit would replace that
 *                        page): closed, then Accel+T (`'one-more'`).
 *   way `new`            the bar is down: Accel+T (`'one-more'`).
 *
 * A bar that is up is used, never closed with Escape first: Escape closes the bar only from its
 * own field (the chrome's document-level Escape stands back while the bar is open), and the
 * field could have lost the keyboard while the bar stayed up – the chrome used to blur its
 * focused control whenever a page's view took the keyboard (`focus.page`), which the new tab
 * page adopted at the onboarding's end does a moment after the new-tab bar focused its field.
 * One Escape and a 5 s wait for the bar to hide then ran out (main red on 9bdc1c30, 630b7dd7
 * and 7669e6b4). The chrome now keeps the bar's field through that event and takes the keyboard
 * back (lib/panes.ts pageTookKeyboard); the harness still uses the bar as it finds it, and reads
 * the caret before it touches the field (`caretVerdict`).
 */
export function newTabPlan({ barVisible, submitTabUrl }) {
  if (!barVisible) return { way: 'new', rowsAfter: 'one-more' }
  if (submitTabUrl === null || submitTabUrl === undefined) {
    return { way: 'use', rowsAfter: 'one-more' }
  }
  if (isNewTabUrl(submitTabUrl)) return { way: 'use', rowsAfter: 'same' }
  return { way: 'close-then-new', rowsAfter: 'one-more' }
}

/**
 * The keyboard owner (smoke.mjs Session.keyboardOwner) that is the URL bar's field with its
 * caret: the chrome page holds the keyboard – not a page's view – and the field is the
 * document's active element. Either alone is a bar the user cannot type into.
 */
export const URLBAR_FIELD_OWNER = 'chrome:urlbar-input'

/**
 * A step's detail as it is, or the step's failure when a URL bar the step typed into had no
 * caret: `carets` are the readings `openUrlInNewTab` took before the harness focused the field
 * (`{ focused, owner, ms, bar }`; by default the one at `detail.caret`), and the error carries
 * the detail so the step keeps what it gathered. Thrown once the step's work is done – the page
 * loaded and on screen all the same, through the harness's focus-first way into the field
 * (#342) – so the scenarios that build on the step go on and a regression is one failure, named
 * where it is: the new tab's URL bar up with no caret, the state main's boot smoke was in three
 * times on 2026-09-22 before lib/panes.ts pageTookKeyboard kept the field from the page's view.
 */
export function caretVerdict(detail, carets = [detail.caret]) {
  const missing = carets.find((caret) => caret && !caret.focused)
  if (!missing) return detail
  const bar = missing.bar === 'accel-t' ? 'brought up with Accel+T' : 'found up'
  const error = new Error(
    `the URL bar ${bar} had no caret: the keyboard was ${missing.owner} for the ${missing.ms} ms before the harness focused the field`
  )
  error.detail = detail
  throw error
}

/** The sidebar rows a plan ends with: `rowsBefore` when the blank tab took the URL, one more otherwise. */
export function rowsExpected(rowsBefore, plan) {
  return plan.rowsAfter === 'same' ? rowsBefore : rowsBefore + 1
}

/** Chromium's `ERR_ABORTED`: a navigation replaced by another, never a network fault. */
export const ERR_ABORTED = -3

/**
 * Whether a `did-fail-load` event (as `hookMain` records it: `{ type, wc, code, desc, url,
 * isMain }`) is a network failure of the main frame for `url` – what one retry may cure.
 */
export function isRetryableFailLoad(event, url) {
  if (!event || event.type !== 'did-fail-load' || !event.isMain) return false
  if (typeof event.code !== 'number' || event.code >= 0 || event.code === ERR_ABORTED) return false
  return typeof event.url === 'string' && event.url.startsWith(url)
}

/** The first retryable failure among `events` for `url`, or null. */
export function firstRetryableFailLoad(events, url) {
  for (const event of events) if (isRetryableFailLoad(event, url)) return event
  return null
}

/**
 * One line for the step's detail: which error the retry answered.
 * `{ code: -101, desc: 'ERR_CONNECTION_RESET' }` → `retried once after did-fail-load -101 ERR_CONNECTION_RESET`.
 */
export function retryDetail(event) {
  return `retried once after did-fail-load ${event.code} ${event.desc ?? ''}`.trim()
}

/**
 * Wait for `loaded()` to report the tab at `url`, watching `events()` (the main-process event
 * log, from a watermark the caller took before navigating) for a retryable failure; on the first
 * one run `retry()` and keep waiting, once. Resolves `{ tab, retried }`; rejects when the budget
 * runs out, naming the failures seen.
 */
export async function waitForTabWithRetry({
  url,
  loaded,
  events,
  retry,
  timeoutMs,
  intervalMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  const deadline = now() + timeoutMs
  let retried = null
  const seen = new Set()
  for (;;) {
    const tab = await loaded()
    if (tab) return { tab, retried }
    const failure = firstRetryableFailLoad(
      (await events()).filter((e) => !seen.has(e)),
      url
    )
    if (failure) {
      seen.add(failure)
      if (retried) {
        throw new Error(
          `tab ${url} failed to load twice: ${retryDetail(retried)}, then did-fail-load ${failure.code} ${failure.desc ?? ''}`.trim()
        )
      }
      retried = failure
      await retry(failure)
    }
    if (now() >= deadline) break
    await sleep(intervalMs)
  }
  throw new Error(
    `tab ${url} loaded (not within ${timeoutMs} ms${retried ? `; ${retryDetail(retried)}` : ''})`
  )
}
