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
import android.view.Choreographer
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.FileProvider
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.ext.Extensions
import app.zen.chromium.blocking.Blocking
import app.zen.chromium.ext.ExtensionStore
import app.zen.chromium.privacy.Privacy
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
class Host(override val activity: MainActivity, private val root: FrameLayout, private val fullscreenLayer: FrameLayout) : PageHost {
    val storage = Storage(activity)
    /** The file-backed handoffs to the chrome: the big boot documents and the big fetched bodies (`BootHandoff.kt`). */
    val handoff = BootHandoff(storage, File(activity.cacheDir, BootHandoff.SPILL_DIR))
    /** The process's request engine, built from the rule sets the core persists, before any tab exists. */
    override val blocking = Blocking.shared(activity)
    /** The process's privacy host: the policy the core pushes, the Safe Browsing tables it writes. */
    override val privacy = Privacy.shared(activity)
    override val keys = Keys()
    override val permissions = Permissions(this)
    override val security = Security(this)
    override val downloads = Downloads(activity, this)
    var chrome = ChromeWebView(activity, this)
        private set
    override val tabs = TabHost(root, this)
    val agentServer = AgentServer(this)
    val updates = Updates(activity, this)
    val translate = Translate(activity, this)
    val siteData = SiteData()

    init {
        // A private session the last run did not get to end (a crash, the system killing the app)
        // ends now, before any tab exists and while its profile is free to be deleted.
        Profiles.wipePrivate(activity)
    }

    /** The launcher icon colour (one enabled `activity-alias`), driven by Settings → Look and Feel. */
    val launcherIcon = LauncherIcon(activity)
    override val pageToken: String = SecureRandom().let { r -> ByteArray(16).also(r::nextBytes).joinToString("") { "%02x".format(it) } }
    override val pageScript: String = activity.assets.open("page.js").bufferedReader().readText().replace("__ZEN_TOKEN__", pageToken)
    /** The extension runtime's Kotlin half: created before the tabs so their WebViews can attach. */
    override val extensions: Extensions = Extensions(this)
    /** The core's page-controls policy (desktop site, dark theme for sites, zoom), mirrored per navigation. */
    override var pageRules: PageRules = PageRules.NONE
        private set
    /** The same rules as the core sent them, handed to every page's document-start script. */
    override var pageRulesJson: JSONObject = JSONObject()
        private set
    private val io = Executors.newCachedThreadPool { r -> Thread(r, "zen-io") }
    private val main = Handler(Looper.getMainLooper())

    init {
        // Spilled bodies the last chrome document never released (it, or the process, went away).
        io.execute(handoff::sweep)
    }
    /** The share sheet, in both directions (after `io`: it fetches on it). */
    val share = Share(this, io)
    /** Links that leave the web: held here while the core (and the user) decide. */
    override val externalProtocols = ExternalProtocols(this)
    /** Device credential and biometric prompts, and the Keystore-wrapped password vault key. */
    val reauth = Reauth(activity)
    val vault = VaultKeystore(activity, reauth, io, main)
    /** The extension store's files and downloads (installs live under `files/zen/extensions`). */
    val extStore = ExtensionStore(this, io, main)
    /** Home-screen shortcuts; the launcher's confirmations reach it through `ShortcutPinnedReceiver`. */
    val shortcuts = Shortcuts(activity, io)
    /** Voice search: the device's speech recogniser behind the chrome's mic buttons (OMN-19). */
    val voice = Voice(this)
    override var fullscreenTab: TabWebView? = null
        private set
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    override var immersive = false
        private set
    /** The chrome's colour scheme, so native pieces (the back preview) match it. */
    override var themeDark = false
        private set
    /** The chrome's `--zen-scrim` token (ARGB): the space-tinted dim under its sheets. */
    override var themeScrim = parseColor(DEFAULT_SCRIM)
        private set
    /** Settings → Look and Feel → Pull to refresh, mirrored by the chrome (on until it says otherwise). */
    override var pullToRefresh = true
        private set
    /** The core's word on the pages' forms script (`view.forms` config), kept for new documents. */
    override var formsEnabled = true
        private set
    /** Settings → Passwords → autofill provider, applied to every page WebView (`autofill.setProvider`). */
    override var autofillProvider = SystemAutofill.PROVIDER_SYSTEM
        private set
    /** Previews of the pages a back gesture would return to. */
    override val snapshots = HistorySnapshots(activity)
    /** The tab cards' pictures, one JPEG per tab under the cache dir (`thumbnail.*`, [TabWebView.captureThumbnail]). */
    override val thumbnails = Thumbnails(File(activity.cacheDir, Thumbnails.DIR))
    /**
     * Page views go behind the chrome no earlier than with the chrome's next drawn frame, and the
     * chrome hears when the frame carrying each change is on screen (`view.drawn`, [reportDrawn]).
     */
    private val pageVisibility = PageVisibility { tabId, visible, change ->
        tabs.setVisible(tabId, visible)
        reportDrawn(tabId, visible, change)
    }
    /** Last: it reads the tabs and fullscreen state above when it decides what back would do. */
    val back = PredictiveBack(activity, this, chrome = { chrome }, onLeave = { activity.moveTaskToBack(true) })
    val lifecycle = HostLifecycle()

    // --- what the pages report into (PageHost): all of it goes to the core in the chrome ------------

    override fun viewEvent(tabId: String, name: String, payload: Any?) = chrome.viewEvent(tabId, name, payload)
    override fun hostEvent(name: String, payload: Any?) = chrome.hostEvent(name, payload)
    override fun onKey(tabId: String?, input: JSONObject) = chrome.onKey(tabId, input)
    override fun pullEvent(tabId: String, phase: String, payload: JSONObject?) = chrome.pullEvent(tabId, phase, payload)
    override fun selectionMenu(tabId: String, text: String, reply: (String?) -> Unit) = chrome.selectionMenu(tabId, text, reply)
    override fun progress(tabId: String, percent: Int) = chrome.viewEvent(tabId, "progress", json("progress" to percent / 100.0))
    override val underlay: View get() = chrome
    override fun backChanged() = back.refresh()
    override fun onPageTransitionEnded(transition: PageBackTransition) = back.onPageTransitionEnded(transition)

    // ---------------------------------------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------------------------------------

    /** Synchronous methods (bridge thread!). Only cheap, thread-safe work belongs here. */
    fun dispatchSync(method: String, args: JSONObject): Any? = when (method) {
        "boot" -> {
            // The core's documents: the small ones inline, the big ones listed for the chrome to
            // fetch through the document handler (`BootHandoff.kt`, `src/android/handoff.ts`).
            val documents = storage.bootDocuments(BootHandoff.BOOT_INLINE_LIMIT)
            json(
                "version" to BuildConfig.VERSION_NAME,
                // The OS release decides a few capabilities (the clipboard chip, the share sheet's row).
                "sdkInt" to Build.VERSION.SDK_INT,
                "signer" to Updates.signerSha256(activity),
                // The applicationId; a release whose APK carries another one installs as a new app.
                "packageName" to activity.packageName,
                // Multi-profile WebView: what makes a private tab private (and containers separate).
                "profiles" to Profiles.supported,
                "appIcon" to launcherIcon.current(),
                "files" to documents.files,
                "deferred" to documents.deferred,
                "downloadsDir" to (Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)?.absolutePath ?: ""),
                // Where the extension store installs; its presence turns the extensions capability on.
                "extensionsRoot" to extStore.root.absolutePath,
                // Whether content scripts get real isolated worlds (decided once, when the runtime was built).
                "isolatedWorlds" to extensions.isolatedWorlds,
                "insets" to activity.currentInsets(),
                "fullscreen" to immersive,
                "environment" to activity.environment(),
                "pinShortcuts" to shortcuts.supported,
                // A speech recogniser on the device: the mic buttons show (voice search, OMN-19).
                "voiceSearch" to voice.available
            )
        }
        // Answers `true` once the file is replaced; a failure throws, which the bridge reports as
        // no answer, and the chrome keeps its mirror as it was (`AndroidStoreIO.writeSync`).
        "storage.writeSync" -> {
            storage.writeSync(args.str("name"), args.str("text"), args.bool("backup"))
            true
        }
        // Documents outside the boot payload (the rule-set files under blocking/), and a boot
        // document the core reads before its fetched file has arrived.
        "storage.read" -> storage.read(args.str("name"))
        "storage.exists" -> storage.exists(args.str("name"))
        else -> throw IllegalArgumentException("Unknown sync method: $method")
    }

    /** Asynchronous methods (main thread). Call `reply` exactly once. */
    fun dispatch(method: String, args: JSONObject, reply: (Any?) -> Unit) {
        val tabId = args.strOrNull("tabId")
        val tab = tabId?.let { tabs.get(it) }
        when (method) {
            // A write that failed rejects the call: the chrome must not remember it as made.
            "storage.write" -> storage.write(args.str("name"), args.str("text"), args.bool("backup")) { failure ->
                main.post { reply(if (failure == null) null else Rejection(failure.message ?: failure.javaClass.simpleName)) }
            }
            "storage.remove" -> storage.remove(args.str("name")) { main.post { reply(null) } }

            // --- request blocking (the BlockingHost contract and diagnostics) ----------------------
            "blocking.bundled" -> reply(blocking.bundledLists())
            "blocking.install" -> blocking.installBundled(args.obj("set"), args.str("file")) { main.post { reply(it) } }
            "blocking.stats" -> reply(blocking.stats())

            // --- privacy (the PrivacyHost contract) ----------------------------------------------
            "privacy.apply" -> {
                privacy.apply(args.obj("flags"))
                for (view in tabs.all()) view.applyPrivacy()
                reply(null)
            }
            "privacy.bundledFeed" -> reply(privacy.bundledFeed(args.str("id")))

            // --- tab card thumbnails (the ThumbnailHost contract; `Thumbnails.kt` is the file layer) ---
            "thumbnail.configure" -> { thumbnails.width = args.num("width").toInt(); reply(null) }
            // A read per card the chrome shows, off the main thread; the file's bytes go over as a
            // data URL with their size, so the chrome can count them against its budget.
            "thumbnail.load" -> io.execute {
                val picture = thumbnails.loadPicture(args.str("tabId"))
                main.post { reply(picture?.let { json("data" to it.dataUrl, "width" to it.width, "height" to it.height) }) }
            }
            "thumbnail.drop" -> { io.execute { thumbnails.drop(args.str("tabId")) }; reply(null) }
            "thumbnail.sweep" -> {
                val keep = args.arr("keep").let { ids -> (0 until ids.length()).mapTo(HashSet()) { ids.optString(it) } }
                io.execute { thumbnails.sweep(keep) }
                reply(null)
            }

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
            "view.setDesktopMode" -> { tab?.setDesktopMode(args.bool("on")); reply(null) }
            "view.setDarkening" -> { tab?.setDarkening(args.bool("on")); reply(null) }
            "view.setPageRules" -> { setPageRules(args); reply(null) }
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
            "view.forms" -> {
                val command = args.obj("command")
                // The on/off configuration is the same for every page: remember it for the next document.
                if (command.str("type") == "config") formsEnabled = command.bool("enabled", true)
                tab?.sendForms(command)
                reply(null)
            }
            "view.setPopupsAllowed" -> { tab?.setPopupsAllowed(args.bool("allowed")); reply(null) }
            "view.postMessage" -> { tab?.postToPage(args.obj("message").toString()); reply(null) }
            "view.setBackground" -> {
                tab?.setBackgroundColor(parseColor(args.str("color", "#ffffff")))
                reply(null)
            }
            "view.focus" -> { tab?.requestFocus(); reply(null) }
            "view.setBounds" -> { tabs.setBounds(args.str("tabId"), args.obj("rect")); reply(null) }
            "view.setRadius" -> { tabs.setRadius(args.str("tabId"), args.num("radius")); reply(null) }
            "view.setPullOffset" -> { tab?.setPullOffset(args.num("offset")); reply(null) }
            "view.setCover" -> { tabs.setCover(args.str("tabId"), args.obj("cover")); reply(null) }
            "view.setVisible" -> { setTabVisible(args.str("tabId"), args.bool("visible")); reply(null) }
            "view.bringToFront" -> { tabs.bringToFront(args.str("tabId")); reply(null) }
            "view.download" -> {
                if (tab != null) downloads.start(args.str("url"), tab.settings.userAgentString, null, null, -1, tab.tabId)
                reply(null)
            }
            "view.print" -> { tab?.let(::print); reply(null) }
            "view.savePage" -> if (tab == null) reply(null) else savePage(tab, args.str("name"), reply)
            "view.snapshot" -> if (tab == null) reply(null) else tab.snapshot(reply)
            "view.screenshot" -> if (tab == null) reply(null) else tab.screenshot { png -> saveToDownloads(args.str("name"), "image/png", png, reply) }
            "view.capture" -> if (tab == null) reply(null) else tab.capture(args.str("mode", "viewport"), args.optJSONObject("region"), args.str("format", "jpeg"), args.optInt("quality", -1), reply)
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
            "chrome.setTheme" -> { applyTheme(args.bool("dark"), args.str("scheme", "system"), args.str("background"), args.str("scrim")); reply(null) }
            "chrome.setPullToRefresh" -> {
                pullToRefresh = args.bool("enabled", true)
                for (view in tabs.all()) view.applyPullToRefreshMode()
                reply(null)
            }
            "back.update" -> { back.update(args.bool("chrome"), args.strOrNull("tabId"), args.optBoolean("root")); reply(null) }
            "window.setFullscreen" -> { setImmersive(args.bool("fullscreen")); reply(null) }
            "app.quit" -> { activity.finishAndRemoveTask(); reply(null) }
            "app.background" -> { activity.moveTaskToBack(true); reply(null) }
            "app.openExternal" -> { openExternal(args.str("url")); reply(null) }
            "app.openPath" -> { downloads.open(args.str("path"), ""); reply(null) }
            "app.setIcon" -> { launcherIcon.apply(args.str("id"), activity); reply(null) }
            "app.share" -> share.share(args, reply)
            "app.openAppLinkSettings" -> { openAppLinkSettings(); reply(null) }
            "app.openPrivateDnsSettings" -> { openPrivateDnsSettings(); reply(null) }
            "externalProtocol.respond" -> { externalProtocols.respond(args.str("requestId"), args.bool("allow")); reply(null) }
            "app.isDefaultBrowser" -> reply(DefaultBrowser.isDefault(activity))
            "app.requestDefaultBrowser" -> activity.requestDefaultBrowser(reply)
            "keys.setShortcuts" -> { keys.setShortcuts(args.arr("bindings")); reply(null) }

            // --- services --------------------------------------------------------------------------
            "dialog.confirm" -> confirm(args, reply)
            "dialog.openText" -> activity.pickTextFiles(args.arr("extensions")) { files -> reply(files) }
            "dialog.saveText" -> activity.saveTextFile(args.str("defaultName"), args.str("mimeType"), args.str("text")) { ok -> reply(ok) }

            // --- passwords: vault key protection and re-authentication ---------------------------
            "vault.available" -> io.execute { val ok = vault.available(); main.post { reply(ok) } }
            "vault.wrap" -> vault.wrap(args.str("key"), reply)
            "vault.unwrap" -> vault.unwrap(args.str("blob"), args.bool("interactive"), reply)
            "reauth.available" -> reply(reauth.available())
            "reauth.verify" -> reauth.authenticate(args.str("reason"), strong = false) { ok -> reply(ok) }
            "clipboard.writeText" -> {
                SecretClipboard.write(activity, args.str("text"), args.bool("sensitive"))
                reply(null)
            }
            "clipboard.clearText" -> reply(SecretClipboard.clear(activity, args.str("expected")))
            "clipboard.writeImage" -> copyImage(args.str("url"), reply)

            // --- autofill: the system framework's status, and which provider owns the pages -----------
            "autofill.status" -> reply(SystemAutofill.status(activity))
            "autofill.setProvider" -> {
                autofillProvider = SystemAutofill.provider(args.strOrNull("provider"))
                for (view in tabs.all()) view.applyAutofillProvider()
                reply(null)
            }
            "net.fetch" -> fetchText(args.str("url"), args.obj("headers"), args.num("timeoutMs").toInt(), reply)
            // The chrome has read a spilled body (`BootHandoff.readBody`): its file goes.
            "net.release" -> { io.execute { handoff.release(args.str("token")) }; reply(null) }
            "download.bind" -> { downloads.bind(args.str("token"), args.str("id"), args.obj("destination"), args.bool("private")); reply(null) }
            "download.cancel" -> { downloads.cancel(args.str("id")); reply(null) }
            "download.pause" -> { downloads.pause(args.str("id")); reply(null) }
            "download.resume" -> { downloads.resume(args); reply(null) }
            "download.retry" -> { downloads.retry(args); reply(null) }
            "download.release" -> downloads.release(args, reply)
            "download.discard" -> downloads.discard(args, reply)
            "download.exists" -> downloads.exists(args.str("savePath"), reply)
            "download.deleteFile" -> downloads.deleteFile(args.str("savePath"), reply)
            "download.chooseDirectory" -> downloads.chooseDirectory(reply)
            "download.open" -> { downloads.open(args.str("savePath"), args.str("mimeType")); reply(null) }
            "download.showAll" -> { downloads.showAll(); reply(null) }
            "profile.clear" -> {
                security.forgetCertificates(args.str("containerId"))
                Profiles.clear(activity, args.str("containerId")) { reply(null) }
            }
            // Clear browsing data: the engine's kinds (cookies, storage, cache) per container, and the
            // preview's counts. A live tab of a container clears its cache; otherwise a throwaway view.
            "profile.clearBrowsingData" -> {
                val containerIds = BrowsingData.strings(args.arr("containerIds"))
                val kinds = BrowsingData.strings(args.arr("kinds")).toSet()
                // Certificate decisions go with the cookies, as the core's do.
                if ("cookies" in kinds) containerIds.forEach(security::forgetCertificates)
                BrowsingData.clear(
                    activity,
                    containerIds,
                    kinds,
                    { containerId -> tabs.all().firstOrNull { it.containerId == containerId } }
                ) { reply(null) }
            }
            "profile.browsingDataCounts" -> BrowsingData.counts(BrowsingData.strings(args.arr("containerIds"))) { reply(it) }
            "permission.respond" -> { permissions.respond(args.str("requestId"), args.bool("allow")); reply(null) }
            "auth.respond" -> {
                security.respondAuth(args.str("requestId"), args.strOrNull("username"), args.strOrNull("password"))
                reply(null)
            }
            "security.forgetSession" -> { security.forgetSession(); reply(null) }
            "security.allowCertificate" -> {
                security.allowCertificate(args.str("containerId"), args.str("url"), args.str("fingerprint"))
                reply(null)
            }
            "shortcut.pin" -> shortcuts.pin(args, reply)

            // --- voice search (Voice.kt; the contract is `VoiceHost` in src/core/platform.ts) ----------
            "voice.start" -> voice.start(reply)
            "voice.cancel" -> { voice.cancel(); reply(null) }
            "voice.openSettings" -> { voice.openSettings(); reply(null) }

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

            // --- extension store (ext/ExtensionStore.kt; the contract is src/android/extensionStoreIo.ts).
            //     The runtime that runs extensions has its own methods, in its own block. -------------
            "extStore.fetch" -> extStore.fetch(args.str("url"), args.num("maxBytes").toLong(), reply)
            "extStore.unpack" -> extStore.unpack(args, reply)
            "extStore.discard" -> { extStore.discard(args.str("token")); reply(null) }
            "extStore.remove" -> extStore.remove(args.str("id"), reply)
            "extStore.prune" -> extStore.prune(args.str("id"), args.str("keep"), reply)
            "extStore.sweep" -> extStore.sweep(reply)
            "extStore.pick" -> extStore.pick(reply)
            "extStore.takeSideloads" -> reply(extStore.takeSideloads())
            // --- end of the extension store block -------------------------------------------------------

            // --- page translation models ----------------------------------------------------------
            "translate.list" -> translate.list(reply)
            "translate.download" -> translate.download(
                args.str("token"), args.str("url"), args.str("name"), args.num("size").toLong(), args.str("sha256"), reply
            )
            "translate.cancel" -> { translate.cancel(args.str("token")); reply(null) }
            "translate.delete" -> translate.delete(args.arr("names"), reply)

            // The extension runtime's methods (ext/Extensions.kt; the contract is src/android/extensionRuntime.ts).
            else -> if (method.startsWith("ext.")) extensions.handle(method, args, reply) else throw IllegalArgumentException("Unknown method: $method")
        }
    }

    /**
     * Keep a WebView alive without showing it (extension background pages). It sits behind the
     * chrome at one pixel: a view that is not attached, or invisible, counts as hidden to the
     * renderer and gets background timer throttling, which a background page must not.
     */
    fun attachHidden(view: View) {
        root.addView(view, 0, FrameLayout.LayoutParams(1, 1))
    }

    fun detachHidden(view: View) {
        root.removeView(view)
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

    override fun enterFullscreen(tab: TabWebView, view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenTab != null) exitFullscreen(fullscreenTab!!)
        fullscreenTab = tab
        fullscreenCallback = callback
        fullscreenLayer.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        fullscreenLayer.visibility = View.VISIBLE
        setSystemBarsHidden(true)
        chrome.viewEvent(tab.tabId, "enterFullscreen", null)
        back.refresh()
    }

    override fun exitFullscreen(tab: TabWebView) {
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

    /**
     * The window left the screen (launcher, another app, the lock screen). Fullscreen is a way of
     * looking at a page, not a setting: the app comes back with its bars, like Chrome does, rather
     * than in the fullscreen it was left in – a relaunch from the launcher is a new start to the
     * user, whether or not the process survived.
     */
    fun onStop() {
        if (immersive) setImmersive(false)
        // A recogniser listening to a screen that is gone: the session ends, the sheet with it.
        voice.abort()
    }

    /** Back while in Zenium's own fullscreen (and nothing is fullscreen on the page) leaves it. */
    override fun leaveImmersive() = setImmersive(false)

    private fun setImmersive(on: Boolean) {
        if (immersive == on) return
        immersive = on
        setSystemBarsHidden(on || fullscreenTab != null)
        chrome.hostEvent("fullscreen", json("fullscreen" to on))
        back.refresh()
    }

    private fun setSystemBarsHidden(hidden: Boolean) {
        val controller = WindowInsetsControllerCompat(activity.window, root)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hidden) controller.hide(WindowInsetsCompat.Type.systemBars()) else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    // ---------------------------------------------------------------------------------------------
    // Services
    // ---------------------------------------------------------------------------------------------

    override fun openExternal(url: String) {
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

    /**
     * Android's Private DNS setting (encrypted DNS for every app, Android 9+) lives in the
     * Network & internet screen; there is no intent for the row itself. The main Settings screen
     * is the fallback on devices that lack even that action.
     */
    private fun openPrivateDnsSettings() {
        for (action in listOf(Settings.ACTION_WIRELESS_SETTINGS, Settings.ACTION_SETTINGS)) {
            try {
                activity.startActivity(Intent(action))
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

    private fun applyTheme(dark: Boolean, scheme: String, background: String, scrim: String) {
        themeDark = dark
        if (scrim.isNotEmpty()) themeScrim = parseColor(scrim)
        val color = parseColor(background.ifEmpty { if (dark) "#16161b" else "#f2f1f5" })
        root.setBackgroundColor(color)
        activity.window.decorView.setBackgroundColor(color)
        val controller = WindowInsetsControllerCompat(activity.window, root)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
        // Pages see Zenium's colour scheme, not only the system's: the app's night mode drives
        // `prefers-color-scheme` and the algorithmic darkening in every page WebView (the manifest
        // handles `uiMode` in place, so nothing reloads).
        val night = when (scheme) {
            "dark" -> AppCompatDelegate.MODE_NIGHT_YES
            "light" -> AppCompatDelegate.MODE_NIGHT_NO
            else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        }
        if (AppCompatDelegate.getDefaultNightMode() != night) AppCompatDelegate.setDefaultNightMode(night)
    }

    /** The core's page-controls policy: every tab re-registers its document-start script. */
    private fun setPageRules(rules: JSONObject) {
        pageRulesJson = rules
        pageRules = PageRules.fromJson(rules)
        for (tab in tabs.all()) tab.onPageRulesChanged()
    }

    private fun print(tab: TabWebView) {
        val manager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
        val name = tab.title?.ifEmpty { null } ?: "Zenium page"
        // Through PrintRelay: the WebView's PDF write must never wait on the spooler (BH-01).
        val adapter = PrintRelay(tab.createPrintDocumentAdapter(name), File(activity.cacheDir, "print"), io)
        manager.print(name, adapter, PrintAttributes.Builder().build())
    }

    private fun savePage(tab: TabWebView, name: String, reply: (Any?) -> Unit) {
        val dir = File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir, "").apply { mkdirs() }
        val base = name.removeSuffix(".html").removeSuffix(".htm")
        var file = File(dir, "$base.mht")
        var n = 1
        while (file.exists()) file = File(dir, "$base(${n++}).mht")
        tab.saveWebArchive(file.absolutePath, false) { path -> reply(path) }
    }

    /**
     * Store bytes as a file in the public Downloads collection; resolves with the file's path. The
     * core names the download after the last segment of what it gets back, so the path it is –
     * the MediaStore row's URI ends in the row's id, and a screenshot listed as "1000000025" was
     * that id. `Downloads.open` finds the row again from the path.
     */
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
                    pathOf(uri) ?: uri.toString()
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

    /**
     * Where MediaStore put the file behind one of its Downloads rows: its `DATA` column (still
     * filled in on Q+, where the row may have renamed the file to keep names unique), or the
     * display name under the public Downloads folder; null when the row says neither.
     */
    @Suppress("DEPRECATION") // DATA, see above
    private fun pathOf(uri: Uri): String? = runCatching {
        val columns = arrayOf(MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.DISPLAY_NAME)
        activity.contentResolver.query(uri, columns, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return@use null
            c.getString(0)?.takeIf { it.isNotEmpty() }
                ?: c.getString(1)?.takeIf { it.isNotEmpty() }?.let { name ->
                    File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name).absolutePath
                }
        }
    }.getOrNull()

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

    /**
     * `timeoutMs` ≤ 0 keeps the short default meant for suggestions and Live Folders. A body
     * over `BootHandoff.NET_INLINE_LIMIT` is not answered inline (JSON-quoted into a script the
     * chrome's main thread parses) but spilled to a file the chrome fetches by token
     * (`body: {token, bytes}`; `fetchText` in `src/android/platform.ts` reads it and releases it).
     */
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
                val body = if (ok) conn.inputStream.use { handoff.readBody(it) } else BootHandoff.Body.Inline("")
                // The validators a later conditional fetch sends back (`If-None-Match`, `If-Modified-Since`).
                val responseHeaders = JSONObject()
                conn.getHeaderField("ETag")?.let { responseHeaders.put("etag", it) }
                conn.getHeaderField("Last-Modified")?.let { responseHeaders.put("last-modified", it) }
                val result = json("ok" to ok, "status" to status, "headers" to responseHeaders)
                when (body) {
                    is BootHandoff.Body.Inline -> result.put("text", body.text)
                    is BootHandoff.Body.Spilled -> result.put("text", "").put("body", json("token" to body.token, "bytes" to body.bytes))
                }
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

    /**
     * Leaving the foreground: a probe answered while hidden would only mislead. The pages on
     * screen have their card pictures taken while the window still shows them – the tab the app
     * comes back to in the overview, or is restored with, is the one it was left on.
     */
    fun onPause() {
        cancelProbe()
        for (tab in tabs.all()) tab.captureThumbnail()
    }

    /** Ask every WebView on screen for a fresh frame at its current size. */
    fun repaint() {
        root.requestLayout()
        chrome.invalidate()
        for (tab in tabs.all()) if (tab.visibility == View.VISIBLE) tab.invalidate()
    }

    /**
     * `view.setVisible`: a show happens now; a hide waits for the chrome to draw the frame that
     * carries the layout it was reported from – the chrome lies under the pages, and that frame
     * holds the page's stand-in picture – or for [PageVisibility.DEADLINE_MS] (see [PageVisibility]).
     */
    private fun setTabVisible(tabId: String, visible: Boolean) {
        val ticket = pageVisibility.request(tabId, visible) ?: return
        // A page on its way off the screen has its card picture taken while it is still there. The
        // chrome may have just captured its cover for the same frame: the copy is shared, and a
        // fresh cover stands as the picture ([TabWebView.captureThumbnail]).
        tabs.get(tabId)?.captureThumbnail()
        val deadline = Runnable {
            if (pageVisibility.complete(ticket)) Log.d(TAG, "hide of $tabId: chrome drew no frame within the deadline")
        }
        main.postDelayed(deadline, PageVisibility.DEADLINE_MS)
        chrome.postVisualStateCallback(ticket.id, object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) {
                if (pageVisibility.complete(ticket)) main.removeCallbacks(deadline)
            }
        })
    }

    /**
     * Tell the chrome once the frame carrying `change` – `tabId`'s view now `visible` or gone – is
     * on screen (`view.drawn`; the renderer's `lib/pageView.ts` times the swap between the live page
     * and its picture from it). A visibility change takes effect with the next traversal, which
     * runs after the frame callbacks of that frame, so the second frame callback from here is the
     * first to run with the frame submitted. A view coming back must have content to draw in that
     * frame: its own visual-state callback says when it has (the next draw after it reflects the
     * page), and the frames are counted from there. A renderer that never answers (gone, or the
     * window on its way out) is not waited on past [PageVisibility.DRAWN_DEADLINE_MS]; the change
     * is reported once whichever comes first, and not at all when a newer change to the same tab
     * has overtaken it – that one's frame is the one that matters.
     */
    private fun reportDrawn(tabId: String, visible: Boolean, change: Long) {
        val report = Runnable {
            if (pageVisibility.drawn(tabId, change)) chrome.hostEvent("view.drawn", json("tabId" to tabId, "visible" to visible))
        }
        main.postDelayed(report, PageVisibility.DRAWN_DEADLINE_MS)
        val onFrame = {
            afterFrames(2) {
                main.removeCallbacks(report)
                report.run()
            }
        }
        val view = if (visible) tabs.get(tabId) else null
        if (view == null) {
            onFrame()
            return
        }
        view.postVisualStateCallback(change, object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) = onFrame()
        })
    }

    /** Run `then` at the start of the `count`-th frame from now. */
    private fun afterFrames(count: Int, then: () -> Unit) {
        val choreographer = Choreographer.getInstance()
        var left = count
        choreographer.postFrameCallback(object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                if (--left <= 0) then() else choreographer.postFrameCallback(this)
            }
        })
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
        // The old core's unread spilled bodies went with its document.
        io.execute(handoff::sweep)
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
        // Spilled bodies the dead chrome never released would otherwise stay for the process lifetime.
        io.execute(handoff::sweep)
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
        extensions.destroy()
        cancelProbe()
        voice.destroy()
        shortcuts.destroy()
        agentServer.stop()
        downloads.destroy()
        updates.shutdown()
        security.shutdown()
        translate.shutdown()
        tabs.destroyAll()
        // Not the request engine: it is the process's, and a custom tab may still be using it.
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
