package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectivityJudgeTest {
    private val judge = Connectivity.Judge(initial = true)

    @Test
    fun `online means internet and validated, both`() {
        assertTrue(Connectivity.Judge.onlineOf(internet = true, validated = true))
        assertFalse(Connectivity.Judge.onlineOf(internet = true, validated = false))
        assertFalse(Connectivity.Judge.onlineOf(internet = false, validated = true))
        assertFalse(Connectivity.Judge.onlineOf(internet = false, validated = false))
    }

    @Test
    fun `losing the default network is offline, once`() {
        assertNull(judge.available("wifi"))
        assertNull(judge.capabilities("wifi", internet = true, validated = true))
        assertEquals(false, judge.lost("wifi"))
        assertFalse(judge.isOnline)
        assertNull(judge.unavailable())
    }

    @Test
    fun `a new default that validates is online again`() {
        judge.available("wifi")
        judge.capabilities("wifi", internet = true, validated = true)
        judge.lost("wifi")
        assertNull(judge.available("cell"))
        assertNull(judge.capabilities("cell", internet = true, validated = false))
        assertFalse(judge.isOnline)
        assertEquals(true, judge.capabilities("cell", internet = true, validated = true))
        assertTrue(judge.isOnline)
    }

    @Test
    fun `a network switch does not lose the reading to the old network's trailing callbacks`() {
        judge.available("wifi")
        judge.capabilities("wifi", internet = true, validated = true)
        // The system names the new default first, then reports the old one gone.
        assertNull(judge.available("cell"))
        assertNull(judge.capabilities("cell", internet = true, validated = true))
        assertNull(judge.lost("wifi"))
        assertNull(judge.capabilities("wifi", internet = false, validated = false))
        assertTrue(judge.isOnline)
    }

    @Test
    fun `a captive portal is offline until the system validates it`() {
        assertEquals(false, judge.capabilities("wifi", internet = true, validated = false))
        assertEquals(true, judge.capabilities("wifi", internet = true, validated = true))
    }

    @Test
    fun `reset takes the system's reading and forgets the network`() {
        judge.available("wifi")
        judge.reset(false)
        assertFalse(judge.isOnline)
        assertEquals(true, judge.capabilities("cell", internet = true, validated = true))
    }
}
