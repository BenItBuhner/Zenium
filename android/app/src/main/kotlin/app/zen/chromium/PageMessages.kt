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

    /** Anything else goes to the core as a `pageMessage` view event, without the token. */
    data class Forward(val message: JSONObject) : PageMessageRoute()
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
