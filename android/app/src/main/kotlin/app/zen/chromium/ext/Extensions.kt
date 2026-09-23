package app.zen.chromium.ext

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Choreographer
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebResourceResponseCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.BridgeAdmission
import app.zen.chromium.Host
import app.zen.chromium.Profiles
import app.zen.chromium.TabWebView
import app.zen.chromium.arr
import app.zen.chromium.blocking.BlockingTab
import app.zen.chromium.blocking.Decision
import app.zen.chromium.blocking.DecisionObserver
import app.zen.chromium.blocking.Domains
import app.zen.chromium.blocking.HeaderStage
import app.zen.chromium.blocking.ProfileCookieStore
import app.zen.chromium.blocking.RedirectExecutor
import app.zen.chromium.blocking.Request
import app.zen.chromium.blocking.ResourceType
import app.zen.chromium.bool
import app.zen.chromium.json
import app.zen.chromium.obj
import app.zen.chromium.str
import app.zen.chromium.strOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.security.SecureRandom
import java.util.Locale
import java.util.WeakHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

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
 *  - the extension seams of the request engine (`blocking/`): declarativeNetRequest itself is
 *    the core's translator writing `ext:` rule sets into the persisted index the engine
 *    compiles, scoped to the partitions the extension runs in; this class hears the engine's
 *    decisions ([DecisionObserver]) and reports the ones an extension's rule took – and, while
 *    an extension listens for `webRequest`, every one – as `ext.request`, and substitutes the
 *    response of a redirected subresource ([RedirectExecutor], see [redirect]).
 *
 * Protocol (the core → here), keyed by extension id where it applies: `ext.env`, `ext.open`,
 * `ext.configure`, `ext.detach`, `ext.background.start` / `stop`, `ext.popup.open` / `close`,
 * `ext.send`, `ext.exec`, `ext.readFile`, `ext.cookies.get` / `set`, `ext.observeRequests`,
 * `ext.proxy.set` / `clear` (`chrome.proxy.settings` over the WebView's proxy override, [ExtensionProxy]).
 * Here → the core (host events): `ext.message`, `ext.gone`, `ext.popupClosed`, `ext.request`.
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
        /** `host_permissions` (and MV2 origin permissions): the hosts the CORS proxy reaches for the extension's pages. */
        val hosts: List<MatchPattern>,
        /** The generated background page, or null when the extension has none / an MV2 page. */
        val backgroundHtml: String?,
        val backgroundUrl: String?,
        /** Page-mode boot config (JSON) without `context`; set per WebView kind. */
        val pageConfig: String,
        /** Content-mode boot config (JSON) of a late boot: no groups, `with` isolation. */
        val lateConfig: String,
        /**
         * The substitution map of the extension's stylesheets (`cssSubstitutionMap` in the core):
         * every `text/css` file served on the extension's origin has its `__MSG_name__`
         * placeholders replaced from it, as Chrome's renderer does for a `chrome-extension://`
         * stylesheet response (`ExtensionFiles.localizeCss`).
         */
        val cssMessages: Map<String, String> = emptyMap()
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
    /**
     * Tab pages requested on an extension's origin before its configure (a restored tab at
     * boot): held on an empty document and loaded again when the extension is served, failed
     * when it is not coming (see [HeldPages]).
     */
    private val heldPages = HeldPages<TabWebView>()
    /** Per extension, the units currently installed on every tab (main thread). */
    private val units = LinkedHashMap<String, List<ScriptUnit>>()
    /**
     * Whether an extension listens for `webRequest` right now (`ext.observeRequests`): then every
     * decision of the engine is reported, not only those an extension's rule took.
     */
    @Volatile private var observeRequests = false
    /** `ext.request` ids: one sequence per process, like Chrome's request ids. */
    private val requestIds = AtomicLong(1)
    /** The `identity.launchWebAuthFlow` sheets open right now, by the runtime's view id (`ext.auth.*`). */
    private val authSheets = HashMap<Int, ExtensionAuthSheet>()
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
    /** `chrome.offscreen`'s hidden page per extension: a background-like view on the URL the extension named. */
    private val offscreens = HashMap<String, ExtensionWebView>()
    private var popup: ExtensionPopup? = null
    /** The user agent extension pages send (set when the first extension view is built), for the CORS proxy's requests. */
    @Volatile var userAgent: String? = null
    /** Optional host permissions granted at runtime (`chrome.permissions.request`), per extension; read on request threads. */
    @Volatile private var grantedHosts: Map<String, List<MatchPattern>> = emptyMap()
    /** The jar half of `chrome.cookies` (see [ExtensionCookies]). */
    private val cookies = ExtensionCookies()
    /** The shade half of `chrome.notifications` (see [ExtensionNotifications]). */
    private val notifications = ExtensionNotifications(host.activity, io) { id, notificationId, event, index ->
        onNotificationEvent(id, notificationId, event, index)
    }
    /**
     * Taps on cards of extensions not attached right now (the card outlived the process, or the
     * chrome is still booting): delivered when `ext.configure` brings the extension back.
     */
    private val pendingNotificationEvents = HashMap<String, ArrayDeque<JSONObject>>()
    /** The notification permission is asked for once per process, on the first card (Android 13+). */
    private var askedNotifications = false
    /**
     * Whether the WebView stores the cookies of an intercepted response handed over through
     * `WebResourceResponseCompat.setCookies` (`COOKIE_INTERCEPT`, Chromium 137+); read once, and
     * defensively, as [NavigationReports] reads its features.
     */
    val cookieIntercept: Boolean by lazy {
        runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.COOKIE_INTERCEPT) }.getOrDefault(false)
    }
    /**
     * Cross-origin fetches of extension pages to permitted hosts (see [CorsProxy]). A credentialed
     * response's `Set-Cookie` reaches the WebView's jar as the response's cookies where the WebView
     * files those itself, through `CookieManager` otherwise.
     */
    private val corsProxy = CorsProxy(
        object : CorsProxy.Cookies {
            override val intercepts: Boolean get() = cookieIntercept
            override fun header(url: String): String? = CookieManager.getInstance().getCookie(url)
            override fun store(url: String, setCookie: String) = CookieManager.getInstance().setCookie(url, setCookie)
        }
    ) { userAgent }
    /**
     * The engine's last decisions on the tabs' requests ("allow|block|redirect|upgrade type
     * <micros>us <cpuMicros>cpu url": the wall-clock time `EngineSnapshot.decide` took and the
     * CPU time the thread spent in it, `?cpu` where the platform cannot tell), kept while `debug`
     * for instrumentation (the demo's latency figures).
     */
    val decisions = ArrayDeque<String>()
    /** While `debug`: the CORS proxy's last answers ("<ext> METHOD status url"), for instrumentation. */
    val proxied = ArrayDeque<String>()
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
    /**
     * The bridge's traffic so far, three counters on the main thread, for instrumentation (the
     * frame budget reads them around a scroll): `[0]` messages from frames to the host (a content
     * script's or an extension page's `postMessage`, host-bound), `[1]` events the runtime raised
     * into the chrome's core on their behalf (`ext.*`: a message forwarded, a request observed, an
     * endpoint gone – each an `evaluateJavascript` on the chrome WebView), `[2]` messages from the
     * host to frames (replies, deliveries, events; page-bound). Always on: three increments.
     */
    private val bridgeCounters = LongArray(3)

    /** A copy of the bridge counters (see [bridgeCounters]): frames to host, host to chrome, host to frames. */
    fun bridgeCounts(): LongArray = bridgeCounters.copyOf()

    /**
     * The flood guard's counters ([BridgeForward]): messages forwarded to the core, action updates
     * folded into a newer one, action updates dropped at the pending bound, messages refused there.
     */
    fun floodGuardCounts(): LongArray = longArrayOf(forward.forwarded, forward.superseded, forward.dropped, forward.refused)

    /** An `ext.*` event into the chrome's core, counted ([bridgeCounters]). */
    private fun chromeEvent(name: String, payload: Any?) {
        bridgeCounters[1]++
        host.chrome.hostEvent(name, payload)
    }

    /**
     * The page-to-host flood guard in front of `ext.message` ([BridgeForward]): action state
     * coalesced per frame, the forward paced by a frame budget, what waits bounded. Frames come
     * from the Choreographer; nothing goes while the chrome is not ready for events (it is
     * rebuilding). `setIcon` pixels are scaled here ([ActionCalls], [IconScaling]) before they
     * cross; a bound hit puts a line on the extension's error console ([consoleLine]).
     */
    private val forward = BridgeForward(
        frames = { tick -> Choreographer.getInstance().postFrameCallback { tick.run() } },
        ready = { host.chrome.ready },
        sink = object : BridgeForward.Sink {
            override fun forward(ep: String, tabId: String?, top: Boolean, origin: String, text: CharSequence) {
                // The message goes to the core as the frame wrote it (one copy, no rebuild); the
                // core drops the token it carries (`extensionRuntime.onMessage`).
                val event = StringBuilder(text.length + 128)
                    .append("{\"ep\":").append(JSONObject.quote(ep))
                    .append(",\"tabId\":").append(if (tabId == null) "null" else JSONObject.quote(tabId))
                    .append(",\"top\":").append(top)
                    .append(",\"origin\":").append(JSONObject.quote(origin))
                    .append(",\"message\":").append(text)
                    .append('}')
                bridgeCounters[1]++
                host.chrome.hostEventJson("ext.message", event)
            }

            override fun rewrite(message: JSONObject, text: String): String? = ActionCalls.rewriteIcon(message, text, IconScaling)

            override fun warn(source: BridgeForward.Source, message: String) = consoleLine(source, message)
        }
    )

    /**
     * A warning on an extension's error console (`ExtensionInfo.errors`, the extensions page's
     * "Errors"), through the core (`ext.console`): attributed to the endpoint's kind of context
     * as Chrome's console sources go – its background as the worker's, a content script's as
     * `content`, any page of its own as `page`.
     */
    private fun consoleLine(source: BridgeForward.Source, message: String) {
        val kind = when (source.context) {
            "background", "offscreen" -> "worker"
            "content" -> "content"
            else -> "page"
        }
        chromeEvent(
            "ext.console",
            json("id" to source.extensionId, "level" to "warning", "source" to kind, "message" to message, "url" to source.url.ifEmpty { null }, "context" to source.context)
        )
    }

    val origin = ORIGIN_SUFFIX

    /** The engine's extension seams, this runtime's (see the class comment). */
    private val observer = DecisionObserver { tab, request, decision, elapsedNanos, cpuNanos -> onDecision(tab, request, decision, elapsedNanos, cpuNanos) }
    private val redirector = RedirectExecutor { tab, request, target, type -> redirect(target, request, type, tab) }

    /**
     * The engine's headers-received stage for documents ([HeaderStage]): its relay reads and
     * writes the cookies of the tab's profile, since WebView neither sends its cookies with a
     * fetch made here nor keeps the `Set-Cookie` of an intercepted response.
     */
    private val headerStage = HeaderStage(ProfileCookieStore)

    init {
        // The engine is the process's; the window's runtime is the one that hears it (a custom
        // tab has no extensions, its requests are still decided by the same snapshot).
        host.blocking.observer = observer
        host.blocking.redirector = redirector
        host.blocking.headerStage = headerStage
    }

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
                        "worldSlots" to worldSlots.size,
                        "navigationListener" to NavigationReports.supported,
                        // The engines' `maxMessageLength`: half the bridge's own message limit,
                        // as the core re-serializes a delivered message inside `ext.send`'s
                        // arguments (a string in a string, its quotes escaped) before the
                        // bridge measures that call (BridgeAdmission).
                        "messageLimit" to host.chrome.bridge.admission.messageLimitChars / 2
                    )
                )
            }
            "ext.open" -> open(args.str("id"), args.str("path"), reply)
            "ext.configure" -> configure(args, reply)
            "ext.detach" -> { detachExtension(args.str("id")); reply(null) }
            "ext.expect" -> {
                // The extensions the core is about to configure (told before it restores the
                // windows), or, with an empty list once its start is over, none: a page still
                // held for an extension that is not coming fails now.
                val ids = args.arr("ids").let { a -> List(a.length()) { i -> a.optString(i, "") }.filter(VALID_ID::matches) }
                for (held in heldPages.expect(ids)) failHeld(held)
                reply(null)
            }
            "ext.observeRequests" -> { observeRequests = args.bool("on"); reply(null) }
            "ext.send" -> { send(args.str("ep"), args.str("message")); reply(null) }
            "ext.background.start" -> { startBackground(args.str("id")); reply(null) }
            "ext.background.stop" -> { stopBackground(args.str("id")); reply(null) }
            "ext.popup.open" -> { openPopup(args.str("id"), args.str("url"), args.str("context", "popup"), args.str("title", "")); reply(null) }
            "ext.popup.close" -> { closePopup(); reply(null) }
            "ext.offscreen.open" -> { openOffscreen(args.str("id"), args.str("url")); reply(null) }
            "ext.offscreen.close" -> { closeOffscreen(args.str("id")); reply(null) }
            "ext.auth.open" -> { openAuthSheet(args.getInt("viewId"), args.str("id"), args.str("url"), args.str("title")); reply(null) }
            "ext.auth.show" -> { authSheets[args.getInt("viewId")]?.show(); reply(null) }
            "ext.auth.close" -> { authSheets.remove(args.getInt("viewId"))?.close(); reply(null) }
            "ext.hosts" -> {
                val id = args.str("id")
                val hosts = args.arr("hosts").let { a -> MatchPattern.compileAll(List(a.length()) { i -> a.optString(i, "") }) }
                grantedHosts = if (hosts.isEmpty()) grantedHosts - id else grantedHosts + (id to hosts)
                reply(null)
            }
            "ext.exec" -> exec(args, reply)
            "ext.cookies.read" -> reply(cookies.read(args.str("container", Profiles.DEFAULT_CONTAINER), args.str("url")))
            "ext.cookies.write" -> cookies.write(args.str("container", Profiles.DEFAULT_CONTAINER), args.str("url"), args.str("cookie"), reply)
            "ext.notifications.show" -> { showNotification(args.str("id"), args.obj("notification")); reply(null) }
            "ext.notifications.hide" -> { notifications.hide(args.str("id"), args.str("notificationId")); reply(null) }
            "ext.notifications.forget" -> { notifications.forget(args.str("id")); reply(null) }
            "ext.notifications.allowed" -> reply(notifications.allowed())
            "ext.proxy.set" -> ExtensionProxy.apply(ExtensionProxy.Plan.of(args), { r -> main.post(r) }) { error ->
                reply(if (error == null) null else Host.Rejection(error))
            }
            "ext.proxy.clear" -> ExtensionProxy.clear({ r -> main.post(r) }) { error ->
                reply(if (error == null) null else Host.Rejection(error))
            }
            "ext.readFile" -> {
                val id = args.str("id")
                val path = args.str("path")
                io.execute {
                    // Never a multi-megabyte answer: quoting one took the browser process's heap
                    // (ExtensionFiles.BRIDGE_TEXT_LIMIT); the runtime streams such files itself.
                    val file = fileFor(id, path)
                    val text = ExtensionFiles.bridgeText(file)
                    if (text == null && file?.isFile == true) Log.w(TAG, "ext.readFile $id $path: ${file.length()} bytes is too large for a bridge answer")
                    main.post { reply(text) }
                }
            }
            "ext.i18n.detectLanguage" -> {
                // The classifier is a call into the system's text-classification service; a
                // failure of that service is a text nobody could place.
                val text = args.str("text")
                io.execute {
                    val detected = runCatching { LanguageDetection.detect(host.activity, text) }
                        .getOrElse { e -> Log.w(TAG, "detectLanguage: ${e.message}"); LanguageDetection.NONE }
                    main.post { reply(detected) }
                }
            }
            "ext.system.cpu" -> {
                // `/proc` reads are file IO (and refused by the sandbox as often as not): off the main thread.
                io.execute {
                    val reading = SystemInfo.cpu()
                    main.post { reply(reading) }
                }
            }
            "ext.system.memory" -> reply(SystemInfo.memory(host.activity))
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
                hosts = s.arr("hosts").let { a -> MatchPattern.compileAll(List(a.length()) { i -> a.optString(i, "") }) },
                backgroundHtml = s.strOrNull("backgroundHtml"),
                backgroundUrl = s.strOrNull("backgroundUrl"),
                pageConfig = s.str("page", "{}"),
                lateConfig = s.str("late", "{}"),
                cssMessages = s.obj("cssMessages").let { m -> m.keys().asSequence().associateWith { k -> m.optString(k, "") } }
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
                flushNotificationEvents(id)
                // A tab that asked for one of the extension's pages before this: the empty
                // document it holds is loaded again, now that the origin answers (units first,
                // so the page's document-start script is the extension's).
                releaseHeld(id)
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

    // --- notifications ---------------------------------------------------------------------------

    /**
     * `ext.notifications.show`: the card, once the app may post (Android 13+ asks the first time,
     * as the downloader does; a refusal leaves the card unposted, `getPermissionLevel` says so).
     */
    private fun showNotification(id: String, notification: JSONObject) {
        val dir = served[id]?.dir
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !askedNotifications && !notifications.allowed()) {
            askedNotifications = true
            host.activity.requestRuntimePermissions(listOf(Manifest.permission.POST_NOTIFICATIONS)) {
                notifications.show(id, dir, notification)
            }
            return
        }
        notifications.show(id, dir, notification)
    }

    /** A tap or a button on a card: the activity intent [MainActivity] received. */
    fun onNotificationIntent(intent: Intent): Boolean = notifications.onIntent(intent)

    private fun onNotificationEvent(id: String, notificationId: String, event: String, index: Int) {
        val payload = json("id" to id, "notificationId" to notificationId, "event" to event, "index" to index)
        if (served.containsKey(id)) chromeEvent("ext.notification", payload)
        else pendingNotificationEvents.getOrPut(id) { ArrayDeque() }.addLast(payload)
    }

    private fun flushNotificationEvents(id: String) {
        val queue = pendingNotificationEvents.remove(id) ?: return
        for (payload in queue) chromeEvent("ext.notification", payload)
    }

    // --- detach ----------------------------------------------------------------------------------

    /** `ext.detach { id }`: the extension's units leave every tab; its pages and cache go. */
    private fun detachExtension(id: String) {
        units.remove(id)
        served = served - id
        for (held in heldPages.dropped(id)) failHeld(held)
        for (view in handlers.keys.toList()) removeExtension(view, id)
        stopBackground(id)
        closeOffscreen(id)
        if (popup?.extensionId == id) closePopup()
        // The core dropped these endpoints already; the frames keep running what was injected.
        endpoints.entries.removeAll { it.value.extensionId == id }
        forward.forgetExtension(id)
        // Its world slots are free for the next extension; a straggling hello from a document
        // that still runs the old world's script claims this id and is refused by the slot check.
        worldSlots.releaseAll(id)
        io.execute { compiler.forget(id) }
        configureStats.remove(id)
        notifications.forget(id)
        pendingNotificationEvents.remove(id)
        closeAuthSheets(id)
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
        observeRequests = false
        closeAuthSheets()
    }

    /** Host → endpoint: the reply proxy of the frame that said hello. A dead frame reports `ext.gone`. */
    private fun send(ep: String, message: String) {
        val endpoint = endpoints[ep] ?: return
        bridgeCounters[2]++
        if (debug) recordReply(ep, message)
        val ok = runCatching { endpoint.proxy.postMessage(message) }.isSuccess
        if (!ok) gone(listOf(ep))
    }

    private fun recordProxy(extensionId: String, request: CorsProxy.Request, status: Int) {
        synchronized(proxied) {
            if (proxied.size >= 200) proxied.removeFirst()
            proxied.addLast("$extensionId ${request.method} $status ${request.url}")
        }
    }

    private fun recordCall(ep: String, message: JSONObject, chars: Int) {
        val ext = endpoints[ep]?.extensionId ?: message.str("ext")
        trace(">", ep, ext, message, chars)
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
        val reply = BridgeEnvelope.read(message) ?: return
        trace("<", ep, endpoints[ep]?.extensionId ?: "", reply, message.length)
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
    private fun trace(direction: String, ep: String, ext: String, message: JSONObject, chars: Int = 0) {
        val context = endpoints[ep]?.context ?: message.str("ctx", "?")
        val t = message.str("t")
        // A big message is an envelope here (its nested values unread): its size stands in for them.
        val size = if (chars >= BridgeEnvelope.BIG_MESSAGE) " chars=$chars" else ""
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
            // A page policy's refusal handed to the host (or a webpack chunk of a module graph for
            // the content script's scope): the extension file asked for, and the answer.
            "mainScript", "extFetch", "chunkScript" -> message.str("url").take(100)
            "mainScriptDone", "extFetchDone", "chunkDone" -> if (message.optBoolean("ok", true)) "ok" else "error=${message.optString("error").take(80)}"
            else -> ""
        }
        synchronized(bridgeTrace) {
            if (bridgeTrace.size >= TRACE_LINES) bridgeTrace.removeFirst()
            bridgeTrace.addLast("${SystemClock.uptimeMillis()} $direction ${ext.take(8)}/$context $t $detail$size".trimEnd())
        }
    }

    /** A snapshot of `callStats` for instrumentation. */
    fun callStatsSnapshot(): Map<String, IntArray> = synchronized(callStats) { callStats.mapValues { it.value.copyOf() } }

    /** The bridge trace lines mentioning `extensionId` (its first eight characters), oldest first. */
    fun traceSnapshot(extensionId: String): List<String> =
        synchronized(bridgeTrace) { bridgeTrace.filter { it.contains(" ${extensionId.take(8)}/") } }

    /**
     * The endpoints a view holds right now, one line each (context, extension, main frame, URL,
     * endpoint id), for instrumentation: whether the document a blank extension page shows is
     * still one the host can answer.
     */
    fun endpointSnapshot(view: WebView): List<String> =
        endpoints.entries.filter { it.value.view === view }.map { (ep, e) ->
            "${e.context} ${e.extensionId.take(8)} main=${e.isMainFrame} world=${e.world} url=${e.url} ep=$ep"
        }

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
     * Instrumentation only: `code` run in `extensionId`'s content scope on `view`'s main frame
     * the way `scripting.executeScript({ code })` runs it ([exec]'s main-frame path) – the
     * isolated world where the frame has one, else the main world's `with` scope through the
     * bootstrap (a late boot when the document has no scope for the extension yet) – with the
     * guarded JSON handed back as the WebView gave it (`{"v": …}` or `{"e": …}`), null when
     * nothing answered. The driver reads what a content script's own `window.postMessage`
     * does in that scope. Main thread.
     */
    fun evalInScope(view: WebView, extensionId: String, code: String, callback: (String?) -> Unit) {
        val ext = served[extensionId]
        if (ext == null) {
            callback(null)
            return
        }
        val mine = endpoints.values.filter { it.view === view && it.extensionId == extensionId && it.context == "content" && it.isMainFrame }
        val world = if (isolatedWorlds) mine.firstOrNull { it.world } else null
        if (world != null) {
            val call = ExtensionScripts.execScript(token, extensionId, "js", JSONObject(), code, emptyList(), null, null, null, false, false)
            val delivered = runCatching {
                world.proxy.executeJavaScript(call, object : androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException> {
                    override fun onResult(result: String?) { callback(result) }
                    override fun onError(error: androidx.webkit.JavaScriptExecutionException) { callback(null) }
                })
            }.isSuccess
            if (!delivered) callback(null)
            return
        }
        val prefix = if (mine.none { !it.world }) ExtensionScripts.lateBoot(bootstrap, ext.lateConfig, debug) else null
        val script = ExtensionScripts.execScript(token, extensionId, "js", JSONObject(), code, emptyList(), null, null, prefix, true, true)
        view.evaluateJavascript(script) { result -> callback(result) }
    }

    /**
     * `scripting.executeScript` / `insertCSS` / MV2 `tabs.executeScript` into a frame of a tab.
     * The code runs through the bootstrap's `__zenExtExec` in the extension's scope: in its
     * isolated world through the world endpoint's reply proxy when the frame has one; else in
     * the main world with `evaluateJavascript`, after a late boot when the document has no scope
     * for the extension yet (a tab that predates the extension, a page none of its declarations
     * matched, or a WebView without worlds). `world: "MAIN"` injections take the main-world path.
     *
     * A subframe (`doc`: its document id, see [Endpoint]) is reached through its own endpoint's
     * reply proxy, the one handle a WebView gives to a frame (`evaluateJavascript` takes none), so
     * it needs a WebView with `JS_INJECTION_IN_FRAME_AND_WORLD` and a frame the extension has a
     * script in: the world endpoint for the isolated world, the main-world one for `world: "MAIN"`.
     *
     * The extension's own files (`files`, extension-relative paths) are read here and streamed
     * into the script ([ExtensionScripts.execScript]) rather than sent as `code`: a missing one is
     * Chrome's `Could not load file` rejection. The read is off the main thread; where the script
     * runs is decided first, with the endpoints this call saw.
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
        val paths = args.optJSONArray("files")?.let { a -> List(a.length()) { i -> a.optString(i, "") } } ?: emptyList()
        val files = ArrayList<File>(paths.size)
        for (path in paths) {
            val file = fileIn(ext.dir, path)?.takeIf { it.isFile }
            if (file == null) {
                reply(Host.Rejection("Could not load file: '$path'."))
                return
            }
            files.add(file)
        }
        val wantMain = payload.optString("world") == "MAIN"
        val doc = args.strOrNull("doc")
        var prefix: String? = null
        var named = false
        val run: (String) -> Unit
        if (doc != null) {
            if (!isolatedWorlds) {
                reply(Host.Rejection("This WebView cannot run a script in a subframe (Chromium 146 and later can)"))
                return
            }
            val frame = endpoints.values.filter { it.view === tab && it.extensionId == id && it.context == "content" && !it.isMainFrame && it.doc == doc }
            if (frame.isEmpty()) {
                reply(Host.Rejection("No such frame in the tab (it navigated away, or the extension has no script in it)"))
                return
            }
            val endpoint = frame.firstOrNull { it.world == !wantMain }
            if (endpoint == null) {
                reply(Host.Rejection("The extension has no ${if (wantMain) "main-world" else "isolated-world"} script in that frame"))
                return
            }
            run = { call -> runInFrame(endpoint, call, reply) }
        } else {
            val mine = endpoints.values.filter { it.view === tab && it.extensionId == id && it.context == "content" && it.isMainFrame }
            val world = if (isolatedWorlds && !wantMain) mine.firstOrNull { it.world } else null
            if (world != null) {
                run = { call -> runInFrame(world, call, reply) }
            } else {
                if (mine.none { !it.world }) {
                    lateBoots++
                    prefix = ExtensionScripts.lateBoot(bootstrap, ext.lateConfig, debug)
                }
                // Named like the document-start script: the injected function's DOM writes are the extension's too.
                named = true
                run = { script -> tab.evaluateJavascript(script) { result -> reply(unwrap(result)) } }
            }
        }
        // Evaluated in the main world for the extension's own scope (not a `world: "MAIN"`
        // injection): the bootstrap gives it the `with` scope proxy, and the body must resolve its
        // bare identifiers there, as a content script's group does.
        val scoped = named && !wantMain
        val assemble = {
            ExtensionScripts.execScript(
                token, id, args.str("kind", "js"), payload, args.strOrNull("code"), files,
                args.strOrNull("funcSource"), args.optJSONArray("args")?.toString(), prefix, named, scoped
            )
        }
        if (files.isEmpty()) {
            run(assemble())
            return
        }
        io.execute {
            val script = runCatching(assemble)
            main.post {
                script.fold(run) { e -> reply(Host.Rejection("Could not load file: ${e.message ?: e.javaClass.simpleName}.")) }
            }
        }
    }

    /** [ExtensionScripts.guarded] `call`, run in the frame and world of `endpoint` through its reply proxy. */
    private fun runInFrame(endpoint: Endpoint, call: String, reply: (Any?) -> Unit) {
        val delivered = runCatching {
            endpoint.proxy.executeJavaScript(call, object : androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException> {
                override fun onResult(result: String?) { main.post { reply(unwrap(result)) } }
                override fun onError(error: androidx.webkit.JavaScriptExecutionException) { main.post { reply(Host.Rejection(error.message ?: "script failed")) } }
            })
        }.isSuccess
        if (!delivered) reply(Host.Rejection("The frame is gone"))
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
     * it arrives), so endpoints of a main frame that reported exactly the new URL are kept – or
     * [documentUrl], the address the document reads as its own where that differs from the
     * tab's (the PDF viewer page: `zen://pdf` for the tab, the PDF's URL for the document).
     * Passing no URL (the view is going away) drops everything.
     */
    fun onDocumentGone(view: WebView, url: String? = null, documentUrl: String? = null) {
        val mine = endpoints.filterValues { it.view === view }
        val kept = if (url == null) emptyMap() else mine.filterValues { it.isMainFrame && (it.url == url || it.url == documentUrl) }
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
        forward.forget(eps)
        chromeEvent("ext.gone", json("eps" to JSONArray(eps)))
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
        // The host reads the envelope (top-level scalars) and hands the text on as it came; a big
        // message is never built whole on this thread (`BridgeEnvelope`).
        val message = BridgeEnvelope.read(text) ?: return
        if (message.str("token") != token) return
        val ep = message.str("ep")
        if (ep.isEmpty()) return
        // The bridge's raw-length admission for this direction (BridgeAdmission): a message over
        // the host's limit is answered with Chrome's oversized-message error and copied no
        // further (into the core's event, the core's parse, a delivery). The engines refuse at
        // half the limit in the sender's realm, so only an older bootstrap or a hand-built
        // envelope gets this far.
        if (!host.chrome.bridge.admission.admitUnqueued(text.length)) {
            refuseBridgeMessage(proxy, ep, message, text.length)
            return
        }
        bridgeCounters[0]++
        if (slot != null) {
            val known = endpoints[ep]
            val claimed = if (known != null) known.extensionId else message.str("ext")
            if (worldSlots.owner(slot) != claimed || (known != null && known.slot != slot)) return
        }
        // A private tab's document still running the script of an extension no longer allowed
        // there (the toggle flipped after the document started) has no bridge.
        if (view.isPrivateTab && served[endpoints[ep]?.extensionId ?: message.str("ext")]?.allowPrivate != true) return
        if (debug) recordCall(ep, message, text.length)
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
            "proxyBody" -> {
                // The body of a bodied cross-origin fetch, ahead of the request naming its ticket (CorsProxy).
                val bytes = runCatching { Base64.decode(message.str("body"), Base64.DEFAULT) }.getOrNull() ?: return
                corsProxy.putBody(message.str("ticket"), bytes)
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
            "chunkScript" -> {
                chunkScript(view, proxy, isMainFrame, ep, message)
                return
            }
            "extFetch" -> {
                extensionFetch(proxy, ep, message)
                return
            }
        }
        val tabId = (view as? TabWebView)?.tabId
        // To the core through the flood guard: now, at a later frame, folded into a newer action
        // update, or refused with an answer to the frame (see BridgeForward).
        val endpoint = endpoints[ep]
        val source = BridgeForward.Source(
            ep,
            endpoint?.extensionId ?: message.str("ext"),
            endpoint?.context ?: kind,
            endpoint?.url ?: message.str("url")
        ) { reply ->
            if (debug) recordReply(ep, reply)
            runCatching { proxy.postMessage(reply) }
        }
        forward.offer(source, message, text, tabId, isMainFrame, origin.toString())
    }

    /**
     * The answer to a bridge message refused on length: a `msg` or `call` hears its reply fail
     * with Chrome's text (`runtime.sendMessage`'s promise rejects, `lastError` for a callback);
     * a `portMsg` has its port closed with it (`onDisconnect`, `lastError`), the one signal the
     * host can give a port whose message it never saw whole, and one that also ends the
     * broadcast a page keeps repeating on it. Other kinds are dropped.
     */
    private fun refuseBridgeMessage(proxy: JavaScriptReplyProxy, ep: String, message: JSONObject, chars: Int) {
        val admission = host.chrome.bridge.admission
        val count = admission.refused.get()
        if (count == 1 || count % 100 == 0) {
            Log.w(TAG, "a ${message.str("t")} of $chars chars from $ep refused, over the bridge's message limit of ${admission.messageLimitChars} chars ($count so far)")
        }
        val reply = when (message.str("t")) {
            "msg", "call" -> json("t" to "reply", "ep" to ep, "id" to message.opt("id"), "ok" to false, "error" to BridgeAdmission.MESSAGE_TOO_LONG)
            "portMsg" -> json("t" to "portDisconnect", "ep" to ep, "portId" to message.str("portId"), "error" to BridgeAdmission.MESSAGE_TOO_LONG)
            else -> return
        }.toString()
        if (debug) recordReply(ep, reply)
        runCatching { proxy.postMessage(reply) }
    }

    /**
     * A content script inserted `<script src="https://<id>.ext.zenium.invalid/…">` into the page
     * and the page's Content-Security-Policy refused it. In Chrome an extension's resources are
     * beyond a page's policy (`chrome-extension:` bypasses CSP); the emulated origin is an https
     * origin any `script-src` can refuse. The world reports the refused element; the file, when
     * it is web-accessible, runs in the main world through `evaluateJavascript`, which no page
     * policy governs, and the world hears back so it can fire the element's `load`. In a subframe
     * (`evaluateJavascript` takes no frame) the file runs through the reply proxy of the frame's
     * main-world endpoint, when some extension's main-world script gave it one (Chromium 146+).
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
        val doc = endpoints[ep]?.doc ?: ep.substringBefore('.')
        val frameMain = if (isMainFrame || !isolatedWorlds) null else
            endpoints.values.firstOrNull { it.view === view && it.context == "content" && !it.isMainFrame && !it.world && it.doc == doc }
        when {
            ext == null -> done("the extension is not attached")
            uri.scheme != "https" || uri.host != "$extId$ORIGIN_SUFFIX" -> done("$url is not on the extension's origin")
            !isMainFrame && frameMain == null -> done("no main-world script of an extension runs in that frame, and only its bridge could run the file there")
            !ext.webAccessible.any { it.matches(path) } -> done("$path is not a web-accessible resource")
            else -> io.execute {
                val text = fileIn(ext.dir, path)?.takeIf { it.isFile }?.let { f -> runCatching { f.readText() }.getOrNull() }
                if (text == null) {
                    done("$path was not found")
                    return@execute
                }
                // `;void 0` keeps the script's last expression out of the result string.
                val script = "$text\n;void 0;\n//# sourceURL=$url"
                main.post {
                    if (frameMain == null) {
                        view.evaluateJavascript(script) { done(null) }
                        return@post
                    }
                    // A script that throws still ran (its element gets `load`, as in Chrome).
                    val delivered = runCatching {
                        frameMain.proxy.executeJavaScript(script, object : androidx.webkit.WebViewOutcomeReceiver<String, androidx.webkit.JavaScriptExecutionException> {
                            override fun onResult(result: String?) = done(null)
                            override fun onError(error: androidx.webkit.JavaScriptExecutionException) {
                                if (debug) Log.d(TAG, "$url threw in the frame's main world: ${error.message}")
                                done(null)
                            }
                        })
                    }.isSuccess
                    if (!delivered) done("the frame is gone")
                }
            }
        }
    }

    /**
     * A content script's module graph on a WebView without isolated worlds asked for a webpack
     * chunk and was served the stub (ExtensionScripts.chunkStub); the bootstrap now asks for the
     * chunk to run as a block of the extension's `with` scope, where its bare identifiers resolve
     * as the content script's own do. The file, when it is web-accessible, runs through
     * `evaluateJavascript` (the main frame; a subframe's stub imports the chunk plain) as an exec
     * of kind `chunk`, the same shape as a scoped `scripting.executeScript` file: the bootstrap
     * runs it in the scope and settles the stub's wait itself. Whatever the host refuses – and a
     * file `evaluateJavascript` could not run at all (a syntax error, no bootstrap in the
     * document) – is answered with `chunkDone`, and the stub imports the chunk plain, bracketed,
     * as it was served before the stub.
     */
    private fun chunkScript(view: WebView, proxy: JavaScriptReplyProxy, isMainFrame: Boolean, ep: String, message: JSONObject) {
        val id = message.opt("id")
        val url = message.str("url")
        val extId = endpoints[ep]?.extensionId ?: message.str("ext")
        fun refuse(error: String) {
            val reply = json("t" to "chunkDone", "ep" to ep, "id" to id, "ok" to false, "error" to error).toString()
            main.post {
                if (debug) recordReply(ep, reply)
                runCatching { proxy.postMessage(reply) }
            }
        }
        val uri = Uri.parse(url)
        val ext = served[extId]
        val path = (uri.path ?: "/").trimStart('/')
        when {
            ext == null -> refuse("the extension is not attached")
            uri.scheme != "https" || uri.host != "$extId$ORIGIN_SUFFIX" -> refuse("$url is not on the extension's origin")
            !isMainFrame -> refuse("a chunk runs in the content script's scope of a main frame only")
            !ext.webAccessible.any { it.matches(path) } -> refuse("$path is not a web-accessible resource")
            else -> io.execute {
                val file = fileIn(ext.dir, path)?.takeIf { it.isFile }
                if (file == null) {
                    refuse("$path was not found")
                    return@execute
                }
                val payload = JSONObject().put("id", id).put("url", url)
                val script = runCatching {
                    ExtensionScripts.execScript(token, extId, "chunk", payload, null, listOf(file), null, null, null, false, true)
                }.getOrElse { e ->
                    refuse("Could not load file: ${e.message ?: e.javaClass.simpleName}.")
                    return@execute
                }
                main.post {
                    view.evaluateJavascript(script) { result ->
                        val outcome = unwrap(result)
                        // A text `evaluateJavascript` could not run at all (a syntax error in the
                        // chunk) answers a bare null, which the guard never does: the stub imports
                        // the chunk plain, and the error shows where the import's own would have.
                        if (outcome is Host.Rejection) refuse(outcome.message)
                        else if (result == null || result == "null") refuse("the chunk's text did not run in the document")
                    }
                }
            }
        }
    }

    /**
     * A content script under the `with` fallback fetched a file of its extension
     * (`https://<id>.ext.zenium.invalid/locales/en.json`) and the page's Content-Security-Policy
     * refused the request (`connect-src`): in Chrome a content script's fetch of its extension's
     * web-accessible resource is beyond the page's policy (the isolated world's own applies), and
     * on a WebView with worlds the world's request goes through the same way. The bootstrap
     * reports the refused fetch (`extensionFetchRelay.ts`); the file, when it is web-accessible,
     * is read here and answered over the bridge, which no page policy governs, with its type;
     * otherwise the reason, and the content script keeps the page's refusal.
     */
    private fun extensionFetch(proxy: JavaScriptReplyProxy, ep: String, message: JSONObject) {
        val id = message.opt("id")
        val url = message.str("url")
        val extId = endpoints[ep]?.extensionId ?: message.str("ext")
        fun reply(body: ByteArray?, mime: String?, error: String?) {
            val text = json(
                "t" to "extFetchDone", "ep" to ep, "id" to id, "ok" to (error == null), "error" to error, "mime" to mime,
                "body" to body?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
            ).toString()
            main.post {
                if (debug) recordReply(ep, text)
                runCatching { proxy.postMessage(text) }
            }
        }
        val uri = Uri.parse(url)
        val ext = served[extId]
        val path = (uri.path ?: "/").trimStart('/')
        when {
            ext == null -> reply(null, null, "the extension is not attached")
            uri.scheme != "https" || uri.host != "$extId$ORIGIN_SUFFIX" -> reply(null, null, "$url is not on the extension's origin")
            !ext.webAccessible.any { it.matches(path) } -> reply(null, null, "$path is not a web-accessible resource")
            else -> io.execute {
                val bytes = fileIn(ext.dir, path)?.takeIf { it.isFile }?.let { f -> runCatching { f.readBytes() }.getOrNull() }
                val mime = ExtensionScripts.mimeType(path)
                when {
                    bytes == null -> reply(null, null, "$path was not found")
                    bytes.size > MAX_RELAYED_FILE_BYTES -> reply(null, null, "$path is ${bytes.size} bytes, more than the bridge carries ($MAX_RELAYED_FILE_BYTES)")
                    // A stylesheet relayed over the bridge is the one the origin would have served: localized.
                    mime == "text/css" && ext.cssMessages.isNotEmpty() ->
                        reply(ExtensionFiles.localizeCss(String(bytes, Charsets.UTF_8), ext.cssMessages).toByteArray(), mime, null)
                    else -> reply(bytes, mime, null)
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Request path: the extension origin, the CORS proxy, and the engine's extension seams
    // ---------------------------------------------------------------------------------------------

    /**
     * Every WebView's `shouldInterceptRequest` (background thread), ahead of the request engine.
     * Tab pages: a top-level navigation to an extension origin gets any file (Chrome lets any
     * extension page open as a tab), other frames only its web-accessible resources; a fetch of
     * an extension page to a permitted host goes through the CORS proxy. Extension WebViews: any
     * file of their own extension, another extension's web-accessible resources only, and the
     * background view's document is the generated background page wherever the
     * core put it (`backgroundDocument`: an MV3 worker's page lives at the worker script's URL,
     * so `self.location` reads as in Chrome). Null for everything else: a tab's request then
     * goes to `Blocking.intercept`, where the extensions' declarativeNetRequest sets are among
     * the rule sets; an extension page's request goes out as it is (Chrome exempts an
     * extension's own requests from its rules).
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
            // A tab's document on an origin the runtime does not serve: held while the core is
            // about to configure the extension, failed as Chrome fails it otherwise; anything
            // else of an unserved extension (a frame, a resource) is simply not there.
            val ext = served[id] ?: return if (tab != null && request.isForMainFrame) unservedPage(request, tab, id) else notFound()
            // Chrome does not load a chrome-extension:// URL in incognito for an extension not allowed there.
            if (tab?.isPrivateTab == true && !ext.allowPrivate) return if (request.isForMainFrame) refusedPage(tab, url.toString()) else notFound()
            val path = (url.path ?: "/").trimStart('/')
            val origin = "https://$hostName/"
            val ownPage = tab != null && (
                request.isForMainFrame ||
                    request.requestHeaders?.get("Referer")?.startsWith(origin) == true ||
                    tab.currentUrl?.startsWith(origin) == true
                )
            // A foreign page (a web page, or another extension's own view asking for this one's
            // files: `chrome-extension://<other>/...` spelled out in Read&Write's offscreen
            // document resolves here, ExtensionPageNavigation) gets the web-accessible resources
            // only, as Chrome serves them; the extension's own pages get any file.
            val foreign = if (extensionPage != null) extensionPage.id != id else !ownPage
            if (foreign && !ext.webAccessible.any { it.matches(path) }) return notFound()
            if (backgroundDocument && request.isForMainFrame && ext.backgroundHtml != null && "$origin$path" == ext.backgroundUrl) {
                return response("text/html", 200, "OK", ext.backgroundHtml.toByteArray())
            }
            // A module a content script imports on a WebView without isolated worlds evaluates on
            // the page's real global, where the `with` scope's `chrome` is not: the served text is
            // bracketed so the bootstrap's accessor answers the extension's `chrome` while it runs
            // (ExtensionScripts.moduleChromeWrap). A module request is a CORS one and carries the
            // page's `Origin`; a classic `<script src>` (no-cors, no `Origin`) runs as a page script
            // in Chrome too and is served as it is. Extension pages have their own `chrome`. The
            // graph is told by the document, not the Referer (ExtensionScripts.isPageModuleGraph:
            // a dependency's referrer is the module that imports it). A webpack chunk of the graph
            // is served as the stub that runs it in the content script's scope, unless this is the
            // stub's own plain request for it (ExtensionScripts.chunkStub).
            val moduleGraph = tab != null && extensionPage == null && ExtensionScripts.isPageModuleGraph(
                path,
                request.isForMainFrame,
                tab.currentUrl,
                origin,
                request.requestHeaders?.keys?.any { it.equals("Origin", ignoreCase = true) } == true,
                isolatedWorlds
            )
            val chunkStubUrl = if (moduleGraph && url.getQueryParameter(ExtensionScripts.PLAIN_QUERY) == null) url.toString() else null
            return serve(ext, path, if (moduleGraph) id else null, chunkStubUrl)
        }
        // A fetch or XHR of an extension page to a host its permissions cover: Chrome skips CORS
        // there, the proxy stands in (CorsProxy). The request's `Origin` names the extension, so
        // a popup, a background view and an extension page opened in a tab are one case.
        val corsOrigin = request.requestHeaders?.entries?.firstOrNull { it.key.equals("Origin", true) }?.value
        if (corsOrigin != null && corsOrigin.startsWith("https://") && corsOrigin.endsWith(ORIGIN_SUFFIX)) {
            val id = corsOrigin.removePrefix("https://").removeSuffix(ORIGIN_SUFFIX)
            val ext = served[id]
            if (ext != null && (tab?.isPrivateTab != true || ext.allowPrivate)) {
                val proxied = CorsProxy.Request(request.method ?: "GET", url.toString(), request.requestHeaders ?: emptyMap())
                val hosts = grantedHosts[id]?.let { ext.hosts + it } ?: ext.hosts
                if (corsProxy.applies(proxied, corsOrigin, hosts)) {
                    val reply = corsProxy.handle(proxied, id, corsOrigin)
                    // A 3xx the proxy could not follow cannot be a WebResourceResponse; the WebView tries itself.
                    if (reply != null && reply.status !in 300..399) {
                        if (debug) recordProxy(id, proxied, reply.status)
                        if (reply.cookies.isEmpty()) {
                            return WebResourceResponse(reply.mime, reply.charset, reply.status, reply.reason, reply.headers, reply.body)
                        }
                        // COOKIE_INTERCEPT: the WebView stores the response's cookies itself (it drops a
                        // plain Set-Cookie header of an intercepted response).
                        return WebResourceResponseCompat(reply.mime, reply.charset, reply.status, reply.reason, reply.headers, reply.body)
                            .apply { setCookies(reply.cookies) }
                            .toWebResourceResponse()
                    }
                }
            }
        }
        return null
    }

    /**
     * The engine decided a tab's request ([DecisionObserver], on the IO thread that took it).
     * A decision an extension's rule took (`ext:` set) always reaches the core – it is that
     * extension's matched rule, action count and `onRuleMatchedDebug` event; while an extension
     * listens for `webRequest`, every decision does, as the material of the observational events.
     * The rest is only counted here while `debug`.
     *
     * Every event carries the tab's document generation the request belonged to
     * (`BlockingTab.documentGeneration`): the core tells one document's matches from the
     * next's by it, since the tab's `navigated` event, posted at commit, often lands after the
     * new page's first decisions.
     */
    private fun onDecision(tab: BlockingTab, request: Request, decision: Decision, elapsedNanos: Long, cpuNanos: Long) {
        val micros = elapsedNanos / 1_000
        val cpuMicros = if (cpuNanos < 0) null else cpuNanos / 1_000
        val action = when (decision.action) {
            Decision.Action.ALLOW -> "allow"
            Decision.Action.BLOCK -> "block"
            Decision.Action.REDIRECT -> "redirect"
            Decision.Action.UPGRADE -> "upgrade"
            Decision.Action.MODIFY_HEADERS -> "modifyHeaders"
        }
        val type = request.type.dnrName
        if (debug) synchronized(decisions) {
            if (decisions.size >= 400) decisions.removeFirst()
            decisions.addLast("$action $type ${micros}us ${cpuMicros ?: "?"}cpu ${request.url}")
        }
        val extensionRule = decision.matchedSet?.startsWith(EXT_SET_PREFIX) == true
        if (!extensionRule && !observeRequests) return
        val payload = json(
            "tabId" to tab.tabId,
            "requestId" to requestIds.getAndIncrement().toString(),
            "url" to request.url,
            "type" to type,
            "method" to request.method,
            // Chrome's `initiator` is the requesting document's origin, none for a navigation.
            "initiator" to request.documentUrl?.let { Domains.originOf(it) },
            "mainFrame" to (request.type == ResourceType.MAIN_FRAME),
            "document" to request.documentGeneration,
            "action" to action,
            "matchedSet" to (decision.matchedSet?.takeIf { extensionRule }),
            "matchedRule" to (if (extensionRule) decision.matchedRule else null),
            "micros" to micros,
            "cpuMicros" to cpuMicros
        )
        main.post { chromeEvent("ext.request", payload) }
    }

    /**
     * The engine's redirect executor ([RedirectExecutor]): a `redirect` or `upgradeScheme` rule
     * of a subresource, which WebView cannot answer with a real redirect (`WebResourceResponse`
     * throws for any status in 300..399; measured, it took the process down). Redirects are
     * therefore emulated: frames get a page that replaces itself with the target, targets on an
     * extension origin are served in place (uBlock Origin Lite's neutered scripts), and other
     * subresources are fetched here on the intercept thread and their body substituted. Non-GET
     * requests, and a target the fetch cannot stand in for, are let through unchanged.
     */
    private fun redirect(ruleTarget: String, request: WebResourceRequest, type: ResourceType, tab: BlockingTab): WebResourceResponse? {
        // A rule may name the extension's own resource as Chrome spells it; the served origin answers.
        val location = ExtensionUrls.toServed(ruleTarget)
        if (type == ResourceType.MAIN_FRAME || type == ResourceType.SUB_FRAME) {
            val html = "<!doctype html><meta charset=\"utf-8\"><script>location.replace(${JSONObject.quote(location)})</script>"
            return response("text/html", 200, "OK", html.toByteArray())
        }
        val target = Uri.parse(location)
        val targetHost = target.host ?: return null
        if (targetHost.endsWith(ORIGIN_SUFFIX)) {
            val ext = served[targetHost.removeSuffix(ORIGIN_SUFFIX)] ?: return notFound()
            // The rule applied in this partition, so the extension runs there; the private check
            // is the same one a page's own fetch of the resource would meet.
            if (tab.containerId == Profiles.PRIVATE_CONTAINER && !ext.allowPrivate) return notFound()
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

    /**
     * A file of the extension; with `moduleChromeFor`, a script bracketed for that extension's
     * module graph, and with `chunkStubUrl` (the request's URL) a webpack chunk of the graph is
     * answered with the stub that runs the file in the content script's scope instead
     * (ExtensionScripts.chunkStub; the stub's own plain request comes without it).
     */
    private fun serve(ext: Served, path: String, moduleChromeFor: String? = null, chunkStubUrl: String? = null): WebResourceResponse {
        if (path == GENERATED_BACKGROUND) {
            val html = ext.backgroundHtml ?: return notFound()
            return response("text/html", 200, "OK", html.toByteArray())
        }
        val file = fileIn(ext.dir, path) ?: return notFound()
        if (!file.isFile) return notFound()
        val mime = ExtensionScripts.mimeType(path)
        if (moduleChromeFor != null && chunkStubUrl != null && ExtensionScripts.isWebpackChunk(ExtensionFiles.head(file, ExtensionScripts.WEBPACK_CHUNK_HEAD))) {
            return response(mime, 200, "OK", ExtensionScripts.chunkStub(moduleChromeFor, chunkStubUrl).toByteArray())
        }
        // A stylesheet is localized as Chrome's renderer localizes a `chrome-extension://` one
        // (`ExtensionLocalizationThrottle`): read whole, its placeholders substituted, whatever
        // linked it. Anything else streams from disk.
        if (mime == "text/css" && ext.cssMessages.isNotEmpty() && file.length() <= ExtensionFiles.LOCALIZED_CSS_LIMIT) {
            val text = runCatching { file.readText() }.getOrNull() ?: return notFound()
            return response(mime, 200, "OK", ExtensionFiles.localizeCss(text, ext.cssMessages).toByteArray())
        }
        // Streamed from disk, the module bracket on either side (ExtensionFiles.servedBody); the
        // prologue is chosen by the file's head (a webpack chunk binds its own `chrome` / `self`,
        // a module declaring `chrome` itself keeps the bare entry), read up to a MiB, never whole.
        val body = ExtensionFiles.servedBody(
            file,
            moduleChromeFor?.let { ExtensionScripts.moduleChromeOpen(it, ExtensionFiles.head(file, ExtensionScripts.MODULE_SCAN_HEAD)) },
            moduleChromeFor?.let(ExtensionScripts::moduleChromeClose)
        ) ?: return notFound()
        return response(mime, 200, "OK", body.stream, body.length)
    }

    private fun response(mime: String, status: Int, reason: String, body: ByteArray, extra: Map<String, String> = emptyMap()): WebResourceResponse =
        response(mime, status, reason, ByteArrayInputStream(body), body.size.toLong(), extra)

    private fun response(mime: String, status: Int, reason: String, body: InputStream, length: Long, extra: Map<String, String> = emptyMap()): WebResourceResponse {
        val headers = HashMap<String, String>(extra)
        headers["Access-Control-Allow-Origin"] = "*"
        headers["Cache-Control"] = "no-cache"
        headers["Content-Length"] = length.toString()
        return WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json")) "utf-8" else null, status, reason, headers, body)
    }

    private fun notFound() = response("text/plain", 404, "Not Found", ByteArray(0))

    /**
     * A tab's document on the origin of an extension that is not served (network thread). While
     * the core is about to configure the extension the page is held: an empty document under
     * the page's URL, loaded again from [releaseHeld] once the configure completes. Otherwise it
     * fails like a page of an extension Chrome has not enabled, `ERR_BLOCKED_BY_CLIENT`, through
     * the core's error page: the empty document stands under the URL as WebView's own error
     * page does for a failed load, and the tab steps over it on the way back.
     */
    private fun unservedPage(request: WebResourceRequest, tab: TabWebView, id: String): WebResourceResponse {
        val href = request.url.toString()
        if (heldPages.expects(id)) {
            heldPages.hold(id, tab, href)
            // The configure may have completed between the served check and the hold; then the
            // real answer, and no reload of a page that loads on its own.
            if (served[id] == null) return heldPage()
            heldPages.unhold(id, tab, href)
            return intercept(request, tab, null) ?: notFound()
        }
        return refusedPage(tab, href)
    }

    /** The empty document a refused page shows; the tab fails the load as the document starts. */
    private fun refusedPage(tab: TabWebView, href: String): WebResourceResponse {
        tab.refuseExtensionPage(href)
        return heldPage()
    }

    private fun heldPage(): WebResourceResponse = response("text/html", 200, "OK", HELD_PAGE_HTML.toByteArray())

    /** The pages held for `id`, loaded again now that its origin answers (main thread). */
    private fun releaseHeld(id: String) {
        val tabs = host.tabs.all()
        for (held in heldPages.served(id)) {
            val view = held.view
            // A tab that moved on, or went, keeps its own page.
            if (view !in tabs || view.currentUrl != held.url) continue
            Log.i(TAG, "reloading a held page of ${id.take(8)}: ${held.url.take(80)}")
            view.reload()
        }
    }

    /** A page held for an extension that is not coming: it fails (main thread). */
    private fun failHeld(held: HeldPages.Held<TabWebView>) {
        val view = held.view
        if (view !in host.tabs.all() || view.currentUrl != held.url) return
        view.failExtensionPage(held.url)
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

    /**
     * Ask the runtime to run an extension's stopped background (an MV3 worker idles out half a
     * minute after its last traffic), as Chrome's management page starts an inactive worker when
     * its view is inspected. Instrumentation: the driver probes a worker's APIs through its view.
     */
    fun wakeBackground(id: String) = chromeEvent("ext.wake", json("id" to id))

    /** The document-start script units currently installed in every tab, across extensions. */
    fun scriptUnits(): List<ScriptUnit> = units.values.flatten()

    /**
     * The extensions' rule sets in the engine's current snapshot, for instrumentation: per set,
     * its rule count and how many of its rules the index cannot bucket (`wildcard`), with the
     * partitions it is scoped to.
     */
    fun ruleSetStats(): JSONArray {
        val out = JSONArray()
        for (set in host.blocking.snapshot.ruleSets) {
            if (!set.id.startsWith(EXT_SET_PREFIX)) continue
            out.put(
                json(
                    "id" to set.id, "rules" to set.rules.size, "wildcard" to set.index.wildcardCount,
                    "hosts" to set.index.hostCount, "priority" to set.priority,
                    "partitions" to (set.partitions?.let { JSONArray(it.sorted()) })
                )
            )
        }
        return out
    }

    /** The WebView of the open popup / options sheet, if any. */
    fun popupView(): ExtensionWebView? = popup?.webView

    /** The WebView of an extension's open `identity.launchWebAuthFlow` sheet, if any (instrumentation). */
    fun authSheetView(extensionId: String): WebView? = authSheets.values.firstOrNull { it.extensionId == extensionId }?.webView

    /** Whether the CORS proxy's log (`proxied`) has an answer for a URL containing `fragment`, as "METHOD status url" lines. */
    fun proxiedMatching(fragment: String): List<String> = synchronized(proxied) { proxied.filter { it.contains(fragment) } }

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

    /**
     * `ext.offscreen.open`: the extension's one offscreen document (`chrome.offscreen`), a hidden
     * view like the background's on the page the extension named; its bootstrap says hello as an
     * `offscreen` endpoint, which is what the core's `createDocument` waits for. An earlier one
     * under the id is replaced (the core refuses a second `createDocument`; this is its retry).
     */
    private fun openOffscreen(id: String, url: String) {
        val ext = served[id] ?: return
        closeOffscreen(id)
        val view = ExtensionWebView(host, this, ext, "offscreen")
        offscreens[id] = view
        host.attachHidden(view)
        view.loadUrl(url)
    }

    private fun closeOffscreen(id: String) {
        val view = offscreens.remove(id) ?: return
        onDocumentGone(view)
        host.detachHidden(view)
        view.destroy()
    }

    private fun openPopup(id: String, url: String, context: String, title: String) {
        closePopup()
        val ext = served[id] ?: return
        val sheet = ExtensionPopup(host, this, ext, title, url, context) {
            popup = null
            chromeEvent("ext.popupClosed", json("id" to id))
        }
        popup = sheet
        sheet.show()
    }

    fun closePopup() {
        popup?.dismiss()
        popup = null
    }

    /**
     * `ext.auth.open`: the sheet of an `identity.launchWebAuthFlow`, loading hidden until the flow
     * says `ext.auth.show`; what happens in it goes back as `ext.authView` (see [ExtensionAuthSheet]).
     */
    private fun openAuthSheet(viewId: Int, id: String, url: String, title: String) {
        authSheets.remove(viewId)?.close()
        val sheet = ExtensionAuthSheet(host, viewId, id, title) { event, target ->
            if (event == ExtensionAuthSheet.EVENT_CLOSED) authSheets.remove(viewId)
            chromeEvent("ext.authView", json("viewId" to viewId, "event" to event, "url" to target))
        }
        authSheets[viewId] = sheet
        sheet.load(url)
    }

    /** Every auth sheet, or those of one extension, down without a word (the core ended the flows). */
    private fun closeAuthSheets(extensionId: String? = null) {
        val going = authSheets.values.filter { extensionId == null || it.extensionId == extensionId }
        for (sheet in going) {
            authSheets.remove(sheet.viewId)
            sheet.close()
        }
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
        // A dead offscreen page goes the same way; `hasDocument` says false once its endpoint is gone.
        val offscreen = offscreens.entries.firstOrNull { it.value === view }?.key
        if (offscreen != null) closeOffscreen(offscreen)
        if (popup?.webView === view) closePopup()
    }

    fun pageScript(ext: Served, context: String): String {
        val config = runCatching { JSONObject(ext.pageConfig) }.getOrDefault(JSONObject())
        config.put("context", context)
        return ExtensionScripts.page(bootstrap, config.toString(), debug)
    }

    fun onBridgeMessageFromPage(view: WebView, data: String?, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) =
        onBridgeMessage(view, data, origin, isMainFrame, proxy, "page", slot = null)

    fun destroy() {
        closePopup()
        closeAuthSheets()
        for (id in backgrounds.keys.toList()) stopBackground(id)
        for (id in offscreens.keys.toList()) closeOffscreen(id)
        notifications.destroy()
        io.shutdownNow()
        // The engine outlives the window; a runtime that is gone must not be called (a newer
        // window's runtime may already have taken the seams over).
        if (host.blocking.observer === observer) host.blocking.observer = null
        if (host.blocking.redirector === redirector) host.blocking.redirector = null
        if (host.blocking.headerStage === headerStage) host.blocking.headerStage = null
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
        /** The largest extension file answered to a content script over the bridge (`extensionFetch`): base64 over `postMessage` has a price. */
        const val MAX_RELAYED_FILE_BYTES = 16 * 1024 * 1024
        /**
         * The document a tab shows while its extension page is held (or is being failed): empty,
         * in the page's colour scheme, so it reads as a page still loading, not as a page.
         */
        const val HELD_PAGE_HTML =
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
                "<style>:root{color-scheme:light dark}</style></head><body></body></html>"
        /** The id prefix of the extensions' rule sets in the engine (`engineSetId` in `core/extensions/dnr/sink.ts`). */
        const val EXT_SET_PREFIX = "ext:"
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
