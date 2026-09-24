package app.zen.chromium

/**
 * The rules of a minimized custom tab (CustomTabActivity.kt's Minimize, the floating
 * picture-in-picture card): the window's shape and what the card says. Pure, so the text fallbacks
 * and the callback mapping have a JVM test.
 */
object CustomTabMinimize {
    /** The floating window's aspect ratio, Chrome's 16:9 card. */
    const val ASPECT_WIDTH = 16
    const val ASPECT_HEIGHT = 9

    /** What the caller's `CustomTabsCallback` hears (`onMinimized` / `onUnminimized`). */
    enum class Event { MINIMIZED, UNMINIMIZED }

    /** The card's two lines: the page's title (its host when it has none) over its host. */
    data class Card(val title: String, val host: String)

    fun card(title: String?, url: String): Card {
        val host = host(url)
        val trimmed = title?.trim().orEmpty()
        return Card(if (trimmed.isEmpty()) host else trimmed, host)
    }

    /** The URL's host without a leading `www.`; the URL itself when it has no host (`about:blank`). */
    fun host(url: String): String {
        val schemeEnd = url.indexOf("://")
        if (schemeEnd < 0) return url
        var rest = url.substring(schemeEnd + 3)
        val at = rest.indexOf('@')
        val slash = rest.indexOfAny(charArrayOf('/', '?', '#'))
        if (at >= 0 && (slash < 0 || at < slash)) rest = rest.substring(at + 1)
        val end = rest.indexOfAny(charArrayOf('/', '?', '#', ':')).let { if (it < 0) rest.length else it }
        val host = rest.substring(0, end)
        return if (host.startsWith("www.", ignoreCase = true)) host.substring(4) else host
    }

    /**
     * The event for a picture-in-picture change: entering it is [Event.MINIMIZED], leaving it
     * [Event.UNMINIMIZED]; null when nothing changed (the platform reports the same mode twice).
     */
    fun event(wasMinimized: Boolean, isMinimized: Boolean): Event? = when {
        wasMinimized == isMinimized -> null
        isMinimized -> Event.MINIMIZED
        else -> Event.UNMINIMIZED
    }
}
