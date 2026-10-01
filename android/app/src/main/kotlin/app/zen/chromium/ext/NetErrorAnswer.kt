package app.zen.chromium.ext

/**
 * The refusal Chrome gives as a network error, not a response, answered as a response after all:
 * the WebView answers a served-origin request (`https://<id>.ext.zenium.invalid/…`) only from
 * `Extensions.intercept`, which has no way to fail a request but a response, so the request of an
 * extension page for a file of an extension that is not installed, for another extension's file
 * that is not web-accessible, or in a private tab the extension may not see ([BLOCKED],
 * Chrome's `ERR_BLOCKED_BY_CLIENT`), and for a file the extension has not ([FILE_NOT_FOUND],
 * Chrome's `ERR_FILE_NOT_FOUND`), is a 404 carrying [HEADER], and the extension page's `fetch`
 * rejects it as Chrome's does – `TypeError: Failed to fetch` (`extensionCorsProxy.ts`, its
 * `NET_ERROR_HEADER`). An extension reads that rejection as the file's absence: Black Menu for
 * Google tells Vivaldi by a `HEAD` of Vivaldi's reader extension
 * (`chrome-extension://mpognobbkildjkofajifpdfhcoklimli/…`, `then(() => true, () => null)`) and
 * turned its toolbar tap into the side panel when the 404 resolved (compat round 25, WebView 156).
 * The header is exposed to a cross-origin reader, since another extension's page is one.
 */
object NetErrorAnswer {
    const val HEADER = "X-Zenium-Net-Error"
    const val BLOCKED = "ERR_BLOCKED_BY_CLIENT"
    const val FILE_NOT_FOUND = "ERR_FILE_NOT_FOUND"

    /** The headers of a refusal: the code under [HEADER], exposed to a cross-origin reader. */
    fun headers(code: String): Map<String, String> = mapOf(HEADER to code, "Access-Control-Expose-Headers" to HEADER)
}
