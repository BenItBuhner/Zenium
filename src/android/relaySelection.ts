/**
 * Whether a request the request stage let through is relayed for its response
 * (`Verdict.MediaRelay`; `blocking-rule-interface.md` 7.2 as 7.10 amends it) – the runtime's
 * twin of the Kotlin engine's `blocking/RelaySelection.kt`. One pure function of five facts,
 * written twice on purpose, with one truth table pinned in both tests
 * (`__tests__/relaySelection.test.ts`, `BlockingTest.kt`): the engine chooses with it what to
 * relay; the runtime, which hears the page script's observation of a `fetch` / XHR, tells with
 * it which of those the relay already served, so the two sources never report one response
 * twice.
 *
 * The facts, as the intercept has them (`WebResourceRequest.requestHeaders`):
 * - `allowed`: the request stage's answer is ALLOW – the rules', and no `onBeforeRequest`
 *   listener cancelled or redirected it;
 * - `mainFrame`: a document – the main frame's, or a frame's: never relayed;
 * - `method`: `GET` only;
 * - `hasRange`: the request carries `Range` – what a media element sends (`bytes=0-` first, the
 *   seek's range after) and a `fetch` / XHR normally does not;
 * - `hasOrigin`: the request carries `Origin` – what a cors-mode `fetch` / XHR sends
 *   cross-origin (round 14, Table 1 of `internal/extensions/webrequest-page-visible-measurements.md`:
 *   present on 12 of 12 cross-origin fetch / XHR loads, absent on every media-element and
 *   same-origin load, on WebView 113 and 156 alike), and a `crossorigin` element load sends too.
 *   `Origin` present is a page script's request, or an element's the sniffer misses (the
 *   recorded gap): never relayed.
 *
 * No type in it: the runtime has no engine type for a page-script observation, so a `Range` GET
 * typed image, script, style or font by its `Accept` or extension (nothing but a range-reading
 * script sends one) is relayed like the ambiguous request.
 */
export function selects(
  allowed: boolean,
  mainFrame: boolean,
  method: string,
  hasRange: boolean,
  hasOrigin: boolean
): boolean {
  return allowed && !mainFrame && method === 'GET' && hasRange && !hasOrigin
}

/**
 * What the page script's observer reports of a `fetch` / XHR the page made, as far as the relay
 * selection needs it (`blocking-rule-interface.md` 7.10 names the fields; the observer and its
 * emission are the extension program's).
 */
export interface ScriptRequestObservation {
  tabId: string | null
  url: string
  method: string
  /** The page's `Range` request header, or null when it set none. */
  range: string | null
  /**
   * Whether the request's URL is of another origin than the page's. A cors-mode request – every
   * XHR, a `fetch` unless `mode: 'no-cors'` – then carried `Origin` (round 14: 12 of 12); a
   * no-cors one did not, and a ranged one of those is the recorded gap: relayed, and not told so
   * here.
   */
  crossOrigin: boolean
}

/**
 * Whether the relay served the request the page script observed – then its response comes from
 * the Kotlin engine (`ext.response`, §7.5) and the observation is dropped. A request the page's
 * script could observe was let through (a blocked one failed in the page, and the page script
 * sees no document): the `Range` header stands for `hasRange`, `crossOrigin` for `hasOrigin`.
 */
export function relayServedObservation(observation: ScriptRequestObservation): boolean {
  return selects(
    true,
    false,
    observation.method,
    observation.range !== null,
    observation.crossOrigin
  )
}
