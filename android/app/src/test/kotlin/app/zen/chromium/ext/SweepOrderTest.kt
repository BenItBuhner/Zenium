package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

/** The compat sweep's row order (`CompatSweep.demo`), decided in [SweepOrder]. */
class SweepOrderTest {
    private data class Row(val id: String, val name: String)

    // Compat round 23's `[lane]` rows in the table's order (CompatSweep.kt): Popup Blocker (strict)
    // and Reader View sit in round 22's block, Adblock Ad Blocker Pro and Magical behind them, the
    // storage order probe is the table's last row.
    private val popupBlocker = Row("aefkmifgmaafnojlojpnekbpbmjiiogg", "Popup Blocker (strict)")
    private val readerView = Row("ecabifbgmdmgdllomnfinbmaellmclnh", "Reader View")
    private val adblock = Row("dgjbaljgolmlcmmklmmeafecikidmjpi", "Adblock Ad Blocker Pro")
    private val magical = Row("iibninhmiggehlcdolcilmhacighjamp", "Magical")
    private val ubo = Row("odfafepnkmbhccpbejgmiehpchacaeak", "uBlock Origin")
    private val orderProbe = Row("hnelfnelkfmbnhdelmcbkdcfedmjccjp", "Zenium compat proof: storage order")
    private val table = listOf(popupBlocker, readerView, adblock, magical, ubo, orderProbe)

    private fun order(only: Collection<String>?, last: List<String>) = SweepOrder.order(table, Row::id, only, last)

    @Test
    fun `no last rows - the table's order, every row`() {
        assertEquals(table, order(null, emptyList()))
    }

    @Test
    fun `the default last row runs behind the rest, the rest in the table's order`() {
        assertEquals(listOf(popupBlocker, readerView, adblock, magical, orderProbe, ubo), order(null, listOf(ubo.id)))
    }

    @Test
    fun `the last rows run in the list's order, not the table's - the lane's Reader View last of all`() {
        val lane = listOf(adblock, popupBlocker, orderProbe, magical, readerView)
        val last = listOf(popupBlocker.id, orderProbe.id, magical.id, readerView.id)
        assertEquals(lane, order(lane.map { it.id }, last))
        // Round 22's stable sort read the same lists as the table's order of the four – Popup
        // Blocker, Reader View, Magical, the probe –, Reader View third of five.
        val round22 = table.filter { it in lane }.sortedBy { if (it.id in last) 1 else 0 }
        assertEquals(listOf(adblock, popupBlocker, readerView, magical, orderProbe), round22)
    }

    @Test
    fun `only filters the table in the table's order - a last id outside only does not run`() {
        assertEquals(listOf(adblock, readerView), order(setOf(readerView.id, adblock.id), listOf(readerView.id, magical.id)))
    }

    @Test
    fun `a last name without a row is ignored - a row named twice runs once, at its first place`() {
        assertEquals(listOf(popupBlocker, adblock, magical, ubo, orderProbe, readerView), order(null, listOf("nosuchrowinthetableaaaaaaaaaaaaa", readerView.id, readerView.id)))
    }

    @Test
    fun `every row in last - the list's order alone`() {
        assertEquals(listOf(orderProbe, adblock, popupBlocker), order(setOf(popupBlocker.id, adblock.id, orderProbe.id), listOf(orderProbe.id, adblock.id, popupBlocker.id)))
    }
}
