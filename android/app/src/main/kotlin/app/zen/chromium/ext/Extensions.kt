package app.zen.chromium.ext

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
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
 * The Kotlin half of the extension emulation layer. The browser core (TypeScript, in the chrome
 * WebView) owns the extension model: it parses manifests, plans content-script injection, routes
 * messages and implements the `chrome.*` calls. This class is the platform it needs:
 *
 *  - the install directory (`files/zen/extensions/<id>/`, unpacked extensions) and a scan of it;
 *  - the synthetic origin `https://<id>.ext.zenium.invalid/`, served from the unpacked directory
 *    through `shouldInterceptRequest` of every WebView (tab pages see only web-accessible
 *    resources; extension pages see everything, plus the generated background page);
 *  - the document-start script units for tab WebViews (bootstrap + sources + config, one unit per
 *    origin-rule set), re-installed on every tab whenever the core reconfigures;
 *  - the `__zenExtBridge` WebMessageListener: every frame that runs a content script or an
 *    extension page says hello with an endpoint id; its JavaScriptReplyProxy is kept so the core
 *    can answer it (`ext.send`);
 *  - hidden background WebViews and the popup bottom sheet;
 *  - declarativeNetRequest on the request path (static rulesets read from disk, dynamic rules
 *    from the core) and, on demand, observational `webRequest` events.
 */
class Extensions(private val host: Host) {
    val dir: File = File(host.activity.filesDir, "zen/extensions")
    /** Every bridge message carries this; pages never see it (it lives in closures only). */
    val token: String = SecureRandom().let { r -> ByteArray(16).also(r::nextBytes).joinToString("") { "%02x".format(it) } }
    private val bootstrap: String by lazy { host.activity.assets.open("ext.js").bufferedReader().readText() }
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-ext") }

    /**
     * One document-start script, injected into frames whose origin matches `origins`; into the
     * named isolated world when `world` is set (only when the WebView has isolated worlds).
     */
    class ScriptUnit(val origins: Set<String>, val script: String, val world: String?)

    /** What the core configured for one enabled extension. */
    class Served(
        val id: String,
        val dir: File,
        /** `web_accessible_resources` globs (tab pages may only fetch these). */
        val webAccessible: List<Regex>,
        /** The generated background page, or null when the extension has none / an MV2 page. */
        val backgroundHtml: String?,
        val backgroundUrl: String?,
        /** Page-mode boot config (JSON) without `context`; set per WebView kind. */
        val pageConfig: String
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
        val world: Boolean
    )

    /**
     * Real isolated worlds: `JS_INJECTION_IN_FRAME_AND_WORLD` (androidx.webkit 1.17, Chromium 146+
     * WebView). Content-script units then run in a per-extension world and the emulation proxy is
     * off. Resolved once, on the main thread, when the core first scans.
     */
    val isolatedWorlds: Boolean by lazy {
        runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD) }.getOrDefault(false)
    }
    /** Worlds (by name) whose bridge listener is already registered on a WebView. */
    private val worldListeners = WeakHashMap<WebView, MutableSet<String>>()

    @Volatile private var units: List<ScriptUnit> = emptyList()
    @Volatile private var served: Map<String, Served> = emptyMap()
    @Volatile private var rules: NetRules? = null
    @Volatile private var observeRequests = false
    @Volatile var debug = true
        private set
    private val handlers = WeakHashMap<WebView, MutableList<ScriptHandler>>()
    private val endpoints = HashMap<String, Endpoint>()
    private val backgrounds = HashMap<String, ExtensionWebView>()
    private var popup: ExtensionPopup? = null
    /** Last request decisions ("allow|block|… type micros url"), kept while `debug` for instrumentation. */
    val decisions = ArrayDeque<String>()
    /**
     * While `debug`: `"<ext> <ns>.<method>"` → `[calls, failed replies]` over the bridge, so the
     * demo can grade messaging and storage per real extension (`msg` counts as
     * `runtime.sendMessage`, `connect` as `runtime.connect`, `portMsg` as `port.postMessage`).
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

    val origin = ORIGIN_SUFFIX

    // ---------------------------------------------------------------------------------------------
    // Native methods (from the core)
    // ---------------------------------------------------------------------------------------------

    fun handle(method: String, args: JSONObject, reply: (Any?) -> Unit) {
        when (method) {
            "ext.scan" -> {
                val worlds = isolatedWorlds
                io.execute {
                    val list = scan()
                    main.post {
                        reply(json("token" to token, "extensions" to list, "uiLanguage" to Locale.getDefault().toLanguageTag(), "isolatedWorlds" to worlds))
                    }
                }
            }
            "ext.configure" -> configure(args, reply)
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
            "ext.readFile" -> io.execute {
                val text = runCatching { fileFor(args.str("id"), args.str("path"))?.readText() }.getOrNull()
                main.post { reply(text) }
            }
            "ext.remove" -> io.execute {
                val id = args.str("id")
                if (VALID_ID.matches(id)) File(dir, id).deleteRecursively()
                main.post { reply(null) }
            }
            else -> throw IllegalArgumentException("Unknown method: $method")
        }
    }

    /**
     * Installed extensions: `[{ id, path, manifest, locales: { <locale>: <messages.json> }, icon }]`.
     * Only the locales the core can use (the UI locale, its language, the manifest default) travel.
     */
    fun scan(): JSONArray {
        val out = JSONArray()
        val dirs = dir.listFiles()?.filter { it.isDirectory && VALID_ID.matches(it.name) }?.sortedBy { it.name } ?: emptyList()
        for (extDir in dirs) {
            val manifestFile = File(extDir, "manifest.json")
            val manifestText = runCatching { manifestFile.readText() }.getOrNull() ?: continue
            val manifest = runCatching { JSONObject(manifestText) }.getOrNull()
            val locales = JSONObject()
            val defaultLocale = manifest?.strOrNull("default_locale")
            val ui = Locale.getDefault()
            for (candidate in listOf(ui.toString(), ui.language, defaultLocale).filterNotNull().map { it.replace('-', '_') }) {
                val file = File(extDir, "_locales/$candidate/messages.json")
                if (file.isFile && !locales.has(candidate)) runCatching { locales.put(candidate, file.readText()) }
            }
            val icon = manifest?.optJSONObject("icons")?.let { icons ->
                val largest = icons.keys().asSequence().mapNotNull { k -> k.toIntOrNull()?.let { it to icons.str(k) } }.maxByOrNull { it.first }
                largest?.second?.let { path -> dataUrl(File(extDir, path.trimStart('/'))) }
            }
            out.put(json("id" to extDir.name, "path" to extDir.absolutePath, "manifest" to manifestText, "locales" to locales, "icon" to icon))
        }
        return out
    }

    /**
     * `{ units: [{ origins, config, groups: [{ ext, index, js, isolation }], css: [{ ext, path }] }],
     *    extensions: { <id>: { webAccessible: [glob], backgroundHtml, backgroundUrl, page } }, debug }`.
     * Reading the sources is file IO, so the units are assembled off the main thread and installed
     * on it; background WebViews of extensions that disappeared are torn down.
     */
    private fun configure(args: JSONObject, reply: (Any?) -> Unit) {
        val debug = args.bool("debug", true)
        io.execute {
            val extensions = args.obj("extensions")
            val servedNow = HashMap<String, Served>()
            for (id in extensions.keys()) {
                if (!VALID_ID.matches(id)) continue
                val e = extensions.obj(id)
                servedNow[id] = Served(
                    id = id,
                    dir = File(dir, id),
                    webAccessible = e.arr("webAccessible").let { a -> List(a.length()) { i -> globToRegex(a.optString(i, "")) } },
                    backgroundHtml = e.strOrNull("backgroundHtml"),
                    backgroundUrl = e.strOrNull("backgroundUrl"),
                    pageConfig = e.str("page", "{}")
                )
            }
            val unitsNow = ArrayList<ScriptUnit>()
            val unitsJson = args.arr("units")
            val bootstrapText = bootstrap
            for (i in 0 until unitsJson.length()) {
                val u = unitsJson.optJSONObject(i) ?: continue
                val groups = ArrayList<ExtensionScripts.Group>()
                val groupsJson = u.arr("groups")
                for (j in 0 until groupsJson.length()) {
                    val g = groupsJson.optJSONObject(j) ?: continue
                    val ext = g.str("ext")
                    val files = g.arr("js")
                    val sources = List(files.length()) { k ->
                        val path = files.optString(k, "")
                        runCatching { fileFor(ext, path)?.readText() }.getOrNull()
                            ?: "console.error(${JSONObject.quote("[Zenium] extension $ext: missing content script $path")});"
                    }
                    groups.add(ExtensionScripts.Group(ext, g.optInt("index"), sources, g.str("isolation", "shadow")))
                }
                val css = LinkedHashMap<String, String>()
                val cssJson = u.arr("css")
                for (j in 0 until cssJson.length()) {
                    val c = cssJson.optJSONObject(j) ?: continue
                    val text = runCatching { fileFor(c.str("ext"), c.str("path"))?.readText() }.getOrNull() ?: continue
                    css["${c.str("ext")}/${c.str("path").trimStart('/')}"] = text
                }
                val origins = u.arr("origins").let { a -> List(a.length()) { k -> a.optString(k, "*") } }.toSet().ifEmpty { setOf("*") }
                val world = u.strOrNull("world")?.takeIf { it.isNotEmpty() && isolatedWorlds }
                unitsNow.add(ScriptUnit(origins, ExtensionScripts.documentStart(bootstrapText, u.str("config", "{}"), groups, css, debug), world))
            }
            main.post {
                this.debug = debug
                served = servedNow
                units = unitsNow
                for (view in host.tabs.all()) installUnits(view)
                for (id in backgrounds.keys.toList()) if (id !in servedNow) stopBackground(id)
                if (popup?.extensionId?.let { it !in servedNow } == true) closePopup()
                Log.i(TAG, "configured ${servedNow.size} extension(s), ${unitsNow.size} script unit(s), " +
                    "${unitsNow.sumOf { it.script.length }} chars of document-start script")
                reply(json("units" to unitsNow.map { json("origins" to JSONArray(it.origins.toList()), "chars" to it.script.length) }.let { JSONArray(it) }))
            }
        }
    }

    /**
     * `{ static: [{ ext, paths: [ruleset json paths] }], dynamic: [normalised rules] }`. Static
     * rulesets are Chrome's rule format read from the extension directory; dynamic and session
     * rules arrive normalised from the core's translator.
     */
    private fun setRules(args: JSONObject, reply: (Any?) -> Unit) {
        io.execute {
            val started = System.nanoTime()
            val all = ArrayList<NetRules.Rule>()
            val statics = args.arr("static")
            var files = 0
            var cached = 0
            for (i in 0 until statics.length()) {
                val s = statics.optJSONObject(i) ?: continue
                val ext = s.str("ext")
                val paths = s.arr("paths")
                for (j in 0 until paths.length()) {
                    val file = fileFor(ext, paths.optString(j, "")) ?: continue
                    if (!file.isFile) continue
                    val loaded = loadStaticRuleset(ext, file) ?: continue
                    files++
                    if (loaded.second) cached++
                    all.addAll(loaded.first)
                }
            }
            val dynamic = args.arr("dynamic")
            for (i in 0 until dynamic.length()) {
                val o = dynamic.optJSONObject(i) ?: continue
                runCatching { NetRules.parse(o) }.getOrNull()?.let(all::add)
            }
            val compiled = if (all.isEmpty()) null else NetRules(all)
            val ms = (System.nanoTime() - started) / 1_000_000
            main.post {
                rules = compiled
                Log.i(TAG, "rules: ${compiled?.rules?.size ?: 0} from $files file(s) ($cached cached) in $ms ms")
                reply(json("rules" to (compiled?.rules?.size ?: 0), "files" to files, "cached" to cached, "ms" to ms))
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
        val cacheDir = File(host.activity.cacheDir, "ext-rules/$ext").apply { mkdirs() }
        val cacheFile = File(cacheDir, "${file.name}.${file.length()}.${file.lastModified()}.json")
        runCatching {
            if (cacheFile.isFile) {
                val arr = JSONArray(cacheFile.readText())
                val rules = ArrayList<NetRules.Rule>(arr.length())
                for (k in 0 until arr.length()) arr.optJSONObject(k)?.let { rules.add(NetRules.parse(it)) }
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
            callStats.getOrPut(key) { IntArray(2) }[0]++
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
            if (!reply.optBoolean("ok", true)) callStats.getOrPut(key) { IntArray(2) }[1]++
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
                val kind = (data as? JSONObject)?.let { it.optString("type", "").ifEmpty { it.optString("t", "") } } ?: ""
                listOfNotNull(
                    target?.opt("tabId")?.let { "tab=$it" },
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
            if (bridgeTrace.size >= 600) bridgeTrace.removeFirst()
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

    private fun exec(args: JSONObject, reply: (Any?) -> Unit) {
        val tab = host.tabs.get(args.str("tabId"))
        if (tab == null) {
            reply(Host.Rejection("No tab with that id"))
            return
        }
        val ext = args.str("ext")
        val script = ExtensionScripts.exec(
            token, ext, args.str("kind", "js"), args.obj("payload"),
            args.strOrNull("code"), args.strOrNull("funcSource"), args.optJSONArray("args")?.toString()
        )
        if (isolatedWorlds) {
            // `__zenExtExec` lives in the extension's world, out of `evaluateJavascript`'s reach; the
            // main frame's reply proxy executes in the frame and world it came from. A frame has the
            // extension's world endpoint and, for `world: "MAIN"` scripts, a main-world one: pick
            // the one the injection asks for, the other if only that one exists.
            val wantMain = args.obj("payload").optString("world") == "MAIN"
            val candidates = endpoints.values.filter { it.view === tab && it.extensionId == ext && it.context == "content" && it.isMainFrame }
            val endpoint = candidates.firstOrNull { it.world != wantMain } ?: candidates.firstOrNull()
            if (endpoint == null) {
                reply(Host.Rejection("The extension has no content-script world in that tab yet"))
                return
            }
            val delivered = runCatching {
                endpoint.proxy.executeJavaScript(script, object : androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException> {
                    override fun onResult(result: String?) { main.post { reply(Host.RawJson(result ?: "null")) } }
                    override fun onError(error: androidx.webkit.JavaScriptExecutionException) { main.post { reply(Host.Rejection(error.message ?: "script failed")) } }
                })
            }.isSuccess
            if (!delivered) reply(Host.Rejection("The frame's world is gone"))
            return
        }
        tab.evaluateJavascript(script) { result -> reply(Host.RawJson(result ?: "null")) }
    }

    // ---------------------------------------------------------------------------------------------
    // Tab WebViews
    // ---------------------------------------------------------------------------------------------

    /**
     * Called from every tab WebView's constructor, and again when a custom tab's page is adopted by
     * the browser window: the bridge listener plus the current units, once per view (the WebView
     * rejects a second listener under the same name).
     */
    fun attach(view: TabWebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return
        if (handlers.containsKey(view)) return
        WebViewCompat.addWebMessageListener(view, BRIDGE, setOf("*")) { v, message, origin, isMainFrame, proxy ->
            onBridgeMessage(v, message.data, origin, isMainFrame, proxy, "content")
        }
        installUnits(view)
    }

    private fun installUnits(view: WebView) {
        handlers.remove(view)?.forEach { runCatching { it.remove() } }
        val list = ArrayList<ScriptHandler>()
        // Extension pages opened as tabs (options pages, a changelog the background opens with
        // `tabs.create`): the page bootstrap on the extension's own origin, registered ahead of the
        // content units so it is the one that claims the frame's bridge object.
        for (ext in served.values) {
            val handler = runCatching {
                WebViewCompat.addDocumentStartJavaScript(view, pageScript(ext, "page"), setOf("https://${ext.id}$ORIGIN_SUFFIX"))
            }.getOrNull() ?: continue
            list.add(handler)
        }
        for (unit in units) {
            val handler = runCatching { addUnit(view, unit, unit.origins) }
                .recoverCatching {
                    // An origin rule the WebView rejects: fall back to every origin (the bootstrap matches anyway).
                    addUnit(view, unit, setOf("*"))
                }.getOrNull() ?: continue
            list.add(handler)
        }
        handlers[view] = list
    }

    /**
     * Main world: `addDocumentStartJavaScript`. Isolated world: the world's own bridge listener
     * (once per WebView and world; the injected object is world-scoped and comes first) and
     * `addJavaScriptOnEvent(DOCUMENT_START)` in that world.
     */
    private fun addUnit(view: WebView, unit: ScriptUnit, origins: Set<String>): ScriptHandler {
        val worldName = unit.world ?: return WebViewCompat.addDocumentStartJavaScript(view, unit.script, origins)
        val world = WebViewCompat.getExecutionWorld(view, worldName)
        val registered = worldListeners.getOrPut(view) { HashSet() }
        if (registered.add(worldName)) {
            WebViewCompat.addWebMessageListener(view, BRIDGE, setOf("*"), world) { v, message, origin, isMainFrame, proxy ->
                onBridgeMessage(v, message.data, origin, isMainFrame, proxy, "content")
            }
        }
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
        worldListeners.remove(view)
    }

    private fun gone(eps: List<String>) {
        for (ep in eps) endpoints.remove(ep)
        host.chrome.hostEvent("ext.gone", json("eps" to JSONArray(eps)))
    }

    private fun onBridgeMessage(view: WebView, data: String?, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy, kind: String) {
        val text = data ?: return
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return
        if (message.str("token") != token) return
        message.remove("token")
        val ep = message.str("ep")
        if (ep.isEmpty()) return
        if (debug) recordCall(ep, message)
        when (message.str("t")) {
            "hello" -> {
                val context = message.str("ctx", kind)
                val doc = ep.substringBefore('.')
                if (isMainFrame) onNewDocument(view, doc)
                endpoints[ep] = Endpoint(
                    view, proxy, context, message.str("ext"), isMainFrame, message.str("url"), doc, message.optBoolean("world")
                )
            }
            "popupSize" -> {
                popup?.resize(message.optInt("width"), message.optInt("height"))
                return
            }
            "closePopup" -> {
                closePopup()
                return
            }
        }
        val tabId = (view as? TabWebView)?.tabId
        host.chrome.hostEvent(
            "ext.message",
            json("ep" to ep, "tabId" to tabId, "top" to isMainFrame, "origin" to origin.toString(), "message" to message)
        )
    }

    // ---------------------------------------------------------------------------------------------
    // Request path: the extension origin and declarativeNetRequest
    // ---------------------------------------------------------------------------------------------

    /**
     * Every WebView's `shouldInterceptRequest` (background thread). Tab pages: a top-level
     * navigation to an extension origin gets any file (Chrome lets any extension page open as a
     * tab), other frames only its web-accessible resources; then the DNR decision. Extension
     * WebViews: any file.
     */
    fun intercept(request: WebResourceRequest, tab: TabWebView?, extensionPage: Served?): WebResourceResponse? {
        val url = request.url
        val hostName = url.host ?: return null
        if (hostName.endsWith(ORIGIN_SUFFIX)) {
            val id = hostName.removeSuffix(ORIGIN_SUFFIX)
            val ext = served[id] ?: return notFound()
            val path = (url.path ?: "/").trimStart('/')
            val origin = "https://$hostName/"
            val ownPage = tab != null && (
                request.isForMainFrame ||
                    request.requestHeaders?.get("Referer")?.startsWith(origin) == true ||
                    tab.currentUrl?.startsWith(origin) == true
                )
            if (extensionPage == null && !ownPage && !ext.webAccessible.any { it.matches(path) }) return notFound()
            return serve(ext, path)
        }
        if (extensionPage != null) return null
        val rules = this.rules
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
        val file = fileFor(ext.id, path) ?: return notFound()
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

    /** A file inside an extension's directory, or null when the path escapes it. */
    fun fileFor(id: String, path: String): File? {
        if (!VALID_ID.matches(id)) return null
        val root = File(dir, id)
        val file = File(root, path.trimStart('/'))
        val canonical = runCatching { file.canonicalPath }.getOrNull() ?: return null
        if (!canonical.startsWith(root.canonicalPath + File.separator)) return null
        return file
    }

    fun servedFor(id: String): Served? = served[id]

    /** The hidden background WebView of an enabled extension (instrumentation reads its console). */
    fun backgroundView(id: String): ExtensionWebView? = backgrounds[id]

    /** The document-start script units currently installed in every tab (origins and size). */
    fun scriptUnits(): List<ScriptUnit> = units

    /** The WebView of the open popup / options sheet, if any. */
    fun popupView(): ExtensionWebView? = popup?.webView

    // ---------------------------------------------------------------------------------------------
    // Background pages and popups
    // ---------------------------------------------------------------------------------------------

    /**
     * Idempotent: a reconfigure (every `updateDynamicRules`/`registerContentScripts` call triggers
     * one) keeps a background that is already running at the same URL. Restarting it on every
     * configure made the five demo backgrounds restart every ~5 s, because each start called one
     * of those APIs. `ext.background.stop` first for a real reload.
     */
    private fun startBackground(id: String) {
        val ext = served[id] ?: return
        val url = ext.backgroundUrl ?: return
        if (backgrounds[id]?.served?.backgroundUrl == url) return
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
     * chrome lost it too). A dead background view goes; the core that reboots with the chrome
     * re-sends `ext.background.start`. A dead popup is closed.
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
        onBridgeMessage(view, data, origin, isMainFrame, proxy, "page")

    fun destroy() {
        closePopup()
        for (id in backgrounds.keys.toList()) stopBackground(id)
        io.shutdownNow()
    }

    companion object {
        const val TAG = "ZenExt"
        const val BRIDGE = "__zenExtBridge"
        const val ORIGIN_SUFFIX = ".ext.zenium.invalid"
        const val GENERATED_BACKGROUND = "_generated_background_page.html"
        val VALID_ID = Regex("^[a-p]{32}$")

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

        private fun dataUrl(file: File): String? {
            if (!file.isFile || file.length() > 512 * 1024) return null
            val bytes = runCatching { file.readBytes() }.getOrNull() ?: return null
            return "data:${ExtensionScripts.mimeType(file.name)};base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        }
    }
}
