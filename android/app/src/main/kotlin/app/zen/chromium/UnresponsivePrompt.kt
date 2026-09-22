package app.zen.chromium

import android.content.Context
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable

/**
 * "This page isn't responding" (ERR-16 / OS-36) on the native prompt sheet ([NativePromptSheet],
 * the v2 §9.23 composition drawn with Android views), because the chrome that would draw the
 * sheet runs in the very renderer that has stopped answering. The composition, its numbers and
 * its inks are the chassis's, pinned against main.css by `V2TokensPinTest`; this class says only
 * what the prompt is: the site as the title block's identity – its favicon at the 20 glyph, a
 * globe in the ink for a page without one, the host on one line at 17/600 – our sentence as the
 * 15 description at 69 %, and the §9.11 footer of Wait, the plain peer, and Exit page, the
 * destructive one in the danger ink, no primary. The scrim, the system back and the grabber are
 * Wait, the answer that changes nothing; the motion is the chassis's 120 ms fade in place, the
 * page under the scrim standing still (its WebView is the hung renderer's), no drag.
 */
class UnresponsivePrompt(
    context: Context,
    dark: Boolean,
    site: String,
    favicon: Bitmap?,
    private val onWait: () -> Unit,
    private val onExit: () -> Unit
) {
    private val sheet: NativePromptSheet

    init {
        val ink = V2Ink(context, dark)
        val glyph = if (favicon != null) BitmapDrawable(context.resources, favicon) else ink.glyph(R.drawable.ic_globe)
        val content = NativePromptSheet.Content(
            title = site,
            titleOneLine = true,
            glyph = glyph,
            description = context.getString(R.string.unresponsive_description),
            secondary = context.getString(R.string.unresponsive_wait),
            primary = NativePromptSheet.Peer(context.getString(R.string.unresponsive_exit), NativePromptSheet.Tone.DANGER)
        )
        sheet = NativePromptSheet(context, ink, content) { answer ->
            if (answer.accepted) onExit() else onWait()
        }
    }

    val showing: Boolean get() = sheet.showing

    fun show() = sheet.show()

    /** Take the sheet down without an answer (the renderer answered again, or went). */
    fun dismiss() = sheet.dismiss()
}
