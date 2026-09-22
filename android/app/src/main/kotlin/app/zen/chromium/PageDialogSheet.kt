package app.zen.chromium

/**
 * A page's dialog as Zenium's sheet (PUI-27, PUI-28): one [PageDialogSpec] on the §9.23 chassis,
 * [NativePromptSheet] – the numbers, the inks, the fade, the scrim / back / grip as the
 * secondary and the TalkBack pose are the chassis's; this class only says what goes in its slots.
 * See [PageDialogSpec] for why the chrome's own `PageDialog` cannot draw it here (v2 §9.23 names
 * the page's dialogs as the chassis's second consumer, on that proof).
 *
 * The slots ([content]): Chrome's title line ("example.com says", "Leave site?") in the pinned
 * block; the PAGE's message as body copy – 15/400 in the text ink, the page's words are what the
 * user came to read – for an `alert` and a `confirm`; for a `prompt` the message is the §9.12
 * field's LABEL, the field prefilled with the page's default and its value selected, so the first
 * keystroke replaces it, as Chrome's; a `beforeunload` question keeps OUR sentence ("Changes you
 * made may not be saved.") as the description at 69 %, since it is not the page's. From the page's
 * second dialog of a visit on, Chrome's §9.14 check row; Cancel as the secondary peer except on an
 * alert, which has OK alone; OK / Leave / Reload as the accent primary.
 *
 * Answering: the primary accepts (the prompt's text with it; the field's Done key is the
 * primary), and Cancel, the scrim, the system back and the grip answer as a cancel – an alert is
 * dismissed either way. One answer per sheet.
 */
class PageDialogSheet(
    host: PageHost,
    private val spec: PageDialogSpec,
    /**
     * The answer, once: `accepted` with the prompt's `value` (null for every other kind) and
     * whether the check row was ticked.
     */
    private val onAnswer: (accepted: Boolean, value: String?, suppress: Boolean) -> Unit
) {
    private val sheet = NativePromptSheet(
        host.activity,
        // The theme in force, with the accent the chrome handed over for the primary (`chrome.setTheme`).
        V2Ink(host.activity, host.themeDark, host.themeAccent, host.themeOnAccent),
        content(spec)
    ) { answer ->
        val value = if (answer.accepted && spec.kind == PageDialogKind.PROMPT) answer.text ?: "" else null
        onAnswer(answer.accepted, value, answer.checked)
    }

    fun show() = sheet.show()

    /** The page went (its view destroyed, its tab closed): the sheet goes without an answer of its own. */
    fun dismiss() = sheet.dismiss()

    companion object {
        /** Chrome's secondary peer. */
        const val CANCEL_LABEL = "Cancel"

        /** What of `spec` goes into which slot of the chassis (pure; see the class comment). */
        fun content(spec: PageDialogSpec): NativePromptSheet.Content {
            val ours = spec.kind == PageDialogKind.LEAVE || spec.kind == PageDialogKind.RELOAD
            val prompt = spec.kind == PageDialogKind.PROMPT
            val message = spec.message.takeIf { it.isNotEmpty() }
            return NativePromptSheet.Content(
                title = spec.title,
                description = if (ours) message else null,
                body = if (ours || prompt) null else message,
                field = if (prompt) NativePromptSheet.Field(text = spec.defaultValue, label = message) else null,
                check = if (spec.suppressible) PageDialogSpec.SUPPRESS_LABEL else null,
                secondary = if (spec.cancellable) CANCEL_LABEL else null,
                primary = NativePromptSheet.Peer(spec.acceptLabel)
            )
        }
    }
}
