package app.zen.chromium

import app.zen.chromium.PredictiveBack.Target
import org.junit.Assert.assertEquals
import org.junit.Test

class PredictiveBackTest {
    private fun decide(
        fullscreen: Boolean = false,
        chrome: Boolean = false,
        immersive: Boolean = false,
        pageCanGoBack: Boolean = false,
        root: Boolean = false
    ) = PredictiveBack.decideTarget(fullscreen, chrome, immersive, pageCanGoBack, root)

    @Test
    fun `a page's fullscreen ends before anything else, whatever the chrome or the page could do`() {
        assertEquals(Target.FULLSCREEN, decide(fullscreen = true))
        assertEquals(Target.FULLSCREEN, decide(fullscreen = true, chrome = true, immersive = true, pageCanGoBack = true, root = true))
    }

    @Test
    fun `a chrome surface closes before the page navigates`() {
        assertEquals(Target.CHROME, decide(chrome = true, pageCanGoBack = true, root = true))
        assertEquals(Target.CHROME, decide(chrome = true))
    }

    @Test
    fun `the app's own fullscreen is left before the page navigates, but after a chrome surface closes`() {
        assertEquals(Target.FULLSCREEN, decide(immersive = true, pageCanGoBack = true, root = true))
        assertEquals(Target.CHROME, decide(chrome = true, immersive = true))
    }

    @Test
    fun `the page goes back while it has history`() {
        assertEquals(Target.PAGE, decide(pageCanGoBack = true))
        assertEquals(Target.PAGE, decide(pageCanGoBack = true, root = true))
    }

    @Test
    fun `at the first page the chrome's root back runs instead of leaving the app`() {
        assertEquals(Target.ROOT, decide(root = true))
    }

    @Test
    fun `with nothing to do the system's own back runs`() {
        assertEquals(Target.NONE, decide())
    }
}
