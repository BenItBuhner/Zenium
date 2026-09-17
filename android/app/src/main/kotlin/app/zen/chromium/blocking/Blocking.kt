package app.zen.chromium.blocking

import android.content.Context
import android.content.res.AssetManager
import android.os.SystemClock
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import app.zen.chromium.Storage
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

/**
 * The Android request engine. The core persists its rule sets under `files/zen/blocking/`
 * (`index.json` with every set's structured rules, one file per set with its filter text – the
 * same documents the desktop reads); this class compiles them into an [EngineSnapshot] on a
 * background thread whenever the index is rewritten and answers `shouldInterceptRequest` from
 * the current snapshot on WebView's IO threads. It also hands the core the bundled snapshot of
 * the default lists (`assets/blocking/`), the `BlockingHost` half of the platform contract.
 *
 * One instance per process ([shared]): the browser window's `Host` and every custom tab's
 * `CustomTabHost` read the same files, so they share one compiled snapshot – the default lists
 * are a few hundred thousand filters, one copy is enough – and it outlives any one activity.
 *
 * Matcher choice: pure Kotlin (`FilterIndex`, `NetworkFilter`, `UrlPattern`). adblock-rust behind
 * a JNI wrapper would need a Rust toolchain and NDK in the Gradle CI plus a native library per
 * ABI; the hostname map and token buckets here answer in microseconds for the default lists,
 * which is what the IO thread needs.
 */
class Blocking(private val storage: Storage, private val assets: AssetManager) {
    @Volatile
    var snapshot: EngineSnapshot = EngineSnapshot.EMPTY
        private set

    private val builder = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "zen-blocking") }
    private var scheduled: ScheduledFuture<*>? = null
    private var cachedText: Pair<String, TextEngine>? = null

    /** Wall-clock milliseconds of the last build, for the settings sheet and the demo. */
    @Volatile
    var lastBuildMs: Long = 0
        private set

    @Volatile
    var builds: Int = 0
        private set

    /** A rewrite of the index by any host's storage (the core writes through the browser window's). */
    private val onStorageChanged: (String) -> Unit = { name ->
        if (name == Storage.BLOCKING_INDEX) scheduleRebuild(REBUILD_DELAY_MS)
    }

    /** Follow the core's index; the first snapshot is built right away. */
    fun start() {
        Storage.addChangeListener(onStorageChanged)
        scheduleRebuild(0)
    }

    fun stop() {
        Storage.removeChangeListener(onStorageChanged)
        builder.shutdownNow()
    }

    @Synchronized
    private fun scheduleRebuild(delayMs: Long) {
        scheduled?.cancel(false)
        scheduled = runCatching { builder.schedule({ rebuild() }, delayMs, TimeUnit.MILLISECONDS) }.getOrNull()
    }

    /** Read the index and every enabled set's text; called on the builder thread. */
    internal fun rebuild() {
        val started = SystemClock.elapsedRealtime()
        val sets = readIndex()
        val withText = sets.filter { it.enabled && it.hasFilterText && it.file != null }
        val fingerprint = withText.joinToString("|") { "${it.id}=${it.textFingerprint}" }
        val cached = cachedText
        val text = if (cached != null && cached.first == fingerprint) {
            cached.second
        } else {
            val parsed = TextEngine.parse(withText.mapNotNull { readFilterText(it) })
            cachedText = fingerprint to parsed
            parsed
        }
        snapshot = EngineSnapshot(sets, if (text.filterCount > 0) text else null)
        lastBuildMs = SystemClock.elapsedRealtime() - started
        builds++
    }

    private fun readIndex(): List<RuleSetInfo> {
        val raw = storage.read(Storage.BLOCKING_INDEX) ?: return emptyList()
        val index = runCatching { JSONObject(raw) }.getOrNull() ?: return emptyList()
        if (index.optInt("version") != 1) return emptyList()
        val arr = index.optJSONArray("sets") ?: return emptyList()
        val out = ArrayList<RuleSetInfo>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            RuleSetInfo.parse(o)?.let { out.add(it) }
        }
        return out
    }

    private fun readFilterText(set: RuleSetInfo): String? {
        val raw = storage.read("${Storage.BLOCKING_DIR}/${set.file}") ?: return null
        return extractFilterText(raw)
    }

    // ---------------------------------------------------------------------------------------------
    // shouldInterceptRequest
    // ---------------------------------------------------------------------------------------------

    /**
     * The engine's answer for a page's request, or null to let WebView load it. Runs on an IO
     * thread: nothing here touches the WebView. Blocked subresources get an empty 403 (the page
     * sees a failed load, as it would from a cancelled request on the desktop); `$redirect`
     * filters get an empty resource of the right type instead, like uBlock Origin's neutered
     * resources; a blocked document is answered with 204 – Chromium drops the navigation without
     * committing – and the tab is told so it can show the Zenium blocked page.
     */
    fun intercept(tab: BlockingTab, request: WebResourceRequest): WebResourceResponse? {
        val verdict = evaluate(
            snapshot, tab, request.url.toString(), request.isForMainFrame,
            request.requestHeaders?.get("Accept"), request.method ?: "GET"
        )
        return when (verdict) {
            Verdict.Pass -> null
            is Verdict.Empty -> emptyResponse(verdict.status, verdict.reason, "text/plain")
            is Verdict.Neutered -> neuteredResponse(verdict.type)
        }
    }

    /** A main-frame navigation the tab is about to follow (`shouldOverrideUrlLoading`): block it? */
    fun decideNavigation(tab: BlockingTab, url: String): Decision = decideNavigation(snapshot, tab, url)

    // ---------------------------------------------------------------------------------------------
    // Bundled snapshot (BlockingHost)
    // ---------------------------------------------------------------------------------------------

    /** The lists this build ships a snapshot of (`assets/blocking/manifest.json`), as the core expects them. */
    fun bundledLists(): JSONArray {
        val manifest = manifest() ?: return JSONArray()
        val builtAt = manifest.optLong("builtAt", 0L)
        val out = JSONArray()
        val lists = manifest.optJSONArray("lists") ?: return out
        for (i in 0 until lists.length()) {
            val l = lists.optJSONObject(i) ?: continue
            out.put(
                JSONObject()
                    .put("id", l.optString("id"))
                    .put("version", l.opt("version") ?: JSONObject.NULL)
                    .put("builtAt", builtAt)
                    .put("filterCount", l.optInt("filterCount"))
            )
        }
        return out
    }

    /**
     * Write the bundled snapshot of `set.id` to `file` (a profile path the core chose) as the
     * complete rule-set document, on the storage thread so it lands before the index that will
     * point at it. `done` gets the snapshot's metadata, or null when the build has no snapshot.
     */
    fun installBundled(set: JSONObject, file: String, done: (JSONObject?) -> Unit) {
        val manifest = manifest()
        val entry = manifest?.optJSONArray("lists")?.let { lists ->
            (0 until lists.length()).map { lists.optJSONObject(it) }.firstOrNull { it?.optString("id") == set.optString("id") }
        }
        if (manifest == null || entry == null) {
            done(null)
            return
        }
        storage.execute {
            val result = runCatching {
                val text = assets.open("blocking/${entry.optString("file")}").use { input ->
                    GZIPInputStream(input).bufferedReader().readText()
                }
                val document = JSONObject(set.toString()).put("filterText", text)
                storage.writeSync(file, document.toString())
                JSONObject()
                    .put("id", entry.optString("id"))
                    .put("version", entry.opt("version") ?: JSONObject.NULL)
                    .put("builtAt", manifest.optLong("builtAt", 0L))
                    .put("filterCount", entry.optInt("filterCount"))
            }.getOrNull()
            done(result)
        }
    }

    private fun manifest(): JSONObject? = runCatching {
        JSONObject(assets.open("blocking/manifest.json").bufferedReader().readText())
    }.getOrNull()

    /** Diagnostics for the settings sheet and the demo driver. */
    fun stats(): JSONObject = JSONObject()
        .put("sets", snapshot.setCount)
        .put("filters", snapshot.filterCount)
        .put("builds", builds)
        .put("lastBuildMs", lastBuildMs)

    companion object {
        /** The core debounces its index writes; one more beat coalesces a burst of set changes. */
        private const val REBUILD_DELAY_MS = 300L

        @Volatile
        private var sharedEngine: Blocking? = null

        /**
         * The process's engine, started on first use over a storage of its own on the same
         * files. Never stopped: it belongs to no activity.
         */
        fun shared(context: Context): Blocking {
            sharedEngine?.let { return it }
            synchronized(this) {
                sharedEngine?.let { return it }
                val app = context.applicationContext
                return Blocking(Storage(app), app.assets).also {
                    it.start()
                    sharedEngine = it
                }
            }
        }

        private fun isHttp(url: String): Boolean =
            url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)

        /**
         * Decide one request against `snap` and tell `tab` what happened. Everything
         * `shouldInterceptRequest` does except building the `WebResourceResponse`, so it runs on
         * the JVM in tests.
         */
        fun evaluate(
            snap: EngineSnapshot,
            tab: BlockingTab,
            url: String,
            isMainFrame: Boolean,
            accept: String?,
            method: String
        ): Verdict {
            if (snap === EngineSnapshot.EMPTY || !isHttp(url)) return Verdict.Pass
            val known = ResourceType.guessKnown(url, isMainFrame, accept)
            val type = known ?: ResourceType.XMLHTTPREQUEST
            val req = Request(
                url, type, if (isMainFrame) null else tab.documentUrl, method,
                tabId = tab.tabId, typeMask = known?.bit ?: ResourceType.AMBIGUOUS_MASK
            )
            val decision = snap.decide(req)
            return when (decision.action) {
                Decision.Action.ALLOW -> Verdict.Pass
                Decision.Action.BLOCK -> {
                    if (isMainFrame) {
                        tab.onDocumentBlocked(url)
                        Verdict.Empty(204, "No Content")
                    } else {
                        tab.onRequestsBlocked(1)
                        Verdict.Empty(403, "Forbidden")
                    }
                }
                Decision.Action.REDIRECT -> when {
                    decision.matchedSet == Decision.TEXT_SET_ID -> {
                        // A filter list's `$redirect`: the neutered stand-in, counted as blocked.
                        tab.onRequestsBlocked(1)
                        Verdict.Neutered(type)
                    }
                    isMainFrame && decision.redirectUrl != null -> {
                        tab.onDocumentRedirected(decision.redirectUrl)
                        Verdict.Empty(204, "No Content")
                    }
                    // WebView cannot redirect a subresource from here; the translator's rule is honoured on the desktop only.
                    else -> Verdict.Pass
                }
                Decision.Action.UPGRADE -> {
                    if (isMainFrame && decision.redirectUrl != null) {
                        tab.onDocumentRedirected(decision.redirectUrl)
                        Verdict.Empty(204, "No Content")
                    } else Verdict.Pass
                }
            }
        }

        fun decideNavigation(snap: EngineSnapshot, tab: BlockingTab, url: String): Decision {
            if (snap === EngineSnapshot.EMPTY || !isHttp(url)) return Decision.ALLOW
            return snap.decide(Request(url, ResourceType.MAIN_FRAME, null, "GET", tabId = tab.tabId))
        }

        private val TRANSPARENT_GIF = byteArrayOf(
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80.toByte(), 0x00, 0x00,
            0x00, 0x00, 0x00, 0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0x21, 0xf9.toByte(), 0x04,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
            0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
        )

        fun emptyResponse(status: Int, reason: String, mimeType: String): WebResourceResponse =
            WebResourceResponse(mimeType, "utf-8", status, reason, mapOf("Content-Length" to "0"), ByteArrayInputStream(ByteArray(0)))

        /** uBlock Origin's `noop` resources by type: something harmless the page can load. */
        fun neuteredResponse(type: ResourceType): WebResourceResponse = when (type) {
            ResourceType.SCRIPT -> WebResourceResponse("application/javascript", "utf-8", ByteArrayInputStream(ByteArray(0)))
            ResourceType.STYLESHEET -> WebResourceResponse("text/css", "utf-8", ByteArrayInputStream(ByteArray(0)))
            ResourceType.IMAGE -> WebResourceResponse("image/gif", null, ByteArrayInputStream(TRANSPARENT_GIF))
            ResourceType.SUB_FRAME -> WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(ByteArray(0)))
            ResourceType.XMLHTTPREQUEST -> WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
            else -> emptyResponse(403, "Forbidden", "text/plain")
        }

        /**
         * The `filterText` of a persisted rule-set document without materialising the whole
         * multi-megabyte JSON object: the value is scanned as a JSON string literal.
         */
        fun extractFilterText(json: String): String? {
            val key = "\"filterText\":"
            var from = 0
            while (true) {
                val at = json.indexOf(key, from)
                if (at == -1) return null
                var i = at + key.length
                while (i < json.length && json[i].isWhitespace()) i++
                if (i < json.length && json[i] == '"') {
                    decodeStringLiteral(json, i + 1)?.let { return it }
                }
                from = at + key.length
            }
        }

        /** Decode the JSON string literal that opens before `start`; null when it never closes. */
        private fun decodeStringLiteral(s: String, start: Int): String? {
            val out = StringBuilder(s.length - start)
            var i = start
            while (i < s.length) {
                val c = s[i]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        if (i + 1 >= s.length) return null
                        when (val e = s[i + 1]) {
                            'n' -> out.append('\n')
                            't' -> out.append('\t')
                            'r' -> out.append('\r')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000c')
                            'u' -> {
                                if (i + 5 >= s.length) return null
                                val code = s.substring(i + 2, i + 6).toIntOrNull(16) ?: return null
                                out.append(code.toChar())
                                i += 4
                            }
                            else -> out.append(e) // `"`, `\`, `/`
                        }
                        i += 2
                        continue
                    }
                    else -> out.append(c)
                }
                i++
            }
            return null
        }
    }
}

/** What `shouldInterceptRequest` answers, before it becomes a `WebResourceResponse`. */
sealed class Verdict {
    /** Let WebView load the request. */
    object Pass : Verdict()

    /** An empty body with this status: 403 for blocked subresources, 204 for dropped navigations. */
    class Empty(val status: Int, val reason: String) : Verdict()

    /** uBlock Origin's neutered stand-in for a `$redirect` filter. */
    class Neutered(val type: ResourceType) : Verdict()
}

/** What the engine needs from a tab and tells it (implemented by `TabWebView`). */
interface BlockingTab {
    val tabId: String

    /** The URL of the document the tab shows; read from any thread. */
    val documentUrl: String?

    /** `count` more subresources of the current document were blocked (IO thread). */
    fun onRequestsBlocked(count: Int)

    /** The navigation to `url` was blocked before it committed (IO thread). */
    fun onDocumentBlocked(url: String)

    /** A `redirect` / `upgradeScheme` rule sends the navigation to `url` instead (IO thread). */
    fun onDocumentRedirected(url: String)
}
