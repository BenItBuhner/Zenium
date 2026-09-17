package app.zen.chromium

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * Implements every native method the JS core can call (`window.__zenNative.call`), and owns the
 * platform services the tab WebViews report into. One instance per activity.
 */
class Host(val activity: MainActivity, private val root: FrameLayout, private val fullscreenLayer: FrameLayout) {
    val storage = Storage(activity)
    val keys = Keys()
    val permissions = Permissions(this)
    val downloads = Downloads(activity, this)
    var chrome = ChromeWebView(activity, this)
        private set
    val tabs = TabHost(root, this)
    val agentServer = AgentServer(this)
    val updates = Updates(activity, this)
    val siteData = SiteData()
    /** The launcher icon colour (one enabled `activity-alias`), driven by Settings → Look and Feel. */
    val launcherIcon = LauncherIcon(activity)
    val pageToken: String = SecureRandom().let { r -> ByteArray(16).also(r::nextBytes).joinToString("") { "%02x".format(it) } }
    val pageScript: String = activity.assets.open("page.js").bufferedReader().readText().replace("__ZEN_TOKEN__", pageToken)
    private val io = Executors.newCachedThreadPool { r -> Thread(r, "zen-io") }
    private val main = Handler(Looper.getMainLooper())
    /** The share sheet, in both directions (after `io`: it fetches on it). */
    val share = Share(this, io)
    /** Links that leave the web: held here while the core (and the user) decide. */
    val externalProtocols = ExternalProtocols(this)
    var fullscreenTab: TabWebView? = null
        private set
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    var immersive = false
        private set
    /** The chrome's colour scheme, so native pieces (the back preview) match it. */
    var themeDark = false
        private set
    /** The chrome's `--zen-scrim` token (ARGB): the space-tinted dim under its sheets. */
    var themeScrim = parseColor(DEFAULT_SCRIM)
        private set
    /** Previews of the pages a back gesture would return to. */
    val snapshots = HistorySnapshots(activity)
    /** Last: it reads the tabs and fullscreen state above when it decides what back would do. */
    val back = PredictiveBack(activity, this)
    val lifecycle = HostLifecycle()

    // ---------------------------------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------------------------------

    /** Synchronous methods (bridge thread!). Only cheap, thread-safe work belongs here. */
    fun dispatchSync(method: String, args: JSONObject): Any? = when (method) {
        "boot" -> json(
            "version" to BuildConfig.VERSION_NAME,
            // The OS release decides a few capabilities (the clipboard chip, the share sheet's row).
            "sdkInt" to Build.VERSION.SDK_INT,
            "signer" to Updates.signerSha256(activity),
            // The applicationId; a release whose APK carries another one installs as a new app.
            "packageName" to activity.packageName,
            "appIcon" to launcherIcon.current(),
            "files" to storage.readAll(),
            "downloadsDir" to (Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)?.absolutePath ?: ""),
            "insets" to activity.currentInsets(),
            "fullscreen" to immersive
        )
        "storage.writeSync" -> {
            storage.writeSync(args.str("name"), args.str("text"))
            null
        }
        else -> throw IllegalArgumentException("Unknown sync method: $method")
    }

    /** Asynchronous methods (main thread). Call `reply` exactly once. */
    fun dispatch(method: String, args: JSONObject, reply: (Any?) -> Unit) {
        val tabId = args.strOrNull("tabId")
        val tab = tabId?.let { tabs.get(it) }
        when (method) {
            "storage.write" -> storage.write(args.str("name"), args.str("text")) { main.post { reply(null) } }

            // --- views -----------------------------------------------------------------------
            "view.create" -> { tabs.create(args.str("tabId"), args.str("containerId", Profiles.DEFAULT_CONTAINER)); reply(null) }
            "view.destroy" -> { tabs.destroy(args.str("tabId")); reply(null) }
            "view.bind" -> { tabs.bind(args.str("viewId"), args.str("tabId")); reply(null) }
            "view.load" -> { tab?.loadUrl(args.str("url")); reply(null) }
            "view.loadHtml" -> { tab?.loadHtml(args.str("url"), args.str("html")); reply(null) }
            "view.back" -> { if (tab?.canGoBack() == true) tab.goBack(); reply(null) }
            "view.forward" -> { if (tab?.canGoForward() == true) tab.goForward(); reply(null) }
            "view.reload" -> {
                if (args.bool("ignoreCache")) tab?.clearCache(false)
                tab?.reload()
                reply(null)
            }
            "view.stop" -> { tab?.stopLoading(); reply(null) }
            "view.setMuted" -> { tab?.setMuted(args.bool("muted")); reply(null) }
            "view.setZoom" -> { tab?.setZoom(args.num("factor", 1.0)); reply(null) }
            "view.find" -> { tab?.find(args.str("text"), args.bool("forward", true), args.bool("newSession", true)); reply(null) }
            "view.stopFind" -> { tab?.stopFind(); reply(null) }
            "view.eval" -> {
                if (tab == null) reply(null)
                else tab.evaluate(args.str("code")) { result ->
                    // JSON text of the value; a thrown/rejected error rejects the bridge call,
                    // which is what the core expects from Electron's executeJavaScript.
                    val error = result?.let { r -> runCatching { JSONObject(r).strOrNull("__zenError") }.getOrNull() }
                    if (error != null) reply(Rejection(error)) else reply(RawJson(result ?: "null"))
                }
            }
            "view.input" -> if (tab == null) reply(null) else tab.sendAgentInput(args.obj("event")) { reply(null) }
            "view.setFlags" -> { tab?.setFlags(args.obj("flags")); reply(null) }
            "view.setZap" -> { tab?.setZap(args.bool("on")); reply(null) }
            "view.setBackground" -> {
                tab?.setBackgroundColor(parseColor(args.str("color", "#ffffff")))
                reply(null)
            }
            "view.focus" -> { tab?.requestFocus(); reply(null) }
            "view.setBounds" -> { tabs.setBounds(args.str("tabId"), args.obj("rect")); reply(null) }
            "view.setRadius" -> { tabs.setRadius(args.str("tabId"), args.num("radius")); reply(null) }
            "view.setVisible" -> { tabs.setVisible(args.str("tabId"), args.bool("visible")); reply(null) }
            "view.bringToFront" -> { tabs.bringToFront(args.str("tabId")); reply(null) }
            "view.download" -> {
                if (tab != null) downloads.start(args.str("url"), tab.settings.userAgentString, null, null, -1, tab.tabId)
                reply(null)
            }
            "view.print" -> { tab?.let(::print); reply(null) }
            "view.savePage" -> if (tab == null) reply(null) else savePage(tab, args.str("name"), reply)
            "view.snapshot" -> if (tab == null) reply(null) else tab.snapshot(reply)
            "view.screenshot" -> if (tab == null) reply(null) else tab.screenshot { png -> saveToDownloads(args.str("name"), "image/png", png, reply) }
            "view.capture" -> if (tab == null) reply(null) else tab.capture(args.str("mode", "viewport"), args.optJSONObject("region"), args.str("format", "jpeg"), reply)
            "view.certificate" -> reply(tab?.certificateInfo())

            // --- site information (cookies and storage of a site, per container) -------------------
            "site.cookies" -> reply(siteData.cookies(args.str("containerId", Profiles.DEFAULT_CONTAINER), args.str("url")))
            "site.storage" -> siteData.storage(args.str("containerId", Profiles.DEFAULT_CONTAINER), args.str("site"), reply)
            "site.clearCookies" -> siteData.clearCookies(args.str("containerId", Profiles.DEFAULT_CONTAINER), args.str("url"), reply)
            "site.clearStorage" -> siteData.clearStorage(
                args.str("containerId", Profiles.DEFAULT_CONTAINER), args.str("site"), args.arr("origins"), reply
            )

            // --- chrome / window / app -----------------------------------------------------------
            "chrome.focus" -> { chrome.requestFocus(); reply(null) }
            "chrome.showKeyboard" -> {
                chrome.requestFocus()
                val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showSoftInput(chrome, InputMethodManager.SHOW_IMPLICIT)
                reply(null)
            }
            "chrome.hideKeyboard" -> {
                val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imm.hideSoftInputFromWindow(chrome.windowToken, 0)
                reply(null)
            }
            "chrome.haptic" -> { haptic(args.str("kind")); reply(null) }
            "chrome.setTheme" -> { applyTheme(args.bool("dark"), args.str("background"), args.str("scrim")); reply(null) }
            "back.update" -> { back.update(args.bool("chrome"), args.strOrNull("tabId")); reply(null) }
            "window.setFullscreen" -> { setImmersive(args.bool("fullscreen")); reply(null) }
            "app.quit" -> { activity.finishAndRemoveTask(); reply(null) }
            "app.background" -> { activity.moveTaskToBack(true); reply(null) }
            "app.openExternal" -> { openExternal(args.str("url")); reply(null) }
            "app.openPath" -> { downloads.open(args.str("path"), ""); reply(null) }
            "app.setIcon" -> { launcherIcon.apply(args.str("id"), activity); reply(null) }
            "app.share" -> share.share(args, reply)
            "app.openAppLinkSettings" -> { openAppLinkSettings(); reply(null) }
            "externalProtocol.respond" -> { externalProtocols.respond(args.str("requestId"), args.bool("allow")); reply(null) }
            "keys.setShortcuts" -> { keys.setShortcuts(args.arr("bindings")); reply(null) }

            // --- services --------------------------------------------------------------------------
            "dialog.confirm" -> confirm(args, reply)
            "dialog.openText" -> activity.pickTextFiles(args.arr("extensions")) { files -> reply(files) }
            "dialog.saveText" -> activity.saveTextFile(args.str("defaultName"), args.str("mimeType"), args.str("text")) { ok -> reply(ok) }
            "clipboard.writeText" -> {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Zenium", args.str("text")))
                reply(null)
            }
            "clipboard.writeImage" -> copyImage(args.str("url"), reply)
            "net.fetch" -> fetchText(args.str("url"), args.obj("headers"), args.num("timeoutMs").toInt(), reply)
            "download.bind" -> { downloads.bind(args.str("token"), args.str("id")); reply(null) }
            "download.cancel" -> { downloads.cancel(args.str("id")); reply(null) }
            "download.pause", "download.resume" -> reply(null)
            "download.open" -> { downloads.open(args.str("savePath"), args.str("mimeType")); reply(null) }
            "download.showAll" -> { downloads.showAll(); reply(null) }
            "profile.clear" -> { Profiles.clear(args.str("containerId")); reply(null) }
            "permission.respond" -> { permissions.respond(args.str("requestId"), args.bool("allow")); reply(null) }

            // --- AI agents (MCP server) ------------------------------------------------------------
            "agent.start" -> reply(agentServer.start(args.num("port", 41735.0).toInt(), args.bool("lan")))
            "agent.stop" -> { agentServer.stop(); reply(null) }
            "agent.reply" -> { agentServer.reply(args.optInt("id"), args); reply(null) }

            // --- automatic updates -----------------------------------------------------------------
            "update.download" -> updates.download(
                args.str("token"), args.str("url"), args.str("name"), args.num("size").toLong(), args.str("sha256"), reply
            )
            "update.cancel" -> { updates.cancel(args.str("token")); reply(null) }
            "update.install" -> reply(updates.install(args.str("path")))

            else -> throw IllegalArgumentException("Unknown method: $method")
        }
    }

    /** Marker so `encodeResult` passes pre-encoded JSON through untouched. */
    class RawJson(val json: String) {
        override fun toString(): String = json
    }

    /** Answering with this rejects the bridge call instead of resolving it. */
    class Rejection(val message: String)

    // ---------------------------------------------------------------------------------------------
    // Fullscreen (HTML element fullscreen and Zen's F11-style fullscreen)
    // ---------------------------------------------------------------------------------------------

    fun enterFullscreen(tab: TabWebView, view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenTab != null) exitFullscreen(fullscreenTab!!)
        fullscreenTab = tab
        fullscreenCallback = callback
        fullscreenLayer.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        fullscreenLayer.visibility = View.VISIBLE
        setSystemBarsHidden(true)
        chrome.viewEvent(tab.tabId, "enterFullscreen", null)
        back.refresh()
    }

    fun exitFullscreen(tab: TabWebView) {
        if (fullscreenTab !== tab) return
        fullscreenLayer.removeAllViews()
        fullscreenLayer.visibility = View.GONE
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        fullscreenTab = null
        if (!immersive) setSystemBarsHidden(false)
        chrome.viewEvent(tab.tabId, "leaveFullscreen", null)
        back.refresh()
    }

    /** Back gesture while a video is fullscreen: leave fullscreen first. */
    fun handleBackInFullscreen(): Boolean {
        val tab = fullscreenTab ?: return false
        exitFullscreen(tab)
        return true
    }

    private fun setImmersive(on: Boolean) {
        immersive = on
        setSystemBarsHidden(on || fullscreenTab != null)
        chrome.hostEvent("fullscreen", json("fullscreen" to on))
    }

    private fun setSystemBarsHidden(hidden: Boolean) {
        val controller = WindowInsetsControllerCompat(activity.window, root)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hidden) controller.hide(WindowInsetsCompat.Type.systemBars()) else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    // ---------------------------------------------------------------------------------------------
    // Services
    // ---------------------------------------------------------------------------------------------

    fun openExternal(url: String) {
        val intent = try {
            if (url.startsWith("intent:")) Intent.parseUri(url, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, Uri.parse(url))
        } catch (e: Exception) {
            return
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Never bounce http(s) back to ourselves.
        if (intent.data?.scheme in setOf("http", "https") && intent.action == Intent.ACTION_VIEW) {
            chrome.openUrl(url)
            return
        }
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            val fallback = intent.getStringExtra("browser_fallback_url")
            if (fallback != null) chrome.openUrl(fallback)
            else Toast.makeText(activity, "No app can open this link", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * Android's "Open by default" screen for Zenium (which links open in it, Android 12+); older
     * releases have it inside the app's details page.
     */
    private fun openAppLinkSettings() {
        val app = Uri.parse("package:${activity.packageName}")
        val screens = ArrayList<Intent>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) screens.add(Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, app))
        screens.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app))
        for (screen in screens) {
            try {
                activity.startActivity(screen)
                return
            } catch (e: ActivityNotFoundException) {
                // The next screen down is on every device.
            }
        }
    }

    private fun confirm(args: JSONObject, reply: (Any?) -> Unit) {
        var answered = false
        val done = { ok: Boolean -> if (!answered) { answered = true; reply(ok) } }
        MaterialAlertDialogBuilder(activity)
            .setTitle(args.str("message"))
            .setMessage(args.strOrNull("detail"))
            .setPositiveButton(args.str("okLabel", "OK")) { _, _ -> done(true) }
            .setNegativeButton(args.str("cancelLabel", "Cancel")) { _, _ -> done(false) }
            .setOnCancelListener { done(false) }
            .show()
    }

    /**
     * The system's own haptics for the chrome's gestures – the long-press pick-up, a notch as the
     * dragged address bar passes the middle of the screen, and the click of it docking – so they
     * feel like every other long-press and snap on the device.
     */
    private fun haptic(kind: String) {
        val constant = when (kind) {
            "lift" -> HapticFeedbackConstants.LONG_PRESS
            "tick" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) HapticFeedbackConstants.SEGMENT_TICK
                else HapticFeedbackConstants.CLOCK_TICK
            "dock" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM
                else HapticFeedbackConstants.CONTEXT_CLICK
            else -> return
        }
        chrome.performHapticFeedback(constant)
    }

    private fun applyTheme(dark: Boolean, background: String, scrim: String) {
        themeDark = dark
        if (scrim.isNotEmpty()) themeScrim = parseColor(scrim)
        val color = parseColor(background.ifEmpty { if (dark) "#16161b" else "#f2f1f5" })
        root.setBackgroundColor(color)
        activity.window.decorView.setBackgroundColor(color)
        val controller = WindowInsetsControllerCompat(activity.window, root)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }

    private fun print(tab: TabWebView) {
        val manager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
        val name = tab.title?.ifEmpty { null } ?: "Zenium page"
        manager.print(name, tab.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
    }

    private fun savePage(tab: TabWebView, name: String, reply: (Any?) -> Unit) {
        val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir, "").apply { mkdirs() }
        val base = name.removeSuffix(".html").removeSuffix(".htm")
        var file = File(dir, "$base.mht")
        var n = 1
        while (file.exists()) file = File(dir, "$base(${n++}).mht")
        tab.saveWebArchive(file.absolutePath, false) { path -> reply(path) }
    }

    /** Store bytes as a file in the public Downloads collection; resolves with a path or URI. */
    fun saveToDownloads(name: String, mimeType: String, bytes: ByteArray?, reply: (Any?) -> Unit) {
        if (bytes == null) {
            reply(null)
            return
        }
        io.execute {
            val result: String? = runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, mimeType)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val resolver = activity.contentResolver
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return@runCatching null
                    resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    uri.toString()
                } else {
                    val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir
                    val file = File(dir, name)
                    file.writeBytes(bytes)
                    file.absolutePath
                }
            }.getOrNull()
            main.post { reply(result) }
        }
    }

    private fun copyImage(url: String, reply: (Any?) -> Unit) {
        io.execute {
            val ok = runCatching {
                val bytes = if (url.startsWith("data:")) {
                    val comma = url.indexOf(',')
                    android.util.Base64.decode(url.substring(comma + 1), android.util.Base64.DEFAULT)
                } else {
                    (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 8000; readTimeout = 8000 }
                        .inputStream.use { it.readBytes() }
                }
                val dir = File(activity.cacheDir, "clipboard").apply { mkdirs() }
                val file = File(dir, "image-${System.currentTimeMillis()}.png")
                file.writeBytes(bytes)
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newUri(activity.contentResolver, "Image", uri))
                true
            }.getOrDefault(false)
            main.post { reply(ok) }
        }
    }

    /** `timeoutMs` ≤ 0 keeps the short default meant for suggestions and Live Folders. */
    private fun fetchText(url: String, headers: JSONObject, timeoutMs: Int, reply: (Any?) -> Unit) {
        io.execute {
            val result = runCatching {
                val timeout = if (timeoutMs > 0) timeoutMs else 2500
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = timeout
                    readTimeout = timeout
                    for (key in headers.keys()) setRequestProperty(key, headers.str(key))
                }
                val status = conn.responseCode
                val ok = status in 200..299
                val text = if (ok) conn.inputStream.bufferedReader().use { it.readText() } else ""
                json("ok" to ok, "status" to status, "text" to text)
            }.getOrElse { json("ok" to false, "status" to 0, "text" to "") }
            main.post { reply(result) }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Lifecycle: coming back on screen, and a lost renderer
    // ---------------------------------------------------------------------------------------------

    /**
     * The window is about to be shown again after being hidden (screen turned back on, back from
     * the launcher or the lock screen). Nothing was paused on the way out (see [HostLifecycle]),
     * so nothing is resumed; what comes back needs a fresh frame from every WebView on screen –
     * a compositor may have dropped its last one under a memory trim while hidden – and the
     * chrome gets to lay itself out against the window it returns to. `resumeTimers` is a global
     * no-op unless something paused them; it costs nothing to be certain.
     */
    fun onStart() {
        chrome.resumeTimers()
        chrome.hostEvent("resume", null)
        repaint()
    }

    /** Back in the foreground after being hidden: check, a moment later, that the chrome paints. */
    fun onResume() {
        scheduleProbe(attempt = 0, delayMs = HostLifecycle.PROBE_DELAY_MS)
    }

    /** Leaving the foreground: a probe answered while hidden would only mislead. */
    fun onPause() {
        cancelProbe()
    }

    /** Ask every WebView on screen for a fresh frame at its current size. */
    fun repaint() {
        root.requestLayout()
        chrome.invalidate()
        for (tab in tabs.all()) if (tab.visibility == View.VISIBLE) tab.invalidate()
    }

    private var probeRun: Runnable? = null
    private var probeDeadline: Runnable? = null
    private var pendingRepair: Runnable? = null

    private fun scheduleProbe(attempt: Int, delayMs: Long) {
        cancelProbe()
        val run = Runnable { probe(attempt) }
        probeRun = run
        main.postDelayed(run, delayMs)
    }

    private fun cancelProbe() {
        probeRun?.let(main::removeCallbacks)
        probeRun = null
        probeDeadline?.let(main::removeCallbacks)
        probeDeadline = null
        pendingRepair?.let(main::removeCallbacks)
        pendingRepair = null
    }

    /**
     * The wake watchdog. A WebView whose window is resumed but whose contents the platform left
     * hidden paints nothing; a renderer whose main thread is wedged answers nothing; a chrome
     * whose UI unmounted itself paints its background and nothing else. All three look the same
     * from the outside – a blank browser – and none reports itself. So the chrome document is
     * asked how it is doing ([HostLifecycle.PROBE_SCRIPT]), and [HostLifecycle.repairAfterProbe]
     * decides what that calls for.
     */
    private fun probe(attempt: Int) {
        probeRun = null
        val target = chrome
        // A chrome still booting (fresh from a rebuild) has nothing to answer with yet; its load
        // is the repair in progress.
        if (!target.ready) return
        var settled = false
        val deadline = Runnable {
            if (settled) return@Runnable
            settled = true
            probeDeadline = null
            onProbeAnswer(target, null, attempt)
        }
        probeDeadline = deadline
        main.postDelayed(deadline, HostLifecycle.PROBE_TIMEOUT_MS)
        target.evaluateJavascript(HostLifecycle.PROBE_SCRIPT) { result ->
            if (settled) return@evaluateJavascript
            settled = true
            main.removeCallbacks(deadline)
            probeDeadline = null
            onProbeAnswer(target, result?.trim('"'), attempt)
        }
    }

    private fun onProbeAnswer(target: ChromeWebView, answer: String?, attempt: Int) {
        if (target !== chrome || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
        when (lifecycle.repairAfterProbe(answer, attempt)) {
            HostLifecycle.Repair.NONE -> Log.i(TAG, "wake probe: chrome $answer")
            HostLifecycle.Repair.RETRY -> {
                Log.w(TAG, "wake probe: ${if (answer == null) "no answer from the chrome renderer" else "chrome document $answer"}; asking once more")
                scheduleProbe(attempt + 1, 0)
            }
            HostLifecycle.Repair.REATTACH -> {
                Log.w(TAG, "wake probe: chrome document is $answer while resumed; re-attaching the WebViews")
                reattach(target)
                for (tab in tabs.all()) if (tab.visibility == View.VISIBLE) reattach(tab)
                scheduleProbe(attempt + 1, HostLifecycle.PROBE_DELAY_MS)
            }
            HostLifecycle.Repair.REBUILD -> {
                Log.e(TAG, "wake probe: chrome document still $answer; rebuilding the chrome")
                rebuildChrome(target)
            }
            HostLifecycle.Repair.TERMINATE -> {
                Log.e(TAG, "wake probe: chrome renderer unresponsive; ending the renderer process")
                terminateRenderer(target)
            }
        }
    }

    /**
     * End the renderer process behind the chrome (and, with it, every tab's): its
     * `onRenderProcessGone` then rebuilds the chrome around a fresh renderer, which is the only way
     * out when the process no longer answers – a new WebView would land in the same wedged
     * process. Where the platform cannot end it (an old WebView), the rebuild happens directly and
     * the wedged process is left to the system; and should the `onRenderProcessGone` not follow,
     * the rebuild happens anyway after a grace period.
     */
    private fun terminateRenderer(target: ChromeWebView) {
        val process = if (WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER)) {
            WebViewCompat.getWebViewRenderProcess(target)
        } else null
        val ended = process != null &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE) &&
            runCatching { process.terminate() }.getOrDefault(false)
        if (!ended) {
            Log.w(TAG, "the renderer process could not be ended; rebuilding the chrome in place")
            rebuildChrome(target)
            return
        }
        val fallback = Runnable {
            pendingRepair = null
            if (chrome === target) {
                Log.w(TAG, "no onRenderProcessGone after ending the renderer; rebuilding the chrome anyway")
                rebuildChrome(target)
            }
        }
        pendingRepair = fallback
        main.postDelayed(fallback, HostLifecycle.TERMINATE_GRACE_MS)
    }

    /**
     * A new document started loading in the chrome WebView (the chrome reloaded itself). The core
     * that owned the tab views went with the old document; the one booting recreates every tab
     * from the persisted state, so the views here are orphans and go.
     */
    fun onChromeDocumentReplaced() {
        cancelProbe()
        tabs.dropAll()
    }

    /**
     * Take a WebView off the window and put it straight back where it was: the WebView drops and
     * re-creates its hardware renderer and re-announces its visibility to the renderer, the
     * platform's own way of re-attaching compositing that was lost while the window was away.
     */
    private fun reattach(view: View) {
        val index = root.indexOfChild(view)
        if (index < 0) return
        val params = view.layoutParams
        val focused = view.hasFocus()
        root.removeView(view)
        root.addView(view, index, params)
        if (focused) view.requestFocus()
        view.invalidate()
    }

    /**
     * The chrome WebView lost its renderer (killed in the background under memory pressure, or a
     * crash). The browser core ran inside it, so every tab page is orphaned – they share the
     * renderer, and their own `onRenderProcessGone` may arrive before or after this one. Drop them
     * without a word to a chrome that is gone, swap in a fresh chrome WebView in the same place
     * and let it boot the core again from the persisted profile: the same path as a cold start,
     * which recreates every tab from `state.json` and reloads the pages on screen. A chrome that
     * dies again right away is retried with a growing delay rather than in a tight loop.
     */
    fun onChromeGone(dead: ChromeWebView) = rebuildChrome(dead)

    /**
     * Replace the chrome WebView (and every tab, which shares its renderer) with a fresh one that
     * boots the core again – for a renderer that is gone, and for one that is there but not
     * painting or answering. Destroying every WebView releases the renderer process; the fresh
     * chrome starts a new one.
     */
    private fun rebuildChrome(dead: ChromeWebView) {
        if (dead !== chrome || activity.isFinishing || activity.isDestroyed) return
        cancelProbe()
        tabs.dropAll()
        val index = root.indexOfChild(dead)
        val params = dead.layoutParams ?: FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        root.removeView(dead)
        runCatching { dead.destroy() }
        val fresh = ChromeWebView(activity, this)
        root.addView(fresh, if (index >= 0) index else 0, params)
        chrome = fresh
        val delay = lifecycle.chromeRebuildDelayMs()
        if (delay > 0) Log.w(TAG, "the rebuilt chrome died again (${lifecycle.consecutiveRapidRebuilds}x in a row); loading it in $delay ms")
        val load = Runnable {
            if (chrome !== fresh || activity.isFinishing || activity.isDestroyed) return@Runnable
            fresh.load()
            if (activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) fresh.requestFocus()
        }
        if (delay > 0) main.postDelayed(load, delay) else load.run()
    }

    fun destroy() {
        cancelProbe()
        agentServer.stop()
        updates.shutdown()
        tabs.destroyAll()
        // The chrome too: a WebView that outlives its activity keeps its document – and the
        // browser core inside it – running against a host that is gone, and would even rebuild
        // itself if its renderer died.
        (chrome.parent as? ViewGroup)?.removeView(chrome)
        runCatching { chrome.destroy() }
        io.shutdownNow()
    }

    companion object {
        private const val TAG = "ZenHost"

        /** The chrome's base light scrim (`--zen-scrim` before any space theme is applied). */
        private const val DEFAULT_SCRIM = "#49484a47"

        fun parseColor(css: String): Int = runCatching {
            // #rrggbbaa (Electron style) → Android ARGB.
            if (css.length == 9 && css.startsWith("#")) {
                val rgb = css.substring(1, 7)
                val a = css.substring(7, 9)
                Color.parseColor("#$a$rgb")
            } else Color.parseColor(css)
        }.getOrDefault(Color.WHITE)
    }
}
