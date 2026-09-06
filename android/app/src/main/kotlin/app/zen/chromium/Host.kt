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
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
    val chrome = ChromeWebView(activity, this)
    val tabs = TabHost(root, this)
    val pageToken: String = SecureRandom().let { r -> ByteArray(16).also(r::nextBytes).joinToString("") { "%02x".format(it) } }
    val pageScript: String = activity.assets.open("page.js").bufferedReader().readText().replace("__ZEN_TOKEN__", pageToken)
    private val io = Executors.newCachedThreadPool { r -> Thread(r, "zen-io") }
    private val main = Handler(Looper.getMainLooper())
    private var fullscreenTab: TabWebView? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    var immersive = false
        private set

    // ---------------------------------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------------------------------

    /** Synchronous methods (bridge thread!). Only cheap, thread-safe work belongs here. */
    fun dispatchSync(method: String, args: JSONObject): Any? = when (method) {
        "boot" -> json(
            "version" to BuildConfig.VERSION_NAME,
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
                else tab.evaluateJavascript(args.str("code")) { result ->
                    // WebView returns JSON text; pass it through so the core sees the real value.
                    reply(RawJson(result ?: "null"))
                }
            }
            "view.setFlags" -> { tab?.setFlags(args.obj("flags")); reply(null) }
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

            // --- chrome / window / app -----------------------------------------------------------
            "chrome.focus" -> { chrome.requestFocus(); reply(null) }
            "chrome.setTheme" -> { applyTheme(args.bool("dark"), args.str("background")); reply(null) }
            "window.setFullscreen" -> { setImmersive(args.bool("fullscreen")); reply(null) }
            "app.quit" -> { activity.finishAndRemoveTask(); reply(null) }
            "app.background" -> { activity.moveTaskToBack(true); reply(null) }
            "app.openExternal" -> { openExternal(args.str("url")); reply(null) }
            "app.openPath" -> { downloads.open(args.str("path"), ""); reply(null) }
            "keys.setShortcuts" -> { keys.setShortcuts(args.arr("bindings")); reply(null) }

            // --- services --------------------------------------------------------------------------
            "dialog.confirm" -> confirm(args, reply)
            "clipboard.writeText" -> {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Zen", args.str("text")))
                reply(null)
            }
            "clipboard.writeImage" -> copyImage(args.str("url"), reply)
            "net.fetch" -> fetchText(args.str("url"), args.obj("headers"), reply)
            "download.bind" -> { downloads.bind(args.str("token"), args.str("id")); reply(null) }
            "download.cancel" -> { downloads.cancel(args.str("id")); reply(null) }
            "download.pause", "download.resume" -> reply(null)
            "download.open" -> { downloads.open(args.str("savePath"), args.str("mimeType")); reply(null) }
            "download.showAll" -> { downloads.showAll(); reply(null) }
            "profile.clear" -> { Profiles.clear(args.str("containerId")); reply(null) }
            "permission.respond" -> { permissions.respond(args.str("requestId"), args.bool("allow")); reply(null) }
            else -> throw IllegalArgumentException("Unknown method: $method")
        }
    }

    /** Marker so `encodeResult` passes pre-encoded JSON through untouched. */
    class RawJson(val json: String) {
        override fun toString(): String = json
    }

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

    private fun applyTheme(dark: Boolean, background: String) {
        val color = parseColor(background.ifEmpty { if (dark) "#16161b" else "#f2f1f5" })
        root.setBackgroundColor(color)
        activity.window.decorView.setBackgroundColor(color)
        val controller = WindowInsetsControllerCompat(activity.window, root)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }

    private fun print(tab: TabWebView) {
        val manager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
        val name = tab.title?.ifEmpty { null } ?: "Zen page"
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
    private fun saveToDownloads(name: String, mimeType: String, bytes: ByteArray?, reply: (Any?) -> Unit) {
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

    private fun fetchText(url: String, headers: JSONObject, reply: (Any?) -> Unit) {
        io.execute {
            val result = runCatching {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 2500
                    readTimeout = 2500
                    for (key in headers.keys()) setRequestProperty(key, headers.str(key))
                }
                val ok = conn.responseCode in 200..299
                val text = if (ok) conn.inputStream.bufferedReader().use { it.readText() } else ""
                json("ok" to ok, "text" to text)
            }.getOrElse { json("ok" to false, "text" to "") }
            main.post { reply(result) }
        }
    }

    fun destroy() {
        tabs.destroyAll()
        io.shutdownNow()
    }

    companion object {
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
