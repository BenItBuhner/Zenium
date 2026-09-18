package app.zen.chromium.ext

import android.view.ViewGroup
import android.widget.FrameLayout
import app.zen.chromium.Host
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import kotlin.math.roundToInt

/**
 * A browser-action popup (or options page) on a phone: a bottom sheet hosting the extension
 * WebView. Chrome sizes popups to their document; the page bootstrap reports the document size
 * (`popupSize`) and the sheet follows it between a floor and most of the screen. The back
 * gesture and a tap outside dismiss it, `window.close()` in the popup does too.
 */
class ExtensionPopup(
    private val host: Host,
    extensions: Extensions,
    served: Extensions.Served,
    private val url: String,
    context: String,
    private val onClosed: () -> Unit
) {
    val extensionId = served.id
    private val density = host.activity.resources.displayMetrics.density
    private val dialog = BottomSheetDialog(host.activity)
    private val container = FrameLayout(host.activity)
    val webView = ExtensionWebView(host, extensions, served, context)
    private var closed = false

    init {
        // Options pages are documents, not popups: they get the tall sheet from the start.
        val initial = ((if (context == "popup") 320 else 560) * density).roundToInt()
        container.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, initial))
        dialog.setContentView(container)
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.behavior.skipCollapsed = true
        dialog.setOnDismissListener {
            if (closed) return@setOnDismissListener
            closed = true
            webView.destroy()
            onClosed()
        }
    }

    fun show() {
        dialog.show()
        webView.loadUrl(url)
    }

    /** CSS px reported by the popup document → the sheet's height (Chrome caps popups at 600 px). */
    fun resize(widthCss: Int, heightCss: Int) {
        if (heightCss <= 0) return
        val screen = host.activity.resources.displayMetrics.heightPixels
        val wanted = (heightCss.coerceAtMost(600) * density).roundToInt()
        val height = wanted.coerceIn((120 * density).roundToInt(), (screen * 0.85).roundToInt())
        val params = webView.layoutParams
        if (params.height == height) return
        params.height = height
        webView.layoutParams = params
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
    }

    fun dismiss() {
        if (closed) return
        dialog.dismiss()
    }
}
