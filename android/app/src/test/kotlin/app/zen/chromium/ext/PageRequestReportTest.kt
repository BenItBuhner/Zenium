package app.zen.chromium.ext

import app.zen.chromium.blocking.HeaderStage
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * The report of an extension page's own loads (compat round 27, R27-2), in Image Downloader's
 * shape: its popup draws the site's images with `new Image()` and its worker listens on
 * `onCompleted` / `onBeforeRedirect` for `initiator === location.origin`, reading
 * `content-type` and `content-length` off `responseHeaders`.
 */
class PageRequestReportTest {
    private class Event(val name: String, val payload: JSONObject)

    /** A fetcher answering from a script of responses by URL; what it was asked is kept. */
    private class ScriptedFetcher(private val answers: Map<String, () -> HeaderStage.Response?>) : HeaderStage.Fetcher {
        val asked = ArrayList<Triple<String, String, Map<String, String>>>()
        override fun fetch(url: String, method: String, headers: Map<String, String>): HeaderStage.Response? {
            asked.add(Triple(url, method, LinkedHashMap(headers)))
            val answer = answers[url] ?: return null
            return answer()
        }
    }

    private fun response(status: Int, reason: String, vararg headers: Pair<String, String>, body: ByteArray? = ByteArray(0)): HeaderStage.Response {
        val map = LinkedHashMap<String?, List<String>?>()
        map[null] = listOf("HTTP/1.1 $status $reason")
        for ((name, value) in headers) map[name] = (map[name] ?: emptyList()) + value
        return HeaderStage.Response(status, reason, map, body?.let { ByteArrayInputStream(it) })
    }

    private fun image(url: String = IMAGE, accept: String = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"): PageRequestReport.Load =
        PageRequestReport.Load(
            url,
            "GET",
            false,
            linkedMapOf(
                "Accept" to accept,
                "Referer" to "$ORIGIN/popup/index.html",
                "Accept-Encoding" to "gzip, deflate, br",
                "X-Requested-With" to "app.zen.chromium",
                "Cookie" to "sid=1"
            )
        )

    private fun relay(fetcher: HeaderStage.Fetcher, load: PageRequestReport.Load, events: MutableList<Event>): PageRequestReport.Relayed? {
        var next = 100
        return PageRequestReport(fetcher).relay(load, ORIGIN, PageRequestReport.typeOf(load), "41", { (++next).toString() }, UA) { name, payload ->
            events.add(Event(name, payload))
        }
    }

    private fun names(events: List<Event>): List<String> = events.map { "${it.name}:${it.payload.optString("at", "-")}:${it.payload.getString("requestId")}" }

    private fun header(payload: JSONObject, name: String): String? {
        val list = payload.getJSONArray("responseHeaders")
        for (i in 0 until list.length()) {
            val line = list.getJSONObject(i)
            if (line.getString("name").equals(name, ignoreCase = true)) return line.getString("value")
        }
        return null
    }

    @Test
    fun `a subresource over http(s) is reported, the document, a preflight and another scheme are not`() {
        assertTrue(PageRequestReport.reports(image()))
        assertTrue(PageRequestReport.reports(PageRequestReport.Load("$ORIGIN/popup/index.js", "GET", false, emptyMap())))
        assertFalse(PageRequestReport.reports(PageRequestReport.Load("$ORIGIN/popup/index.html", "GET", true, emptyMap())))
        assertFalse(PageRequestReport.reports(PageRequestReport.Load("data:image/png;base64,AAAA", "GET", false, emptyMap())))
        assertFalse(PageRequestReport.reports(PageRequestReport.Load("blob:$ORIGIN/9f0c", "GET", false, emptyMap())))
        assertFalse(
            PageRequestReport.reports(
                PageRequestReport.Load("https://api.example/v1", "OPTIONS", false, mapOf("Access-Control-Request-Method" to "POST", "Origin" to ORIGIN))
            )
        )
        assertTrue(PageRequestReport.reports(PageRequestReport.Load("https://api.example/v1", "OPTIONS", false, mapOf("Origin" to ORIGIN))))
    }

    @Test
    fun `the type is the engine's guess from Accept then the extension`() {
        assertEquals("image", PageRequestReport.typeOf(image()))
        assertEquals("image", PageRequestReport.typeOf(PageRequestReport.Load("https://cdn.example/a", "GET", false, mapOf("Accept" to "image/webp,*/*"))))
        assertEquals("script", PageRequestReport.typeOf(PageRequestReport.Load("$ORIGIN/popup/index.js", "GET", false, mapOf("Accept" to "*/*"))))
        assertEquals("stylesheet", PageRequestReport.typeOf(PageRequestReport.Load("$ORIGIN/popup/index.css", "GET", false, mapOf("Accept" to "text/css,*/*;q=0.1"))))
        assertEquals("xmlhttprequest", PageRequestReport.typeOf(PageRequestReport.Load("https://api.example/v1/images", "GET", false, mapOf("Accept" to "*/*"))))
    }

    @Test
    fun `the request stage names the extension's origin as the initiator and no tab`() {
        val payload = PageRequestReport.request(image(), IMAGE, ORIGIN, "41", "image")
        assertTrue(payload.isNull("tabId"))
        assertEquals("41", payload.getString("requestId"))
        assertEquals(IMAGE, payload.getString("url"))
        assertEquals("image", payload.getString("type"))
        assertEquals("GET", payload.getString("method"))
        assertEquals(ORIGIN, payload.getString("initiator"))
        assertFalse(payload.getBoolean("mainFrame"))
        assertEquals(0, payload.getInt("document"))
        assertEquals("allow", payload.getString("action"))
        assertTrue(payload.isNull("matchedSet"))
        assertTrue(payload.isNull("matchedRule"))
        assertTrue(payload.isNull("redirectedFrom"))
    }

    @Test
    fun `a relayed image reports its headers and, once read to the end, its completion with the wire's content type and length`() {
        val body = ByteArray(5120) { 7 }
        val fetcher = ScriptedFetcher(
            mapOf(IMAGE to { response(200, "OK", "Content-Type" to "image/jpeg", "Content-Length" to "5120", "Cache-Control" to "max-age=60", "Set-Cookie" to "a=1; Path=/", body = body) })
        )
        val events = ArrayList<Event>()
        val relayed = relay(fetcher, image(), events)!!
        // What went out: the page's headers without Referer and Cookie, identity encoding, the WebView's user agent.
        val (url, method, sent) = fetcher.asked.single()
        assertEquals(IMAGE, url)
        assertEquals("GET", method)
        assertEquals("identity", sent["Accept-Encoding"])
        assertEquals(UA, sent["User-Agent"])
        assertEquals("app.zen.chromium", sent["X-Requested-With"])
        assertNull(sent.keys.firstOrNull { it.equals("Referer", ignoreCase = true) })
        assertNull(sent.keys.firstOrNull { it.equals("Cookie", ignoreCase = true) })
        assertNull(sent.keys.firstOrNull { it.equals("Host", ignoreCase = true) })
        // The headers stage, under the request's id, before the body is read.
        assertEquals(listOf("ext.response:headers:41"), names(events))
        val headers = events[0].payload
        assertEquals(200, headers.getInt("statusCode"))
        assertEquals("HTTP/1.1 200 OK", headers.getString("statusLine"))
        assertEquals(IMAGE, headers.getString("url"))
        assertEquals("image", headers.getString("type"))
        assertTrue(headers.isNull("tabId"))
        assertTrue(headers.getBoolean("relayed"))
        assertEquals("image/jpeg", header(headers, "content-type"))
        assertEquals("5120", header(headers, "content-length"))
        assertEquals("a=1; Path=/", header(headers, "set-cookie"))
        // What WebView is handed: the mime apart, the content type and the cookies out of the map, the length kept.
        assertEquals(200, relayed.status)
        assertEquals("OK", relayed.reason)
        assertEquals("image/jpeg", relayed.mime)
        assertNull(relayed.charset)
        assertEquals("5120", relayed.headers["Content-Length"])
        assertEquals("max-age=60", relayed.headers["Cache-Control"])
        assertNull(relayed.headers.keys.firstOrNull { it.equals("Content-Type", ignoreCase = true) })
        assertNull(relayed.headers.keys.firstOrNull { it.equals("Set-Cookie", ignoreCase = true) })
        assertEquals(5120, relayed.body.readBytes().size)
        assertEquals(listOf("ext.response:headers:41", "ext.response:complete:41"), names(events))
        assertEquals("5120", header(events[1].payload, "content-length"))
        relayed.body.close()
        // The close after the end reports nothing more.
        assertEquals(2, events.size)
    }

    @Test
    fun `a body WebView closes before its end is an aborted request`() {
        val fetcher = ScriptedFetcher(mapOf(IMAGE to { response(200, "OK", "Content-Type" to "image/png", body = ByteArray(64)) }))
        val events = ArrayList<Event>()
        val relayed = relay(fetcher, image(), events)!!
        relayed.body.read()
        relayed.body.close()
        assertEquals(listOf("ext.response:headers:41", "ext.response:error:41"), names(events))
        assertEquals(HeaderStage.ERR_ABORTED, events[1].payload.getString("error"))
    }

    @Test
    fun `a redirect is reported as its hop, the target's own request under a fresh id, then the target's response`() {
        val fetcher = ScriptedFetcher(
            mapOf(
                IMAGE to { response(302, "Found", "Location" to "/cdn/photo-1.jpg?s=large", body = null) },
                "https://photos.example/cdn/photo-1.jpg?s=large" to { response(200, "OK", "Content-Type" to "image/jpeg", "Content-Length" to "3", body = byteArrayOf(1, 2, 3)) }
            )
        )
        val events = ArrayList<Event>()
        val relayed = relay(fetcher, image(), events)!!
        assertEquals(3, relayed.body.readBytes().size)
        assertEquals(
            listOf("ext.response:headers:41", "ext.request:-:101", "ext.response:headers:101", "ext.response:complete:101"),
            names(events)
        )
        val hop = events[0].payload
        assertEquals(302, hop.getInt("statusCode"))
        assertEquals(IMAGE, hop.getString("url"))
        assertEquals("/cdn/photo-1.jpg?s=large", header(hop, "location"))
        val target = events[1].payload
        assertEquals("https://photos.example/cdn/photo-1.jpg?s=large", target.getString("url"))
        assertEquals(ORIGIN, target.getString("initiator"))
        assertEquals("image", target.getString("type"))
        assertTrue(target.isNull("tabId"))
        assertEquals("https://photos.example/cdn/photo-1.jpg?s=large", events[3].payload.getString("url"))
        assertEquals("image/jpeg", header(events[3].payload, "content-type"))
        assertEquals(2, fetcher.asked.size)
        assertEquals("https://photos.example/cdn/photo-1.jpg?s=large", fetcher.asked[1].first)
    }

    @Test
    fun `a 304 and a 3xx without a target end the relay's observation and go back to WebView`() {
        val fetcher = ScriptedFetcher(mapOf(IMAGE to { response(304, "Not Modified", "ETag" to "\"x\"", body = null) }))
        val events = ArrayList<Event>()
        assertNull(relay(fetcher, image(), events))
        assertEquals(listOf("ext.response:headers:41"), names(events))
        assertEquals(304, events[0].payload.getInt("statusCode"))
        assertNull(header(events[0].payload, "location"))
    }

    @Test
    fun `a fetch that cannot be made, a status WebView cannot carry and a chain past the limit are errors with Chrome's names`() {
        var events = ArrayList<Event>()
        assertNull(relay(ScriptedFetcher(emptyMap()), image(), events))
        assertEquals(listOf("ext.response:error:41"), names(events))
        assertEquals(HeaderStage.ERR_CONNECTION_FAILED, events[0].payload.getString("error"))
        assertEquals(0, events[0].payload.getInt("statusCode"))

        events = ArrayList()
        assertNull(relay(ScriptedFetcher(mapOf(IMAGE to { response(101, "Switching Protocols", body = null) })), image(), events))
        assertEquals(listOf("ext.response:error:41"), names(events))
        assertEquals(HeaderStage.ERR_INVALID_RESPONSE, events[0].payload.getString("error"))

        events = ArrayList()
        val loop = ScriptedFetcher(mapOf(IMAGE to { response(301, "Moved Permanently", "Location" to IMAGE, body = null) }))
        assertNull(relay(loop, image(), events))
        assertEquals(PageRequestReport.MAX_HOPS + 1, loop.asked.size)
        val last = events.last().payload
        assertEquals("error", last.getString("at"))
        assertEquals(PageRequestReport.ERR_TOO_MANY_REDIRECTS, last.getString("error"))
        // Every hop before it was reported with its target, and the target's request under a fresh id.
        assertEquals(PageRequestReport.MAX_HOPS, events.count { it.name == "ext.request" })
        assertEquals(PageRequestReport.MAX_HOPS, events.count { it.payload.optString("at") == "headers" })
    }

    @Test
    fun `only a GET or a HEAD is relayed`() {
        val fetcher = ScriptedFetcher(mapOf(IMAGE to { response(200, "OK", body = ByteArray(0)) }))
        val events = ArrayList<Event>()
        assertNull(relay(fetcher, PageRequestReport.Load(IMAGE, "POST", false, emptyMap()), events))
        assertTrue(events.isEmpty())
        assertTrue(fetcher.asked.isEmpty())
        val head = relay(fetcher, PageRequestReport.Load(IMAGE, "head", false, emptyMap()), events)
        assertNotNull(head)
        assertEquals("HEAD", fetcher.asked.single().second)
        assertEquals("HEAD", events[0].payload.getString("method"))
    }

    @Test
    fun `a load the host answered itself is headers then complete with the content type composed, and a refusal's net error is the one error`() {
        val served = PageRequestReport.answered(
            "41",
            PageRequestReport.Load("$ORIGIN/popup/index.css", "GET", false, mapOf("Accept" to "text/css,*/*;q=0.1")),
            "stylesheet",
            200,
            "OK",
            mapOf("Content-Length" to "812", "Cache-Control" to "no-cache", "Access-Control-Allow-Origin" to "*"),
            "text/css",
            "utf-8"
        )
        assertEquals(listOf("headers", "complete"), served.map { it.getString("at") })
        for (payload in served) {
            assertEquals(200, payload.getInt("statusCode"))
            assertEquals("HTTP/1.1 200 OK", payload.getString("statusLine"))
            assertEquals("text/css; charset=utf-8", header(payload, "content-type"))
            assertEquals("812", header(payload, "content-length"))
            assertEquals("stylesheet", payload.getString("type"))
            assertTrue(payload.isNull("tabId"))
            assertFalse(payload.has("error"))
        }
        val refused = PageRequestReport.answered(
            "42",
            PageRequestReport.Load("$ORIGIN/missing.png", "GET", false, emptyMap()),
            "image",
            404,
            "Not Found",
            NetErrorAnswer.headers(NetErrorAnswer.FILE_NOT_FOUND) + ("Content-Length" to "0"),
            "text/plain",
            "utf-8"
        )
        assertEquals(1, refused.size)
        assertEquals("error", refused[0].getString("at"))
        assertEquals("net::ERR_FILE_NOT_FOUND", refused[0].getString("error"))
        assertEquals(0, refused[0].getInt("statusCode"))
        // A proxied reply without a reason phrase gets the status's own.
        val proxied = PageRequestReport.answered("43", PageRequestReport.Load("https://api.example/v1", "GET", false, emptyMap()), "xmlhttprequest", 204, "", emptyMap(), "text/plain", null)
        assertEquals("HTTP/1.1 204 No Content", proxied[0].getString("statusLine"))
        assertEquals("text/plain", header(proxied[0], "content-type"))
    }

    private companion object {
        const val ORIGIN = "https://cbnhnlbagkabdnaoedjdfpbfmkcofbcl.ext.zenium.invalid"
        const val IMAGE = "https://photos.example/photo-1.jpg"
        const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.5672.136 Mobile Safari/537.36"
    }
}
