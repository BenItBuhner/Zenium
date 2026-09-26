package app.zen.chromium.ext

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

class ReplyTimingTest {
    @Test
    fun `the three legs are the differences of the four stamps, in the trace line's tail form`() {
        // The host saw the call at 1,000; the runtime saw it at 1,087 (the evaluateJavascript's
        // queue), answered at 1,089, and the host sends the reply at 1,160.
        assertEquals(" hop=87 run=2 back=71", ReplyTiming.legs(1_000L, JSONArray().put(1_087L).put(1_089L), 1_160L))
    }

    @Test
    fun `a zero-length leg reads 0 and a rounding inversion is kept as it comes`() {
        assertEquals(" hop=0 run=0 back=0", ReplyTiming.legs(5L, JSONArray().put(5L).put(5L), 5L))
        assertEquals(" hop=-1 run=3 back=0", ReplyTiming.legs(10L, JSONArray().put(9L).put(12L), 12L))
    }

    @Test
    fun `nothing without the call's receipt, the runtime's stamps or both of them`() {
        assertEquals("", ReplyTiming.legs(null, JSONArray().put(1L).put(2L), 3L))
        assertEquals("", ReplyTiming.legs(1L, null, 3L))
        assertEquals("", ReplyTiming.legs(1L, JSONArray().put(2L), 3L))
        assertEquals("", ReplyTiming.legs(1L, JSONArray().put("x").put(2L), 3L))
        assertEquals("", ReplyTiming.legs(1L, JSONArray(), 3L))
    }

    @Test
    fun `the stamps are read as the runtime writes them, integers of the wall clock`() {
        // Date.now() values of 2026, as JSON numbers; org.json reads them as longs.
        val at = JSONArray("[1790000000123, 1790000000125]")
        assertEquals(" hop=23 run=2 back=75", ReplyTiming.legs(1_790_000_000_100L, at, 1_790_000_000_200L))
    }
}
