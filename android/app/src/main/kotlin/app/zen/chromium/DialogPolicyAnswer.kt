package app.zen.chromium

import org.json.JSONObject

/**
 * An AI agent's dialog policy on the phone (the core's `browser_dialog_policy`,
 * `HostCapabilities.agentDialogPolicy`; `src/android/agentDialogs.ts`): what the page's
 * `alert` / `confirm` / `prompt` and its "Leave site?" come to on a tab an agent drives while
 * the user is not looking at it. The WebView's one renderer waits in the page's call for every
 * page and for the chrome, so nothing could hold such a dialog for the agent to answer later
 * (`PageDialogsDemo` scenario 9): the agent says ahead of the action how each kind is to be
 * answered, the core hands the tab's effective policy down (`view.setDialogPolicy`,
 * [TabWebView.dialogPolicy]), and the `WebChromeClient` answers from it at once – the default
 * for a kind the policy leaves out: alert OK, confirm Cancel, prompt Cancel, "Leave site?"
 * leave – and reports every answer (the `pageDialogAnswered` view event, [Report]) for the
 * agent's next result. The host never spends a `once` rule itself: the core does on the
 * report and hands the view what is left.
 *
 * Whose a dialog is follows the core's `AgentService.takesLeave`, in its order: the host must
 * have the policy at all (`PageHost.pageDialogs`: a custom tab keeps the WebView's own
 * dialogs; the callers check it first); an unload check the USER started – a tab's close, the
 * app's exit (`TabWebView.confirmUnload`, the core's `unloadingForUser`) – is never the
 * policy's, whoever's tab it is ([UnloadObjection] settles it as leave, no sheet); a tab the
 * user is LOOKING at follows the user's own choices, sheet and all, policy or not; and only a
 * tab an agent drives hidden ([TabWebView.agentDriven], the core's word at each of its actions,
 * cleared by a show) is the policy's. Anything else is today's path, byte for byte
 * ([Decision.Today]). "Shown" is the view drawn (`View.isShown`), not [UnloadObjection.inFront]:
 * a tab the agent opened in the background and the user never visited has never been behind
 * another tab by the host's pass ([BackgroundTabRule]) and would read as in front there, yet it
 * is the commonest hidden agent tab there is; a drawn view, whatever the pass last said, is in
 * front of the user.
 *
 * Free of Android types, so the table runs under plain JUnit (`DialogPolicyAnswerTest`).
 */
object DialogPolicyAnswer {
    /**
     * The line Chrome shows in a "Leave site?" whatever the page set; what a report of one
     * carries (the core's `LEAVE_SITE_MESSAGE`).
     */
    const val LEAVE_SITE_MESSAGE = "Changes you made may not be saved."

    /** The core quotes a dialog's message capped here; the report carries no more. */
    const val MESSAGE_CAP = 500

    /**
     * What the agent said for a kind, or what a dialog was answered with (the core's
     * `AgentDialogAnswer`): OK or Cancel for a confirm or a prompt, a prompt's text, leave or
     * stay for a "Leave site?".
     */
    sealed interface Said {
        data object Accept : Said
        data object Dismiss : Said
        data class Text(val text: String) : Said
        data object Leave : Said
        data object Stay : Said
    }

    /**
     * One kind's entry in the tab's effective policy: what the agent said, and whether the
     * tab's own rule (`tab`) or the session-wide one (`session`) says it.
     */
    data class Entry(val said: Said, val rule: String)

    /**
     * The tab's effective policy as the core resolved it (`AgentDialogPolicy`): its own rules
     * over the session-wide ones, kind by kind. A kind left out takes the default answer.
     */
    data class Policy(
        val confirm: Entry? = null,
        val prompt: Entry? = null,
        val beforeunload: Entry? = null
    ) {
        /**
         * An alert has no rule of its own (OK is its only answer): its report carries `tab` when
         * the policy has a kind from the tab's own rules, else `session` when it has any kind.
         */
        val alertRule: String
            get() {
                val entries = listOfNotNull(confirm, prompt, beforeunload)
                return when {
                    entries.any { it.rule == "tab" } -> "tab"
                    entries.isNotEmpty() -> "session"
                    else -> "default"
                }
            }
    }

    /**
     * The report of a dialog answered without its agent (the core's `PageDialogAnswered`): the
     * kind's word, the URL of the document that opened it, its message capped at [MESSAGE_CAP]
     * (Chrome's own line for a "Leave site?", whatever the page set), a prompt's initial text,
     * the answer and the rule that gave it – `default` for a kind the policy left out, or when
     * no policy was handed. [toJson] is the `pageDialogAnswered` view event's payload.
     */
    data class Report(
        val kind: String,
        val url: String,
        val message: String,
        val defaultValue: String?,
        val answer: Said,
        val rule: String
    ) {
        fun toJson(): JSONObject {
            val answerJson: Any = when (val said = answer) {
                Said.Accept -> "accept"
                Said.Dismiss -> "dismiss"
                is Said.Text -> json("text" to said.text)
                Said.Leave -> "leave"
                Said.Stay -> "stay"
            }
            val out = json("kind" to kind, "url" to url, "message" to message)
            if (defaultValue != null) out.put("defaultValue", defaultValue)
            return out.put("answer", answerJson).put("rule", rule)
        }
    }

    sealed interface Decision {
        /**
         * Not the policy's: the view does what it does today – the sheet, a hidden page's
         * dismissal, [UnloadObjection]'s table.
         */
        data object Today : Decision

        /**
         * The policy's: the `JsResult` is answered at once – confirmed when `accepted`, with
         * `text` for a prompt, else cancelled – nothing is shown, and [report] goes to the core
         * as the `pageDialogAnswered` view event.
         */
        data class Answer(val accepted: Boolean, val text: String?, val report: Report) : Decision
    }

    /**
     * The policy `view.setDialogPolicy` carries, or null for the core's `null` (no rule covers
     * the tab). An entry the host cannot read – an answer or a rule that is not one of the
     * core's words – is dropped, and its kind takes the default as a kind left out does; a
     * policy with nothing readable is none.
     */
    fun parse(policy: JSONObject?): Policy? {
        policy ?: return null
        val parsed = Policy(
            confirm = entry(policy.optJSONObject("confirm"), ::confirmSaid),
            prompt = entry(policy.optJSONObject("prompt"), ::promptSaid),
            beforeunload = entry(policy.optJSONObject("beforeunload"), ::leaveSaid)
        )
        val empty = parsed.confirm == null && parsed.prompt == null && parsed.beforeunload == null
        return if (empty) null else parsed
    }

    private fun entry(json: JSONObject?, said: (Any?) -> Said?): Entry? {
        json ?: return null
        val rule = json.str("rule")
        if (rule != "tab" && rule != "session") return null
        return Entry(said(json.opt("answer")) ?: return null, rule)
    }

    private fun confirmSaid(answer: Any?): Said? = when (answer) {
        "accept" -> Said.Accept
        "dismiss" -> Said.Dismiss
        else -> null
    }

    private fun promptSaid(answer: Any?): Said? = when (answer) {
        "accept" -> Said.Accept
        "dismiss" -> Said.Dismiss
        is JSONObject -> answer.strOrNull("text")?.let { Said.Text(it) }
        else -> null
    }

    private fun leaveSaid(answer: Any?): Said? = when (answer) {
        "leave" -> Said.Leave
        "stay" -> Said.Stay
        else -> null
    }

    /**
     * What a dialog of `kind` comes to: today's path, or the policy's answer with its report.
     * `agentDriven` is the core's word on the tab ([TabWebView.agentDriven]), `shown` whether
     * the view is drawn, `userUnload` whether an unload check is in flight
     * ([TabWebView.confirmUnload]); `url` is the document's that opened the dialog, `message`
     * the page's (unused for a "Leave site?", whose line is Chrome's), `defaultValue` a
     * prompt's initial text. The gates stand in the core's order (`takesLeave`): the user's
     * unload, the tab in front, then the agent's tab; the kind's entry or its default last.
     */
    fun decide(
        kind: PageDialogKind,
        policy: Policy?,
        agentDriven: Boolean,
        shown: Boolean,
        userUnload: Boolean,
        url: String,
        message: String?,
        defaultValue: String?
    ): Decision {
        if (userUnload || shown || !agentDriven) return Decision.Today
        val leaving = kind == PageDialogKind.LEAVE || kind == PageDialogKind.RELOAD
        val entry = when (kind) {
            PageDialogKind.ALERT -> null
            PageDialogKind.CONFIRM -> policy?.confirm
            PageDialogKind.PROMPT -> policy?.prompt
            PageDialogKind.LEAVE, PageDialogKind.RELOAD -> policy?.beforeunload
        }
        val said = entry?.said ?: when (kind) {
            PageDialogKind.ALERT -> Said.Accept
            PageDialogKind.CONFIRM, PageDialogKind.PROMPT -> Said.Dismiss
            PageDialogKind.LEAVE, PageDialogKind.RELOAD -> Said.Leave
        }
        val rule = when {
            kind == PageDialogKind.ALERT -> policy?.alertRule
            else -> entry?.rule
        } ?: "default"
        val prompt = kind == PageDialogKind.PROMPT
        // A prompt accepted without text of the agent's is OK with the field's own text, as the
        // core reports it.
        val answered = if (prompt && said == Said.Accept) Said.Text(defaultValue ?: "") else said
        val report = Report(
            kind = when (kind) {
                PageDialogKind.ALERT -> "alert"
                PageDialogKind.CONFIRM -> "confirm"
                PageDialogKind.PROMPT -> "prompt"
                PageDialogKind.LEAVE, PageDialogKind.RELOAD -> "beforeunload"
            },
            url = url,
            message = if (leaving) LEAVE_SITE_MESSAGE else (message ?: "").take(MESSAGE_CAP),
            defaultValue = if (prompt) defaultValue ?: "" else null,
            answer = answered,
            rule = rule
        )
        val accepted = answered is Said.Text || answered == Said.Accept || answered == Said.Leave
        return Decision.Answer(accepted, (answered as? Said.Text)?.text, report)
    }
}
