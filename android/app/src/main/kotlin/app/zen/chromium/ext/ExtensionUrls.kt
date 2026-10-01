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

    /**
     * The path segment under a web page's own origin where the host serves an extension's
     * web-accessible files a second time, `/.zenium-ext/<id>/<path>`: a module graph a page's
     * `script-src` refused at the served origin is asked for again from there by the bootstrap
     * (`extensionScriptRecovery.ts`), as `'self'` or the page's host admits it. The TypeScript
     * twin is `PAGE_ALIAS_SEGMENT` / `pageAliasUrl`; the two must agree.
     */
    const val PAGE_ALIAS_SEGMENT = ".zenium-ext"

    private val PAGE_ALIAS = Regex("^/\\.zenium-ext/([a-p]{32})(?:/(.*))?$", RegexOption.IGNORE_CASE)

    /** The extension id and the file path (no leading slash) of an alias path, or null for any other path. */
    fun pageAlias(path: String): Pair<String, String>? {
        val m = PAGE_ALIAS.matchEntire(path) ?: return null
        return m.groupValues[1].lowercase() to (m.groupValues.getOrNull(2) ?: "")
    }

    /** An alias URL whole: any `http(s)` page origin, then the alias path; the query and fragment apart. */
    private val PAGE_ALIAS_URL = Regex("^https?://[^/?#]+(/\\.zenium-ext/[a-p]{32}(?:/[^?#]*)?)(?:[?#].*)?$", RegexOption.IGNORE_CASE)

    /**
     * The extension-relative path (no leading slash; the query and fragment dropped) of one of
     * `extensionId`'s own files, spelled at the served origin
     * (`https://<id>.ext.zenium.invalid/<path>`) or at its page-origin alias under any page
     * (`https://<page>/.zenium-ext/<id>/<path>`, the spelling a content script's `import()`
     * retried past the page's policy asks with); null for a URL of any other extension or origin.
     */
    fun ownFile(url: String, extensionId: String): String? {
        val served = SERVED.matchEntire(url)
        if (served != null) {
            if (!served.groupValues[1].equals(extensionId, ignoreCase = true)) return null
            return served.groupValues[2].substringBefore('?').substringBefore('#').trimStart('/')
        }
        val alias = PAGE_ALIAS_URL.matchEntire(url) ?: return null
        val (id, path) = pageAlias(alias.groupValues[1]) ?: return null
        return if (id.equals(extensionId, ignoreCase = true)) path else null
    }

    /** A path that may be empty or start at `?` / `#` gets its root slash, as URL parsing would give it. */
    private fun rooted(rest: String): String = if (rest.startsWith("/")) rest else "/$rest"
}
