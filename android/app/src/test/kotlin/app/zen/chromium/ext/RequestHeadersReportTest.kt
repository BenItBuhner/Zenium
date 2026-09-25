package app.zen.chromium.ext

import app.zen.chromium.json
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestHeadersReportTest {
    /** The `ext.request` payload as `Extensions.onDecision` builds it for the player's subtitle fetch. */
    private fun decided(url: String = TIMEDTEXT): JSONObject = json(
        "tabId" to "t7",
        "requestId" to "412",
        "url" to url,
        "type" to "xmlhttprequest",
        "method" to "GET",
        "initiator" to "https://www.youtube.com",
        "mainFrame" to false,
        "document" to 3L,
        "action" to "allow",
        "matchedSet" to null,
        "matchedRule" to null,
        "micros" to 41L,
        "cpuMicros" to 30L
    )

    @Test
    fun `the decision and the headers of one request make the report, under the decision's id`() {
        val headers = linkedMapOf(
            "Accept" to "*/*",
            "X-Youtube-Client-Name" to "1",
            "X-Youtube-Client-Version" to "2.20260925.01.00",
            "Referer" to "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        )
        val report = RequestHeadersReport.build(decided(), TIMEDTEXT, headers)!!
        assertEquals("t7", report.getString("tabId"))
        assertEquals("412", report.getString("requestId"))
        assertEquals(TIMEDTEXT, report.getString("url"))
        assertEquals("xmlhttprequest", report.getString("type"))
        assertEquals("GET", report.getString("method"))
        assertEquals("https://www.youtube.com", report.getString("initiator"))
        assertEquals(false, report.getBoolean("mainFrame"))
        assertEquals(3L, report.getLong("document"))
        // The header lines in WebView's order, name and value as sent (the runtime lowercases nothing).
        val lines = report.getJSONArray("requestHeaders")
        assertEquals(4, lines.length())
        assertEquals(
            headers.entries.map { it.key to it.value },
            List(lines.length()) { i -> lines.getJSONObject(i).let { it.getString("name") to it.getString("value") } }
        )
        // The decision's own fields stay on the decision: the report is the header stage's alone.
        for (key in listOf("action", "matchedSet", "matchedRule", "micros", "cpuMicros")) assertTrue(key, !report.has(key))
    }

    @Test
    fun `another URL on the thread is another request, and no decision is no report`() {
        // The thread's last decision was a request the verdict kept in (never sent), or an
        // extension page's own request came through without a decision: nothing pairs.
        assertNull(RequestHeadersReport.build(decided("https://www.youtube.com/youtubei/v1/player"), TIMEDTEXT, mapOf("Accept" to "*/*")))
        assertNull(RequestHeadersReport.build(null, TIMEDTEXT, mapOf("Accept" to "*/*")))
    }

    @Test
    fun `a request with no headers on record reports an empty list, not none`() {
        val report = RequestHeadersReport.build(decided(), TIMEDTEXT, null)!!
        assertEquals(0, report.getJSONArray("requestHeaders").length())
        assertEquals(0, RequestHeadersReport.build(decided(), TIMEDTEXT, emptyMap())!!.getJSONArray("requestHeaders").length())
    }

    @Test
    fun `a navigation's decision has no initiator and the report says null, as the decision does`() {
        val navigation = decided("https://www.youtube.com/watch?v=jNQXAC9IVRw").put("initiator", JSONObject.NULL).put("mainFrame", true)
        val report = RequestHeadersReport.build(navigation, "https://www.youtube.com/watch?v=jNQXAC9IVRw", mapOf("Accept" to "text/html"))!!
        assertSame(JSONObject.NULL, report.get("initiator"))
        assertEquals(true, report.getBoolean("mainFrame"))
        // A decision from a source without the field at all reads the same on the wire.
        val bare = decided().also { it.remove("initiator"); it.remove("tabId") }
        val fromBare = RequestHeadersReport.build(bare, TIMEDTEXT, null)!!
        assertSame(JSONObject.NULL, fromBare.get("initiator"))
        assertSame(JSONObject.NULL, fromBare.get("tabId"))
    }

    private companion object {
        const val TIMEDTEXT = "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&fmt=json3"
    }
}
