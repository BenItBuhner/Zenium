package app.zen.chromium

import android.app.Activity
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
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
open class MainActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    private lateinit var fullscreenLayer: FrameLayout
    lateinit var host: Host
        protected set
    private var insets = JSONObject()
    private var latestInsets: WindowInsetsCompat? = null
    /** The keyboard is animating for the chrome; its frames are streamed as insets. */
    private var imeAnimating = false
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallback: ((Map<String, Boolean>) -> Unit)? = null
    private var textFilesCallback: ((JSONArray) -> Unit)? = null

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

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooserCallback ?: return@registerForActivityResult
        fileChooserCallback = null
        callback.onReceiveValue(
            if (result.resultCode == Activity.RESULT_OK)
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            else null
        )
    }

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        val callback = permissionCallback ?: return@registerForActivityResult
        permissionCallback = null
        callback(results)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // CustomTabActivity shares the activity-level upload, permission and fullscreen plumbing,
        // but deliberately builds a native provider surface instead of the browser chrome.
        if (this is CustomTabActivity) return
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
        if (CustomTabsLaunch.isCustomTabsLaunch(intent)) {
            val customTab = Intent(intent).setClass(this, CustomTabActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
            }
            startActivity(customTab)
            // MainActivity is singleTask: without consuming this, a configuration change replays
            // the Custom Tabs launch and opens a second provider window.
            intent.action = null
            return
        }
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString?.let { if (it.startsWith("http")) host.chrome.openUrl(it) }
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

    override fun onResume() {
        super.onResume()
        host.chrome.hostEvent("focus", json("focused" to true))
    }

    override fun onPause() {
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
        // dropping (UI_HIDDEN alone is not pressure – the user may be right back).
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) host.snapshots.clear()
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

    // --- helpers for the WebChromeClients -------------------------------------------------------

    fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = callback
        return try {
            fileChooser.launch(params.createIntent())
            true
        } catch (e: Exception) {
            fileChooserCallback = null
            false
        }
    }

    /** Let the user pick text files (CSS mods); answers with `[{ name, text }]`. */
    fun pickTextFiles(extensions: JSONArray, callback: (JSONArray) -> Unit) {
        textFilesCallback?.invoke(JSONArray())
        textFilesCallback = callback
        val mimes = (0 until extensions.length()).mapNotNull { i ->
            when (extensions.optString(i)) {
                "css" -> "text/css"
                "json" -> "application/json"
                "txt" -> "text/plain"
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

    private fun displayNameOf(uri: Uri): String {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val name = cursor.getString(0)
                if (!name.isNullOrBlank()) return name
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "mod.css"
    }

    fun requestRuntimePermissions(permissions: List<String>, callback: (Map<String, Boolean>) -> Unit) {
        permissionCallback?.invoke(emptyMap())
        permissionCallback = callback
        permissionLauncher.launch(permissions.toTypedArray())
    }
}
