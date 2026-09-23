package app.zen.chromium

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageDialogsTest {
    /**
     * `strings.xml`'s `page_dialog_*` as the device would read them (aapt's `\'` unescaped), so
     * every test below composes on the resource formats themselves, not on copies of them.
     */
    private val strings: Map<String, String> = Regex("""<string name="page_dialog_(\w+)">(.*?)</string>""")
        .findAll(source("android/app/src/main/res/values/strings.xml"))
        .associate { it.groupValues[1] to it.groupValues[2].replace("\\'", "'") }

    private val words = PageDialogWords(
        titleSite = strings.getValue("title_site"),
        titleEmbedded = strings.getValue("title_embedded"),
        titleEmbeddedNoSite = strings.getValue("title_embedded_no_site"),
        titleNoSite = strings.getValue("title_no_site"),
        leaveTitle = strings.getValue("leave_title"),
        reloadTitle = strings.getValue("reload_title"),
        leaveMessage = strings.getValue("leave_message"),
        suppress = strings.getValue("suppress"),
        cancel = strings.getValue("cancel"),
        ok = strings.getValue("ok"),
        leave = strings.getValue("leave"),
        reload = strings.getValue("reload")
    )

    // --- the visit: Chrome's checkbox from the second dialog on, its silencing until a navigation ---

    @Test
    fun firstDialogOffersNoCheckboxTheSecondDoes() {
        val visit = PageDialogVisit()
        assertEquals(false, visit.request())
        assertEquals(true, visit.request())
        assertEquals(true, visit.request())
        assertEquals(3, visit.shown)
        assertFalse(visit.suppressed)
    }

    @Test
    fun anUntickedCheckboxSilencesNothing() {
        val visit = PageDialogVisit()
        visit.request()
        visit.answered(suppress = false)
        assertEquals(true, visit.request())
    }

    @Test
    fun aTickedCheckboxAnswersEveryLaterDialogAtOnce() {
        val visit = PageDialogVisit()
        visit.request()
        visit.request()
        visit.answered(suppress = true)
        assertTrue(visit.suppressed)
        assertNull(visit.request())
        assertNull(visit.request())
        // Nothing was shown for them.
        assertEquals(2, visit.shown)
    }

    @Test
    fun aNavigationEndsTheVisit() {
        val visit = PageDialogVisit()
        visit.request()
        visit.request()
        visit.answered(suppress = true)
        visit.reset()
        assertFalse(visit.suppressed)
        assertEquals(0, visit.shown)
        // The next page starts over: its first dialog shows, without the checkbox.
        assertEquals(false, visit.request())
    }

    // --- the wording: Chrome's lines in strings.xml, the title line, the beforeunload question, the buttons ---

    @Test
    fun theWordsAreChromesAndEveryOneIsReadBySheet() {
        // Chrome's IDS_JAVASCRIPT_MESSAGEBOX_* and IDS_BEFOREUNLOAD_* / IDS_BEFORERELOAD_* lines, the
        // site as `%1$s` where Chrome has its placeholder.
        assertEquals(
            mapOf(
                "title_site" to "%1\$s says",
                "title_embedded" to "An embedded page at %1\$s says",
                "title_embedded_no_site" to "An embedded page on this page says",
                "title_no_site" to "This page says",
                "leave_title" to "Leave site?",
                "reload_title" to "Reload site?",
                "leave_message" to "Changes you made may not be saved.",
                "suppress" to "Don't let this page create more dialogs",
                "cancel" to "Cancel",
                "ok" to "OK",
                "leave" to "Leave",
                "reload" to "Reload"
            ),
            strings
        )
        // The sheet reads each of them and nothing else: a line added to one side alone fails here.
        val read = Regex("""R\.string\.page_dialog_(\w+)""")
            .findAll(source("android/app/src/main/kotlin/app/zen/chromium/PageDialogSheet.kt"))
            .map { it.groupValues[1] }
            .toSet()
        assertEquals(strings.keys, read)
        // No English of its own left in the spec or the sheet.
        for (file in listOf("PageDialogs.kt", "PageDialogSheet.kt")) {
            val code = source("android/app/src/main/kotlin/app/zen/chromium/$file").lines().filter { !it.trimStart().startsWith("*") && !it.trimStart().startsWith("/") }
            for (line in listOf(" says\"", "\"Cancel\"", "\"OK\"", "\"Leave", "\"Reload", "Don't let", "may not be saved"))
                assertFalse("$file still has $line", code.any { it.contains(line) })
        }
    }

    @Test
    fun theSiteIsTheHostOfAnHttpPageWithItsPort() {
        assertEquals("example.com", PageDialogSpec.site("https://example.com/a/b?c"))
        assertEquals("127.0.0.1:18138", PageDialogSpec.site("http://127.0.0.1:18138/"))
        assertEquals("", PageDialogSpec.site("file:///sdcard/page.html"))
        assertEquals("", PageDialogSpec.site("data:text/html,hi"))
        assertEquals("", PageDialogSpec.site("about:blank"))
        assertEquals("", PageDialogSpec.site("not a url"))
    }

    @Test
    fun aFrameOfAnotherOriginIsEmbedded() {
        assertFalse(PageDialogSpec.embedded("https://example.com/frame", "https://example.com/"))
        assertTrue(PageDialogSpec.embedded("https://ads.example.net/", "https://example.com/"))
        assertTrue(PageDialogSpec.embedded("http://example.com/", "https://example.com/"))
        // `about:blank` and `about:srcdoc` frames inherit their parent's origin.
        assertFalse(PageDialogSpec.embedded("about:blank", "https://example.com/"))
        assertFalse(PageDialogSpec.embedded("about:srcdoc", "https://example.com/"))
    }

    @Test
    fun titlesAreChromes() {
        assertEquals("example.com says", words.title("example.com", embedded = false))
        assertEquals("127.0.0.1:18138 says", words.title("127.0.0.1:18138", embedded = false))
        assertEquals("This page says", words.title("", embedded = false))
        assertEquals("An embedded page at ads.example.net says", words.title("ads.example.net", embedded = true))
        // A frame of an opaque origin (a `data:` frame on an https page): Chrome's …_NONSTANDARD_URL_IFRAME line.
        assertEquals("An embedded page on this page says", words.title("", embedded = true))
    }

    @Test
    fun aPageDialogCarriesItsKindSiteMessageAndDefault() {
        val prompt = PageDialogSpec.page(PageDialogKind.PROMPT, "https://example.com/", "https://example.com/", "Name?", "Ada", suppressible = true)
        assertEquals("example.com", prompt.site)
        assertFalse(prompt.embedded)
        assertEquals("example.com says", prompt.title(words))
        assertEquals("Name?", prompt.message)
        assertEquals("Ada", prompt.defaultValue)
        assertTrue(prompt.suppressible)
        assertTrue(prompt.cancellable)
        assertFalse(prompt.ours)
        assertEquals("OK", prompt.acceptLabel(words))
        // Only a prompt has a field: a confirm's default is dropped.
        val confirm = PageDialogSpec.page(PageDialogKind.CONFIRM, "https://example.com/", "https://example.com/", "Sure?", "x", suppressible = false)
        assertEquals("", confirm.defaultValue)
        val alert = PageDialogSpec.page(PageDialogKind.ALERT, "https://example.com/", "https://example.com/", "Hi", "", suppressible = false)
        assertFalse(alert.cancellable)
        // A frame of another origin is titled after its own site, an opaque one after none.
        val framed = PageDialogSpec.page(PageDialogKind.ALERT, "https://ads.example.net/f", "https://example.com/", "Hi", "", suppressible = false)
        assertEquals("ads.example.net", framed.site)
        assertTrue(framed.embedded)
        assertEquals("An embedded page at ads.example.net says", framed.title(words))
        val opaque = PageDialogSpec.page(PageDialogKind.ALERT, "data:text/html,hi", "https://example.com/", "Hi", "", suppressible = false)
        assertEquals("", opaque.site)
        assertTrue(opaque.embedded)
        assertEquals("An embedded page on this page says", opaque.title(words))
    }

    @Test
    fun beforeUnloadAsksToLeaveOrToReload() {
        val leave = PageDialogSpec.beforeUnload(reload = false)
        assertEquals(PageDialogKind.LEAVE, leave.kind)
        assertTrue(leave.ours)
        assertEquals("Leave site?", leave.title(words))
        // The sentence is ours (the words'), not a message of the page's.
        assertEquals("", leave.message)
        assertEquals("Leave", leave.acceptLabel(words))
        assertTrue(leave.cancellable)
        assertFalse(leave.suppressible)
        val reload = PageDialogSpec.beforeUnload(reload = true)
        assertTrue(reload.ours)
        assertEquals("Reload site?", reload.title(words))
        assertEquals("Reload", reload.acceptLabel(words))
    }

    // --- the slots on the §9.23 chassis (PageDialogSheet.content) ---

    @Test
    fun thePagesMessageIsBodyCopyAndTheCheckRowComesFromTheSecondDialog() {
        val alert = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.ALERT, "https://example.com/", "https://example.com/", "Hello from the page.", "", suppressible = false), words)
        assertEquals("example.com says", alert.title)
        // R1: the page's words are body copy in the text ink, not our 69 % description.
        assertEquals("Hello from the page.", alert.body)
        assertNull(alert.description)
        assertNull(alert.field)
        assertNull(alert.check)
        // An alert has OK alone.
        assertNull(alert.secondary)
        assertEquals("OK", alert.primary.label)
        assertEquals(NativePromptSheet.Tone.ACCENT, alert.primary.tone)

        val confirm = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.CONFIRM, "https://example.com/", "https://example.com/", "Delete the draft?", "", suppressible = true), words)
        assertEquals("Delete the draft?", confirm.body)
        assertEquals("Don't let this page create more dialogs", confirm.check)
        assertEquals("Cancel", confirm.secondary)
        assertEquals("OK", confirm.primary.label)
    }

    @Test
    fun aPromptsMessageIsTheFieldsLabelAndItsDefaultTheFieldsText() {
        val prompt = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.PROMPT, "https://example.com/", "https://example.com/", "What is your name?", "Ada", suppressible = false), words)
        // R2: the message labels the field; nothing of it in the body or the description.
        assertNull(prompt.body)
        assertNull(prompt.description)
        assertEquals("What is your name?", prompt.field?.label)
        assertEquals("Ada", prompt.field?.text)
        assertEquals("Cancel", prompt.secondary)
        // prompt() with no message: the field alone, unlabelled.
        val bare = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.PROMPT, "https://example.com/", "https://example.com/", "", "", suppressible = false), words)
        assertNull(bare.field?.label)
        assertEquals("", bare.field?.text)
    }

    @Test
    fun beforeUnloadKeepsOurSentenceAsTheDescription() {
        val leave = PageDialogSheet.content(PageDialogSpec.beforeUnload(reload = false), words)
        assertEquals("Leave site?", leave.title)
        // Our sentence, not the page's: the description at 69 %.
        assertEquals("Changes you made may not be saved.", leave.description)
        assertNull(leave.body)
        assertNull(leave.field)
        assertNull(leave.check)
        assertEquals("Cancel", leave.secondary)
        assertEquals("Leave", leave.primary.label)
        assertEquals("Reload", PageDialogSheet.content(PageDialogSpec.beforeUnload(reload = true), words).primary.label)
    }

    private companion object {
        /** A source file by its path from the repository root, wherever Gradle runs the test from. */
        fun source(path: String): String {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return File(dir, path).readText()
                dir = dir.parentFile
            }
            error("$path: no repository root above ${File(".").absolutePath}")
        }
    }
}
