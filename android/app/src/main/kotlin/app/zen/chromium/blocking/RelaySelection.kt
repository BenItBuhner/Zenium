package app.zen.chromium.blocking

/**
 * Whether a request the request stage let through is relayed for its response
 * ([Verdict.MediaRelay]; `blocking-rule-interface.md` 7.2 as 7.10 amends it). One pure function
 * of five facts, written twice on purpose – here and in `src/android/relaySelection.ts` – with
 * one truth table pinned in both tests: the runtime, which hears the page script's observation
 * of a `fetch` / XHR, has to know which of those the relay already served, so the two sources
 * never report one response twice.
 *
 * The facts, as the intercept has them (`WebResourceRequest.requestHeaders`):
 * - `allowed`: the request stage's answer is ALLOW – the rules' `ALLOW`, and no `onBeforeRequest`
 *   listener cancelled or redirected it (a block still blocks, a redirect still redirects);
 * - `mainFrame`: a document – the main frame's, or a frame's (`SUB_FRAME`): never relayed;
 * - `method`: `GET` only;
 * - `hasRange`: the request carries `Range` – what a media element sends (`bytes=0-` on its
 *   first request, the seek's range after) and a `fetch` / XHR normally does not;
 * - `hasOrigin`: the request carries `Origin` – what a cors-mode `fetch` / XHR sends cross-origin
 *   (round 14, Table 1 of `internal/extensions/webrequest-page-visible-measurements.md`: present
 *   on 12 of 12 cross-origin fetch / XHR loads, absent on every media-element and same-origin
 *   load, on WebView 113 and 156 alike), and a `crossorigin` element load sends too. `Origin`
 *   present is a page script's request, or an element's the sniffer misses (recorded gap):
 *   never relayed.
 *
 * No type in it: the runtime has no engine type for a page-script observation, so a `Range` GET
 * typed image, script, style or font by its `Accept` or extension (nothing but a range-reading
 * script sends one) is relayed like the ambiguous request.
 */
object RelaySelection {
    fun selects(allowed: Boolean, mainFrame: Boolean, method: String, hasRange: Boolean, hasOrigin: Boolean): Boolean =
        allowed && !mainFrame && method == "GET" && hasRange && !hasOrigin

    /** Whether `headers` carry a header named `name`, in any case (WebView keeps the page's spelling). */
    fun hasHeader(headers: Map<String, String>, name: String): Boolean =
        headers.keys.any { it.equals(name, ignoreCase = true) }
}
