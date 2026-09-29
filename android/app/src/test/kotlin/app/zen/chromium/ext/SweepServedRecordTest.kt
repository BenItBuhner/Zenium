package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SweepServedRecordTest {
    private val id = "gkeojjjcdcopjkbelgbcpckplegclfeg"
    private val own = "gkeojjjc 200 userscript.js?jku8x8x sub-resource; foreign; from 10.0.2.2:8765/page-a.html?adguardextra"
    private val record = listOf(
        "gkeojjjc 200 popup.html main-frame; own",
        "gkeojjjc 200 popup.js sub-resource; own; from gkeojjjcdcopjkbelgbcpckplegclfeg.ext.zenium.invalid/popup.html",
        own,
        "fpjppnhn 200 userscript.js sub-resource; foreign; from 10.0.2.2:8765/page-a.html",
        "gkeojjjc 200 userscript.js?zenworld sub-resource; foreign; from 10.0.2.2:8765/page-a.html?adguardextra",
        "gkeojjjc 200 userscript.js?zenworldorigin sub-resource; foreign; from 10.0.2.2:8765/page-a.html?adguardextra",
        "gkeojjjc 200 userscript.js?zenpage sub-resource; foreign; from 10.0.2.2:8765/page-a.html?adguardextra"
    )

    @Test
    fun `the extension's own lines for the file leave out another extension's, its other files and the probe's inserts`() {
        assertEquals(listOf(own), SweepServedRecord.ownLines(record, id, "userscript.js"))
        // A referer that happens to name the file is not the path's naming of it.
        val referred = "gkeojjjc 200 other.js sub-resource; foreign; from example.com/userscript.js"
        assertEquals(emptyList<String>(), SweepServedRecord.ownLines(listOf(referred), id, "userscript.js"))
    }

    @Test
    fun `a served insertion is the row's pass, the line quoted, the timeline's blindness named as Chrome's`() {
        val r = SweepServedRecord.reading(listOf(own), "userscript.js")
        assertTrue(r.pass)
        assertEquals(
            "the served-resource record has the extension's own insertion served – $own – where the page's timeline holds no entry for a world's load, as Chrome's holds none: the record is the row's read",
            r.word
        )
    }

    @Test
    fun `a served insertion after a refused one passes and names the refusal too`() {
        val refused = "gkeojjjc 404 userscript.js?abc sub-resource; foreign; not-web-accessible; from 10.0.2.2:8765/page-a.html"
        val r = SweepServedRecord.reading(listOf(refused, own), "userscript.js")
        assertTrue(r.pass)
        assertTrue(r.word.contains("(and 1 refused, the last: $refused)"))
    }

    @Test
    fun `a refusal alone is ours, by the line's word`() {
        val refused = "gkeojjjc 404 userscript.js?abc sub-resource; foreign; missing; from 10.0.2.2:8765/page-a.html"
        val r = SweepServedRecord.reading(listOf(refused), "userscript.js")
        assertFalse(r.pass)
        assertEquals(
            "the served-resource record has the extension's own insertion REFUSED by the runtime – $refused – ours: the web-accessible gate, the alias spelling or a file not in the bundle, by the line's word",
            r.word
        )
    }

    @Test
    fun `no line is an insertion that never reached the intercept, the fixture's policy or its absence named`() {
        val none = SweepServedRecord.reading(emptyList(), "userscript.js")
        assertFalse(none.pass)
        assertEquals(
            "the served-resource record has no line for the extension's own userscript.js: the insertion never reached the intercept – the fixture sends no policy, so the content script did not insert it – or inserted an address the runtime's origins do not answer",
            none.word
        )
        val policy = SweepServedRecord.reading(emptyList(), "userscript.js", fixturePolicy = "script-src 'self'")
        assertFalse(policy.pass)
        assertTrue(policy.word.endsWith("the fixture's policy (script-src 'self') refuses the element before its request, as Chrome's would not for an extension's world"))
    }
}
