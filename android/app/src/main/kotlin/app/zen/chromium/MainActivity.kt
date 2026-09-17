package app.zen.chromium

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
    private var insets = JSONObject()
    private var latestInsets: WindowInsetsCompat? = null
    /** The keyboard is animating for the chrome; its frames are streamed as insets. */
    private var imeAnimating = false
    private var textFilesCallback: ((JSONArray) -> Unit)? = null
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
        val files = JSONArray()
        for (uri in uris) {
            val text = runCatching {
                contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
            }.getOrNull() ?: continue
            if (text.length > 512 * 1024) continue
            files.put(json("name" to displayNameOf(uri), "text" to text))
        }
        callback(files)
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

    /** Tell the chrome how far the status bar, cutout, gesture bar and keyboard reach in CSS px. */
    private fun applyInsets(windowInsets: WindowInsetsCompat) {
        val bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
        val d = resources.displayMetrics.density
        insets = json(
            "top" to bars.top / d,
            "right" to bars.right / d,
            "bottom" to maxOf(bars.bottom, ime.bottom) / d,
            "left" to bars.left / d
        )
        host.chrome.hostEvent("insets", insets)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
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
                    else intent.dataString?.let { if (it.startsWith("http")) host.chrome.openUrl(it) }
                }
                else -> intent.dataString?.let { if (it.startsWith("http")) host.chrome.openUrl(it) }
            }
            // Shared into Zenium: the core routes it (a link opens, text searches with the user's
            // engine, an image gets a page) – see Share.kt and src/shared/shareTarget.ts.
            Intent.ACTION_SEND -> host.share.onReceived(intent)
            Intent.ACTION_WEB_SEARCH -> host.share.onWebSearch(intent)
            // One of Zenium's own buttons in the system share sheet (Android 14).
            Share.ACTION_BROWSER_ACTION -> host.share.onBrowserAction(intent)
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

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The chrome re-measures itself; nothing to do but let WebViews relayout.
        root.requestLayout()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // Backgrounded and on the system's LRU list: the back previews are the one cache worth
        // dropping (see HostLifecycle for why UI_HIDDEN is not pressure).
        if (HostLifecycle.trimDropsSnapshots(level)) host.snapshots.clear()
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

    /** Let the user pick text files (CSS mods); answers with `[{ name, text }]`. */
    fun pickTextFiles(extensions: JSONArray, callback: (JSONArray) -> Unit) {
        textFilesCallback?.invoke(JSONArray())
        textFilesCallback = callback
        val mimes = (0 until extensions.length()).mapNotNull { i ->
            when (extensions.optString(i)) {
                "css" -> "text/css"
                "json" -> "application/json"
                "txt" -> "text/plain"
                "html", "htm" -> "text/html"
                else -> null
            }
        }.ifEmpty { listOf("*/*") }
        try {
            textFilePicker.launch(mimes.toTypedArray())
        } catch (e: Exception) {
            textFilesCallback = null
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

    private fun displayNameOf(uri: Uri): String {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val name = cursor.getString(0)
                if (!name.isNullOrBlank()) return name
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "mod.css"
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
