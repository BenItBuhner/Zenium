package app.zen.chromium.ext

import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import app.zen.chromium.Host

/**
 * A browser-action popup or an embedded options page on a phone: the extension WebView inside the
 * v2 sheet ([ExtensionSheet]). Chrome sizes a popup to its document, up to 800×600 CSS px; the
 * page bootstrap reports the document's own size (`popupSize`) and the popup surface follows it:
 * its height between a floor and most of the screen, its width the document's own when that is
 * narrower than the sheet (centred on the sheet's panel colour) and the sheet's otherwise. An
 * options page is a document made for a tab, so it fills the sheet and gets the tall body from
 * the start; a `chrome.sidePanel` document (`context = "sidePanel"`, which Chrome docks beside
 * the page at full height) does the same. `window.close()` in the popup dismisses the sheet, as
 * do the scrim, the back gesture and the header's close control.
 */
class ExtensionPopup(
    private val host: Host,
    extensions: Extensions,
    served: Extensions.Served,
    title: String,
    private val url: String,
    context: String,
    private val onClosed: () -> Unit
) {
    val extensionId = served.id
    private val density = host.activity.resources.displayMetrics.density
    val webView = ExtensionWebView(host, extensions, served, context)
    private val sheet = ExtensionSheet(host, title, webView) {
        webView.destroy()
        onClosed()
    }
    private val popup = context == "popup"

    init {
        val initial = if (popup) dp(INITIAL_POPUP_DP) else sheet.maxBodyHeight()
        webView.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, initial).apply {
            gravity = Gravity.CENTER_HORIZONTAL
        }
        webView.setOnScrollChangeListener { _, _, scrollY, _, _ -> sheet.setScrolled(scrollY > 0) }
    }

    fun show() {
        sheet.show()
        webView.loadUrl(url)
    }

    /** CSS px reported by the popup document → the surface's size (Chrome caps popups at 800×600). */
    fun resize(widthCss: Int, heightCss: Int) {
        if (!popup || heightCss <= 0) return
        val params = webView.layoutParams as FrameLayout.LayoutParams
        val height = dp(heightCss.coerceAtMost(MAX_POPUP_HEIGHT_CSS)).coerceIn(dp(MIN_POPUP_DP), sheet.maxBodyHeight())
        val sheetWidth = sheet.frame.width.takeIf { it > 0 } ?: host.activity.resources.displayMetrics.widthPixels
        val wanted = if (widthCss > 0) dp(widthCss.coerceAtMost(MAX_POPUP_WIDTH_CSS)) else sheetWidth
        // The document's own width when it has one narrower than the sheet; the sheet's otherwise.
        val width = if (wanted < sheetWidth - dp(2)) wanted else ViewGroup.LayoutParams.MATCH_PARENT
        if (params.height == height && params.width == width) return
        params.height = height
        params.width = width
        webView.layoutParams = params
    }

    fun dismiss() = sheet.dismiss()

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        /** The popup surface before the document reports its size. */
        const val INITIAL_POPUP_DP = 320
        /** Popups shorter than this are hard to hit on a phone. */
        const val MIN_POPUP_DP = 120
        /** Chrome's popup maximums. */
        const val MAX_POPUP_WIDTH_CSS = 800
        const val MAX_POPUP_HEIGHT_CSS = 600
    }
}
