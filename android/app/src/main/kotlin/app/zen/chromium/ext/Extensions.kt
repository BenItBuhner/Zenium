package app.zen.chromium.ext

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.Host
import app.zen.chromium.Profiles
import app.zen.chromium.TabWebView
import app.zen.chromium.arr
import app.zen.chromium.bool
import app.zen.chromium.json
import app.zen.chromium.obj
import app.zen.chromium.str
import app.zen.chromium.strOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.security.SecureRandom
import java.util.Locale
import java.util.WeakHashMap
import java.util.concurrent.Executors

/**
 * The Kotlin half of the extension runtime. The browser core (`src/android/extensionRuntime.ts`,
 * in the chrome WebView) owns the extension model: it takes the records the store installed,
 * parses their manifests, plans content-script units, routes messages and implements the
 * `chrome.*` calls. This class is the platform it needs, one extension at a time:
 *
 *  - `ext.open` reads a record's manifest and locale files from its directory;
 *  - `ext.configure` compiles that extension's units (bootstrap + sources + config, one script
 *    per world and origin-rule set, [UnitCompiler] caching per extension and version) and
 *    installs them on every tab WebView, replacing only that extension's earlier handlers, so a
 *    reconfigure of one extension leaves every other extension's injected scripts alone;
 *  - the synthetic origin `https://<id>.ext.zenium.invalid/`, served from the record's
 *    directory through `shouldInterceptRequest` of every WebView (tab pages see only
 *    web-accessible resources; extension pages see everything, plus the generated background page);
 *  - the `__zenExtBridge` WebMessageListener of the main world and of each of a fixed pool of
 *    isolated worlds ([WorldSlots]), all registered when a tab view is built: every frame that
 *    runs a content script or an extension page says hello with an endpoint id; its
 *    JavaScriptReplyProxy is kept so the core can answer it (`ext.send`);
 *  - the transport janitor (`ext-janitor.js`) in the main world of every tab frame, ahead of
 *    every page script, so a late boot for `scripting.executeScript` into a document that
 *    predates the extension's world finds an unspoofable bridge;
 *  - hidden background WebViews (started and stopped by the core's lifecycle policy) and the
 *    popup / options bottom sheet;
 *  - declarativeNetRequest on the request path (static rulesets read from the extension
 *    directory, dynamic rules from the core) and, on demand, observational `webRequest` events.
 *
 * Protocol (the core → here), keyed by extension id where it applies: `ext.env`, `ext.open`,
 * `ext.configure`, `ext.detach`, `ext.background.start` / `stop`, `ext.popup.open` / `close`,
 * `ext.send`, `ext.exec`, `ext.readFile`, `ext.cookies.get` / `set`, `ext.setRules`,
 * `ext.observeRequests`. Here → the core (host events): `ext.message`, `ext.gone`,
 * `ext.popupClosed`, `ext.request`.
 */
class Extensions(private val host: Host) {
    /** Every bridge message carries this; pages never see it (it lives in closures only). */
    val token: String = SecureRandom().let { r -> ByteArray(16).also(r::nextBytes).joinToString("") { "%02x".format(it) } }

    /**
     * Real isolated worlds: `JS_INJECTION_IN_FRAME_AND_WORLD` (androidx.webkit 1.17, Chromium 146+
     * WebView). Content-script units then run in a per-extension world and the emulation proxy is
     * off. Decided once, here on the main thread while the host is built, so the boot payload can
     * carry it to the core before any extension runs (`reducedExtensionIsolation`).
     */
    val isolatedWorlds: Boolean =
        runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD) }.getOrDefault(false)

    private val bootstrap: String by lazy { host.activity.assets.open("ext.js").bufferedReader().readText() }
    private val janitor: String by lazy {
        val script = host.activity.assets.open("ext-janitor.js").bufferedReader().readText()
        "(function(){var __zenExtBoot={token:${JSONObject.quote(token)}};\n$script\n})();"
    }
    private val compiler = UnitCompiler { bootstrap }
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-ext") }
    private val rulesIo = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-ext-rules") }
    /** Static rulesets parsed in this process: file path → (size.mtime fingerprint, rules). Rules thread only. */
    private val staticRules = HashMap<String, Pair<String, List<NetRules.Rule>>>()

    /**
     * One document-start script of one extension, injected into frames whose origin matches
     * `origins`; into the named isolated world when `world` is set.
     */
    class ScriptUnit(val extensionId: String, val key: String, val origins: Set<String>, val script: String, val world: String?)

    /** What the core configured for one attached extension. */
    class Served(
        val id: String,
        val version: String,
        /** The record's directory (`<root>/<id>/<version>`), where every file is read from. */
        val dir: File,
        val allowFileAccess: Boolean,
        /**
         * Whether the extension runs in private tabs (Chrome's "allow in Incognito"): without it
         * no unit is injected there, its origin is not served to them and its rules do not
         * apply to their requests.
         */
        val allowPrivate: Boolean,
        /** `web_accessible_resources` globs (tab pages may only fetch these). */
        val webAccessible: List<Regex>,
        /** The generated background page, or null when the extension has none / an MV2 page. */
        val backgroundHtml: String?,
        val backgroundUrl: String?,
        /** Page-mode boot config (JSON) without `context`; set per WebView kind. */
        val pageConfig: String,
        /** Content-mode boot config (JSON) of a late boot: no groups, `with` isolation. */
        val lateConfig: String
    )

    /**
     * A frame (or extension page) that said hello. `url` is the document's `location.href` at
     * hello time and `doc` the bootstrap's document id (the endpoint id's first segment, derived
     * from the document's `performance.timeOrigin`, so every unit of one document, in whichever
     * world, reports the same id): a main frame saying hello with another `doc` is a new document.
     * `world` marks an endpoint inside a real isolated world (the `world` unit of its extension) as
     * opposed to the frame's main-world endpoint.
     */
    class Endpoint(
        val view: WebView,
        val proxy: JavaScriptReplyProxy,
        val context: String,
        val extensionId: String,
        val isMainFrame: Boolean,
        val url: String,
        val doc: String,
        /** The world slot the endpoint's bridge listener belongs to; null in the main world. */
        val slot: Int?
    ) {
        val world: Boolean get() = slot != null
    }

    /** Per tab WebView: the janitor's handler and, per extension, the handlers of its units. */
    private class ViewHandlers {
        var janitor: ScriptHandler? = null
        val byExtension = HashMap<String, MutableList<ScriptHandler>>()
    }

    @Volatile private var served: Map<String, Served> = emptyMap()
    /** Per extension, the units currently installed on every tab (main thread). */
    private val units = LinkedHashMap<String, List<ScriptUnit>>()
    /** Every extension's rules, for the requests of ordinary tabs and of extension pages. */
    @Volatile private var rules: NetRules? = null
    /** The rules of the extensions allowed in private tabs, for those tabs' requests. */
    @Volatile private var privateRules: NetRules? = null
    @Volatile private var observeRequests = false
    @Volatile var debug = true
        private set
    private val handlers = WeakHashMap<WebView, ViewHandlers>()
    /**
     * The isolated worlds every tab view registers a bridge listener for when it is built, and
     * which extension's world each one carries right now (see [WorldSlots] for why the pool is
     * fixed at construction). Empty pool without world injection.
     */
    private val worldSlots = WorldSlots(if (isolatedWorlds) WORLD_SLOTS else 0)
    private val endpoints = HashMap<String, Endpoint>()
    private val backgrounds = HashMap<String, ExtensionWebView>()
    private var popup: ExtensionPopup? = null
    /** Last request decisions ("allow|block|… type micros url"), kept while `debug` for instrumentation. */
    val decisions = ArrayDeque<String>()
    /**
     * While `debug`: `"<ext> <ns>.<method>"` → `[calls, failed replies, unanswered]` over the
     * bridge, so the demo can grade messaging and storage per real extension (`msg` counts as
     * `runtime.sendMessage`, `connect` as `runtime.connect`, `portMsg` as `port.postMessage`).
     * Unanswered: the two `runtime.lastError` outcomes of a normal Chrome run (`UNANSWERED`).
     */
    val callStats = HashMap<String, IntArray>()
    private val pendingCalls = HashMap<String, String>()
    /** While `debug`: the last few hundred bridge messages, one line each (see [trace]). */
    private val bridgeTrace = ArrayDeque<String>()
    /**
     * Times `onPageStarted` arrived after the new document's bootstrap had already said hello
     * (evidence for the ordering `onDocumentGone` tolerates), for instrumentation.
     */
    var lateOnPageStarted = 0
        private set
    /** Late boots `ext.exec` had to run (a document without the extension's scope), for instrumentation. */
    var lateBoots = 0
        private set
    /** `ext.configure` outcomes per extension (`{ units: [{ key, chars, cached }], ms }`), for instrumentation. */
    val configureStats = HashMap<String, JSONObject>()

    val origin = ORIGIN_SUFFIX

    // ---------------------------------------------------------------------------------------------
    // Native methods (from the core)
    // ---------------------------------------------------------------------------------------------

    fun handle(method: String, args: JSONObject, reply: (Any?) -> Unit) {
        when (method) {
            "ext.env" -> {
                // A runtime asking for its environment is a new one (the chrome booted): whatever
                // an earlier runtime left running is history, and it re-attaches what it wants.
                reset()
                reply(
                    json(
                        "token" to token,
                        "uiLanguage" to Locale.getDefault().toLanguageTag(),
                        "isolatedWorlds" to isolatedWorlds,
                        "worldSlots" to worldSlots.size
                    )
                )
            }
            "ext.open" -> open(args.str("id"), args.str("path"), reply)
            "ext.configure" -> configure(args, reply)
            "ext.detach" -> { detachExtension(args.str("id")); reply(null) }
            "ext.setRules" -> setRules(args, reply)
            "ext.observeRequests" -> { observeRequests = args.bool("on"); reply(null) }
            "ext.send" -> { send(args.str("ep"), args.str("message")); reply(null) }
            "ext.background.start" -> { startBackground(args.str("id")); reply(null) }
            "ext.background.stop" -> { stopBackground(args.str("id")); reply(null) }
            "ext.popup.open" -> { openPopup(args.str("id"), args.str("url"), args.str("context", "popup")); reply(null) }
            "ext.popup.close" -> { closePopup(); reply(null) }
            "ext.exec" -> exec(args, reply)
            "ext.cookies.get" -> reply(CookieManager.getInstance().getCookie(args.str("url")))
            "ext.cookies.set" -> { CookieManager.getInstance().setCookie(args.str("url"), args.str("cookie")); reply(null) }
            "ext.readFile" -> {
                val id = args.str("id")
                val path = args.str("path")
                io.execute {
                    val text = runCatching { fileFor(id, path)?.takeIf { it.isFile }?.readText() }.getOrNull()
                    main.post { reply(text) }
                }
            }
            else -> throw IllegalArgumentException("Unknown method: $method")
        }
    }

    /**
     * `ext.open { id, path }` → `{ manifest, locales: { <locale>: <messages.json> } }`. The path is
     * the record's directory; it has to lie under the store's install root. Only the locales the
     * core can use (the UI locale, its language, the manifest default) travel.
     */
    private fun open(id: String, path: String, reply: (Any?) -> Unit) {
        io.execute {
            val dir = recordDir(path)
            if (dir == null) {
                main.post { reply(Host.Rejection("The extension directory is not under the install root")) }
                return@execute
            }
            val manifestText = runCatching { File(dir, "manifest.json").readText() }.getOrNull()
            if (manifestText == null) {
                main.post { reply(Host.Rejection("manifest.json is missing or unreadable")) }
                return@execute
            }
            val manifest = runCatching { JSONObject(manifestText) }.getOrNull()
            val locales = JSONObject()
            val defaultLocale = manifest?.strOrNull("default_locale")
            val ui = Locale.getDefault()
            for (candidate in listOf(ui.toLanguageTag(), ui.language, defaultLocale).filterNotNull().map { it.replace('-', '_') }) {
                if (candidate.isEmpty() || locales.has(candidate) || !LOCALE_DIR.matches(candidate)) continue
                val file = File(dir, "_locales/$candidate/messages.json")
                if (file.isFile) runCatching { locales.put(candidate, file.readText()) }
            }
            Log.i(TAG, "opened ${id.take(8)} from ${dir.path} (${locales.length()} locale file(s))")
            main.post { reply(json("manifest" to manifestText, "locales" to locales)) }
        }
    }

    /**
     * `ext.configure { id, version, path, allowFileAccess, allowPrivate, units: [{ key, origins,
     * world, config, groups: [{ ext, index, js, isolation }], css: [{ ext, path }] }], served:
     * { webAccessible, backgroundHtml, backgroundUrl, page, late }, debug }` → `{ units: [{ key,
     * chars, cached }], ms }`. Reading the sources is file IO, so the units are compiled off the
     * main thread and installed on it, on every tab, in place of this extension's earlier units only.
     */
    private fun configure(args: JSONObject, reply: (Any?) -> Unit) {
        val id = args.str("id")
        if (!VALID_ID.matches(id)) {
            reply(Host.Rejection("'$id' is not an extension id"))
            return
        }
        val debug = args.bool("debug", true)
        io.execute {
            val started = System.nanoTime()
            val dir = recordDir(args.str("path"))
            if (dir == null) {
                main.post { reply(Host.Rejection("The extension directory is not under the install root")) }
                return@execute
            }
            val s = args.obj("served")
            val servedNow = Served(
                id = id,
                version = args.str("version"),
                dir = dir,
                allowFileAccess = args.bool("allowFileAccess"),
                allowPrivate = args.bool("allowPrivate"),
                webAccessible = s.arr("webAccessible").let { a -> List(a.length()) { i -> globToRegex(a.optString(i, "")) } },
                backgroundHtml = s.strOrNull("backgroundHtml"),
                backgroundUrl = s.strOrNull("backgroundUrl"),
                pageConfig = s.str("page", "{}"),
                lateConfig = s.str("late", "{}")
            )
            val compiled = compiler.compile(id, servedNow.version, args.arr("units"), debug) { path ->
                fileIn(dir, path)?.takeIf { it.isFile }?.readText()
            }
            val unitsNow = compiled.map { ScriptUnit(id, it.key, it.origins.toSet(), it.script, it.world?.takeIf { isolatedWorlds }) }
            val ms = (System.nanoTime() - started) / 1_000_000
            val stats = json(
                "units" to JSONArray(compiled.map { json("key" to it.key, "chars" to it.script.length, "cached" to it.cached) }),
                "ms" to ms
            )
            main.post {
                // The extension's worlds take slots of the fixed pool first; the core keeps within
                // the budget `ext.env` told it, so a refusal here is a bug on one side or the other.
                val wantedWorlds = unitsNow.mapNotNull { it.world }.toSet()
                if (!worldSlots.assign(id, wantedWorlds)) {
                    reply(
                        Host.Rejection(
                            "No isolated world slot for the extension's ${wantedWorlds.size} world(s): " +
                                "${worldSlots.size - worldSlots.free()} of ${worldSlots.size} in use"
                        )
                    )
                    return@post
                }
                this.debug = debug
                served = served + (id to servedNow)
                units[id] = unitsNow
                for (view in host.tabs.all()) installExtension(view, servedNow, unitsNow)
                configureStats[id] = stats
                Log.i(
                    TAG,
                    "configured ${id.take(8)} ${servedNow.version}: ${unitsNow.size} unit(s), " +
                        "${unitsNow.sumOf { it.script.length }} chars (${compiled.count { it.cached }} cached) in $ms ms, " +
                        "worlds ${unitsNow.mapNotNull { u -> u.world?.let(worldSlots::slot) }.toSet()}"
                )
                reply(stats)
            }
        }
    }

    /** `ext.detach { id }`: the extension's units leave every tab; its pages and cache go. */
    private fun detachExtension(id: String) {
        units.remove(id)
        served = served - id
        for (view in handlers.keys.toList()) removeExtension(view, id)
        stopBackground(id)
        if (popup?.extensionId == id) closePopup()
        // The core dropped these endpoints already; the frames keep running what was injected.
        endpoints.entries.removeAll { it.value.extensionId == id }
        // Its world slots are free for the next extension; a straggling hello from a document
        // that still runs the old world's script claims this id and is refused by the slot check.
        worldSlots.releaseAll(id)
        io.execute { compiler.forget(id) }
        configureStats.remove(id)
        Log.i(TAG, "detached ${id.take(8)}")
    }

    /** A new core runtime starts from nothing: every extension of the previous one goes. */
    private fun reset() {
        closePopup()
        for (id in backgrounds.keys.toList()) stopBackground(id)
        for (id in units.keys.toList()) {
            for (view in handlers.keys.toList()) removeExtension(view, id)
            io.execute { compiler.forget(id) }
        }
        units.clear()
        served = emptyMap()
        endpoints.clear()
        worldSlots.clear()
        configureStats.clear()
        rules = null
        privateRules = null
        observeRequests = false
    }

    /**
     * `{ extensions: [{ ext, allowPrivate, paths: [ruleset json paths], dynamic: [normalised
     * rules] }] }`, one entry per declarativeNetRequest extension. Static rulesets are Chrome's
     * rule format read from the extension directory; dynamic and session rules arrive normalised
     * from the core's translator. Two sets come out: everyone's rules, and those of the
     * extensions allowed in private tabs (a private tab's requests see only the latter).
     */
    private fun setRules(args: JSONObject, reply: (Any?) -> Unit) {
        // Its own thread: tens of thousands of rules parse in the hundreds of milliseconds, and
        // the `ext.open` / `ext.configure` of the next extension must not wait behind them.
        rulesIo.execute {
            val started = System.nanoTime()
            val all = ArrayList<NetRules.Rule>()
            val private = ArrayList<NetRules.Rule>()
            var privateExtensions = 0
            val extensions = args.arr("extensions")
            var files = 0
            var cached = 0
            val wanted = HashSet<String>()
            for (i in 0 until extensions.length()) {
                val entry = extensions.optJSONObject(i) ?: continue
                val ext = entry.str("ext")
                val allowPrivate = entry.bool("allowPrivate")
                val mine = ArrayList<NetRules.Rule>()
                val paths = entry.arr("paths")
                for (j in 0 until paths.length()) {
                    val file = fileFor(ext, paths.optString(j, "")) ?: continue
                    if (!file.isFile) continue
                    wanted.add(file.path)
                    val loaded = loadStaticRuleset(ext, file) ?: continue
                    files++
                    if (loaded.second) cached++
                    mine.addAll(loaded.first)
                }
                val dynamic = entry.arr("dynamic")
                for (j in 0 until dynamic.length()) {
                    val o = dynamic.optJSONObject(j) ?: continue
                    runCatching { NetRules.parse(o) }.getOrNull()?.let(mine::add)
                }
                all.addAll(mine)
                if (allowPrivate) {
                    private.addAll(mine)
                    privateExtensions++
                }
            }
            // Rulesets no longer wanted (a disabled ruleset, a detached extension) leave memory.
            staticRules.keys.retainAll(wanted)
            val compiled = if (all.isEmpty()) null else NetRules(all)
            // Every extension allowed in private tabs: the one set serves both kinds of tab.
            val compiledPrivate = when {
                private.isEmpty() -> null
                private.size == all.size -> compiled
                else -> NetRules(private)
            }
            val ms = (System.nanoTime() - started) / 1_000_000
            main.post {
                rules = compiled
                privateRules = compiledPrivate
                Log.i(
                    TAG,
                    "rules: ${compiled?.rules?.size ?: 0} from $files file(s) ($cached cached), " +
                        "${private.size} of $privateExtensions extension(s) in private tabs, in $ms ms"
                )
                reply(
                    json(
                        "rules" to (compiled?.rules?.size ?: 0), "privateRules" to private.size,
                        "files" to files, "cached" to cached, "ms" to ms
                    )
                )
            }
        }
    }

    /**
     * One static ruleset: Chrome's rule format normalised to the model `NetRules.parse` reads.
     * The normalised form is cached next to the app's storage keyed by the file's size and mtime,
     * so warm starts skip the Chrome→model conversion (regexes compile lazily either way).
     * Returns the rules and whether they came from the cache.
     */
    private fun loadStaticRuleset(ext: String, file: File): Pair<List<NetRules.Rule>, Boolean>? {
        val fingerprint = "${file.length()}.${file.lastModified()}"
        // Every `ext.setRules` re-sends every extension's rulesets: a file parsed once in this
        // process is not parsed again while it is unchanged.
        staticRules[file.path]?.let { (seen, rules) -> if (seen == fingerprint) return rules to true }
        val cacheDir = File(host.activity.cacheDir, "ext-rules/$ext").apply { mkdirs() }
        val cacheFile = File(cacheDir, "${file.name}.$fingerprint.json")
        runCatching {
            if (cacheFile.isFile) {
                val arr = JSONArray(cacheFile.readText())
                val rules = ArrayList<NetRules.Rule>(arr.length())
                for (k in 0 until arr.length()) arr.optJSONObject(k)?.let { rules.add(NetRules.parse(it)) }
                staticRules[file.path] = fingerprint to rules
                return rules to true
            }
        }
        val text = runCatching { file.readText() }.getOrNull() ?: return null
        val raw = runCatching { JSONArray(text) }.getOrNull() ?: return null
        val normalised = JSONArray()
        val rules = ArrayList<NetRules.Rule>(raw.length())
        for (k in 0 until raw.length()) {
            val o = NetRules.fromChromeRule(raw.optJSONObject(k) ?: continue, "https://$ext$ORIGIN_SUFFIX") ?: continue
            normalised.put(o)
            runCatching { NetRules.parse(o) }.getOrNull()?.let(rules::add)
        }
        runCatching {
            cacheDir.listFiles()?.filter { it.name.startsWith(file.name + ".") }?.forEach { it.delete() }
            cacheFile.writeText(normalised.toString())
        }
        staticRules[file.path] = fingerprint to rules
        return rules to false
    }

    /** Host → endpoint: the reply proxy of the frame that said hello. A dead frame reports `ext.gone`. */
    private fun send(ep: String, message: String) {
        val endpoint = endpoints[ep] ?: return
        if (debug) recordReply(ep, message)
        val ok = runCatching { endpoint.proxy.postMessage(message) }.isSuccess
        if (!ok) gone(listOf(ep))
    }

    private fun recordCall(ep: String, message: JSONObject) {
        val ext = endpoints[ep]?.extensionId ?: message.str("ext")
        trace(">", ep, ext, message)
        val key = when (message.str("t")) {
            "call" -> "$ext ${message.str("ns")}.${message.str("method")}"
            "msg" -> "$ext runtime.sendMessage"
            "connect" -> "$ext runtime.connect"
            "portMsg" -> "$ext port.postMessage"
            else -> return
        }
        synchronized(callStats) {
            callStats.getOrPut(key) { IntArray(3) }[0]++
            if (message.has("id")) pendingCalls["$ep:${message.opt("id")}"] = key
            if (pendingCalls.size > 4000) pendingCalls.clear()
        }
    }

    private fun recordReply(ep: String, message: String) {
        val reply = runCatching { JSONObject(message) }.getOrNull() ?: return
        trace("<", ep, endpoints[ep]?.extensionId ?: "", reply)
        if (reply.optString("t") != "reply") return
        synchronized(callStats) {
            val key = pendingCalls.remove("$ep:${reply.opt("id")}") ?: return
            if (!reply.optBoolean("ok", true)) {
                val counts = callStats.getOrPut(key) { IntArray(3) }
                // The two outcomes Chrome itself reports through runtime.lastError in normal
                // operation (a tab without a listener, a listener that never answered) are not
                // failures of the layer; they are counted apart so a grader can tell them.
                if (reply.optString("error") in UNANSWERED) counts[2]++ else counts[1]++
            }
        }
    }

    /**
     * One line per bridge message while `debug`: direction, extension, endpoint context, message
     * type and the little that tells messages apart (a call's method, a message's `type` field,
     * a reply's outcome). Instrumentation reads it to see where a handshake stopped.
     */
    private fun trace(direction: String, ep: String, ext: String, message: JSONObject) {
        val context = endpoints[ep]?.context ?: message.str("ctx", "?")
        val t = message.str("t")
        val detail = when (t) {
            "call" -> "${message.str("ns")}.${message.str("method")}"
            "msg", "deliver" -> {
                val target = message.optJSONObject("target")
                val data = message.opt("data")
                // The message's own discriminator, under the names extensions use for it.
                val kind = (data as? JSONObject)?.let { d ->
                    listOf("type", "t", "handler", "action", "method", "kind", "cmd").firstNotNullOfOrNull { k -> d.optString(k, "").ifEmpty { null } }
                } ?: ""
                listOfNotNull(
                    target?.opt("tabId")?.let { "tab=$it" },
                    target?.opt("frameId")?.let { "frame=$it" },
                    kind.takeIf { it.isNotEmpty() }?.let { "type=$it" },
                    (message.optJSONObject("sender")?.has("tab"))?.let { "senderTab=$it" }
                ).joinToString(" ")
            }
            "msgReply" -> "handled=${message.opt("handled")} willRespond=${message.opt("willRespond")} listeners=${message.opt("listeners")}"
            "reply" -> if (message.optBoolean("ok", true)) "ok" else "error=${message.optString("error").take(80)}"
            "event" -> "${message.str("ns")}.${message.str("name")}"
            else -> ""
        }
        synchronized(bridgeTrace) {
            if (bridgeTrace.size >= TRACE_LINES) bridgeTrace.removeFirst()
            bridgeTrace.addLast("${SystemClock.uptimeMillis()} $direction ${ext.take(8)}/$context $t $detail".trimEnd())
        }
    }

    /** A snapshot of `callStats` for instrumentation. */
    fun callStatsSnapshot(): Map<String, IntArray> = synchronized(callStats) { callStats.mapValues { it.value.copyOf() } }

    /** The bridge trace lines mentioning `extensionId` (its first eight characters), oldest first. */
    fun traceSnapshot(extensionId: String): List<String> =
        synchronized(bridgeTrace) { bridgeTrace.filter { it.contains(" ${extensionId.take(8)}/") } }

    /**
     * Instrumentation only: run `script` in the isolated world of `extensionId`'s main-frame
     * content endpoint on `view` and hand back the JSON-encoded result, or null when the
     * extension has no world endpoint there (or worlds are off). `evaluateJavascript` only sees
     * the main world; the reply proxy is the way into a world. Main thread.
     */
    fun evalInWorld(view: WebView, extensionId: String, script: String, callback: (String?) -> Unit) {
        val endpoint = endpoints.values.firstOrNull {
            it.view === view && it.extensionId == extensionId && it.context == "content" && it.isMainFrame && it.world
        }
        if (endpoint == null) {
            callback(null)
            return
        }
        val delivered = runCatching {
            endpoint.proxy.executeJavaScript(script, object : androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException> {
                override fun onResult(result: String?) { callback(result) }
                override fun onError(error: androidx.webkit.JavaScriptExecutionException) { callback(null) }
            })
        }.isSuccess
        if (!delivered) callback(null)
    }

    /**
     * `scripting.executeScript` / `insertCSS` / MV2 `tabs.executeScript` into a tab's main frame.
     * The code runs through the bootstrap's `__zenExtExec` in the extension's scope: in its
     * isolated world through the world endpoint's reply proxy when the frame has one; else in
     * the main world with `evaluateJavascript`, after a late boot when the document has no scope
     * for the extension yet (a tab that predates the extension, a page none of its declarations
     * matched, or a WebView without worlds). `world: "MAIN"` injections take the main-world path.
     */
    private fun exec(args: JSONObject, reply: (Any?) -> Unit) {
        val tab = host.tabs.get(args.str("tabId"))
        if (tab == null) {
            reply(Host.Rejection("No tab with that id"))
            return
        }
        val id = args.str("ext")
        val ext = served[id]
        if (ext == null) {
            reply(Host.Rejection("The extension is not attached"))
            return
        }
        val payload = args.obj("payload")
        val call = ExtensionScripts.guarded(
            ExtensionScripts.exec(token, id, args.str("kind", "js"), payload, args.strOrNull("code"), args.strOrNull("funcSource"), args.optJSONArray("args")?.toString())
        )
        val mine = endpoints.values.filter { it.view === tab && it.extensionId == id && it.context == "content" && it.isMainFrame }
        val wantMain = payload.optString("world") == "MAIN"
        if (isolatedWorlds && !wantMain) {
            val world = mine.firstOrNull { it.world }
            if (world != null) {
                val delivered = runCatching {
                    world.proxy.executeJavaScript(call, object : androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException> {
                        override fun onResult(result: String?) { main.post { reply(unwrap(result)) } }
                        override fun onError(error: androidx.webkit.JavaScriptExecutionException) { main.post { reply(Host.Rejection(error.message ?: "script failed")) } }
                    })
                }.isSuccess
                if (!delivered) reply(Host.Rejection("The frame's world is gone"))
                return
            }
        }
        val booted = mine.any { !it.world }
        val script = if (booted) call else {
            lateBoots++
            ExtensionScripts.lateBoot(bootstrap, ext.lateConfig, debug) + "\n" + call
        }
        tab.evaluateJavascript(script) { result -> reply(unwrap(result)) }
    }

    /** The JSON of a [ExtensionScripts.guarded] evaluation → the value, or a rejection with its error. */
    private fun unwrap(result: String?): Any {
        val text = result ?: return Host.Rejection("The script did not run (no scope for the extension in that document)")
        val outcome = runCatching { JSONObject(text) }.getOrNull() ?: return Host.RawJson(text)
        if (outcome.has("e")) return Host.Rejection(outcome.optString("e", "script failed"))
        val value = outcome.opt("v") ?: return Host.RawJson("null")
        return Host.RawJson(
            when (value) {
                JSONObject.NULL -> "null"
                is String -> JSONObject.quote(value)
                is JSONObject, is JSONArray -> value.toString()
                else -> value.toString()
            }
        )
    }

    // ---------------------------------------------------------------------------------------------
    // Tab WebViews
    // ---------------------------------------------------------------------------------------------

    /**
     * Called from every tab WebView's constructor, and again when a custom tab's page is adopted by
     * the browser window (a page that never had an extension layer, so no document of it holds a
     * bridge binding yet): the bridge listener of the main world and of every world slot, the
     * janitor and the units of every attached extension, once per view. All of a view's bridge
     * listeners are registered here and never later: `addWebMessageListener` on a view with live
     * frames strands the bindings those frames already hold (see [WorldSlots]).
     */
    fun attach(view: TabWebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return
        if (handlers.containsKey(view)) return
        WebViewCompat.addWebMessageListener(view, BRIDGE, setOf("*")) { v, message, origin, isMainFrame, proxy ->
            onBridgeMessage(v, message.data, origin, isMainFrame, proxy, "content", slot = null)
        }
        for (slot in 0 until worldSlots.size) {
            val world = WebViewCompat.getExecutionWorld(view, worldSlots.worldName(slot))
            WebViewCompat.addWebMessageListener(view, BRIDGE, setOf("*"), world) { v, message, origin, isMainFrame, proxy ->
                onBridgeMessage(v, message.data, origin, isMainFrame, proxy, "content", slot)
            }
        }
        val mine = ViewHandlers()
        // The janitor first: document-start scripts run in registration order, and it has to take
        // the bridge object off the main world's global before any unit or page script looks.
        mine.janitor = runCatching { WebViewCompat.addDocumentStartJavaScript(view, janitor, setOf("*")) }.getOrNull()
        handlers[view] = mine
        for ((id, list) in units) served[id]?.let { installExtension(view, it, list) }
    }

    /**
     * One extension's handlers on one view: the previous ones go, the current units come. A
     * private tab gets nothing from an extension not allowed there (documents already running
     * its script keep it, as in Chrome, until they navigate).
     */
    private fun installExtension(view: WebView, ext: Served, list: List<ScriptUnit>) {
        val mine = handlers[view] ?: return
        removeExtension(view, ext.id)
        if (view.isPrivateTab && !ext.allowPrivate) return
        val added = ArrayList<ScriptHandler>()
        // Extension pages opened as tabs (options pages, a changelog the background opens with
        // `tabs.create`): the page bootstrap on the extension's own origin.
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(view, pageScript(ext, "page"), setOf("https://${ext.id}$ORIGIN_SUFFIX"))
        }.getOrNull()?.let(added::add)
        for (unit in list) {
            val handler = runCatching { addUnit(view, unit, unit.origins) }
                .recoverCatching {
                    // An origin rule the WebView rejects: fall back to every origin (the bootstrap matches anyway).
                    addUnit(view, unit, setOf("*"))
                }.getOrNull() ?: continue
            added.add(handler)
        }
        mine.byExtension[ext.id] = added
    }

    private fun removeExtension(view: WebView, id: String) {
        handlers[view]?.byExtension?.remove(id)?.forEach { runCatching { it.remove() } }
    }

    /**
     * Main world: `addDocumentStartJavaScript`. Isolated world: `addJavaScriptOnEvent(DOCUMENT_START)`
     * in the slot world the extension's world name is mapped to (its bridge listener has been on
     * the view since construction; the injected object is world-scoped and comes first).
     */
    private fun addUnit(view: WebView, unit: ScriptUnit, origins: Set<String>): ScriptHandler {
        val worldName = unit.world ?: return WebViewCompat.addDocumentStartJavaScript(view, unit.script, origins)
        val slot = worldSlots.slot(worldName) ?: throw IllegalStateException("$worldName has no world slot")
        val world = WebViewCompat.getExecutionWorld(view, worldSlots.worldName(slot))
        return WebViewCompat.addJavaScriptOnEvent(view, unit.script, WebViewCompat.INJECTION_EVENT_DOCUMENT_START, origins, world)
    }

    /**
     * `onPageStarted(url)` of a WebView: the previous document's endpoints are gone. The callback
     * is posted at commit and can land after the new document's bootstrap already said hello
     * (measured on the emulator: background pages register and make their first calls before
     * it arrives), so endpoints of a main frame that reported exactly the new URL are kept.
     * Passing no URL (the view is going away) drops everything.
     */
    fun onDocumentGone(view: WebView, url: String? = null) {
        val mine = endpoints.filterValues { it.view === view }
        val kept = if (url == null) emptyMap() else mine.filterValues { it.isMainFrame && it.url == url }
        if (kept.isNotEmpty()) {
            lateOnPageStarted++
            Log.d(TAG, "onPageStarted($url) after ${kept.size} endpoint(s) of the new document said hello; kept")
        }
        val dead = mine.keys.filter { it !in kept }
        if (dead.isNotEmpty()) gone(dead)
    }

    /** A main frame said hello: whatever else the view registered under another bootstrap is the old document. */
    private fun onNewDocument(view: WebView, doc: String) {
        val dead = endpoints.filterValues { it.view === view && it.doc != doc }.keys.toList()
        if (dead.isNotEmpty()) gone(dead)
    }

    fun detach(view: WebView) {
        onDocumentGone(view)
        handlers.remove(view)
    }

    private fun gone(eps: List<String>) {
        for (ep in eps) endpoints.remove(ep)
        host.chrome.hostEvent("ext.gone", json("eps" to JSONArray(eps)))
    }

    /**
     * A message from a frame's bridge object: the main world's (`slot` null: content scripts under
     * the emulation proxy, extension pages) or a world slot's. A hello from a slot has to claim
     * the extension the slot carries: the token is the same for every extension, so this is what
     * keeps one extension's world from speaking for another (and a document still running a
     * detached extension's world from speaking at all).
     */
    private fun onBridgeMessage(view: WebView, data: String?, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy, kind: String, slot: Int?) {
        val text = data ?: return
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (message.str("token") != token) return
        message.remove("token")
        val ep = message.str("ep")
        if (ep.isEmpty()) return
        if (slot != null) {
            val known = endpoints[ep]
            val claimed = if (known != null) known.extensionId else message.str("ext")
            if (worldSlots.owner(slot) != claimed || (known != null && known.slot != slot)) return
        }
        // A private tab's document still running the script of an extension no longer allowed
        // there (the toggle flipped after the document started) has no bridge.
        if (view.isPrivateTab && served[endpoints[ep]?.extensionId ?: message.str("ext")]?.allowPrivate != true) return
        if (debug) recordCall(ep, message)
        when (message.str("t")) {
            "hello" -> {
                val context = message.str("ctx", kind)
                val doc = ep.substringBefore('.')
                if (isMainFrame) onNewDocument(view, doc)
                endpoints[ep] = Endpoint(view, proxy, context, message.str("ext"), isMainFrame, message.str("url"), doc, slot)
            }
            "popupSize" -> {
                popup?.resize(message.optInt("width"), message.optInt("height"))
                return
            }
            "closePopup" -> {
                closePopup()
                return
            }
            "mainScript" -> {
                mainWorldScript(view, proxy, isMainFrame, ep, message)
                return
            }
        }
        val tabId = (view as? TabWebView)?.tabId
        host.chrome.hostEvent(
            "ext.message",
            json("ep" to ep, "tabId" to tabId, "top" to isMainFrame, "origin" to origin.toString(), "message" to message)
        )
    }

    /**
     * A content script inserted `<script src="https://<id>.ext.zenium.invalid/…">` into the page
     * and the page's Content-Security-Policy refused it. In Chrome an extension's resources are
     * beyond a page's policy (`chrome-extension:` bypasses CSP); the emulated origin is an https
     * origin any `script-src` can refuse. The world reports the refused element; the file, when
     * it is web-accessible, runs in the main world through `evaluateJavascript`, which no page
     * policy governs, and the world hears back so it can fire the element's `load`. Main frame
     * only: `evaluateJavascript` takes no frame.
     */
    private fun mainWorldScript(view: WebView, proxy: JavaScriptReplyProxy, isMainFrame: Boolean, ep: String, message: JSONObject) {
        val id = message.opt("id")
        val url = message.str("url")
        val extId = endpoints[ep]?.extensionId ?: message.str("ext")
        fun done(error: String?) {
            val reply = json("t" to "mainScriptDone", "ep" to ep, "id" to id, "ok" to (error == null), "error" to error).toString()
            main.post {
                if (debug) recordReply(ep, reply)
                runCatching { proxy.postMessage(reply) }
            }
        }
        val uri = Uri.parse(url)
        val ext = served[extId]
        val path = (uri.path ?: "/").trimStart('/')
        when {
            ext == null -> done("the extension is not attached")
            uri.scheme != "https" || uri.host != "$extId$ORIGIN_SUFFIX" -> done("$url is not on the extension's origin")
            !isMainFrame -> done("only the main frame's scripts can run in the main world")
            !ext.webAccessible.any { it.matches(path) } -> done("$path is not a web-accessible resource")
            else -> io.execute {
                val text = fileIn(ext.dir, path)?.takeIf { it.isFile }?.let { f -> runCatching { f.readText() }.getOrNull() }
                if (text == null) {
                    done("$path was not found")
                    return@execute
                }
                // `;void 0` keeps the script's last expression out of the result string.
                main.post { view.evaluateJavascript("$text\n;void 0;\n//# sourceURL=$url") { done(null) } }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Request path: the extension origin and declarativeNetRequest
    // ---------------------------------------------------------------------------------------------

    /**
     * Every WebView's `shouldInterceptRequest` (background thread). Tab pages: a top-level
     * navigation to an extension origin gets any file (Chrome lets any extension page open as a
     * tab), other frames only its web-accessible resources; then the DNR decision. Extension
     * WebViews: any file, and the background view's document is the generated background page
     * wherever the core put it (`backgroundDocument`: an MV3 worker's page lives at the worker
     * script's URL, so `self.location` reads as in Chrome).
     */
    fun intercept(
        request: WebResourceRequest,
        tab: TabWebView?,
        extensionPage: Served?,
        backgroundDocument: Boolean = false
    ): WebResourceResponse? {
        val url = request.url
        val hostName = url.host ?: return null
        if (hostName.endsWith(ORIGIN_SUFFIX)) {
            val id = hostName.removeSuffix(ORIGIN_SUFFIX)
            val ext = served[id] ?: return notFound()
            // Chrome does not load a chrome-extension:// URL in incognito for an extension not allowed there.
            if (tab?.isPrivateTab == true && !ext.allowPrivate) return notFound()
            val path = (url.path ?: "/").trimStart('/')
            val origin = "https://$hostName/"
            val ownPage = tab != null && (
                request.isForMainFrame ||
                    request.requestHeaders?.get("Referer")?.startsWith(origin) == true ||
                    tab.currentUrl?.startsWith(origin) == true
                )
            if (extensionPage == null && !ownPage && !ext.webAccessible.any { it.matches(path) }) return notFound()
            if (backgroundDocument && request.isForMainFrame && ext.backgroundHtml != null && "$origin$path" == ext.backgroundUrl) {
                return response("text/html", 200, "OK", ext.backgroundHtml.toByteArray())
            }
            return serve(ext, path)
        }
        if (extensionPage != null) return null
        val rules = if (tab?.isPrivateTab == true) privateRules else this.rules
        val observe = observeRequests
        if (rules == null && !observe) return null
        val initiator = tab?.currentUrl
        val type = NetRules.guessResourceType(
            url.toString(), request.requestHeaders?.get("Accept"), request.isForMainFrame, isSubFrame = false
        )
        val started = System.nanoTime()
        val decision = rules?.decide(url.toString(), initiator, type, request.method ?: "GET")
        val micros = (System.nanoTime() - started) / 1_000
        if (debug) synchronized(decisions) {
            if (decisions.size >= 400) decisions.removeFirst()
            decisions.addLast("${decisionName(decision)} $type ${micros}us $url")
        }
        if (observe) {
            val payload = json(
                "tabId" to tab?.tabId, "url" to url.toString(), "type" to type, "method" to (request.method ?: "GET"),
                "initiator" to initiator, "decision" to decisionName(decision), "micros" to micros
            )
            main.post { host.chrome.hostEvent("ext.request", payload) }
        }
        return when (decision) {
            null, NetRules.Decision.Allow -> null
            NetRules.Decision.Block -> blocked()
            NetRules.Decision.UpgradeScheme ->
                if (url.scheme == "http") redirect(url.buildUpon().scheme("https").build().toString(), request, type) else null
            is NetRules.Decision.Redirect -> redirect(decision.url, request, type)
        }
    }

    /**
     * WebView cannot answer an intercepted request with a real redirect: `WebResourceResponse`
     * throws for any status in 300..399 (measured; it took the process down). Redirects are
     * therefore emulated: documents get a page that replaces itself with the target, targets on an
     * extension origin are served in place, and other subresources are fetched here on the
     * intercept thread and their body substituted. Non-GET requests are let through unchanged.
     */
    private fun redirect(location: String, request: WebResourceRequest, type: String): WebResourceResponse? {
        if (type == "main_frame" || type == "sub_frame") {
            val html = "<!doctype html><meta charset=\"utf-8\"><script>location.replace(${JSONObject.quote(location)})</script>"
            return response("text/html", 200, "OK", html.toByteArray())
        }
        val target = Uri.parse(location)
        val targetHost = target.host ?: return null
        if (targetHost.endsWith(ORIGIN_SUFFIX)) {
            val ext = served[targetHost.removeSuffix(ORIGIN_SUFFIX)] ?: return notFound()
            return serve(ext, (target.path ?: "/").trimStart('/'))
        }
        return fetchSubstitute(location, request)
    }

    /** A blocking fetch of `location` whose response stands in for the intercepted request. */
    private fun fetchSubstitute(location: String, request: WebResourceRequest): WebResourceResponse? {
        val method = request.method ?: "GET"
        if (method != "GET" && method != "HEAD") return null
        return runCatching {
            val connection = java.net.URL(location).openConnection() as java.net.HttpURLConnection
            connection.requestMethod = method
            connection.instanceFollowRedirects = true
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            request.requestHeaders?.forEach { (name, value) ->
                // Host is the target's; Accept-Encoding stays with HttpURLConnection so it decodes transparently.
                if (!name.equals("Host", true) && !name.equals("Accept-Encoding", true)) connection.setRequestProperty(name, value)
            }
            val status = connection.responseCode
            if (status < 100 || status in 300..399 || status > 599) return null
            val body = (if (status >= 400) connection.errorStream else connection.inputStream) ?: ByteArrayInputStream(ByteArray(0))
            val contentType = connection.contentType ?: "application/octet-stream"
            val mime = contentType.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
            val charset = contentType.substringAfter("charset=", "").substringBefore(';').trim().ifEmpty { null }
            val headers = HashMap<String, String>()
            for ((name, values) in connection.headerFields) {
                if (name == null || values.isNullOrEmpty()) continue
                // Body arrives decoded and re-framed; the length and encoding headers would lie.
                if (name.equals("Content-Length", true) || name.equals("Content-Encoding", true) || name.equals("Transfer-Encoding", true)) continue
                headers[name] = values.joinToString(", ")
            }
            headers["X-Zenium-Redirected-From"] = request.url.toString()
            WebResourceResponse(mime, charset, status, connection.responseMessage?.ifEmpty { null } ?: "OK", headers, body)
        }.getOrNull()
    }

    private fun serve(ext: Served, path: String): WebResourceResponse {
        if (path == GENERATED_BACKGROUND) {
            val html = ext.backgroundHtml ?: return notFound()
            return response("text/html", 200, "OK", html.toByteArray())
        }
        val file = fileIn(ext.dir, path) ?: return notFound()
        if (!file.isFile) return notFound()
        val bytes = runCatching { file.readBytes() }.getOrNull() ?: return notFound()
        return response(ExtensionScripts.mimeType(path), 200, "OK", bytes)
    }

    private fun response(mime: String, status: Int, reason: String, body: ByteArray, extra: Map<String, String> = emptyMap()): WebResourceResponse {
        val headers = HashMap<String, String>(extra)
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Cache-Control"] = "no-cache"
        headers["Content-Length"] = body.size.toString()
        return WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json")) "utf-8" else null, status, reason, headers, ByteArrayInputStream(body))
    }

    private fun notFound() = response("text/plain", 404, "Not Found", ByteArray(0))

    /** Chrome answers a blocked request with net::ERR_BLOCKED_BY_CLIENT; the closest WebView has is an empty 403. */
    private fun blocked() = response("text/plain", 403, "Blocked by extension", ByteArray(0))

    private fun decisionName(decision: NetRules.Decision?): String = when (decision) {
        null -> "none"
        NetRules.Decision.Allow -> "allow"
        NetRules.Decision.Block -> "block"
        NetRules.Decision.UpgradeScheme -> "upgradeScheme"
        is NetRules.Decision.Redirect -> "redirect"
    }

    /**
     * A record's directory, or null when the path is not a directory under the store's install
     * root (`files/zen/extensions`): the runtime only serves what the store installed.
     */
    private fun recordDir(path: String): File? {
        if (path.isEmpty()) return null
        val dir = File(path)
        val canonical = runCatching { dir.canonicalPath }.getOrNull() ?: return null
        val root = runCatching { host.extStore.root.canonicalPath }.getOrNull() ?: return null
        if (!canonical.startsWith(root + File.separator)) return null
        return if (dir.isDirectory) dir else null
    }

    /** A file inside an attached extension's directory, or null when the path escapes it. */
    fun fileFor(id: String, path: String): File? {
        val ext = served[id] ?: return null
        return fileIn(ext.dir, path)
    }

    /** `path` resolved inside `dir`, or null when it escapes it (`..`, symlinks). */
    private fun fileIn(dir: File, path: String): File? {
        val file = File(dir, path.trimStart('/'))
        val canonical = runCatching { file.canonicalPath }.getOrNull() ?: return null
        val root = runCatching { dir.canonicalPath }.getOrNull() ?: return null
        if (!canonical.startsWith(root + File.separator)) return null
        return file
    }

    fun servedFor(id: String): Served? = served[id]

    /** The hidden background WebView of an attached extension (instrumentation reads its console). */
    fun backgroundView(id: String): ExtensionWebView? = backgrounds[id]

    /** The document-start script units currently installed in every tab, across extensions. */
    fun scriptUnits(): List<ScriptUnit> = units.values.flatten()

    /** The WebView of the open popup / options sheet, if any. */
    fun popupView(): ExtensionWebView? = popup?.webView

    // ---------------------------------------------------------------------------------------------
    // Background pages and popups
    // ---------------------------------------------------------------------------------------------

    /**
     * The core's lifecycle policy (`runtime/background.ts`) asks for a start only when it holds
     * no page: whatever runs here under that id is a leftover it cannot see (a start whose stop
     * has not reported gone yet, or an earlier runtime's page), so the page is always fresh.
     */
    private fun startBackground(id: String) {
        val ext = served[id] ?: return
        val url = ext.backgroundUrl ?: return
        stopBackground(id)
        val view = ExtensionWebView(host, this, ext, "background")
        backgrounds[id] = view
        host.attachHidden(view)
        view.loadUrl(url)
    }

    private fun stopBackground(id: String) {
        val view = backgrounds.remove(id) ?: return
        onDocumentGone(view)
        host.detachHidden(view)
        view.destroy()
    }

    private fun openPopup(id: String, url: String, context: String) {
        closePopup()
        val ext = served[id] ?: return
        val sheet = ExtensionPopup(host, this, ext, url, context) {
            popup = null
            host.chrome.hostEvent("ext.popupClosed", json("id" to id))
        }
        popup = sheet
        sheet.show()
    }

    fun closePopup() {
        popup?.dismiss()
        popup = null
    }

    /** Endpoints of a WebView are dropped when it is destroyed. */
    fun onWebViewDestroyed(view: WebView) = detach(view)

    /**
     * The renderer behind an extension view is gone (every WebView of the app shares it, so the
     * chrome lost it too). A dead background view goes; its endpoints report gone and the core's
     * lifecycle restarts it when something needs it. A dead popup is closed.
     */
    fun onRendererGone(view: ExtensionWebView) {
        val id = backgrounds.entries.firstOrNull { it.value === view }?.key
        if (id != null) stopBackground(id)
        if (popup?.webView === view) closePopup()
    }

    fun pageScript(ext: Served, context: String): String {
        val config = runCatching { JSONObject(ext.pageConfig) }.getOrDefault(JSONObject())
        config.put("context", context)
        return ExtensionScripts.page(bootstrap, config.toString())
    }

    fun onBridgeMessageFromPage(view: WebView, data: String?, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) =
        onBridgeMessage(view, data, origin, isMainFrame, proxy, "page", slot = null)

    fun destroy() {
        closePopup()
        for (id in backgrounds.keys.toList()) stopBackground(id)
        io.shutdownNow()
        rulesIo.shutdownNow()
    }

    companion object {
        const val TAG = "ZenExt"
        const val BRIDGE = "__zenExtBridge"
        /**
         * Isolated worlds a tab view can host at once (one per extension, two for an extension
         * with a `USER_SCRIPT` world). Each costs one listener registration per tab view at
         * construction and nothing at run time until a unit is injected into it; the core plans
         * an extension beyond the budget under the emulation proxy instead.
         */
        const val WORLD_SLOTS = 16
        /** Bridge trace lines kept for instrumentation (one line per message, all extensions together). */
        const val TRACE_LINES = 2400
        /** Reply errors Chrome raises in normal operation: a message to a tab without a listener, a listener that never answered. */
        val UNANSWERED = setOf(
            "Could not establish connection. Receiving end does not exist.",
            "The message port closed before a response was received."
        )
        const val ORIGIN_SUFFIX = ".ext.zenium.invalid"
        const val GENERATED_BACKGROUND = "_generated_background_page.html"
        val VALID_ID = Regex("^[a-p]{32}$")
        /** `_locales/<dir>`: a language tag with underscores, nothing that could leave the directory. */
        val LOCALE_DIR = Regex("^[A-Za-z0-9_]{1,16}$")

        /** A tab view of the private container (extension WebViews and ordinary tabs are not). */
        val WebView.isPrivateTab: Boolean
            get() = (this as? TabWebView)?.containerId == Profiles.PRIVATE_CONTAINER

        /** `web_accessible_resources` glob → regex (`*` spans path separators, as in Chrome). */
        fun globToRegex(glob: String): Regex {
            val clean = glob.trimStart('/')
            val sb = StringBuilder("^")
            for (ch in clean) {
                when (ch) {
                    '*' -> sb.append(".*")
                    else -> if (ch in ".+?^\${}()|[]\\/") sb.append('\\').append(ch) else sb.append(ch)
                }
            }
            return Regex(sb.append('$').toString())
        }
    }
}
