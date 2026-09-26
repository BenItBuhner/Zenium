package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The custom tab's permission prompt on the native sheet (W6-S11, the #515 gate's follow-up): the
 * custom tab asks with [PermissionPromptSheet] and no Material alert, in its own scheme, the
 * family's question naming the site's host with the pair Block | Allow and Allow the accent
 * primary; each permission the engine names has its question; a dismissal answers the request
 * `false` as the dialog's cancel did and remembers nothing; one sheet per window at a time, a
 * request while one is up waiting behind it or sharing its answer. The queue is pure and run; the
 * host's wiring is read from the sources, as `PermissionPromptSheetTest` reads the app window's.
 */
class CustomTabPermissionPromptTest {
    private val root = repoRoot()

    /** Every permission the engine can name (`Permissions.kt`) has the family's question; the rest is refused without asking. */
    @Test
    fun eachPermissionMapsToItsQuestion() {
        assertEquals(R.string.cct_permission_question_camera, CustomTabPermissionPrompt.questionFor("camera"))
        assertEquals(R.string.cct_permission_question_microphone, CustomTabPermissionPrompt.questionFor("microphone"))
        assertEquals(R.string.cct_permission_question_media, CustomTabPermissionPrompt.questionFor("media"))
        assertEquals(R.string.cct_permission_question_location, CustomTabPermissionPrompt.questionFor("geolocation"))
        assertEquals(R.string.cct_permission_question_protected_media, CustomTabPermissionPrompt.questionFor("mediaKeySystem"))
        assertNull(CustomTabPermissionPrompt.questionFor("notifications"))
        assertNull(CustomTabPermissionPrompt.questionFor("midiSysex"))
        assertNull(CustomTabPermissionPrompt.questionFor(""))
    }

    /** The questions name the requester in the `%1$s` shape the sheet fills with the host, and the old fragments are gone. */
    @Test
    fun theQuestionsNameTheHost() {
        val strings = File(root, "android/app/src/main/res/values/strings.xml").readText()
        assertEquals("Allow %1\$s to use your camera?", string(strings, "cct_permission_question_camera"))
        assertEquals("Allow %1\$s to use your microphone?", string(strings, "cct_permission_question_microphone"))
        assertEquals("Allow %1\$s to use your camera and microphone?", string(strings, "cct_permission_question_media"))
        assertEquals("Allow %1\$s to know your location?", string(strings, "cct_permission_question_location"))
        assertEquals("Allow %1\$s to play protected content?", string(strings, "cct_permission_question_protected_media"))
        assertEquals("Block", string(strings, "cct_block"))
        assertEquals("Allow", string(strings, "cct_allow"))
        assertFalse("the dialog's title is gone", strings.contains("cct_permission_message"))
        for (fragment in listOf("cct_permission_camera", "cct_permission_microphone", "cct_permission_media", "cct_permission_location", "cct_permission_protected_media")) {
            assertFalse("the dialog's fragment $fragment is gone", strings.contains("\"$fragment\""))
        }
    }

    /** The custom tab asks on the sheet in its scheme, the site as the requester, Block | Allow with Allow the primary, and no alert dialog. */
    @Test
    fun theCustomTabsAskIsTheSheetNotAnAlert() {
        val host = File(root, "android/app/src/main/kotlin/app/zen/chromium/CustomTabHost.kt").readText()
        val ask = Regex("""private fun askPermission\(args: JSONObject\) \{([\s\S]*?)\n    \}""").find(host)?.groupValues?.get(1) ?: error("CustomTabHost.kt has no askPermission")
        val show = Regex("""private fun showPermissionPrompt\(\) \{([\s\S]*?)\n    \}""").find(host)?.groupValues?.get(1) ?: error("CustomTabHost.kt has no showPermissionPrompt")
        assertFalse("askPermission builds no alert dialog", ask.contains("MaterialAlertDialogBuilder") || ask.contains("AlertDialog"))
        assertFalse("the sheet's show builds no alert dialog", show.contains("MaterialAlertDialogBuilder") || show.contains("AlertDialog"))
        assertTrue(show.contains("PermissionPromptSheet("))
        assertTrue("the sheet is in the tab's resolved scheme", Regex("""PermissionPromptSheet\(\s*activity,\s*themeDark,""").containsMatchIn(show))
        assertTrue("the site's host is the requester", ask.contains("hostOf(args.str(\"url\"))") && show.contains("requester = ask.site"))
        assertTrue("the permission's question is the title", ask.contains("CustomTabPermissionPrompt.questionFor(args.str(\"permission\"))") && show.contains("question = ask.question"))
        assertTrue("Block is the leading, plain peer", show.contains("block = activity.getString(R.string.cct_block)"))
        assertTrue("Allow is the accent primary", show.contains("allow = NativePromptSheet.Peer(activity.getString(R.string.cct_allow), NativePromptSheet.Tone.ACCENT)"))
        assertFalse("no glyph: the question names the site", show.contains("glyph"))
        assertTrue("a kind without a question is refused without asking", ask.contains("permissions.respond(requestId, false)"))
        assertTrue("a finishing window asks nothing", ask.contains("activity.isFinishing || activity.isDestroyed"))
    }

    /** Allow grants; Block and a dismissal refuse the request the same way, and nothing is written: the page's next ask asks again. */
    @Test
    fun aDismissalAnswersFalseAndRemembersNothing() {
        val host = File(root, "android/app/src/main/kotlin/app/zen/chromium/CustomTabHost.kt").readText()
        val show = Regex("""private fun showPermissionPrompt\(\) \{([\s\S]*?)\n    \}""").find(host)?.groupValues?.get(1) ?: error("CustomTabHost.kt has no showPermissionPrompt")
        assertTrue("only ALLOWED grants: BLOCKED and DISMISSED answer false", show.contains("val allow = answer == PermissionPromptSheet.Answer.ALLOWED"))
        assertTrue("every request of the ask gets the one answer", show.contains("for (id in ask.requestIds) permissions.respond(id, allow)"))
        assertTrue("one answer per sheet", show.contains("if (answered) return@PermissionPromptSheet"))
        for (memory in listOf("SharedPreferences", "getSharedPreferences", "SiteDecisions", "GeolocationPermissions.getInstance", "remember(")) {
            assertFalse("a custom tab keeps no site decision ($memory)", host.contains(memory))
        }
        assertTrue("the next ask waiting comes up once this one is answered", show.contains("permissionAsks.settle()") && show.contains("showPermissionPrompt()"))
        val destroy = Regex("""fun destroy\(\) \{([\s\S]*?)\n    \}""").find(host)?.groupValues?.get(1) ?: error("CustomTabHost.kt has no destroy")
        assertTrue("the window's end takes the sheet down without an answer", destroy.contains("permissionPrompt?.dismiss()") && destroy.contains("permissionAsks.clear()"))
        // The 'Open in app' confirm is out of this change's scope and stays the dialog it was.
        assertTrue(Regex("""private fun askExternal\(args: JSONObject\) \{[\s\S]*?MaterialAlertDialogBuilder\(activity\)""").containsMatchIn(host))
    }

    /** One sheet per window: a second request waits behind the first, or shares its answer when it asks the same question of the same site. */
    @Test
    fun oneSheetAtATimeAndTheSameQuestionSharesItsAnswer() {
        val queue = CustomTabPermissionPrompt.Queue()
        assertNull(queue.current)
        assertTrue("the first request brings a sheet up", queue.add("perm_1", R.string.cct_permission_question_location, "maps.example"))
        assertFalse("the same question of the same site joins the sheet up", queue.add("perm_2", R.string.cct_permission_question_location, "maps.example"))
        assertFalse("another question waits behind it", queue.add("perm_3", R.string.cct_permission_question_camera, "maps.example"))
        assertFalse("the same question of another site is its own ask", queue.add("perm_4", R.string.cct_permission_question_location, "other.example"))
        assertFalse("a request for a waiting ask joins that ask", queue.add("perm_5", R.string.cct_permission_question_camera, "maps.example"))
        assertEquals(3, queue.size)
        assertEquals(listOf("perm_1", "perm_2"), queue.current?.requestIds)
        val first = queue.settle()
        assertEquals(listOf("perm_1", "perm_2"), first?.requestIds)
        assertEquals("the camera ask is up next", R.string.cct_permission_question_camera, queue.current?.question)
        assertEquals(listOf("perm_3", "perm_5"), queue.current?.requestIds)
        queue.settle()
        assertEquals("other.example", queue.current?.site)
        assertTrue("with the queue empty again, a request brings a sheet up", queue.settle() != null && queue.add("perm_6", R.string.cct_permission_question_camera, "maps.example"))
        queue.clear()
        assertNull(queue.current)
        assertNull(queue.settle())
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
