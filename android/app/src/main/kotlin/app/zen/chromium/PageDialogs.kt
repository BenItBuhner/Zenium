package app.zen.chromium

import java.net.URI

/**
 * The pages' own dialogs on the phone (PUI-27, PUI-28), the part that is not a view: what a
 * dialog says and offers ([PageDialogSpec]) and what a page has done with dialogs during one
 * visit of its tab ([PageDialogVisit]). The sheet itself is [PageDialogSheet]; [TabWebView]
 * holds the WebView's `JsResult` while it is up.
 *
 * Drawn natively because the WebView's renderer, which every tab and the chrome share, waits
 * inside `alert()` / `confirm()` / `prompt()` and inside a `beforeunload` objection until the
 * `JsResult` is answered: nothing the chrome's own JavaScript draws can come up meanwhile (its
 * dialog would wait on the very call it is to answer), so the core's tab-modal `PageDialog` –
 * the desktop's, where the chrome is its own process – is the phone's native sheet here.
 */

/** What a page dialog is: Chrome's kinds, and the two questions a `beforeunload` objection asks. */
enum class PageDialogKind { ALERT, CONFIRM, PROMPT, LEAVE, RELOAD }

/**
 * One dialog as the sheet shows it: the title line, the message, the prompt's initial text,
 * whether "Don't let this page create more dialogs" is offered, and the words on its buttons.
 */
class PageDialogSpec(
    val kind: PageDialogKind,
    /** Chrome's title line: "example.com says", "Leave site?", … ([title]). */
    val title: String,
    /** The page's message as it wrote it; "Changes you made may not be saved." for a `beforeunload`. */
    val message: String,
    /** `prompt`: the field's initial text. */
    val defaultValue: String = "",
    /** The page's second dialog of the visit on: the checkbox is offered (never on "Leave site?"). */
    val suppressible: Boolean = false
) {
    /** An alert has nothing to cancel: it is dismissed; every other dialog has Cancel. */
    val cancellable: Boolean get() = kind != PageDialogKind.ALERT

    /** The label of the button that accepts the dialog (Chrome's wording). */
    val acceptLabel: String
        get() = when (kind) {
            PageDialogKind.LEAVE -> "Leave"
            PageDialogKind.RELOAD -> "Reload"
            else -> "OK"
        }

    companion object {
        /** Chrome's line under "Leave site?" / "Reload site?". */
        const val LEAVE_MESSAGE = "Changes you made may not be saved."
        /** Chrome's checkbox from a page's second dialog on. */
        const val SUPPRESS_LABEL = "Don't let this page create more dialogs"

        /** An `alert` / `confirm` / `prompt` from the frame at `frameUrl` on the page at `pageUrl`. */
        fun page(
            kind: PageDialogKind,
            frameUrl: String,
            pageUrl: String,
            message: String,
            defaultValue: String,
            suppressible: Boolean
        ): PageDialogSpec = PageDialogSpec(
            kind,
            title(site(frameUrl), embedded(frameUrl, pageUrl)),
            message,
            if (kind == PageDialogKind.PROMPT) defaultValue else "",
            suppressible
        )

        /** The page's `beforeunload` objection: "Leave site?", or "Reload site?" for a reload. */
        fun beforeUnload(reload: Boolean): PageDialogSpec = PageDialogSpec(
            if (reload) PageDialogKind.RELOAD else PageDialogKind.LEAVE,
            if (reload) "Reload site?" else "Leave site?",
            LEAVE_MESSAGE
        )

        /**
         * The site a dialog is titled after, as Chrome shows it: the host of an http(s) page (the
         * scheme dropped, a port kept), "" for pages without one (files, `data:` and `about:blank`
         * documents, opaque origins), which the title words as "This page says".
         */
        fun site(url: String): String {
            val uri = runCatching { URI(url) }.getOrNull() ?: return ""
            if (uri.scheme != "http" && uri.scheme != "https") return ""
            val host = uri.host ?: return ""
            return if (uri.port >= 0) "$host:${uri.port}" else host
        }

        /**
         * Whether `frameUrl` belongs to another origin than the page's top document (Chrome titles
         * such a dialog "An embedded page at … says", so a frame cannot pose as the page whose
         * address is shown). `about:` frames inherit their parent's origin.
         */
        fun embedded(frameUrl: String, pageUrl: String): Boolean {
            val frame = runCatching { URI(frameUrl) }.getOrNull() ?: return false
            val page = runCatching { URI(pageUrl) }.getOrNull() ?: return false
            if (frame.scheme == "about") return false
            return origin(frame) != origin(page)
        }

        private fun origin(uri: URI): String = "${uri.scheme}://${uri.host}:${uri.port}"

        /** Chrome's title line for a page's own dialog. */
        fun title(site: String, embedded: Boolean): String = when {
            embedded && site.isNotEmpty() -> "An embedded page at $site says"
            embedded -> "An embedded page says"
            site.isNotEmpty() -> "$site says"
            else -> "This page says"
        }
    }
}

/**
 * What a page has done with dialogs during one visit of its tab (Chrome's per-WebContents
 * `JavaScriptDialogTabHelper` count): how many it has opened, and whether the user ticked
 * "Don't let this page create more dialogs". Chrome offers the checkbox once the page has shown
 * a dialog before in this visit, and a ticked checkbox has every later dialog of the visit
 * answered at once, the way a dismissal answers it (the alert dismissed, the confirm and the
 * prompt cancelled). The visit ends when the tab commits another document ([reset]); the
 * `beforeunload` question counts for nothing and is never silenced.
 */
class PageDialogVisit {
    /** The dialogs the page has been shown this visit. */
    var shown = 0
        private set

    /** The page has been told to open no more dialogs this visit. */
    var suppressed = false
        private set

    /**
     * The page asks for a dialog: null when the page is silenced (answer it at once, no sheet),
     * otherwise whether the sheet offers the checkbox – true from the page's second dialog on.
     */
    fun request(): Boolean? {
        if (suppressed) return null
        val offer = shown > 0
        shown += 1
        return offer
    }

    /** The user answered a dialog of the visit, the checkbox ticked or not. */
    fun answered(suppress: Boolean) {
        if (suppress) suppressed = true
    }

    /** The tab committed another document: the visit is over, its count and its silencing with it. */
    fun reset() {
        shown = 0
        suppressed = false
    }
}
