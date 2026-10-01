package app.zen.chromium

import org.json.JSONObject

/**
 * The host's side of an AI agent's page dialogs (OS-40 part B; the core's `agentDialogs`
 * capability, `src/android/views.ts`): while an agent drives a page the layout hides
 * (`TabWebView.agentDriven`, #743), the page's `alert` / `confirm` / `prompt` is not Zenium's
 * sheet – nobody is looking at the page, and the WebView's one renderer waits in the call – but
 * a `pageDialog` view event the core routes to the agent (`PageDialogService.ask` →
 * `takesDialog` → `agents.onPageDialog`, answered with `browser_handle_dialog`), the `JsResult`
 * held meanwhile. The answer comes back as `view.pageDialogAnswer`; `user` says the tab turned
 * out not to be an agent's, and the sheet opens as it would have. The shapes live here, pure,
 * so they run on the JVM; [TabWebView] carries them out.
 *
 * Nothing an agent answers is remembered for the user: the visit's dialog count and its "Don't
 * let this page create more dialogs" ([PageDialogVisit]) never see an agent's dialog. The
 * two-minute default is the core's (`AGENT_DIALOG_TTL_MS`) and reads as a dismissal.
 */
object AgentPageDialogs {
    /** The core's name for a kind (`PageDialogRequest.kind`); a `beforeunload` is never routed ([UnloadObjection]). */
    fun kindName(kind: PageDialogKind): String? = when (kind) {
        PageDialogKind.ALERT -> "alert"
        PageDialogKind.CONFIRM -> "confirm"
        PageDialogKind.PROMPT -> "prompt"
        PageDialogKind.LEAVE, PageDialogKind.RELOAD -> null
    }

    /**
     * The `pageDialog` view event for a dialog the page opened: the core's `PageDialogRequest`
     * (the kind, the message, a prompt's default, the calling frame's URL and the page's, by
     * which it titles the dialog and tells an embedded frame's from the page's own) under the
     * id the answer names. Null for a kind the core is never asked about.
     */
    fun event(
        dialogId: String,
        kind: PageDialogKind,
        frameUrl: String,
        pageUrl: String,
        message: String,
        defaultValue: String
    ): JSONObject? {
        val name = kindName(kind) ?: return null
        return json(
            "dialogId" to dialogId,
            "kind" to name,
            "message" to message,
            "defaultValue" to if (kind == PageDialogKind.PROMPT) defaultValue else "",
            "frameUrl" to frameUrl,
            "pageUrl" to pageUrl
        )
    }

    /** The core's word on a held dialog (`view.pageDialogAnswer`). */
    sealed class Answer {
        /** The tab is not an agent's: Zenium's sheet, as every other tab gets. */
        object User : Answer()
        /** The page hears the dialog was dismissed (the agent's cancel, or the core's default once it waited). */
        object Cancel : Answer()
        /** The page hears OK; a prompt gets `value` (an alert's or a confirm's is nothing). */
        data class Accept(val value: String) : Answer()
    }

    /**
     * The answer the bridge carried. A malformed one dismisses the dialog: the page must not
     * sit in its call, and nothing may open over an agent's page by mistake. An alert is
     * accepted whatever the word, as the core's own `sanitizeResponse` has it.
     */
    fun answer(args: JSONObject, kind: PageDialogKind): Answer = when {
        args.bool("user") -> Answer.User
        kind == PageDialogKind.ALERT -> Answer.Accept("")
        !args.bool("accepted") -> Answer.Cancel
        kind == PageDialogKind.PROMPT -> Answer.Accept(args.strOrNull("value") ?: "")
        else -> Answer.Accept("")
    }
}
