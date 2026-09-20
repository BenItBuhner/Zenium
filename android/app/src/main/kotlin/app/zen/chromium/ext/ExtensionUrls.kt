package app.zen.chromium.ext

/**
 * The two spellings of an extension's own URL on Android. WebView refuses `chrome-extension://`,
 * so the runtime serves an extension's pages on a secure origin of its own,
 * `https://<id>.ext.zenium.invalid/` ([Extensions.ORIGIN_SUFFIX]); Chrome, and the extensions
 * written for it, spell the same page `chrome-extension://<id>/`. The host keeps both apart at
 * its boundary: what the WebView loads is the served spelling ([toServed]), what the core and the
 * extensions observe – a tab's URL, a message sender's URL – is Chrome's ([present]). The
 * TypeScript twin is `src/core/extensions/runtime/extensionUrls.ts`.
 */
object ExtensionUrls {
    private val CHROME_EXTENSION = Regex("^chrome-extension://([a-p]{32})(?=[/?#]|$)(.*)$", RegexOption.IGNORE_CASE)
    private val SERVED = Regex("^https://([a-p]{32})\\.ext\\.zenium\\.invalid(?=[/?#]|$)(.*)$", RegexOption.IGNORE_CASE)

    /** `chrome-extension://<id>/p` as the WebView can load it, `https://<id>.ext.zenium.invalid/p`; any other URL as it is. */
    fun toServed(url: String): String {
        val m = CHROME_EXTENSION.matchEntire(url) ?: return url
        return "https://${m.groupValues[1].lowercase()}${Extensions.ORIGIN_SUFFIX}${rooted(m.groupValues[2])}"
    }

    /** `https://<id>.ext.zenium.invalid/p` as Chrome spells it, `chrome-extension://<id>/p`; any other URL as it is. */
    fun present(url: String): String {
        val m = SERVED.matchEntire(url) ?: return url
        return "chrome-extension://${m.groupValues[1].lowercase()}${rooted(m.groupValues[2])}"
    }

    /** True for either spelling of an extension page's URL. */
    fun isExtensionUrl(url: String): Boolean = CHROME_EXTENSION.matches(url) || SERVED.matches(url)

    /** A path that may be empty or start at `?` / `#` gets its root slash, as URL parsing would give it. */
    private fun rooted(rest: String): String = if (rest.startsWith("/")) rest else "/$rest"
}
