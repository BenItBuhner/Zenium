package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

class SweepPopupCloseTest {
    private val closing = "the popup came up and closed itself within 640 ms of its render (a popup document's own window.close(), as Chrome shows it)"

    @Test
    fun `a popup that opened its onboarding in a tab and closed is P with the tab as its answer`() {
        val w = SweepPopupClose.word(640, listOf("https://jiidiaalihmmhddjgbnbgdfflelocpak.ext.zenium.invalid/tab.html#/welcome"), emptyList(), null)
        assertEquals("P", w.verdict)
        assertEquals("$closing; tabs after: opened https://jiidiaalihmmhddjgbnbgdfflelocpak.ext.zenium.invalid/tab.html#/welcome", w.note)
    }

    @Test
    fun `a popup that sent the tab under it to a page of its own names the sending`() {
        val w = SweepPopupClose.word(640, emptyList(), listOf("/language.html"), null)
        assertEquals("P", w.verdict)
        assertEquals("$closing; tabs after: sent the tab under it to /language.html", w.note)
    }

    @Test
    fun `a popup that brought its open page to the front names the raising`() {
        val w = SweepPopupClose.word(640, emptyList(), emptyList(), "https://id.ext.zenium.invalid/app.html#/welcome")
        assertEquals("P", w.verdict)
        assertEquals("$closing; tabs after: brought its open page https://id.ext.zenium.invalid/app.html#/welcome to the front", w.note)
    }

    @Test
    fun `every answer is listed, the opened tabs first`() {
        val w = SweepPopupClose.word(640, listOf("https://example.com/a", "https://example.com/b"), listOf("/own.html"), "https://id.ext.zenium.invalid/open.html")
        assertEquals("P", w.verdict)
        assertEquals(
            "$closing; tabs after: opened https://example.com/a, https://example.com/b; sent the tab under it to /own.html; brought its open page https://id.ext.zenium.invalid/open.html to the front",
            w.note
        )
    }

    @Test
    fun `a popup that closed with nothing after it is PARTIAL and says the read is blind`() {
        val w = SweepPopupClose.word(640, emptyList(), emptyList(), null)
        assertEquals("PARTIAL", w.verdict)
        assertEquals("$closing; tabs after: none – what the popup did before its close is not readable after it", w.note)
    }

    @Test
    fun `the close's timing is the word's own`() {
        assertEquals(
            "the popup came up and closed itself within 1810 ms of its render (a popup document's own window.close(), as Chrome shows it); tabs after: opened https://example.com/",
            SweepPopupClose.word(1810, listOf("https://example.com/"), emptyList(), null).note
        )
    }
}
