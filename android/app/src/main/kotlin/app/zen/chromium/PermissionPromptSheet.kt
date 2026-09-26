package app.zen.chromium

import android.content.Context
import android.graphics.drawable.Drawable
import androidx.annotation.StringRes

/**
 * A permission prompt on the native prompt sheet ([NativePromptSheet], the v2 §9.23 composition
 * drawn with Android views): the family's question naming the requester as the title block –
 * "Allow Sketch to show notifications?" at 17/600, wrapping – and §9.11's pair in the footer,
 * the declining peer (Block) leading and plain, the granting peer (Allow) trailing as the accent
 * primary (§9.29: the answer that grants is the one the pair leads to). The composition, its
 * numbers and its inks are the chassis's, pinned against main.css by `V2TokensPinTest`; the inks
 * are the theme's ([V2Ink] in light or dark, the default accent – never a site's or an app's
 * colour); the motion the chassis's 120 ms fade in place. This class says only what the prompt
 * is, as [UnresponsivePrompt] does for its sheet.
 *
 * Three answers, not two. Allow and Block are records the caller writes ([Answer.ALLOWED],
 * [Answer.BLOCKED]); the scrim, the system back and the grabber are a DISMISSAL
 * ([Answer.DISMISSED]) that leaves the question open – nothing written, the page's promise
 * settled the way its host settles an unanswered prompt (`default`), and the page free to ask
 * again on its next gesture. That is the one place the permission family parts from the chassis's
 * rule that a dismissal answers the secondary, and [NativePromptSheet.Answer.dismissed] carries it.
 *
 * Built once for the installed app's window ([WebAppNotifications]); the requester, the question,
 * the pair's labels and the primary are parameters, so the Custom Tab's permission dialog
 * (`CustomTabHost`'s Material alert dialog today) can take the same chassis in its own change.
 */
class PermissionPromptSheet(
    context: Context,
    dark: Boolean,
    /** The requester's name – the installed app's, a site's host – set into the question. */
    requester: CharSequence,
    /** The family's question naming the requester, a template with one `%1$s` for it: "Allow %1$s to show notifications?". */
    @StringRes question: Int,
    /** The declining peer's label (Block): the leading, plain peer. */
    block: CharSequence,
    /** The granting peer and its tone (Allow, the accent): the trailing primary. */
    allow: NativePromptSheet.Peer,
    /** The requester's identity at the title's start (a favicon); none for a question that names it. */
    glyph: Drawable? = null,
    private val onAnswer: (Answer) -> Unit
) {
    /** The prompt's answer: a record to write (allowed, blocked), or a dismissal that writes nothing. */
    enum class Answer { ALLOWED, BLOCKED, DISMISSED }

    private val sheet: NativePromptSheet

    init {
        val ink = V2Ink(context, dark)
        val content = NativePromptSheet.Content(
            title = context.getString(question, requester),
            glyph = glyph,
            secondary = block,
            primary = allow
        )
        sheet = NativePromptSheet(context, ink, content) { answer -> onAnswer(answerOf(answer)) }
    }

    /** Whether the sheet is up. */
    val showing: Boolean get() = sheet.showing

    fun show() = sheet.show()

    /** Take the sheet down without an answer (the window is going). */
    fun dismiss() = sheet.dismiss()

    companion object {
        /** The chassis's answer read as the family's: the primary allows; a declining answer blocks, unless it was a dismissal. */
        fun answerOf(answer: NativePromptSheet.Answer): Answer = when {
            answer.accepted -> Answer.ALLOWED
            answer.dismissed -> Answer.DISMISSED
            else -> Answer.BLOCKED
        }
    }
}
