package app.zen.chromium

import android.webkit.WebView.HitTestResult

/**
 * Which of the WebView's hit-test results a long-press raises the link menu for, and the address
 * the menu opens on. The WebView types an anchor by its href: `SRC_ANCHOR_TYPE` for a page link
 * (`SRC_IMAGE_ANCHOR_TYPE` for an image in one), but `PHONE_TYPE` for a `tel:` link and
 * `EMAIL_TYPE` for a `mailto:` one – and for those two it hands the bare number or address as the
 * result's extra, not the href. A hold on them raised nothing before PUI-22's items had anything
 * to open on; now every one of the four is the link menu's. `requestFocusNodeHref` answers with
 * the anchor's href whatever its scheme; when its bundle carries none, the extra is put back under
 * the scheme its type names, so the menu's `tel:` / `mailto:` items and its Copy Phone Number /
 * Copy Email Address read one address (`linkCopyItem` in the core).
 */
object LinkHits {
    /** The hit types a long-press opens the link menu for (`TabWebView.onLongPress`). */
    fun opensLinkMenu(type: Int): Boolean = type in LINK_TYPES

    /**
     * The address the menu opens on: the anchor's href when the WebView gave one, else the
     * result's extra under the scheme its type names (a bare extra of a page link is the href
     * itself). Empty when neither says.
     */
    fun href(type: Int, focusedHref: String?, extra: String?): String {
        if (!focusedHref.isNullOrEmpty()) return focusedHref
        if (extra.isNullOrEmpty()) return ""
        return when (type) {
            HitTestResult.PHONE_TYPE -> if (hasScheme(extra, "tel")) extra else "tel:$extra"
            HitTestResult.EMAIL_TYPE -> if (hasScheme(extra, "mailto")) extra else "mailto:$extra"
            else -> extra
        }
    }

    private fun hasScheme(url: String, scheme: String): Boolean =
        url.length > scheme.length && url[scheme.length] == ':' && url.substring(0, scheme.length).equals(scheme, ignoreCase = true)

    private val LINK_TYPES = setOf(
        HitTestResult.SRC_ANCHOR_TYPE,
        HitTestResult.SRC_IMAGE_ANCHOR_TYPE,
        HitTestResult.PHONE_TYPE,
        HitTestResult.EMAIL_TYPE
    )
}
