/**
 * The smoke's one-shot navigation retry.
 *
 * A single `did-fail-load` with a network error (a TLS handshake reset on example.com,
 * `ERR_CONNECTION_RESET` -101) on a GitHub runner is a network hiccup, not a regression: the same
 * run then loads the same site in well under a second. The boot step therefore retries the
 * navigation ONCE when the tab it opened fails its main-frame load with a net error, and reports
 * the retry in the step's detail so the artifacts still show it. A second failure fails the step.
 */

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
