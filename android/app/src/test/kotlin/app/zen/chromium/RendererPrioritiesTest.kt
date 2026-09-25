package app.zen.chromium

import app.zen.chromium.RendererPriorities.IMPORTANT
import app.zen.chromium.RendererPriorities.Policy
import app.zen.chromium.RendererPriorities.WAIVED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererPrioritiesTest {
    /** The chrome, the page in front and `hidden` pages behind it, as the window shows them. */
    private fun browserWindow(hidden: Int, held: Boolean = false): List<Pair<Policy, Boolean>> =
        listOf(RendererPriorities.forChrome(held) to true, RendererPriorities.forPage(true) to true) +
            List(hidden) { RendererPriorities.forPage(false) to false }

    @Test
    fun `the constants are WebView's`() {
        assertEquals(0, WAIVED)
        assertEquals(1, RendererPriorities.BOUND)
        assertEquals(2, IMPORTANT)
    }

    @Test
    fun `a page in front is important, a hidden one waived, both waived with the window`() {
        assertEquals(Policy(IMPORTANT, waivedWhenNotVisible = true), RendererPriorities.forPage(true))
        assertEquals(Policy(WAIVED, waivedWhenNotVisible = true), RendererPriorities.forPage(false))
        assertEquals(IMPORTANT, RendererPriorities.forPage(true).effective(visible = true))
        assertEquals(WAIVED, RendererPriorities.forPage(true).effective(visible = false))
        assertEquals(WAIVED, RendererPriorities.forPage(false).effective(visible = false))
    }

    @Test
    fun `the chrome is important and waived with the window unless held`() {
        assertEquals(Policy(IMPORTANT, waivedWhenNotVisible = true), RendererPriorities.forChrome(held = false))
        assertEquals(Policy(IMPORTANT, waivedWhenNotVisible = false), RendererPriorities.forChrome(held = true))
        assertEquals(WAIVED, RendererPriorities.forChrome(held = false).effective(visible = false))
        assertEquals(IMPORTANT, RendererPriorities.forChrome(held = true).effective(visible = false))
    }

    @Test
    fun `media playing or a capture holds the renderer`() {
        assertFalse(RendererPriorities.held(mediaPlaying = false, capturing = false))
        assertTrue(RendererPriorities.held(mediaPlaying = true, capturing = false))
        assertTrue(RendererPriorities.held(mediaPlaying = false, capturing = true))
        assertTrue(RendererPriorities.held(mediaPlaying = true, capturing = true))
    }

    @Test
    fun `in the foreground the shared renderer stays important whatever the hidden pages ask`() {
        assertEquals(IMPORTANT, RendererPriorities.effective(browserWindow(hidden = 29), windowVisible = true))
        // The overview or a chrome page in front: no page view visible, the chrome alone holds it.
        val chromeOnly = listOf(RendererPriorities.forChrome(false) to true) + List(30) { RendererPriorities.forPage(false) to false }
        assertEquals(IMPORTANT, RendererPriorities.effective(chromeOnly, windowVisible = true))
    }

    @Test
    fun `behind other apps the renderer is waived, the system's cheapest kill`() {
        assertEquals(WAIVED, RendererPriorities.effective(browserWindow(hidden = 29), windowVisible = false))
        assertEquals(WAIVED, RendererPriorities.effective(browserWindow(hidden = 0), windowVisible = false))
    }

    @Test
    fun `behind other apps a held renderer keeps the process's priority`() {
        assertEquals(IMPORTANT, RendererPriorities.effective(browserWindow(hidden = 29, held = true), windowVisible = false))
    }

    @Test
    fun `the platform's default policy is never waived, for comparison`() {
        val default = Policy(IMPORTANT, waivedWhenNotVisible = false)
        assertEquals(IMPORTANT, RendererPriorities.effective(listOf(default to false), windowVisible = false))
    }

    @Test
    fun `no view at all is waived`() {
        assertEquals(WAIVED, RendererPriorities.effective(emptyList(), windowVisible = true))
    }
}
