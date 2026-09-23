package app.zen.chromium

import java.net.URI

/**
 * The pages' own dialogs on the phone (PUI-27, PUI-28), the part that is not a view: what a
 * dialog is and offers ([PageDialogSpec]), Chrome's words for it as `strings.xml` has them
 * ([PageDialogWords]) and what a page has done with dialogs during one visit of its tab
 * ([PageDialogVisit]). The sheet itself is [PageDialogSheet] on the §9.23 chassis
 * ([NativePromptSheet]), which reads the words from the host's resources; [TabWebView] holds the
 * WebView's `JsResult` while it is up. Nothing here touches Android, so all of it is under JUnit.
 *
 * Drawn natively because the WebView's renderer, which every tab and the chrome share, waits
 * inside `alert()` / `confirm()` / `prompt()` and inside a `beforeunload` objection until the
 * `JsResult` is answered: nothing the chrome's own JavaScript draws can come up meanwhile (its
 * dialog would wait on the very call it is to answer), so the core's tab-modal `PageDialog` –
 * the desktop's, where the chrome is its own process – is the phone's native sheet here. v2
 * §9.23 names the page's dialogs as the chassis's second consumer on that proof (this PR's run
 * 1), beside the unresponsive-page prompt; the door closes behind the two.
 */

/** What a page dialog is: Chrome's kinds, and the two questions a `beforeunload` objection asks. */
enum class PageDialogKind { ALERT, CONFIRM, PROMPT, LEAVE, RELOAD }

/**
 * One dialog as the sheet shows it: its kind, the site its title names and whether the asking
 * frame is an embedded one of another origin, the page's message, the prompt's initial text and
 * whether "Don't let this page create more dialogs" is offered. The words themselves – the
 * title line, our `beforeunload` sentence, the buttons – are [PageDialogWords]'s ([title],
 * [acceptLabel]), so a spec carries nothing in English of its own.
 */
class PageDialogSpec(
    val kind: PageDialogKind,
    /** The site the title names, as [site] reads it: the host with its port, "" for a page without one. */
    val site: String = "",
    /** The asking frame is of another origin than the page's top document ([embedded]). */
    val embedded: Boolean = false,
    /** The page's message as it wrote it; "" for a `beforeunload`, whose sentence is ours ([PageDialogWords.leaveMessage]). */
    val message: String = "",
    /** `prompt`: the field's initial text. */
    val defaultValue: String = "",
    /** The page's second dialog of the visit on: the checkbox is offered (never on "Leave site?"). */
    val suppressible: Boolean = false
) {
    /** An alert has nothing to cancel: it is dismissed; every other dialog has Cancel. */
    val cancellable: Boolean get() = kind != PageDialogKind.ALERT

    /** A `beforeunload` question is ours – its sentence and its title are Chrome's words, not the page's. */
    val ours: Boolean get() = kind == PageDialogKind.LEAVE || kind == PageDialogKind.RELOAD

    /** Chrome's title line: "example.com says", "An embedded page at … says", "Leave site?", … */
    fun title(words: PageDialogWords): String = when (kind) {
        PageDialogKind.LEAVE -> words.leaveTitle
        PageDialogKind.RELOAD -> words.reloadTitle
        else -> words.title(site, embedded)
    }

    /** The label of the button that accepts the dialog: OK, or Leave / Reload on a `beforeunload`. */
    fun acceptLabel(words: PageDialogWords): String = when (kind) {
        PageDialogKind.LEAVE -> words.leave
        PageDialogKind.RELOAD -> words.reload
        else -> words.ok
    }

    companion object {
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
            site(frameUrl),
            embedded(frameUrl, pageUrl),
            message,
            if (kind == PageDialogKind.PROMPT) defaultValue else "",
            suppressible
        )

        /** The page's `beforeunload` objection: "Leave site?", or "Reload site?" for a reload. */
        fun beforeUnload(reload: Boolean): PageDialogSpec =
            PageDialogSpec(if (reload) PageDialogKind.RELOAD else PageDialogKind.LEAVE)

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
    }
}

/**
 * Chrome's words for a page's dialog as `strings.xml` has them (`page_dialog_*`): the title
 * formats, the `beforeunload` question, the checkbox and the buttons. A plain bag of strings so
 * the composition ([title], [PageDialogSheet.content]) stays under JUnit, where the test builds
 * one from the resource file itself and pins each line to Chrome's; on the device
 * [PageDialogSheet.words] reads it from the host's resources, so a translation is a `values-xx`
 * file and nothing in Kotlin. The two formats take the site as `%1$s`, as `getString` would.
 */
class PageDialogWords(
    /** "%1$s says" (Chrome's IDS_JAVASCRIPT_MESSAGEBOX_TITLE). */
    val titleSite: String,
    /** "An embedded page at %1$s says": a frame of another origin (…_TITLE_IFRAME). */
    val titleEmbedded: String,
    /** "An embedded page on this page says": a frame of another, opaque origin (…_TITLE_NONSTANDARD_URL_IFRAME). */
    val titleEmbeddedNoSite: String,
    /** "This page says": a file, `data:` or `about:` document (…_TITLE_NONSTANDARD_URL). */
    val titleNoSite: String,
    /** "Leave site?" */
    val leaveTitle: String,
    /** "Reload site?" */
    val reloadTitle: String,
    /** "Changes you made may not be saved." – ours, under either question. */
    val leaveMessage: String,
    /** "Don't let this page create more dialogs" – the checkbox from a page's second dialog on. */
    val suppress: String,
    /** The secondary peer. */
    val cancel: String,
    /** The primary of an alert, a confirm and a prompt. */
    val ok: String,
    /** The primary of "Leave site?". */
    val leave: String,
    /** The primary of "Reload site?". */
    val reload: String
) {
    /** Chrome's title line for a page's own dialog, from the frame's [PageDialogSpec.site] and whether it is embedded. */
    fun title(site: String, embedded: Boolean): String = when {
        embedded && site.isNotEmpty() -> String.format(titleEmbedded, site)
        embedded -> titleEmbeddedNoSite
        site.isNotEmpty() -> String.format(titleSite, site)
        else -> titleNoSite
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
