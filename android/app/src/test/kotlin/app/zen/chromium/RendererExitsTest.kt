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
        val exit = exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = visible)
        exits.chromeRebuilt()
        return exit
    }

    @Test
    fun `classification - didCrash is the crash, a kill in front is the memory page, away is the background`() {
        assertEquals(Exit.CRASH, RendererExits.classify(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true))
        assertEquals(Exit.MEMORY, RendererExits.classify(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true))
        // The activity stopped: the app was away, whatever the detail says of the way – the
        // priority is IMPORTANT under the default policy whether or not a WebView shows.
        assertEquals(Exit.BACKGROUND, RendererExits.classify(didCrash = false, priorityAtExit = IMPORTANT, windowUp = false))
        assertEquals(Exit.BACKGROUND, RendererExits.classify(didCrash = true, priorityAtExit = IMPORTANT, windowUp = false))
        // A waiving policy's word for the same thing, should one ever be set.
        assertEquals(Exit.BACKGROUND, RendererExits.classify(didCrash = false, priorityAtExit = RendererExits.RENDERER_PRIORITY_WAIVED, windowUp = true))
        assertEquals(Exit.BACKGROUND, RendererExits.classify(didCrash = true, priorityAtExit = RendererExits.RENDERER_PRIORITY_WAIVED, windowUp = true))
    }

    @Test
    fun `a kill while the activity is stopped is the quiet reload - while resumed it is the memory page`() {
        // The system reclaiming the renderer with the app in the background, the commonest exit:
        // the front tab is still View.VISIBLE and the priority still IMPORTANT, only the lifecycle
        // knows. Nothing is recorded; the pages come back as themselves.
        assertEquals(Exit.BACKGROUND, exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = false, visibleTabIds = front))
        assertNull(exits.current)
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
        // The same kill with the window up is the page.
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.MEMORY, exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        val report = exits.take("tab_1")
        assertNotNull(report)
        assertEquals("oom-kill", report!!.reason)
        assertFalse(report.repeat)
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
        assertEquals(Exit.MEMORY, exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        assertNull("not armed before the chrome is rebuilt", exits.take("tab_1"))
        assertEquals("oom-kill", exits.peek("tab_1")?.reason)
        exits.chromeRebuilt()
        assertEquals("oom-kill", exits.take("tab_1")?.reason)
    }

    @Test
    fun `the WebViews sharing the renderer report one exit - the reports within the batch window are the same exit`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        now += 200
        assertNull(exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        now += RendererExits.BATCH_MS - 1
        assertNull(exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        assertFalse("three reports of one exit are not a repeat", exits.take("tab_1")!!.repeat)
    }

    @Test
    fun `a background exit records nothing and clears an older record`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.BACKGROUND, exits.gone(didCrash = false, priorityAtExit = RendererExits.RENDERER_PRIORITY_WAIVED, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
        assertNull(exits.current)
    }

    @Test
    fun `no page on screen - nothing is recorded`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = emptyList()))
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
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        now += RendererExits.PENDING_TTL_MS + 1
        assertNull(exits.take("tab_1"))
    }

    @Test
    fun `a chrome rebuilt long after the record leaves it unarmed`() {
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
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
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        assertEquals("hung", exits.take("tab_1")!!.reason)
    }

    @Test
    fun `the host's own ending of a wedged renderer tells no page, and the callback is swallowed`() {
        exits.ending(Exit.BACKGROUND, emptyList())
        assertNull(exits.current)
        now += 100
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        assertNull(exits.take("tab_1"))
    }

    @Test
    fun `an expected callback that never came stops being expected - the next exit is its own`() {
        exits.ending(Exit.BACKGROUND, emptyList())
        exits.expectationOver()
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
    }

    @Test
    fun `the expectation is spent by one callback - a later exit is classified again`() {
        exits.ending(Exit.HUNG, front)
        now += 100
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        exits.take("tab_1")
        now += RendererExits.BATCH_MS + 1
        assertEquals(Exit.MEMORY, exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
    }

    @Test
    fun `the demo's crash - ended as a crash reads as one`() {
        exits.ending(Exit.CRASH, front)
        now += 50
        assertNull(exits.gone(didCrash = false, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        exits.chromeRebuilt()
        assertEquals("crashed", exits.take("tab_1")!!.reason)
    }

    @Test
    fun `willTake - the page's list is not restored exactly when take would answer, and asking consumes nothing`() {
        assertFalse("nothing recorded", exits.willTake("tab_1"))
        assertEquals(Exit.CRASH, exits.gone(didCrash = true, priorityAtExit = IMPORTANT, windowUp = true, visibleTabIds = front))
        // The record stands but the chrome has not been rebuilt: a chrome that stood restores as ever.
        assertFalse("not armed", exits.willTake("tab_1"))
        assertNotNull("peek sees the word all the same", exits.peek("tab_1"))
        exits.chromeRebuilt()
        assertTrue(exits.willTake("tab_1"))
        assertTrue("asking is not taking", exits.willTake("tab_1"))
        assertFalse("another page comes back as itself", exits.willTake("tab_2"))
        assertEquals("crashed", exits.take("tab_1")!!.reason)
        assertFalse("taken", exits.willTake("tab_1"))
    }

    @Test
    fun `willTake - a stale record answers no, and leaves the record to take to expire`() {
        assertEquals(Exit.CRASH, crashAndRebuild())
        now += RendererExits.PENDING_TTL_MS + 1
        assertFalse(exits.willTake("tab_1"))
        assertEquals("the exit still reads until take expires it", Exit.CRASH, exits.current)
        assertNull(exits.take("tab_1"))
        assertNull(exits.current)
    }

    @Test
    fun `willTake - the host's own ending of the renderer counts once the chrome is rebuilt`() {
        exits.ending(Exit.HUNG, listOf("tab_1", "tab_2"))
        assertFalse(exits.willTake("tab_1"))
        exits.chromeRebuilt()
        assertTrue(exits.willTake("tab_1"))
        assertTrue(exits.willTake("tab_2"))
        exits.take("tab_1")
        assertFalse(exits.willTake("tab_1"))
        assertTrue("the other page's word is still to come", exits.willTake("tab_2"))
    }

    private companion object {
        /** `WebView.RENDERER_PRIORITY_IMPORTANT`: the priority while a WebView of the renderer is visible. */
        const val IMPORTANT = 2
    }
}
