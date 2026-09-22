package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PageDialogsTest {
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

    // --- the wording: Chrome's title line, the beforeunload question, the buttons ---

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
        assertEquals("example.com says", PageDialogSpec.title("example.com", embedded = false))
        assertEquals("This page says", PageDialogSpec.title("", embedded = false))
        assertEquals("An embedded page at ads.example.net says", PageDialogSpec.title("ads.example.net", embedded = true))
        assertEquals("An embedded page says", PageDialogSpec.title("", embedded = true))
    }

    @Test
    fun aPageDialogCarriesItsKindMessageAndDefault() {
        val prompt = PageDialogSpec.page(PageDialogKind.PROMPT, "https://example.com/", "https://example.com/", "Name?", "Ada", suppressible = true)
        assertEquals("example.com says", prompt.title)
        assertEquals("Name?", prompt.message)
        assertEquals("Ada", prompt.defaultValue)
        assertTrue(prompt.suppressible)
        assertTrue(prompt.cancellable)
        assertEquals("OK", prompt.acceptLabel)
        // Only a prompt has a field: a confirm's default is dropped.
        val confirm = PageDialogSpec.page(PageDialogKind.CONFIRM, "https://example.com/", "https://example.com/", "Sure?", "x", suppressible = false)
        assertEquals("", confirm.defaultValue)
        val alert = PageDialogSpec.page(PageDialogKind.ALERT, "https://example.com/", "https://example.com/", "Hi", "", suppressible = false)
        assertFalse(alert.cancellable)
    }

    @Test
    fun beforeUnloadAsksToLeaveOrToReload() {
        val leave = PageDialogSpec.beforeUnload(reload = false)
        assertEquals(PageDialogKind.LEAVE, leave.kind)
        assertEquals("Leave site?", leave.title)
        assertEquals("Changes you made may not be saved.", leave.message)
        assertEquals("Leave", leave.acceptLabel)
        assertTrue(leave.cancellable)
        assertFalse(leave.suppressible)
        val reload = PageDialogSpec.beforeUnload(reload = true)
        assertEquals("Reload site?", reload.title)
        assertEquals("Reload", reload.acceptLabel)
    }

    // --- the slots on the §9.23 chassis (PageDialogSheet.content) ---

    @Test
    fun thePagesMessageIsBodyCopyAndTheCheckRowComesFromTheSecondDialog() {
        val alert = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.ALERT, "https://example.com/", "https://example.com/", "Hello from the page.", "", suppressible = false))
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

        val confirm = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.CONFIRM, "https://example.com/", "https://example.com/", "Delete the draft?", "", suppressible = true))
        assertEquals("Delete the draft?", confirm.body)
        assertEquals(PageDialogSpec.SUPPRESS_LABEL, confirm.check)
        assertEquals("Cancel", confirm.secondary)
        assertEquals("OK", confirm.primary.label)
    }

    @Test
    fun aPromptsMessageIsTheFieldsLabelAndItsDefaultTheFieldsText() {
        val prompt = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.PROMPT, "https://example.com/", "https://example.com/", "What is your name?", "Ada", suppressible = false))
        // R2: the message labels the field; nothing of it in the body or the description.
        assertNull(prompt.body)
        assertNull(prompt.description)
        assertEquals("What is your name?", prompt.field?.label)
        assertEquals("Ada", prompt.field?.text)
        assertEquals("Cancel", prompt.secondary)
        // prompt() with no message: the field alone, unlabelled.
        val bare = PageDialogSheet.content(PageDialogSpec.page(PageDialogKind.PROMPT, "https://example.com/", "https://example.com/", "", "", suppressible = false))
        assertNull(bare.field?.label)
        assertEquals("", bare.field?.text)
    }

    @Test
    fun beforeUnloadKeepsOurSentenceAsTheDescription() {
        val leave = PageDialogSheet.content(PageDialogSpec.beforeUnload(reload = false))
        assertEquals("Leave site?", leave.title)
        // Our sentence, not the page's: the description at 69 %.
        assertEquals("Changes you made may not be saved.", leave.description)
        assertNull(leave.body)
        assertNull(leave.field)
        assertNull(leave.check)
        assertEquals("Cancel", leave.secondary)
        assertEquals("Leave", leave.primary.label)
        assertEquals("Reload", PageDialogSheet.content(PageDialogSpec.beforeUnload(reload = true)).primary.label)
    }
}
