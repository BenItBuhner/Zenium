package app.zen.chromium

import java.net.URI

/**
 * What the custom tab's Page Info sheet (the icon row's (i), CCT-03) can say about a page's
 * connection, ruled as the browser's site-info sheet rules it (`siteInfo.ts`): https is secure;
 * http on the loopback (`localhost`, `*.localhost`, `127.x.y.z`) is a local site – served from
 * this device, nothing crosses the network – and any other http page is not secure. A custom tab
 * has no core to ask, so the URL is the whole of what it knows: a load the tab refused for its
 * certificate never lands as an https page here.
 */
object CustomTabPageInfo {
    enum class Connection { SECURE, LOCAL, INSECURE }

    fun connectionOf(url: String): Connection {
        val scheme = url.substringBefore(':', "").lowercase()
        if (scheme == "https") return Connection.SECURE
        val host = hostOf(url)?.lowercase() ?: return Connection.INSECURE
        val local = host == "localhost" || host.endsWith(".localhost") || LOOPBACK.matches(host)
        return if (local) Connection.LOCAL else Connection.INSECURE
    }

    /** The URL's host, null when it has none the parser accepts. */
    fun hostOf(url: String): String? = runCatching { URI(url).host }.getOrNull()?.takeIf { it.isNotEmpty() }

    private val LOOPBACK = Regex("^127\\.\\d+\\.\\d+\\.\\d+$")
}
