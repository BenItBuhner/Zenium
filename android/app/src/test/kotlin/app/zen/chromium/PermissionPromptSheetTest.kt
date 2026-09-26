package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The permission prompt on the native sheet ([PermissionPromptSheet], v2 §9.23): the chassis's
 * two-way answer read as the family's three – Allow a record, Block a record, a dismissal (the
 * scrim, the system back, the grabber) nothing written – with the chassis telling the grabber and
 * the scrim from the secondary peer ([NativePromptSheet.Answer.dismissed]); the installed app's
 * window asks with it and no Material alert, in the theme's inks for its light or dark, the
 * question naming the app and the pair Block | Allow with Allow the accent primary (§9.29).
 * Read from the sources, as the other chassis pins are; the sheet's numbers are
 * `V2TokensPinTest`'s.
 */
class PermissionPromptSheetTest {
    private val root = repoRoot()

    @Test
    fun theAnswerIsThreeWay() {
        assertEquals(PermissionPromptSheet.Answer.ALLOWED, PermissionPromptSheet.answerOf(NativePromptSheet.Answer(accepted = true, text = null, checked = false)))
        assertEquals(PermissionPromptSheet.Answer.BLOCKED, PermissionPromptSheet.answerOf(NativePromptSheet.Answer(accepted = false, text = null, checked = false)))
        assertEquals(PermissionPromptSheet.Answer.DISMISSED, PermissionPromptSheet.answerOf(NativePromptSheet.Answer(accepted = false, text = null, checked = false, dismissed = true)))
        // The primary's answer is the grant whatever else the chassis says of it.
        assertEquals(PermissionPromptSheet.Answer.ALLOWED, PermissionPromptSheet.answerOf(NativePromptSheet.Answer(accepted = true, text = null, checked = false, dismissed = true)))
        // The chassis's flag is additive: every consumer before this one built the answer without it.
        assertFalse(NativePromptSheet.Answer(accepted = false, text = null, checked = false).dismissed)
    }

    /** The chassis tells a dismissal from the secondary peer's tap, and only a declining answer can be one. */
    @Test
    fun theChassisTellsADismissalFromTheSecondary() {
        val chassis = File(root, "android/app/src/main/kotlin/app/zen/chromium/NativePromptSheet.kt").readText()
            .replace(Regex("""/\*[\s\S]*?\*/"""), "")
            .replace(Regex("""//[^\n]*"""), "")
        assertTrue("the scrim and the system back answer as a dismissal", chassis.contains("answer(accepted = false, dismissed = true)"))
        assertTrue("the grabber's tap is a dismissal", chassis.contains("strip.setOnClickListener { dismissByGrabber() }"))
        assertTrue("the secondary peer's tap is the declining answer, chosen", chassis.contains("row.addView(button(label, Tone.PLAIN) { decline() }, peer())"))
        val decline = Regex("""private fun decline\(\) \{([\s\S]*?)\n    \}""").find(chassis)?.groupValues?.get(1) ?: error("NativePromptSheet.kt has no decline()")
        assertTrue("decline() carries no dismissal", decline.contains("answer(accepted = false)") && !decline.contains("dismissed"))
        assertTrue("an accepting answer is never a dismissal", chassis.contains("dismissed = dismissed && !accepted"))
    }

    /** The sheet is the chassis in the theme's inks: no accent of the requester's, no colour or alert of its own. */
    @Test
    fun theSheetIsTheChassisInTheThemesInks() {
        val sheet = File(root, "android/app/src/main/kotlin/app/zen/chromium/PermissionPromptSheet.kt").readText()
            .replace(Regex("""/\*[\s\S]*?\*/"""), "")
            .replace(Regex("""//[^\n]*"""), "")
        assertTrue(sheet.contains("val ink = V2Ink(context, dark)"))
        assertTrue(sheet.contains("NativePromptSheet(context, ink, content)"))
        assertTrue("the question names the requester", sheet.contains("title = context.getString(question, requester)"))
        assertTrue("Block is the leading, plain peer", sheet.contains("secondary = block"))
        assertTrue("Allow is the primary", sheet.contains("primary = allow"))
        assertFalse(sheet.contains("AlertDialog"))
        assertFalse(sheet.contains("R.color."))
        assertFalse(sheet.contains("Tone.DANGER"))
    }

    /** The installed app's window asks on the sheet, in its scheme's light or dark, and writes what the pair says and nothing for a dismissal. */
    @Test
    fun theWindowsPromptIsTheSheetNotAnAlert() {
        val window = File(root, "android/app/src/main/kotlin/app/zen/chromium/WebAppNotifications.kt").readText()
        assertTrue(window.contains("PermissionPromptSheet("))
        assertTrue("the theme's light or dark is the window's scheme", window.contains("activity.scheme.dark"))
        assertTrue(window.contains("question = R.string.webapp_notifications_question"))
        assertTrue(window.contains("block = activity.getString(R.string.cct_block)"))
        assertTrue("Allow is the accent primary", window.contains("allow = NativePromptSheet.Peer(activity.getString(R.string.cct_allow), NativePromptSheet.Tone.ACCENT)"))
        assertTrue(window.contains("PermissionPromptSheet.Answer.ALLOWED -> settle(ALLOW)"))
        assertTrue(window.contains("PermissionPromptSheet.Answer.BLOCKED -> settle(DENY)"))
        assertTrue("a dismissal writes nothing", window.contains("PermissionPromptSheet.Answer.DISMISSED -> settle(null)"))
        assertTrue("only a decision is remembered", window.contains("if (decision != null) remember(decision)"))
        assertFalse(window.contains("MaterialAlertDialogBuilder"))
        assertFalse(window.contains("AlertDialog"))
        assertTrue("the window's end takes the sheet down without an answer", window.contains("prompt?.dismiss()"))
    }

    /** The family's question names the requester; the pair is the Custom Tab's Block and Allow. */
    @Test
    fun theQuestionNamesTheRequester() {
        val strings = File(root, "android/app/src/main/res/values/strings.xml").readText()
        assertEquals("Allow %1\$s to show notifications?", string(strings, "webapp_notifications_question"))
        assertEquals("Block", string(strings, "cct_block"))
        assertEquals("Allow", string(strings, "cct_allow"))
        assertFalse("the alert's fragment is gone", strings.contains("webapp_permission_notifications"))
    }

    private fun string(xml: String, name: String): String =
        Regex("""<string name="$name">([^<]*)</string>""").find(xml)?.groupValues?.get(1) ?: error("strings.xml has no $name")

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
