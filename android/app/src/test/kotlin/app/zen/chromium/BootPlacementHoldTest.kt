package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * NTP-35, the second and third halves of #563's mitigation (1): the boot's served new tab page is
 * MADE, LOADED and placed after the chrome's FULLY DRAWN frame. The hold's state machine, under
 * plain JUnit: nothing of an admitted tab's runs before the frame (its every `view.*` message held
 * in order, the creation and the document's load among them); the release re-dispatches them once,
 * in that order, and the gate stays open; a load of another document into the tab lets it go with
 * what was held applied, its destroy with what was held dropped and answered; a tab never admitted
 * – the phone's every tab, a restored page's – is never held; the deadline is the fail-safe's
 * number. The lead's conditions of form on the page itself (the space's ground alone while held,
 * the whole first paint, the 120 ms fade – the same under reduced motion) are the document's and
 * pinned beside it (`newTabPage.test.ts`, `newTabPageScript.test.ts`).
 */
class BootPlacementHoldTest {
    private val applied = ArrayList<String>()
    private val dropped = ArrayList<String>()

    private fun op(name: String): () -> Unit = { applied.add(name) }
    private fun onDrop(name: String): () -> Unit = { dropped.add(name) }

    /** The served tab's boot in its order: the create, the load, the first layout's placement, the ask behind it. */
    private fun holdBoot(hold: BootPlacementHold, tab: String = "ntp"): List<Boolean> = listOf(
        hold.hold(tab, onDrop("create $tab"), op("create $tab")),
        hold.hold(tab, onDrop("loadHtml $tab"), op("loadHtml $tab")),
        hold.hold(tab, onDrop("setBounds $tab"), op("setBounds $tab")),
        hold.hold(tab, onDrop("shown $tab"), op("shown $tab"))
    )

    @Test
    fun `an admitted tab is held while the gate is closed – any other tab is not`() {
        val hold = BootPlacementHold()
        assertFalse(hold.open)
        assertTrue(hold.admit("ntp"))
        assertTrue(hold.holds("ntp"))
        // The phone's every tab, a tablet's restored page: never admitted, never held.
        assertFalse(hold.holds("restored"))
        assertFalse(hold.holds("phone"))
    }

    @Test
    fun `nothing of the served tab's runs before the frame – its create, its load, its placement are held in order and applied once at the release`() {
        val hold = BootPlacementHold()
        hold.admit("ntp")
        assertEquals(listOf(true, false, false, false), holdBoot(hold))
        assertEquals(4, hold.heldCount)
        assertTrue(hold.heldFor("ntp"))
        assertFalse(hold.heldFor("other"))
        // Held: no view made, no document parsed, nothing shown.
        assertEquals(emptyList<String>(), applied)

        assertEquals(4, hold.release())
        assertEquals(listOf("create ntp", "loadHtml ntp", "setBounds ntp", "shown ntp"), applied)
        assertEquals(emptyList<String>(), dropped)
        assertTrue(hold.open)
        assertEquals(0, hold.heldCount)
        assertFalse(hold.heldFor("ntp"))
        // Open: the tab is no longer held, and no tab is admitted any more.
        assertFalse(hold.holds("ntp"))
        assertFalse(hold.admit("row"))
        assertFalse(hold.holds("row"))
    }

    @Test
    fun `the way of each message – the create, the served load and the placement hold, a page's load leaves, the destroy drops`() {
        val hold = BootPlacementHold()
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.create", null))
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.setBackground", null))
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.setVisible", null))
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.setBounds", null))
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.shown", null))
        // The served document itself, in the spellings the core uses for it.
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.loadHtml", NewTabPage.URL))
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.loadHtml", "${NewTabPage.URL}/"))
        assertEquals(BootPlacementHold.Way.HOLD, hold.way("view.loadHtml", "${NewTabPage.URL}?private=1"))
        // Another document into the tab: an error page's, a chrome page's, a URL – READY waits for those.
        assertEquals(BootPlacementHold.Way.LEAVE, hold.way("view.loadHtml", "zen://error?code=-105"))
        assertEquals(BootPlacementHold.Way.LEAVE, hold.way("view.loadHtml", null))
        assertEquals(BootPlacementHold.Way.LEAVE, hold.way("view.load", "https://open.example/"))
        assertEquals(BootPlacementHold.Way.DROP, hold.way("view.destroy", null))
    }

    @Test
    fun `the first hold alone says so – the deadline is armed once`() {
        val hold = BootPlacementHold()
        hold.admit("a")
        hold.admit("b")
        assertTrue(hold.hold("a", op = op("a1")))
        assertFalse(hold.hold("a", op = op("a2")))
        assertFalse(hold.hold("b", op = op("b1")))
        assertEquals(3, hold.release())
        assertEquals(listOf("a1", "a2", "b1"), applied)
    }

    @Test
    fun `the deadline is asked for once a boot – a hold after LEAVE or DROP drained the list does not ask again`() {
        // Two admitted tabs, the first leaving (or dropped) with the list drained: the next hold
        // is the list's first again but not the boot's – a second ask would arm a second Runnable
        // the frame's release does not cancel (the first line's N2 on #563).
        val hold = BootPlacementHold()
        hold.admit("a")
        hold.admit("b")
        assertTrue(hold.hold("a", op = op("a1")))
        assertEquals(1, hold.leave("a"))
        assertEquals(0, hold.heldCount)
        assertFalse(hold.hold("b", op = op("b1")))
        assertEquals(1, hold.heldCount)
        assertEquals(1, hold.release())
        assertEquals(listOf("a1", "b1"), applied)

        applied.clear()
        val dropped = BootPlacementHold()
        dropped.admit("a")
        dropped.admit("b")
        assertTrue(dropped.hold("a", onDrop("a1"), op("a1")))
        assertEquals(1, dropped.drop("a"))
        assertEquals(0, dropped.heldCount)
        assertFalse(dropped.hold("b", op = op("b1")))
        assertEquals(1, dropped.release())
        assertEquals(listOf("b1"), applied)
        assertEquals(listOf("a1"), this.dropped)
    }

    @Test
    fun `the host admits on the tablet chassis alone and re-dispatches what was held under the bridge's own guard`() {
        // The Kotlin wiring the JUnit state machine cannot reach, pinned by its source text (the
        // repository's idiom): the `view.create` admission is the tag AND `largeScreen()` – the
        // phone never admits because that conjunct is false there, whatever the tag – and both
        // hold sites hand the release a dispatch wrapped as the bridge wraps every dispatch
        // (`dispatchHeld`: a failing held message is logged and rejected, the ones after it run).
        val host = File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/Host.kt").readText()
        assertEquals(1, Regex(Regex.escape("""if (args.optBoolean("newTabPage") && activity.largeScreen() && bootHold.admit(id)) {""")).findAll(host).count())
        assertEquals(2, Regex("""holdAtBoot\([^\n]*\) \{ dispatchHeld\(method, args, reply\) \}""").findAll(host).count())
        assertEquals(0, Regex("""holdAtBoot\([^\n]*\) \{ dispatch\(method, args, reply\) \}""").findAll(host).count())
        assertTrue(host.contains("private fun dispatchHeld(method: String, args: JSONObject, reply: (Any?) -> Unit) {\n        try {\n            dispatch(method, args, reply)\n        } catch (e: Exception) {"))
    }

    private fun repoRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
            dir = dir.parentFile
        }
        error("not inside the repository")
    }

    @Test
    fun `once open, nothing is held or admitted – a New Tab from the row is made and placed at once`() {
        val hold = BootPlacementHold()
        assertEquals(0, hold.release())
        assertTrue(hold.open)
        assertFalse(hold.admit("row"))
        assertFalse(hold.holds("row"))
        // An op offered anyway is applied on the spot and arms no deadline.
        assertFalse(hold.hold("row", op = op("create row")))
        assertEquals(listOf("create row"), applied)
        assertEquals(0, hold.heldCount)
    }

    @Test
    fun `a load of another document into the held tab lets it leave with what was held applied first, in order – and it is not admitted again`() {
        val hold = BootPlacementHold()
        hold.admit("ntp")
        hold.admit("other")
        hold.hold("ntp", onDrop("create ntp"), op("create ntp"))
        hold.hold("other", onDrop("create other"), op("create other"))
        hold.hold("ntp", onDrop("loadHtml ntp"), op("loadHtml ntp"))
        assertEquals(3, hold.heldCount)

        // An intent's URL into the served tab before the frame: its placement is now READY's to wait for.
        assertEquals(2, hold.leave("ntp"))
        assertEquals(listOf("create ntp", "loadHtml ntp"), applied)
        assertEquals(emptyList<String>(), dropped)
        assertFalse(hold.holds("ntp"))
        assertFalse(hold.heldFor("ntp"))
        // The gate is as it was: the other tab still held, the tab that left not re-admitted – its
        // re-dispatched create is a creation, not a second hold.
        assertFalse(hold.open)
        assertTrue(hold.holds("other"))
        assertEquals(1, hold.heldCount)
        assertFalse(hold.admit("ntp"))
        assertFalse(hold.holds("ntp"))

        assertEquals(1, hold.release())
        assertEquals(listOf("create ntp", "loadHtml ntp", "create other"), applied)
    }

    @Test
    fun `a destroy of the held tab drops what was held – each answered, none applied – and the tab is not admitted again`() {
        val hold = BootPlacementHold()
        hold.admit("ntp")
        holdBoot(hold)
        assertEquals(4, hold.drop("ntp"))
        assertEquals(emptyList<String>(), applied)
        // The calls among them are answered so nothing in the core waits on a view never made.
        assertEquals(listOf("create ntp", "loadHtml ntp", "setBounds ntp", "shown ntp"), dropped)
        assertFalse(hold.holds("ntp"))
        assertFalse(hold.heldFor("ntp"))
        assertEquals(0, hold.heldCount)
        assertFalse(hold.open)
        assertFalse(hold.admit("ntp"))
        assertEquals(0, hold.release())
        assertEquals(emptyList<String>(), applied)
    }

    @Test
    fun `a second release applies nothing`() {
        val hold = BootPlacementHold()
        hold.admit("ntp")
        hold.hold("ntp", op = op("create ntp"))
        assertEquals(1, hold.release())
        assertEquals(0, hold.release())
        assertEquals(listOf("create ntp"), applied)
    }

    @Test
    fun `a boot with nothing admitted opens the gate with nothing to apply`() {
        // The phone's boot, a tablet restored on a page: the frame opens the gate at once.
        val hold = BootPlacementHold()
        assertEquals(0, hold.heldCount)
        assertEquals(0, hold.release())
        assertTrue(hold.open)
        assertEquals(emptyList<String>(), applied)
    }

    @Test
    fun `a host going away abandons the hold – open, nothing applied, nothing answered`() {
        val hold = BootPlacementHold()
        hold.admit("ntp")
        holdBoot(hold)
        hold.abandon()
        assertTrue(hold.open)
        assertEquals(0, hold.heldCount)
        assertEquals(emptyList<String>(), applied)
        assertEquals(emptyList<String>(), dropped)
        assertEquals(0, hold.release())
        assertFalse(hold.admit("ntp"))
    }

    @Test
    fun `the deadline is the fail-safe's number – half the splash's watchdog`() {
        assertEquals(5_000L, BootPlacementHold.DEADLINE_MS)
        assertEquals(StartupSplash.WATCHDOG_MS / 2, BootPlacementHold.DEADLINE_MS)
    }
}
