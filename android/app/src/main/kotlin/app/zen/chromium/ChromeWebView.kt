package app.zen.chromium

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.util.Log
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import app.zen.chromium.ext.ExtensionStore
import org.json.JSONObject
import java.io.File

/**
 * The WebView that renders Zen's chrome (sidebar, bottom bar, overlays) and runs the browser core.
 * It sits at the bottom of the view stack; tab WebViews are positioned above it wherever the chrome
 * reports the content area to be – the same arrangement as the Electron window.
 */
@SuppressLint("SetJavaScriptEnabled")
class ChromeWebView(context: Context, private val host: Host) : WebView(context) {
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        // The extension store's package files (downloads and picked documents) and the installed
        // extensions' files, streamed to the core without a trip through the JS bridge
        // (ext/ExtensionStore.kt, src/android/extensionStoreIo.ts).
        .addPathHandler(PACKAGES_PATH, WebViewAssetLoader.InternalStoragePathHandler(context, File(context.cacheDir, ExtensionStore.PACKAGES_DIR)))
        .addPathHandler(EXTENSION_FILES_PATH, WebViewAssetLoader.InternalStoragePathHandler(context, File(context.filesDir, ExtensionStore.ROOT_DIR)))
        // Downloaded translation models (`Translate.kt`), read by the engine worker of the chrome.
        .addPathHandler("/translate/", WebViewAssetLoader.InternalStoragePathHandler(context, Translate.modelsDir(context)))
        .build()
    var ready = false
        private set
    private val whenReady = ArrayList<() -> Unit>()
    /** `window.__zenNative`: the chrome's calls into Kotlin (its queue's refusals are readable for instrumentation). */
    val bridge = JsBridge(host)

    init {
        // Named in the view hierarchy (`R.id.zen_chrome`) so the accessibility tree tells the
        // chrome's WebView from the tabs' (`viewIdResourceName`); nothing reads it otherwise.
        id = R.id.zen_chrome
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // The chrome is designed in CSS px; only its text follows the system font size, and
            // the chrome grows its line boxes to match (`ChromeTextScale`, re-applied on a
            // configuration change by `MainActivity`).
            textZoom = ChromeTextScale.textZoomPercent(resources)
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            // The chrome places focus itself (the address field, a dialog's first field). With a
            // keyboard attached the device is out of touch mode, and requestFocus() would otherwise
            // hand focus to the first focusable node in the document instead.
            setNeedInitialFocus(false)
        }
        setBackgroundColor(Color.TRANSPARENT)
        overScrollMode = OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        addJavascriptInterface(bridge, "__zenNative")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                handoffResponse(request.url) ?: loader.shouldInterceptRequest(request.url)?.also { profilable(request, it) }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // The chrome never navigates; anything that tries is an external link.
                val url = request.url.toString()
                if (url.startsWith(APP_ORIGIN) || url.startsWith(BuildConfig.DEV_SERVER_URL.ifEmpty { "\u0000" })) return false
                host.openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // A document after the first: the chrome reloaded itself (its error screen offers
                // that). Everything queued was for the core in the old document; the host drops the
                // tab views that core owned, and the new one recreates them.
                if (!ready) return
                ready = false
                whenReady.clear()
                Log.w("ZenChrome", "the chrome document is being replaced ($url); dropping the old core's tab views")
                host.onChromeDocumentReplaced()
            }

            override fun onPageFinished(view: WebView, url: String) {
                ready = true
                whenReady.forEach { it() }
                whenReady.clear()
            }

            /**
             * The chrome's renderer died (OOM, system pressure). Returning false here would take the
             * whole app down; instead the host rebuilds the chrome, which reboots the core from its
             * persisted state.
             */
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                ready = false
                whenReady.clear()
                Log.e(
                    "ZenChrome",
                    "chrome renderer gone (${if (detail.didCrash()) "crashed" else "killed"}, priority at exit " +
                        "${detail.rendererPriorityAtExit()}); rebuilding the chrome"
                )
                host.onChromeGone(this@ChromeWebView, detail.didCrash(), detail.rendererPriorityAtExit())
                return true
            }
        }
        // The shared renderer stopping to answer (the unresponsive-page prompt, ERR-16).
        host.watchRenderer(this)
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val level = when (message.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                    ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                    else -> Log.DEBUG
                }
                Log.println(level, "ZenChrome", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }

            /** The chrome's own file inputs (the new tab page's wallpaper) use the system picker too. */
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean = host.activity.showFileChooser(host, filePathCallback, fileChooserParams)
        }
    }

    fun load() {
        val dev = BuildConfig.DEV_SERVER_URL
        loadUrl(if (dev.isNotEmpty()) dev else "$APP_ORIGIN/assets/www/index.html")
    }

    /**
     * The system font size changed (`MainActivity.onConfigurationChanged`): the text takes the new
     * zoom at once, and the chrome hears the factor through the `environment` event that follows.
     * Answers the percent in force.
     */
    fun applyTextScale(): Int {
        val percent = ChromeTextScale.textZoomPercent(resources)
        if (settings.textZoom != percent) {
            Log.d("ZenChrome", "text zoom ${settings.textZoom} -> $percent (font scale ${resources.configuration.fontScale})")
            settings.textZoom = percent
        }
        return percent
    }

    /**
     * The file-backed handoffs (`BootHandoff.kt`) on the app origin: the core's big boot documents
     * under `/zen-docs/<name>` and the spilled `net.fetch` bodies under `/zen-net/<token>`, streamed
     * from their files on WebView's IO thread. Null for every other URL (the asset loader's turn).
     * `Cache-Control: no-store` keeps the renderer from answering a later boot with a stale copy;
     * the `ETag` is the version tag the boot manifest named, for the chrome to compare.
     */
    private fun handoffResponse(url: Uri): WebResourceResponse? {
        if (url.scheme != "https" || url.host != APP_HOST) return null
        val path = url.path ?: return null
        val answer = when {
            path.startsWith(BootHandoff.DOCS_PATH) -> host.handoff.document(path.removePrefix(BootHandoff.DOCS_PATH))
            path.startsWith(BootHandoff.NET_PATH) -> host.handoff.spilled(path.removePrefix(BootHandoff.NET_PATH))
            else -> return null
        }
        if (!answer.ok) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        headers["Content-Length"] = answer.length.toString()
        answer.etag?.let { headers["ETag"] = "\"$it\"" }
        return WebResourceResponse(answer.mimeType, "utf-8", 200, "OK", headers, answer.stream)
    }

    /**
     * A debug build's chrome document may profile its own script: the JS Self-Profiling API's
     * `Profiler` sits behind the `Document-Policy: js-profiling` response header, and the motion
     * profile's probe (`MotionPerfDemo`) reads a scene's script by function through it – the one
     * attribution the WebView's own trace cannot give, its events' arguments being stripped. The
     * policy enables the constructor and nothing else; release documents carry none.
     */
    private fun profilable(request: WebResourceRequest, response: WebResourceResponse) {
        if (!BuildConfig.DEBUG || !request.isForMainFrame) return
        response.responseHeaders = (response.responseHeaders ?: emptyMap()) + ("Document-Policy" to "js-profiling")
    }

    /** Run once the chrome document has loaded (queued before that). */
    fun onReady(block: () -> Unit) {
        if (ready) block() else whenReady.add(block)
    }

    // --- Kotlin → JS -----------------------------------------------------------------------

    fun resolve(id: Int, result: Any?) {
        js("window.__zenHost&&__zenHost.resolve($id,${JSONObject.quote(encodeResult(result))})")
    }

    fun reject(id: Int, message: String) {
        js("window.__zenHost&&__zenHost.reject($id,${JSONObject.quote(message)})")
    }

    fun viewEvent(tabId: String, name: String, payload: Any?) {
        js("window.__zenHost&&__zenHost.viewEvent(${JSONObject.quote(tabId)},${JSONObject.quote(name)},${JSONObject.quote(encodeResult(payload))})")
    }

    fun hostEvent(name: String, payload: Any?) {
        js("window.__zenHost&&__zenHost.hostEvent(${JSONObject.quote(name)},${JSONObject.quote(encodeResult(payload))})")
    }

    /**
     * [hostEvent] for a payload that is JSON text already, quoted into the script in one pass.
     * The extension bridge's `ext.message` events carry a frame's message as it wrote it, up to
     * hundreds of KB; through [hostEvent] such a payload was copied three more times (the
     * `toString`, `JSONObject.quote`'s builder and its string) before the script was built and
     * copied once again – the allocation that outran WebView 156's collector under a flood
     * (`ext/BridgeForward.kt`).
     */
    fun hostEventJson(name: String, json: CharSequence) {
        val script = StringBuilder(json.length + (json.length shr 3) + 96)
        script.append("window.__zenHost&&__zenHost.hostEvent(").append(JSONObject.quote(name)).append(",\"")
        script.appendJsQuoted(json)
        js(script.append("\")").toString())
    }

    /** Forward a physical key; the promise-free path relies on Kotlin having matched it already. */
    fun onKey(tabId: String?, input: JSONObject) {
        val tab = if (tabId == null) "null" else JSONObject.quote(tabId)
        js("window.__zenHost&&__zenHost.onKey($tab,${JSONObject.quote(input.toString())})")
    }

    /**
     * A back gesture aimed at the chrome: `start` (with the swipe edge), `progress` (0…1) and
     * `cancel` are fire-and-forget; the topmost chrome surface moves with them (see the chrome's
     * `lib/back.ts`).
     */
    fun backEvent(phase: String, payload: JSONObject?) {
        js("window.__zenHost&&__zenHost.backEvent(${JSONObject.quote(phase)},${JSONObject.quote(encodeResult(payload))})")
    }

    /**
     * A pull-to-refresh on a tab's page as the WebView recognises it: `start`, `move` (with the
     * finger's travel in CSS px) and `release` or `cancel`; the chrome's `lib/pull.ts` moves the
     * page and reloads it (see `PullToRefreshGesture.kt`).
     */
    fun pullEvent(tabId: String, phase: String, payload: JSONObject?) {
        js("window.__zenHost&&__zenHost.pullEvent(${JSONObject.quote(tabId)},${JSONObject.quote(phase)},${JSONObject.quote(encodeResult(payload))})")
    }

    /**
     * A tab's page scrolled under the bar that hides on scroll: `start` (a finger down), `move`
     * (the scroll since the last report, CSS px, one report per frame), `end` (the finger lifted)
     * or `show` (the page pushed against its top); the chrome's `lib/barHide.ts` moves the bar and
     * hands the page's edge back through `chrome.setBarHide` (see `BarHideGesture.kt`).
     */
    fun barScroll(tabId: String, phase: String, payload: JSONObject?) {
        js("window.__zenHost&&__zenHost.barScroll(${JSONObject.quote(tabId)},${JSONObject.quote(phase)},${JSONObject.quote(encodeResult(payload))})")
    }

    /** Accessibility focus landed in the chrome with the bar hidden: the bar comes back on its spring (`lib/barHide.ts` `showBar`). */
    fun barShow() {
        js("window.__zenHost&&__zenHost.barShow()")
    }

    /** Touch exploration (TalkBack) turned on or off: on, the bar that hides on scroll stays put (`lib/barHide.ts` `setBarHideTouchExploration`). */
    fun barTouchExploration(enabled: Boolean) {
        js("window.__zenHost&&__zenHost.barTouchExploration($enabled)")
    }

    /** Commit the gesture; answers whether the chrome had anything to dismiss or navigate. */
    fun backCommit(callback: (Boolean) -> Unit) {
        evaluateJavascript("window.__zenHost?__zenHost.backEvent('commit',null):false") { result -> callback(result == "true") }
    }

    /**
     * Zenium's items for the floating toolbar over `text` selected in tab `tabId` (the core's
     * `Menus.selectionToolbar`): `reply` gets the JSON text of `[{ id, title }]` in order, "[]"
     * before the core has started, null while the chrome document is still loading.
     */
    fun selectionMenu(tabId: String, text: String, reply: (String?) -> Unit) {
        if (!ready) {
            reply(null)
            return
        }
        val request = JSONObject.quote(json("text" to text).toString())
        evaluateJavascript("window.__zenHost?__zenHost.selectionMenu(${JSONObject.quote(tabId)},$request):null") { reply(it) }
    }

    fun openUrl(url: String) {
        onReady { js("window.__zenHost&&__zenHost.openUrl(${JSONObject.quote(url)})") }
    }

    /** The launcher's "New private tab" shortcut: a private tab in the current space, once the core is up. */
    fun newPrivateTab() {
        onReady { js("window.__zenHost&&__zenHost.newPrivateTab()") }
    }

    // --- the omnibox field's floating toolbar (see FieldToolbar.kt) --------------------------

    /**
     * The WebView starts the system's floating action mode over the chrome's text fields with
     * its own callback (Paste and Select all at the insertion handle; Cut, Copy, Paste, Share,
     * Select all over a selection); wrapped, so the omnibox field's carries Paste and go / Paste
     * and search after the system's Paste (OMN-23, `FieldToolbar`). The mode itself – floating
     * type, handles, position – is the system's. Anything else (a primary action mode, another
     * caller's callback) passes through untouched.
     */
    override fun startActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
        if (type != ActionMode.TYPE_FLOATING || callback !is ActionMode.Callback2) return super.startActionMode(callback, type)
        return super.startActionMode(FieldActionMode(callback), type)
    }

    /**
     * The WebView's field callback with Zenium's item added (`FieldToolbar.plan`). Which field
     * is in focus is asked of the chrome on every prepare of a menu with Paste in it
     * (`FieldToolbar.Listing`: the answer is asynchronous, so the system's items show at once
     * and ours joins within the toolbar's own entrance, the mode invalidated once the chrome has
     * said the field is the omnibox's); what the clipboard holds is read off its description on
     * the spot (`ClipboardPeek.pasteAction`, never its content). A touch on the item sends
     * `urlbar.paste` to the core and finishes the mode.
     */
    private inner class FieldActionMode(private val system: ActionMode.Callback2) : ActionMode.Callback2() {
        private var mode: ActionMode? = null
        private var finished = false
        /** The item as last planned, the one a touch acts on. */
        private var planned: FieldToolbar.Item? = null
        private val listing = FieldToolbar.Listing(
            readField = { onField -> evaluateJavascript(FieldToolbar.FIELD_SCRIPT) { raw -> onField(FieldToolbar.parseField(raw)) } },
            invalidate = { mode?.invalidate() }
        )
        private val strings by lazy {
            FieldToolbar.Strings(
                paste = context.getString(android.R.string.paste),
                pasteAndGo = context.getString(R.string.paste_and_go),
                pasteAndSearch = context.getString(R.string.paste_and_search)
            )
        }

        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            this.mode = mode
            return system.onCreateActionMode(mode, menu)
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            val prepared = system.onPrepareActionMode(mode, menu)
            menu.removeGroup(FieldToolbar.GROUP)
            val systemItems = (0 until menu.size()).map(menu::getItem)
            val plan = FieldToolbar.plan(
                systemItems.map { FieldToolbar.SystemItem(it.groupId, it.order, it.title?.toString() ?: "") },
                listing.field,
                ClipboardPeek.pasteAction(context),
                strings
            )
            Log.d(FIELD_TAG, "field mode prepared: anchored ${plan.anchored}, field ${listing.field}, item ${plan.item?.action}")
            // A menu with Paste is a field the clipboard has something for: ask which field.
            if (plan.anchored) listing.onPrepare()
            planned = plan.item
            plan.item?.let { item ->
                menu.add(FieldToolbar.GROUP, FieldToolbar.ITEM_ID, plan.order, item.title).apply {
                    setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS or MenuItem.SHOW_AS_ACTION_WITH_TEXT)
                    contentDescription = item.title
                }
            }
            return prepared || plan.item != null
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            if (item.groupId != FieldToolbar.GROUP) return system.onActionItemClicked(mode, item)
            val ours = planned ?: return true
            Log.d(FIELD_TAG, "field mode: ${ours.action} touched for ${listing.field}")
            hostEvent("urlbar.paste", FieldToolbar.action(ours.action, listing.field?.tabId))
            if (!finished) mode.finish()
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            finished = true
            listing.finish()
            this.mode = null
            Log.d(FIELD_TAG, "field mode destroyed after ${listing.asks} ask(s)")
            system.onDestroyActionMode(mode)
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            system.onGetContentRect(mode, view, outRect)
        }
    }

    private fun js(code: String) {
        if (ready) evaluateJavascript(code, null) else whenReady.add { evaluateJavascript(code, null) }
    }

    companion object {
        private const val FIELD_TAG = "ZenFieldMode"
        const val APP_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$APP_HOST"
        /** Package files by token (`extensionStoreIo.ts` PACKAGES_PATH). */
        const val PACKAGES_PATH = "/ext-packages/"
        /** Installed extension files, `<id>/<version>/<path>` (`extensionStoreIo.ts` FILES_PATH). */
        const val EXTENSION_FILES_PATH = "/ext-files/"
    }
}
