package app.zen.chromium

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Patterns
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/**
 * The one window of the browser. A FrameLayout holds the chrome WebView at the bottom, tab
 * WebViews above it, and a topmost layer for HTML fullscreen. Rotation, DeX resizing and keyboard
 * changes are handled in place (see `configChanges` in the manifest) so no page ever reloads.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var root: FrameLayout
    private lateinit var fullscreenLayer: FrameLayout
    lateinit var host: Host
        private set
    private var insets = JSONObject()
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallback: ((Map<String, Boolean>) -> Unit)? = null

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
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this) {
            if (host.handleBackInFullscreen()) return@addCallback
            host.chrome.onBack { handled -> if (!handled) moveTaskToBack(true) }
        }

        host.chrome.load()
        handleIntent(intent)
    }

    fun currentInsets(): JSONObject = insets

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString?.let { if (it.startsWith("http")) host.chrome.openUrl(it) }
            Intent.ACTION_SEND -> {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
                val url = Patterns.WEB_URL.matcher(text).let { m -> if (m.find()) m.group() else null }
                host.chrome.openUrl(url ?: "https://www.google.com/search?q=${Uri.encode(text)}")
            }
            Intent.ACTION_WEB_SEARCH -> {
                val q = intent.getStringExtra("query") ?: return
                host.chrome.openUrl("https://www.google.com/search?q=${Uri.encode(q)}")
            }
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

    fun requestRuntimePermissions(permissions: List<String>, callback: (Map<String, Boolean>) -> Unit) {
        permissionCallback?.invoke(emptyMap())
        permissionCallback = callback
        permissionLauncher.launch(permissions.toTypedArray())
    }
}
