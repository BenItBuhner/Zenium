package app.zen.chromium.ext

import app.zen.chromium.PageDialogKind
import app.zen.chromium.PageDialogSpec

/**
 * An extension page's own dialogs – `alert()`, `confirm()`, `prompt()` and a `beforeunload`
 * objection – as Chrome shows them, the part that is not a view (JUnit). Chrome titles a dialog
 * of an extension's page with the extension's NAME (`AppModalDialogManager::GetTitleImpl`: the
 * name for an alerting frame on the extension's origin, the site line for an embedded frame of
 * another), and a service worker has no dialogs at all (no `alert` in its realm). A WebView left
 * to itself draws its stock `JsDialogHelper` dialog instead – `The page at "https://<id>.ext.zenium.invalid" says:`
 * – which compat round 22's targeted 156 lane met on Popup Blocker (strict)'s popup (its health
 * check's `confirm()` after a 2 s `echo` the slow image's frames outran): the emulated origin
 * shown to the user, and a shape neither the host's sheet path nor the sweep's watch knew, the
 * renderer every WebView of the app shares parked in it for the wait's 120 s. [ExtensionWebView]
 * shows [spec] as the host's [app.zen.chromium.PageDialogSheet] (Chrome's words on the sheet's
 * chassis) and answers a hidden view's dialog as dismissed at once ([silence]).
 */
object ExtensionPageDialogs {
    /**
     * Whether the view's page shows dialogs: the ones in the sheet (a popup, an options page, a
     * side panel) do; the worker page and an offscreen document have none.
     */
    fun shows(context: String): Boolean = context != "background" && context != "offscreen"

    /**
     * Why a dialog of `context`'s page is answered as dismissed at once, for the page's console;
     * null when it is shown. A hidden view's – Chrome's service worker has no `alert`, and an
     * offscreen document no surface to show one on – or a page told to open no more this visit.
     */
    fun silence(context: String, kind: PageDialogKind, suppressed: Boolean): String? = when {
        context == "background" -> "[Zenium] ${call(kind)} from the background page is answered as dismissed: a service worker has no dialogs"
        context == "offscreen" -> "[Zenium] ${call(kind)} from the offscreen document is answered as dismissed: an offscreen document has no dialogs"
        suppressed -> "[Zenium] ${call(kind)} is answered as dismissed: the page was told to create no more dialogs this visit"
        else -> null
    }

    private fun call(kind: PageDialogKind): String = when (kind) {
        PageDialogKind.ALERT -> "alert()"
        PageDialogKind.CONFIRM -> "confirm()"
        PageDialogKind.PROMPT -> "prompt()"
        PageDialogKind.LEAVE, PageDialogKind.RELOAD -> "a beforeunload objection"
    }

    /**
     * The dialog as the sheet shows it: titled with the extension's name for a frame on its own
     * origin (an `about:` frame inherits it), Chrome's site line for an embedded frame of another
     * origin ("An embedded page at example.com says"); a prompt keeps its default text.
     */
    fun spec(
        kind: PageDialogKind,
        frameUrl: String,
        extensionOrigin: String,
        extensionName: String,
        message: String,
        defaultValue: String,
        suppressible: Boolean
    ): PageDialogSpec {
        val own = frameUrl == extensionOrigin || frameUrl.startsWith("$extensionOrigin/") || frameUrl.startsWith("about:")
        if (!own) return PageDialogSpec.page(kind, frameUrl, "$extensionOrigin/", message, defaultValue, suppressible)
        return PageDialogSpec(
            kind,
            site = extensionName,
            embedded = false,
            message = message,
            defaultValue = if (kind == PageDialogKind.PROMPT) defaultValue else "",
            suppressible = suppressible
        )
    }
}
