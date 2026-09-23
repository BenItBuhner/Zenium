package app.zen.chromium

import org.json.JSONObject

/**
 * What a message from the page script (src/android/pageScript.ts, over the WebMessage listener
 * or the legacy JavaScript interface) asks of the tab's WebView. Pure, so the plumbing between
 * the script and the view events the chrome sees can be tested off the device.
 */
sealed class PageMessageRoute {
    /** Not JSON, or not carrying this session's token: a page forging browser messages. */
    object Ignore : PageMessageRoute()

    /** The script is up and wants the current flags; the reply proxy is kept for the answers. */
    object Hello : PageMessageRoute()

    /** The settled value of a Promise an `evaluate()` script returned. */
    data class EvalResult(val id: Int, val value: String?) : PageMessageRoute()

    /** The main document's DOMContentLoaded (Electron's `dom-ready`). */
    object DomReady : PageMessageRoute()

    /**
     * A `fullscreenchange` in the page (`installFullscreenReporter`): whether the document has a
     * fullscreen element, whether that element shows a video at all (`video`; the exit hint
     * stands every time for one without, MED-03) and the natural size of the video it shows –
     * 0 × 0 for no video, or a size not known yet. The host turns the screen by it
     * ([PageHost.fullscreenVideo], MED-01); the core never sees it.
     */
    data class Fullscreen(val active: Boolean, val videoWidth: Int, val videoHeight: Int, val video: Boolean) : PageMessageRoute()

    /** Anything else goes to the core as a `pageMessage` view event, without the token. */
    data class Forward(val message: JSONObject) : PageMessageRoute()

    /**
     * Whether the view acts on this message from the frame it came from. The main document
     * speaks for the tab; a frame's hello, `domReady` or forwarded message is not the page's and
     * is dropped. A frame's own [Fullscreen] is heard: an embed's video (a YouTube iframe) goes
     * fullscreen from its frame's document, the one that knows the video's size, while the main
     * document sees only the `<iframe>`, without one.
     */
    fun heardFrom(isMainFrame: Boolean): Boolean = isMainFrame || this is Fullscreen
}

/** Route a page-script message carrying `token` (a per-session secret pages cannot know). */
fun routePageMessage(data: String?, token: String): PageMessageRoute {
    if (data == null) return PageMessageRoute.Ignore
    val obj = runCatching { JSONObject(data) }.getOrNull() ?: return PageMessageRoute.Ignore
    if (obj.str("token") != token) return PageMessageRoute.Ignore
    return when (obj.str("type")) {
        "hello" -> PageMessageRoute.Hello
        "evalResult" -> PageMessageRoute.EvalResult(obj.optInt("id"), obj.strOrNull("value"))
        "domReady" -> PageMessageRoute.DomReady
        "fullscreen" -> {
            val videoWidth = obj.optInt("videoWidth").coerceAtLeast(0)
            PageMessageRoute.Fullscreen(
                obj.optBoolean("active"),
                videoWidth,
                obj.optInt("videoHeight").coerceAtLeast(0),
                // A report without the word (a script from before it) has a video where it has a size.
                obj.optBoolean("video", videoWidth > 0)
            )
        }
        else -> {
            obj.remove("token")
            PageMessageRoute.Forward(obj)
        }
    }
}

/**
 * Raises a tab's `domReady` view event once per document, as Electron fires `dom-ready`: at
 * the page script's DOMContentLoaded message, else at `onPageFinished` for a document the script
 * could not report from (a WebView without document-start scripts injects it at page finished;
 * a document the script did not run in has nothing to say). A new document arms it again.
 */
class DomReadyGate {
    private var raised = false

    /** `onPageStarted`: whatever was raised belonged to the document before this one. */
    fun documentStarted() {
        raised = false
    }

    /** The script's DOMContentLoaded message: raise the event now? */
    fun scriptReady(): Boolean = raise()

    /** `onPageFinished`: the document is complete; raise the event if the script never did. */
    fun pageFinished(): Boolean = raise()

    private fun raise(): Boolean {
        if (raised) return false
        raised = true
        return true
    }
}
