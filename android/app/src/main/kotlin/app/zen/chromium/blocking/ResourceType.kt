package app.zen.chromium.blocking

/** Resource types as `chrome.declarativeNetRequest` names them; `bit` is the type's mask bit. */
enum class ResourceType(val dnrName: String) {
    MAIN_FRAME("main_frame"),
    SUB_FRAME("sub_frame"),
    STYLESHEET("stylesheet"),
    SCRIPT("script"),
    IMAGE("image"),
    FONT("font"),
    OBJECT("object"),
    XMLHTTPREQUEST("xmlhttprequest"),
    PING("ping"),
    CSP_REPORT("csp_report"),
    MEDIA("media"),
    WEBSOCKET("websocket"),
    WEBTRANSPORT("webtransport"),
    WEBBUNDLE("webbundle"),
    OTHER("other");

    val bit: Int get() = 1 shl ordinal

    companion object {
        /** Every type, including main frames (`$all`). */
        val ALL_MASK: Int = (1 shl entries.size) - 1

        /** What a filter without a type option applies to: every type but the main document (uBlock Origin's rule). */
        val DEFAULT_MASK: Int = ALL_MASK and MAIN_FRAME.bit.inv()

        private val byName = entries.associateBy { it.dnrName }

        fun fromDnrName(name: String): ResourceType? = byName[name]

        private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "apng", "jxl")
        private val FONT_EXT = setOf("woff", "woff2", "ttf", "otf", "eot")
        private val MEDIA_EXT = setOf("mp4", "webm", "m4v", "m4a", "mp3", "ogg", "oga", "ogv", "wav", "flac", "aac", "m3u8", "ts", "mpd", "mov", "3gp")

        /**
         * The types a request of unknown kind may be (scripts, fetches, beacons, fonts, media and
         * plugins all send the wildcard `Accept` header): a filter for any of them applies.
         */
        val AMBIGUOUS_MASK: Int =
            SCRIPT.bit or XMLHTTPREQUEST.bit or FONT.bit or MEDIA.bit or OBJECT.bit or PING.bit or OTHER.bit

        /**
         * Android's `WebResourceRequest` carries no resource type, so it is inferred the way other
         * WebView blockers do: the main-frame flag, then the renderer's `Accept` header (documents,
         * stylesheets and images announce themselves), then the file extension. Null when nothing
         * gives it away.
         */
        fun guessKnown(url: String, isMainFrame: Boolean, accept: String?): ResourceType? {
            if (isMainFrame) return MAIN_FRAME
            if (url.startsWith("ws:", ignoreCase = true) || url.startsWith("wss:", ignoreCase = true)) return WEBSOCKET
            if (accept != null) {
                when {
                    accept.startsWith("text/html") || accept.startsWith("application/xhtml") -> return SUB_FRAME
                    accept.startsWith("text/css") -> return STYLESHEET
                    accept.startsWith("image/") -> return IMAGE
                    accept.startsWith("video/") || accept.startsWith("audio/") -> return MEDIA
                    accept.startsWith("font/") || accept.startsWith("application/font") -> return FONT
                }
            }
            when (extensionOf(url)) {
                "js", "mjs", "cjs", "jsx" -> return SCRIPT
                "css" -> return STYLESHEET
                "htm", "html", "xhtml", "php", "asp", "aspx", "jsp" -> return SUB_FRAME
                "swf" -> return OBJECT
                in IMAGE_EXT -> return IMAGE
                in FONT_EXT -> return FONT
                in MEDIA_EXT -> return MEDIA
            }
            return null
        }

        /** [guessKnown], with `xmlhttprequest` – the type of the fetches trackers use – for the unknown. */
        fun guess(url: String, isMainFrame: Boolean, accept: String?): ResourceType =
            guessKnown(url, isMainFrame, accept) ?: XMLHTTPREQUEST

        /** The candidate-type mask of a request: one bit when the type is known, [AMBIGUOUS_MASK] otherwise. */
        fun guessMask(url: String, isMainFrame: Boolean, accept: String?): Int =
            guessKnown(url, isMainFrame, accept)?.bit ?: AMBIGUOUS_MASK

        /** Lowercased extension of the URL's path (`https://x/a/b.min.js?v=1` → `js`), or "" when there is none. */
        fun extensionOf(url: String): String {
            val scheme = url.indexOf("://")
            val pathStart = if (scheme == -1) 0 else url.indexOf('/', scheme + 3)
            if (pathStart == -1) return ""
            var end = url.indexOf('?', pathStart)
            val hash = url.indexOf('#', pathStart)
            if (hash != -1 && (end == -1 || hash < end)) end = hash
            if (end == -1) end = url.length
            val slash = url.lastIndexOf('/', end - 1)
            val dot = url.lastIndexOf('.', end - 1)
            if (dot == -1 || dot < slash || end - dot > 8 || end - dot < 2) return ""
            return url.substring(dot + 1, end).lowercase()
        }
    }
}
