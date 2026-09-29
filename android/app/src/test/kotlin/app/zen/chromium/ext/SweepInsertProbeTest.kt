package app.zen.chromium.ext

import app.zen.chromium.ext.SweepInsertProbe.Legs
import app.zen.chromium.ext.SweepInsertProbe.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SweepInsertProbeTest {
    private fun legs(
        world: Verdict = Verdict.LOAD,
        worldOrigin: Verdict = Verdict.LOAD,
        page: Verdict = Verdict.LOAD,
        worldRan: Boolean = true,
        recoveryLines: Int = 0
    ) = Legs(
        worldRan = worldRan,
        world = world,
        worldOrigin = worldOrigin,
        page = page,
        worldEntry = world == Verdict.LOAD,
        worldOriginEntry = worldOrigin == Verdict.LOAD,
        pageEntry = page == Verdict.LOAD,
        recoveryLines = recoveryLines
    )

    @Test
    fun `the attribute the element's listeners wrote reads as its verdict, none without one`() {
        assertEquals(Verdict.LOAD, SweepInsertProbe.verdict("load"))
        assertEquals(Verdict.ERROR, SweepInsertProbe.verdict("error"))
        assertEquals(Verdict.NONE, SweepInsertProbe.verdict(null))
        assertEquals(Verdict.NONE, SweepInsertProbe.verdict(""))
    }

    @Test
    fun `every insert loading now names document_start's moment, not the world or the loader`() {
        assertEquals(
            "the same insertion loads from the world and the page now (world load, a timeline entry; page load, a timeline entry): the extension's own miss is document_start's moment – an element appended under <html> before <head> exists –, not the world or the loader",
            SweepInsertProbe.reading(legs())
        )
    }

    @Test
    fun `the world's insert loading with no timeline entry where the page's leaves one names the timeline's blindness, not a miss`() {
        // Compat round 23's AFTER on WebView 156 (row 39, AdGuard Extra): both of the world's
        // inserts came to `load` and neither left an entry; the page's left one.
        val after = Legs(
            worldRan = true,
            world = Verdict.LOAD,
            worldOrigin = Verdict.LOAD,
            page = Verdict.LOAD,
            worldEntry = false,
            worldOriginEntry = false,
            pageEntry = true,
            recoveryLines = 0
        )
        assertEquals(
            "the same insertion loads from the world and the page now, and the world's load leaves no timeline entry where the page's leaves one: the row's timeline read is blind to a world load on this lane – the extension's own document_start insertion is unread, not shown missing (Chrome's timeline is blind to it by the same rule; the served-resource record is the row's read)",
            SweepInsertProbe.reading(after)
        )
        // One of the world's loads leaving an entry is the timing reading again: a world load
        // does reach the timeline, so the extension's own absence there is its own.
        assertTrue(SweepInsertProbe.reading(after.copy(worldOriginEntry = true)).contains("document_start's moment"))
        // The page's load without an entry either is not the timeline's blindness to the world alone.
        assertTrue(SweepInsertProbe.reading(after.copy(pageEntry = false)).contains("document_start's moment"))
    }

    @Test
    fun `the served origin loading from the world where the getURL string does not names the spelling`() {
        assertEquals(
            "the world's getURL spelling is the miss: the served origin loads from the world (a timeline entry) where the getURL string none (no timeline entry)",
            SweepInsertProbe.reading(legs(world = Verdict.NONE))
        )
        assertTrue(SweepInsertProbe.reading(legs(world = Verdict.ERROR)).contains("where the getURL string error"))
    }

    @Test
    fun `the page's insert alone loading names the world, none loading the loader, every error the refusal`() {
        assertEquals(
            "the world is the miss: the page's insert loads (a timeline entry) where neither of the world's does (getURL none, served origin error)",
            SweepInsertProbe.reading(legs(world = Verdict.NONE, worldOrigin = Verdict.ERROR))
        )
        assertEquals(
            "the loader is the miss: no insert came to a load or an error in the wait from either world (entries: world false, page false)",
            SweepInsertProbe.reading(legs(world = Verdict.NONE, worldOrigin = Verdict.NONE, page = Verdict.NONE))
        )
        assertEquals(
            "every insert fails with an error event (entries: world false, page false) – the served answer is refused in both worlds",
            SweepInsertProbe.reading(legs(world = Verdict.ERROR, worldOrigin = Verdict.ERROR, page = Verdict.ERROR))
        )
    }

    @Test
    fun `a WebView without isolated worlds reads the page's insert for both realms`() {
        assertEquals(
            "one realm: the page's insert of the served origin loads now (a timeline entry), so the extension's own miss is its moment, not the loader",
            SweepInsertProbe.reading(legs(worldRan = false, world = Verdict.NONE, worldOrigin = Verdict.NONE))
        )
        assertEquals(
            "one realm: the page's insert of the served origin came to nothing in the wait (no timeline entry) – the loader",
            SweepInsertProbe.reading(legs(worldRan = false, world = Verdict.NONE, worldOrigin = Verdict.NONE, page = Verdict.NONE))
        )
    }

    @Test
    fun `the bridge's script-recovery lines are appended to any reading, and a mixed set is spelled out`() {
        assertTrue(SweepInsertProbe.reading(legs(recoveryLines = 2)).endsWith("; the bridge carries 2 script-recovery line(s) for the row"))
        assertEquals(
            "mixed: world load / served origin error / page none (entries true / false / false); the bridge carries 1 script-recovery line(s) for the row",
            SweepInsertProbe.reading(legs(worldOrigin = Verdict.ERROR, page = Verdict.NONE, recoveryLines = 1))
        )
    }
}
