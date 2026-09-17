package app.zen.chromium

/**
 * The rules for links that leave the browser for another app, kept free of Android classes so
 * they can be unit tested: which schemes the WebView renders itself, which never leave the
 * browser, what an `intent:` URL names as its web fallback, and which Intent flags a page must
 * never pass on. `ExternalLaunches` applies them to real Intents.
 */
object ExternalLaunchPolicy {
    /** Schemes the WebView loads itself; a navigation to any other is a request to leave. */
    private val RENDERED = setOf("http", "https", "about", "data", "blob", "javascript")

    /** Schemes that address the device's own files and content providers: never handed out. */
    private val NEVER_LAUNCHED = setOf("file", "content")

    /**
     * Intent.FLAG_GRANT_READ_URI_PERMISSION, _WRITE_, _PERSISTABLE_ and _PREFIX_: a page must not
     * make Zenium share its own URI permissions with the app it launches. Spelled out so this
     * file stays independent of the framework.
     */
    const val GRANT_FLAGS: Int = 0x00000001 or 0x00000002 or 0x00000040 or 0x00000080

    /** The string extra Chrome reads when no app handles an `intent:` URL. */
    const val FALLBACK_EXTRA = "browser_fallback_url"

    /** What an `intent:` URL asks for, as far as the policy cares. */
    data class IntentUrl(
        /** `scheme=`: the scheme of the data the launched app receives (null when absent). */
        val scheme: String?,
        /** `package=`: the app the page insists on, or null for any. */
        val packageName: String?,
        val action: String?,
        /** The page asked for a specific component (`component=`) or carried a selector (`SEL;`). */
        val targeted: Boolean,
        /** `launchFlags=`, as the page wrote them. */
        val launchFlags: Int,
        /** `S.browser_fallback_url=`, decoded, without any check yet. */
        val rawFallback: String?
    )

    fun schemeOf(url: String): String? {
        val m = SCHEME.find(url) ?: return null
        return m.groupValues[1].lowercase()
    }

    fun rendersInWebView(scheme: String?): Boolean = scheme?.lowercase() in RENDERED

    fun neverLaunched(scheme: String?): Boolean = scheme?.lowercase() in NEVER_LAUNCHED

    fun stripGrantFlags(flags: Int): Int = flags and GRANT_FLAGS.inv()

    /** Whether the page's navigation asks to leave the browser at all. */
    fun leavesBrowser(url: String): Boolean {
        val scheme = schemeOf(url) ?: return false
        return !rendersInWebView(scheme)
    }

    /**
     * Parse the `#Intent;key=value;...;end` part of an `intent:` URL the way `Intent.parseUri`
     * reads it (values percent-encoded, `SEL;` opening the selector). Null for anything else.
     */
    fun parseIntentUrl(url: String): IntentUrl? {
        if (schemeOf(url) != "intent") return null
        val start = url.indexOf("#Intent;")
        if (start < 0) return IntentUrl(null, null, null, false, 0, null)
        var scheme: String? = null
        var packageName: String? = null
        var action: String? = null
        var targeted = false
        var launchFlags = 0
        var fallback: String? = null
        var inSelector = false
        for (part in url.substring(start + "#Intent;".length).split(';')) {
            if (part == "end") break
            if (part == "SEL") {
                targeted = true
                inSelector = true
                continue
            }
            val eq = part.indexOf('=')
            if (eq <= 0) continue
            val key = part.substring(0, eq)
            val value = percentDecode(part.substring(eq + 1))
            if (inSelector) continue
            when (key) {
                "scheme" -> scheme = value.lowercase()
                "package" -> packageName = value
                "action" -> action = value
                "component" -> targeted = true
                "launchFlags" -> launchFlags = parseFlags(value)
                "S.$FALLBACK_EXTRA" -> fallback = value
            }
        }
        return IntentUrl(scheme, packageName, action, targeted, launchFlags, fallback)
    }

    /**
     * The scheme the launch resolves to: an `intent:` URL's `scheme=` (falling back to its package
     * name, then to "intent"), any other URL's own scheme. This is what the per-site "remember"
     * is keyed on.
     */
    fun targetScheme(url: String): String {
        val parsed = parseIntentUrl(url) ?: return schemeOf(url) ?: ""
        return parsed.scheme ?: parsed.packageName ?: "intent"
    }

    /** The web page to show instead when no app takes an `intent:` URL, or null when there is none. */
    fun fallbackUrl(url: String): String? {
        val raw = parseIntentUrl(url)?.rawFallback ?: return null
        return if (schemeOf(raw) in setOf("http", "https")) raw else null
    }

    /**
     * Whether an `intent:` URL is one Zenium refuses outright: it would hand the app a file or
     * content URI, whatever else it says.
     */
    fun refusesIntentUrl(url: String): Boolean {
        val parsed = parseIntentUrl(url) ?: return false
        return neverLaunched(parsed.scheme)
    }

    private fun parseFlags(value: String): Int = runCatching {
        if (value.startsWith("0x") || value.startsWith("0X")) value.substring(2).toLong(16).toInt()
        else value.toLong().toInt()
    }.getOrDefault(0)

    /** `%XX` sequences to bytes to UTF-8, like `Uri.decode` (a `+` stays a `+`). */
    fun percentDecode(s: String): String {
        if (!s.contains('%')) return s
        val out = java.io.ByteArrayOutputStream(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length) {
                val hex = s.substring(i + 1, i + 3)
                val byte = hex.toIntOrNull(16)
                if (byte != null) {
                    out.write(byte)
                    i += 3
                    continue
                }
            }
            out.write(c.toString().toByteArray(Charsets.UTF_8))
            i++
        }
        return out.toString("UTF-8")
    }

    private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*):")
}
