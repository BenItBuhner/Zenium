package app.zen.chromium.ext

/**
 * The served-resource record: one line per answer of the runtime's intercept on an extension's
 * origin (`https://<id>.ext.zenium.invalid/<path>`) or on the page alias
 * (`/.zenium-ext/<id>/<path>`), kept while `debug` for the compat sweep's rows (compat round 24,
 * AdGuard Extra's `userscript.js`: its content script's `<script src>` of the file is a load the
 * page's Resource Timing cannot show – Blink precludes a resource fetched from an isolated world
 * from the timeline (`ResourceFetcher::PopulateAndAddResourceTimingInfo`, the world a script
 * element's fetch takes from `GetCurrentWorld()`), and a `chrome-extension://` response is not
 * HTTP (`ResourceResponse::ShouldPopulateResourceTiming`), so Chrome's page timeline holds no
 * such entry either; the record is the read of whether the runtime served the insertion).
 *
 * The line: `<ext8> <status> <path>[?query] <frame>; <side>[; <why>][; from <referer>]` – the
 * extension id's first eight characters, the response's status, the request's path as it was
 * spelled (the alias with its prefix), its query cut to 80 characters, `main-frame` or
 * `sub-resource`, the side `own` (the extension's own page, or a tab on its origin), `foreign` (a
 * web page's request: a content script's insertion, a page's frame of the extension, another
 * extension's view) or none where the answer came before the side was told (an unserved
 * extension's sub-resource); the word for a refusal – [UNSERVED], [PRIVATE], [NOT_WEB_ACCESSIBLE],
 * [WORKER_SCRIPT], [ALIAS_DOCUMENT], or [MISSING] for a 404 past every gate (the file is not in
 * the bundle) –; and the request's Referer without its scheme, cut to 80 characters, when it
 * sends one.
 */
object ServedRecord {
    /** The record's length: the oldest line goes as the next comes. */
    const val CAP = 300

    /** No extension of that id is served (configured) – nothing of it is there. */
    const val UNSERVED = "unserved"
    /** An incognito tab the extension is not allowed in. */
    const val PRIVATE = "private"
    /** A foreign request for a file the manifest's `web_accessible_resources` do not name. */
    const val NOT_WEB_ACCESSIBLE = "not-web-accessible"
    /** The background document's own script asked for again as a sub-resource of itself (WorkerScriptGate). */
    const val WORKER_SCRIPT = "worker-script"
    /** A document, or the bare id, under the page alias: never served there. */
    const val ALIAS_DOCUMENT = "alias-document"
    /** A 404 with no other word: the gates were passed and the file is not in the bundle. */
    const val MISSING = "missing"

    /** One line of the record; `side` is `own`, `foreign` or null, `why` a word above or null for a served answer. */
    fun line(id: String, status: Int, path: String, query: String?, mainFrame: Boolean, side: String?, why: String?, referer: String?): String = buildString {
        append(id.take(8)).append(' ').append(status).append(' ')
        append(path.ifEmpty { "/" })
        if (!query.isNullOrEmpty()) append('?').append(query.take(80))
        append(if (mainFrame) " main-frame" else " sub-resource")
        if (side != null) append("; ").append(side)
        val word = why ?: if (status == 404) MISSING else null
        if (word != null) append("; ").append(word)
        if (!referer.isNullOrEmpty()) append("; from ").append(referer.removePrefix("https://").removePrefix("http://").take(80))
    }

    /** The status a line carries (its second word), -1 for a line not of this shape. */
    fun status(line: String): Int = line.split(' ').getOrNull(1)?.toIntOrNull() ?: -1

    /** Adds `line` to `record` under [CAP], the oldest going first. */
    fun add(record: ArrayDeque<String>, line: String) {
        if (record.size >= CAP) record.removeFirst()
        record.addLast(line)
    }
}
