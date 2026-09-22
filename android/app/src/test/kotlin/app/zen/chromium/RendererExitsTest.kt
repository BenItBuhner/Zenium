package app.zen.chromium

import app.zen.chromium.RendererExits.Exit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererExitsTest {
    private var now = 1_000_000L
    private val exits = RendererExits { now }
    private val front = listOf("tab_1")

    /** A crash in front: the chrome is rebuilt, the rebooted core loads the page, the word is there once. */
    private fun crashAndRebuild(visible: Collection<String> = front): Exit? {
        val exit = exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = visible)
        exits.chromeRebuilt()
        return exit
    }

    @Test
    fun `classification - didCrash is the crash, a kill in front is the memory page, a waived renderer went in the background`() {
        assertEquals(Exit.CRASH, RendererExits.classify(didCrash = true, priorityAtExit = IMPORTANT))
        assertEquals(Exit.MEMORY, RendererExits.classify(didCrash = false, priorityAtExit = IMPORTANT))
        assertEquals(Exit.BACKGROUND, RendererExits.classify(didCrash = false, priorityAtExit = RendererExits.RENDERER_PRIORITY_WAIVED))
        // Even a crash of a renderer nobody was looking at: the pages come back quietly.
        assertEquals(Exit.BACKGROUND, RendererExits.classify(didCrash = true, priorityAtExit = RendererExits.RENDERER_PRIORITY_WAIVED))
    }

    @Test
    fun `the exit's reasons are the core's CrashReason words`() {
        assertEquals("crashed", Exit.CRASH.reason)
        assertEquals("oom-kill", Exit.MEMORY.reason)
        assertEquals("hung", Exit.HUNG.reason)
        assertNull(Exit.BACKGROUND.reason)
    }

    @Test
    fun `a crash in front reaches the page once the chrome is rebuilt, and only that page`() {
        assertEquals(Exit.CRASH, crashAndRebuild(listOf("tab_1")))
        assertNull("a page that was not on screen comes back as itself", exits.take("tab_2"))
        val report = exits.take("tab_1")
        assertNotNull(report)
        assertEquals("crashed", report!!.reason)
        assertFalse(report.repeat)
        assertNull("consumed", exits.take("tab_1"))
    }

    @Test
    fun `the word waits for the rebuild - a core that stood asks and gets nothing consumed`() {
        assertEquals(Exit.MEMORY, exits.gone(didCrash = false, priorityAtExit = IMPORTANT, visibleTabIds = front))
        assertNull("not armed before the chrome is rebuilt", exits.take("tab_1"))
        assertEquals("oom-kill", exits.peek("tab_1")?.reason)
        exits.chromeRebuilt()
        assertEquals("oom-kill", exits.take("tab_1")?.reason)
    }

    @Test
    fun `the WebViews sharing the renderer report one exit - the reports within the batch window are the same exit`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
        now += 200
        assertNull(exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
        now += RendererExits.BATCH_MS - 1
        assertNull(exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
        exits.chromeRebuilt()
        assertFalse("three reports of one exit are not a repeat", exits.take("tab_1")!!.repeat)
    }

    @Test
    fun `a background exit records nothing and clears an older record`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.BACKGROUND, exits.gone(didCrash = false, priorityAtExit = RendererExits.RENDERER_PRIORITY_WAIVED, visibleTabIds = front))
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
        assertNull(exits.current)
    }

    @Test
    fun `no page on screen - nothing is recorded`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = emptyList()))
        assertNull(exits.current)
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
    }

    @Test
    fun `a second going within the minute is a repeat, a later one is not`() {
        assertEquals(Exit.CRASH, crashAndRebuild())
        assertFalse(exits.take("tab_1")!!.repeat)
        now += 30_000
        assertEquals(Exit.CRASH, crashAndRebuild())
        assertTrue(exits.take("tab_1")!!.repeat)
        now += RendererExits.REPEAT_WINDOW_MS
        assertEquals(Exit.CRASH, crashAndRebuild())
        assertFalse(exits.take("tab_1")!!.repeat)
    }

    @Test
    fun `the repeat is per tab`() {
        assertEquals(Exit.CRASH, crashAndRebuild(listOf("tab_1")))
        assertFalse(exits.take("tab_1")!!.repeat)
        now += 10_000
        assertEquals(Exit.CRASH, crashAndRebuild(listOf("tab_2")))
        assertFalse("another tab's first going", exits.take("tab_2")!!.repeat)
        now += 10_000
        assertEquals(Exit.CRASH, crashAndRebuild(listOf("tab_1", "tab_2")))
        assertTrue(exits.take("tab_1")!!.repeat)
        assertTrue(exits.take("tab_2")!!.repeat)
    }

    @Test
    fun `a record the rebooted core never asked about goes stale`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
        exits.chromeRebuilt()
        now += RendererExits.PENDING_TTL_MS + 1
        assertNull(exits.take("tab_1"))
    }

    @Test
    fun `a chrome rebuilt long after the record leaves it unarmed`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
        now += RendererExits.PENDING_TTL_MS + 1
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
    }

    @Test
    fun `exit page - the host ends the renderer as hung and the callback that follows is that exit`() {
        exits.ending(Exit.HUNG, front)
        assertEquals(Exit.HUNG, exits.current)
        // The platform's report of the very exit, a kill in the platform's eyes: not a memory page.
        now += 100
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, visibleTabIds = front))
        exits.chromeRebuilt()
        assertEquals("hung", exits.take("tab_1")!!.reason)
    }

    @Test
    fun `the host's own ending of a wedged renderer tells no page, and the callback is swallowed`() {
        exits.ending(Exit.BACKGROUND, emptyList())
        assertNull(exits.current)
        now += 100
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, visibleTabIds = front))
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
    }

    @Test
    fun `an expected callback that never came stops being expected - the next exit is its own`() {
        exits.ending(Exit.BACKGROUND, emptyList())
        exits.expectationOver()
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, visibleTabIds = front))
    }

    @Test
    fun `the expectation is spent by one callback - a later exit is classified again`() {
        exits.ending(Exit.HUNG, front)
        now += 100
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, visibleTabIds = front))
        exits.chromeRebuilt()
        exits.take("tab_1")
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.MEMORY, exits.gone(didCrash = false, priorityAtExit = IMPORTANT, visibleTabIds = front))
    }

    @Test
    fun `the demo's crash - ended as a crash reads as one`() {
        exits.ending(Exit.CRASH, front)
        now += 50
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, visibleTabIds = front))
        exits.chromeRebuilt()
        assertEquals("crashed", exits.take("tab_1")!!.reason)
    }

    private companion object {
        /** `WebView.RENDERER_PRIORITY_IMPORTANT`: the priority while a WebView of the renderer is visible. */
        const val IMPORTANT = 2
    }
}
