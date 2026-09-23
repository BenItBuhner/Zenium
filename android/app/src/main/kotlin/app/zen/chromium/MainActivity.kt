package app.zen.chromium

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import app.zen.chromium.ext.ExtensionNotifications
import app.zen.chromium.ext.ExtensionStore
import org.json.JSONArray
import org.json.JSONObject

/**
 * The one window of the browser. A FrameLayout holds the chrome WebView at the bottom, tab
 * WebViews above it, and a topmost layer for HTML fullscreen. Rotation, DeX resizing and keyboard
 * changes are handled in place (see `configChanges` in the manifest) so no page ever reloads.
 */
class MainActivity : BrowserActivity() {
    private lateinit var root: FrameLayout
    private lateinit var fullscreenLayer: FrameLayout
    lateinit var host: Host
        private set
    /**
     * The insets as last told to the chrome (CSS px), zeros until the window's first dispatch:
     * the boot payload carries them ([currentInsets]), and a chrome booting ahead of that
     * dispatch must read four numbers, not an empty object.
     */
    private var insets = json("top" to 0.0, "right" to 0.0, "bottom" to 0.0, "left" to 0.0)
    private var latestInsets: WindowInsetsCompat? = null
    /** The keyboard is animating for the chrome; its frames are streamed as insets. */
    private var imeAnimating = false
    private var textFilesCallback: ((JSONArray) -> Unit)? = null
    /** The byte cap of the text-file pick in flight (`TextFiles.capFor`). */
    private var textFilesCap: Long = TextFiles.DEFAULT_CAP_BYTES
    private var saveTextCallback: ((Boolean) -> Unit)? = null
    private var saveTextContent: String = ""

    private val textFileSaver = registerForActivityResult(CreateTextDocument()) { uri ->
        val callback = saveTextCallback ?: return@registerForActivityResult
        saveTextCallback = null
        val text = saveTextContent
        saveTextContent = ""
        if (uri == null) {
            callback(false)
            return@registerForActivityResult
        }
        val written = runCatching {
            contentResolver.openOutputStream(uri, "wt")?.bufferedWriter()?.use { it.write(text) } != null
        }.getOrDefault(false)
        callback(written)
    }

    private val textFilePicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val callback = textFilesCallback ?: return@registerForActivityResult
        textFilesCallback = null
        val cap = textFilesCap
        textFilesCap = TextFiles.DEFAULT_CAP_BYTES
        val files = JSONArray()
        for (uri in uris) {
            // A document over the cap is left out (the read stops at the cap, nothing is held whole).
            val text = runCatching {
                contentResolver.openInputStream(uri)?.use { TextFiles.readCapped(it, cap) }
            }.getOrNull() ?: continue
            files.put(json("name" to displayNameOf(uri), "text" to text))
        }
        callback(files)
    }

    private var packageCallback: ((Uri?) -> Unit)? = null
    private val packagePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val callback = packageCallback ?: return@registerForActivityResult
        packageCallback = null
        callback(uri)
    }

    private var chooserCallback: (() -> Unit)? = null
    /** A share sheet started for its return (`Share.Outcome`): the result code says nothing, the return itself does. */
    private val chooserRequest = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { _ ->
        val callback = chooserCallback ?: return@registerForActivityResult
        chooserCallback = null
        callback()
    }

    private var defaultBrowserCallback: ((Any?) -> Unit)? = null
    private val defaultBrowserRequest = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { _ ->
        val callback = defaultBrowserCallback ?: return@registerForActivityResult
        defaultBrowserCallback = null
        // Result codes differ between the role dialog and the settings screen (and OEMs): the
        // role itself is the answer either way.
        callback(DefaultBrowser.isDefault(this))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        root = FrameLayout(this)
        fullscreenLayer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        host = Host(this, root, fullscreenLayer)
        root.addView(host.chrome, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val shell = FrameLayout(this)
        shell.addView(root, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        // Above the root, so the pages appended to it later never cover the bubble; under the
        // fullscreen layer, which takes the whole screen when it shows.
        shell.addView(host.historyNavBubble, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        shell.addView(fullscreenLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(shell)

        ViewCompat.setOnApplyWindowInsetsListener(shell) { _, windowInsets ->
            latestInsets = windowInsets
            // The end state arrives before the keyboard starts moving; while its animation is
            // being streamed to the chrome the per-frame values below take over instead.
            if (!imeAnimating) applyInsets(windowInsets)
            WindowInsetsCompat.CONSUMED
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val stop = WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP
            ViewCompat.setWindowInsetsAnimationCallback(shell, object : WindowInsetsAnimationCompat.Callback(stop) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    // Only the chrome's own inputs (the address bar) ride the keyboard frame by
                    // frame; a page input would relayout its WebView on every frame instead.
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0 && host.chrome.hasFocus()) imeAnimating = true
                }

                override fun onProgress(insets: WindowInsetsCompat, running: List<WindowInsetsAnimationCompat>): WindowInsetsCompat {
                    if (imeAnimating) applyInsets(insets)
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (!imeAnimating || animation.typeMask and WindowInsetsCompat.Type.ime() == 0) return
                    imeAnimating = false
                    latestInsets?.let(::applyInsets)
                }
            })
        }

        // Back is the host's PredictiveBack: it registers itself only while there is something to
        // pop, so an empty stack leaves the system's own back-to-home animation alone.
        host.chrome.load()
        handleIntent(intent)
    }

    fun currentInsets(): JSONObject = insets

    /**
     * What the page controls need to know about the device (`PageEnvironment` in the core): a
     * large screen or a keyboard and mouse make "desktop site" the automatic default, and the
     * system font scale can be folded into the default zoom. The chrome's own text follows the
     * same setting: `textZoom` is the factor its WebView draws text at (`ChromeTextScale`; the
     * chrome grows its line boxes by it) and `fontWeightAdjustment` the bold-text setting.
     */
    fun environment(): JSONObject {
        val c = resources.configuration
        val keyboard = c.keyboard != Configuration.KEYBOARD_NOKEYS && c.hardKeyboardHidden != Configuration.HARDKEYBOARDHIDDEN_YES
        val mouse = InputDevice.getDeviceIds().any { id ->
            val device = InputDevice.getDevice(id)
            device != null && !device.isVirtual && device.supportsSource(InputDevice.SOURCE_MOUSE)
        }
        return json(
            "largeScreen" to largeScreen(),
            "pointerAndKeyboard" to (keyboard && mouse),
            "fontScale" to c.fontScale.toDouble(),
            "textZoom" to ChromeTextScale.zoomFactor(ChromeTextScale.textZoomPercent(resources)),
            "fontWeightAdjustment" to ChromeTextScale.fontWeightAdjustment(c)
        )
    }

    /**
     * Whether the screen is large ([ScreenClass]: 600 dp or more on its short side, the tablet
     * line): the page controls' desktop default reads it ([environment]), and rotate-to-fullscreen's
     * gate reads the same configuration's other face ([Host.rotateToFullscreen],
     * [ScreenClass.rotateToFullscreen]). Read live from the activity's configuration, which is the
     * display's through split screen (from Android 11 a split task inherits the display's
     * `smallestScreenWidthDp`) and the window's through a fold or a floating window: a fold opened or
     * a desktop window widened moves the class, a split does not – Chrome's own `sw600dp` gate reads
     * the same way.
     */
    fun largeScreen(): Boolean = ScreenClass.large(resources.configuration.smallestScreenWidthDp)

    /**
     * Tell the chrome how far the status bar, cutout, gesture bar and keyboard reach in CSS px,
     * and whether the bars are still on their way back from a page's fullscreen (`settling`,
     * [FullscreenLanding]): the chrome holds its return fade while they are.
     */
    private fun applyInsets(windowInsets: WindowInsetsCompat) {
        val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
        // The system's navigation mode rides the same insets: a gesture-mode window has a
        // `systemGestures` inset down each side, a three-button one has none (GN-04).
        host.navigationModeFromInsets(windowInsets.getInsets(WindowInsetsCompat.Type.systemGestures()).left)
        val d = resources.displayMetrics.density
        insets = json(
            "top" to bars.top / d,
            "right" to bars.right / d,
            "bottom" to maxOf(bars.bottom, ime.bottom) / d,
            "left" to bars.left / d
        )
        sendInsets()
    }

    /** The insets as last measured, with the landing's word as it stands now; judged again when the landing asks. */
    private fun sendInsets() {
        val now = SystemClock.uptimeMillis()
        val wasSettling = host.landing.settling
        val settling = host.landing.settle(landingWindow(), now)
        // The bars settled: the frames the tab host held back for the landing – the chrome's
        // layouts for the screen the exit turned away from (BH-32) – are applied or dropped.
        if (wasSettling && !settling) host.tabs.landed()
        val payload = JSONObject(insets.toString()).put("settling", settling)
        host.chrome.hostEvent("insets", payload)
        root.removeCallbacks(landingCheck)
        val at = host.landing.nextCheckAt()
        if (at >= 0) root.postDelayed(landingCheck, (at - now).coerceAtLeast(0))
    }

    private val landingCheck = Runnable { sendInsets() }

    /** The window as the chrome is told it: its insets, on the screen they were measured for. */
    fun landingWindow(): FullscreenLanding.Window {
        val c = resources.configuration
        return FullscreenLanding.Window(
            insets.optDouble("top", 0.0),
            insets.optDouble("right", 0.0),
            insets.optDouble("bottom", 0.0),
            insets.optDouble("left", 0.0),
            c.screenWidthDp,
            c.screenHeightDp
        )
    }

    /**
     * A page's fullscreen ends ([Host.exitFullscreen]): the chrome hears that the bars are on
     * their way back before it hears of the exit itself, so its first inline layout is not
     * mistaken for the landing.
     */
    fun onFullscreenExit() {
        host.landing.onExit(SystemClock.uptimeMillis())
        sendInsets()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            // A .crx or .zip opened with or shared to Zenium installs as an extension.
            Intent.ACTION_VIEW, Intent.ACTION_SEND -> if (host.extStore.sideload(intent)) {
                intent.action = null
                return
            }
        }
        when (intent.action) {
            Intent.ACTION_VIEW -> when {
                // Another app's CustomTabsIntent aimed at this activity directly (links normally
                // arrive through LinkDispatchActivity, which keeps the custom tab in the caller's
                // task): render it as a custom tab, never as a tab of this window.
                CustomTabIntents.isCustomTab(intent) -> startActivity(CustomTabIntents.toCustomTabActivity(this, intent))
                // "Open in Zenium" from a custom tab: the live page arrives as a WebView to adopt.
                intent.hasExtra(TabHandoff.EXTRA_TOKEN) -> {
                    val view = TabHandoff.take(intent.getStringExtra(TabHandoff.EXTRA_TOKEN))
                    if (view != null) host.tabs.adopt(view)
                    else intent.dataString?.let { if (DeepLinks.accepts(it)) host.chrome.openUrl(it) }
                }
                // A web link, or a `zenium://settings/…` deep link to one of Zenium's own pages.
                else -> intent.dataString?.let { if (DeepLinks.accepts(it)) host.chrome.openUrl(it) }
            }
            // Shared into Zenium: the core routes it (a link opens, text searches with the user's
            // engine, an image gets a page) – see Share.kt and src/shared/shareTarget.ts.
            Intent.ACTION_SEND -> host.share.onReceived(intent)
            Intent.ACTION_WEB_SEARCH -> host.share.onWebSearch(intent)
            // One of Zenium's own buttons in the system share sheet (Android 14).
            Share.ACTION_BROWSER_ACTION -> host.share.onBrowserAction(intent)
            // The launcher's "New private tab" shortcut (src/main/shortcuts/shortcuts.xml, relayed
            // by LauncherIconActivity): the chrome opens one in the current space, or says why it
            // cannot on a WebView without profiles.
            PrivateBrowsing.ACTION_NEW_TAB -> host.chrome.newPrivateTab()
            // A tap or a button on an extension's notification card (chrome.notifications).
            ExtensionNotifications.ACTION_OPENED -> host.extensions.onNotificationIntent(intent)
            // A tap on the media notification (or the system's media player): the session's tab.
            MediaSessions.ACTION_OPEN -> host.media.onOpenIntent(intent)
            // A tap on a page's notification: its tab comes forward (WebNotifications.kt).
            WebNotifications.ACTION_OPENED -> host.webNotifications.onOpenIntent(intent)
        }
        // Consume so a configuration change does not re-open it.
        intent.action = null
    }

    // --- lifecycle --------------------------------------------------------------------------

    /**
     * Set while the window is hidden (screen off, another app in front): the start and resume that
     * follow are a return to the screen, not the launch, and the host checks that everything paints.
     */
    private var hidden = false

    override fun onStart() {
        super.onStart()
        if (hidden) host.onStart()
    }

    override fun onStop() {
        hidden = true
        host.onStop()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        host.chrome.hostEvent("focus", json("focused" to true))
        if (hidden) {
            hidden = false
            host.onResume()
        }
    }

    override fun onPause() {
        host.onPause()
        host.chrome.hostEvent("focus", json("focused" to false))
        // Give the core a chance to persist synchronously before the process may be frozen.
        host.chrome.hostEvent("pause", null)
        super.onPause()
    }

    override fun onDestroy() {
        // Also on configuration-driven recreation (density change): the new activity builds a new
        // host and the core restores the session from disk.
        host.destroy()
        super.onDestroy()
    }

    // --- picture-in-picture (MediaSessions.kt) ---------------------------------------------------

    /** Home or Recents pressed: on Android 8-11 a video playing fullscreen goes into the small window from here. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        host.onUserLeaveHint()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        host.onPictureInPictureModeChanged(isInPictureInPictureMode)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The chrome re-measures itself; nothing to do but let WebViews relayout.
        root.requestLayout()
        // The system font size changed: the chrome's text takes the new zoom first, then hears the
        // factor (and the bold-text setting) with the environment below and grows its line boxes.
        host.chrome.applyTextScale()
        // A dock, a keyboard, a fold or a font-size change may move the page controls' defaults.
        host.chrome.hostEvent("environment", environment())
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // Backgrounded and on the system's LRU list: the back previews are the one cache worth
        // dropping (see HostLifecycle for why UI_HIDDEN is not pressure).
        if (HostLifecycle.trimDropsSnapshots(level)) host.snapshots.clear()
        // Short of memory: the core puts hidden pages to sleep ahead of their timeout (CT-22).
        HostLifecycle.memoryPressure(level)?.let { host.chrome.hostEvent("memoryPressure", json("level" to it)) }
    }

    // --- keyboard --------------------------------------------------------------------------------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Keys go to the focused WebView. Tab views pre-filter shortcuts themselves; when nothing
        // web-ish has focus (e.g. right after a dialog) route shortcuts to the chrome directly.
        val focus = currentFocus
        if (focus !is TabWebView && focus !== host.chrome && event.action == KeyEvent.ACTION_DOWN && host.keys.matches(event)) {
            host.keys.toInput(event)?.let { host.chrome.onKey(null, it) }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // --- helpers for the core ---------------------------------------------------------------------

    /**
     * Let the user pick text files (CSS mods, a bookmarks HTML, a passwords CSV) through
     * `ACTION_OPEN_DOCUMENT`; answers with `[{ name, text }]`. `maxBytes` lifts the size cap for
     * one request (`TextFiles.capFor`).
     */
    fun pickTextFiles(extensions: JSONArray, maxBytes: Double?, callback: (JSONArray) -> Unit) {
        textFilesCallback?.invoke(JSONArray())
        textFilesCallback = callback
        textFilesCap = TextFiles.capFor(maxBytes)
        val mimes = TextFiles.mimeTypesFor((0 until extensions.length()).map { extensions.optString(it) })
        try {
            textFilePicker.launch(mimes)
        } catch (e: Exception) {
            textFilesCallback = null
            textFilesCap = TextFiles.DEFAULT_CAP_BYTES
            callback(JSONArray())
        }
    }

    /** Save text where the user chooses (bookmark export); answers with true once written. */
    fun saveTextFile(name: String, mimeType: String, text: String, callback: (Boolean) -> Unit) {
        saveTextCallback?.invoke(false)
        saveTextCallback = callback
        saveTextContent = text
        try {
            textFileSaver.launch(mimeType.ifBlank { "text/plain" } to name)
        } catch (e: Exception) {
            saveTextCallback = null
            saveTextContent = ""
            callback(false)
        }
    }

    /** Let the user pick a `.crx` or `.zip` to install as an extension; answers with the document, or null. */
    fun pickExtensionPackage(callback: (Uri?) -> Unit) {
        packageCallback?.invoke(null)
        packageCallback = callback
        try {
            packagePicker.launch(ExtensionStore.PICKER_MIME_TYPES)
        } catch (e: Exception) {
            packageCallback = null
            callback(null)
        }
    }

    private fun displayNameOf(uri: Uri): String {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val name = cursor.getString(0)
                if (!name.isNullOrBlank()) return name
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "mod.css"
    }

    /**
     * Ask the system to make Zenium the default browser: the role dialog on Android 10+, the
     * default-apps settings before that. Answers with the role once the user is back, or null
     * when the device offers no way to ask.
     */
    /**
     * Start a share sheet and hear when it has finished (a target taken or the sheet dismissed;
     * `Share.Outcome` tells the two apart). A sheet already awaited is told it returned. False
     * when the sheet could not start.
     */
    fun launchChooserForResult(chooser: Intent, onReturned: () -> Unit): Boolean {
        chooserCallback?.invoke()
        chooserCallback = onReturned
        return try {
            chooserRequest.launch(chooser)
            true
        } catch (e: Exception) {
            chooserCallback = null
            false
        }
    }

    fun requestDefaultBrowser(reply: (Any?) -> Unit) {
        defaultBrowserCallback?.invoke(null)
        defaultBrowserCallback = null
        val intent = DefaultBrowser.requestIntent(this)
        if (intent == null) {
            reply(null)
            return
        }
        defaultBrowserCallback = reply
        try {
            defaultBrowserRequest.launch(intent)
        } catch (e: Exception) {
            defaultBrowserCallback = null
            reply(null)
        }
    }
}

/** `ACTION_CREATE_DOCUMENT` with the MIME type chosen per call (`mimeType to suggestedName`). */
private class CreateTextDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.first)
            .putExtra(Intent.EXTRA_TITLE, input.second)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        if (resultCode == Activity.RESULT_OK) intent?.data else null
}
