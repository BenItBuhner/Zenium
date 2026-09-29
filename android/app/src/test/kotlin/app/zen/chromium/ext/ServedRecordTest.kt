package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

class ServedRecordTest {
    private val id = "gkeojjjcdcopjkbelgbcpckplegclfeg"

    @Test
    fun `a served foreign sub-resource carries the status, the path with its query, the frame, the side and the referer without its scheme`() {
        assertEquals(
            "gkeojjjc 200 userscript.js?jku8x8x sub-resource; foreign; from 10.0.2.2:8765/page-a.html?adguardextra",
            ServedRecord.line(id, 200, "userscript.js", "jku8x8x", false, "foreign", null, "http://10.0.2.2:8765/page-a.html?adguardextra")
        )
    }

    @Test
    fun `an extension's own document is a main-frame own answer without a referer or a word`() {
        assertEquals("gkeojjjc 200 popup.html main-frame; own", ServedRecord.line(id, 200, "popup.html", null, true, "own", null, null))
        assertEquals("gkeojjjc 200 / main-frame; own", ServedRecord.line(id, 200, "", null, true, "own", null, ""))
    }

    @Test
    fun `a 404 past every gate is a missing file, and a given word stands over the derived one`() {
        assertEquals("gkeojjjc 404 nothere.js sub-resource; own; missing", ServedRecord.line(id, 404, "nothere.js", null, false, "own", null, null))
        assertEquals(
            "gkeojjjc 404 secret.js sub-resource; foreign; not-web-accessible; from example.com/",
            ServedRecord.line(id, 404, "secret.js", null, false, "foreign", ServedRecord.NOT_WEB_ACCESSIBLE, "https://example.com/")
        )
        assertEquals("gkeojjjc 404 x.js sub-resource; unserved", ServedRecord.line(id, 404, "x.js", null, false, null, ServedRecord.UNSERVED, null))
        assertEquals("gkeojjjc 200 index.html main-frame; private", ServedRecord.line(id, 200, "index.html", null, true, null, ServedRecord.PRIVATE, null))
    }

    @Test
    fun `the alias path is recorded as spelled, and a long query and referer are cut`() {
        val query = "a".repeat(100)
        val line = ServedRecord.line(id, 200, ".zenium-ext/$id/vendor/chunk.js", query, false, "foreign", null, "https://" + "h".repeat(100) + "/p")
        assertEquals("gkeojjjc 200 .zenium-ext/$id/vendor/chunk.js?${"a".repeat(80)} sub-resource; foreign; from ${"h".repeat(80)}", line)
        assertEquals(200, ServedRecord.status(line))
        assertEquals(-1, ServedRecord.status("not a line"))
    }

    @Test
    fun `the record holds the last CAP lines, the oldest going first`() {
        val record = ArrayDeque<String>()
        for (i in 0 until ServedRecord.CAP + 5) ServedRecord.add(record, "line $i")
        assertEquals(ServedRecord.CAP, record.size)
        assertEquals("line 5", record.first())
        assertEquals("line ${ServedRecord.CAP + 4}", record.last())
    }
}
