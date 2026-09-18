package app.zen.chromium.ext

import app.zen.chromium.ext.CorsProxy.Companion.CREDENTIALS_HEADER
import app.zen.chromium.ext.CorsProxy.Companion.PROXY_HEADER
import app.zen.chromium.ext.CorsProxy.Companion.SKIP
import app.zen.chromium.ext.TinyHttpServer.Response
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.Locale

/**
 * The CORS proxy against a local server: what the target sees (headers forwarded, `Origin`
 * rewritten to `chrome-extension://`, the proxy's markers and the `Referer` gone), what the
 * WebView gets back (the response with CORS headers for the extension origin, framing headers
 * re-derived), ticketed bodies, credentials, redirects, errors.
 */
class CorsProxyTest {
    private val id = "abcdefghijklmnopabcdefghijklmnop"
    private val origin = "https://$id.ext.zenium.invalid"
    private val server = TinyHttpServer()
    private val jar = FakeCookies()
    private val proxy = CorsProxy(jar) { "Zenium/test" }

    private class FakeCookies : CorsProxy.Cookies {
        var cookieHeader: String? = null
        val asked = ArrayList<String>()
        val stored = ArrayList<Pair<String, String>>()
        override fun header(url: String): String? {
            asked.add(url)
            return cookieHeader
        }
        override fun store(url: String, setCookie: String) {
            stored.add(url to setCookie)
        }
    }

    @Before
    fun startServer() {
        // The request as the target saw it: method and (lower-cased) headers, as JSON.
        server.route("/echo") { request ->
            val seen = JSONObject(request.headers).put("method", request.method)
            Response(
                200,
                seen.toString().toByteArray(),
                mapOf(
                    "Content-Type" to "application/json",
                    "X-Server" to "yes",
                    "Content-Encoding" to "identity",
                    // A CORS answer for someone else; the proxy re-serves with its own.
                    "Access-Control-Allow-Origin" to "https://evil.test"
                )
            )
        }
        server.route("/body") { request ->
            Response(
                200,
                request.body,
                mapOf("Content-Type" to (request.header("Content-Type") ?: "application/octet-stream"), "X-Method" to request.method)
            )
        }
        server.route("/see-other") { Response(303, headers = mapOf("Location" to "/echo")) }
        server.route("/found") { Response(302, headers = mapOf("Location" to "/echo")) }
        server.route("/temporary") { Response(307, headers = mapOf("Location" to "body")) }
        server.route("/loop") { Response(301, headers = mapOf("Location" to "/loop")) }
        server.route("/cookie") { Response(200, "ok".toByteArray(), mapOf("Set-Cookie" to "sid=1; Path=/", "Content-Type" to "text/plain")) }
        server.route("/fail") { Response(500, "boom".toByteArray(), mapOf("Content-Type" to "text/plain; charset=utf-8")) }
        server.start()
    }

    @After
    fun stopServer() {
        server.close()
    }

    private fun url(path: String) = "http://127.0.0.1:${server.port}$path"

    private fun request(method: String, path: String, vararg headers: Pair<String, String>) =
        CorsProxy.Request(method, url(path), mapOf("Origin" to origin, *headers))

    private fun CorsProxy.Reply.text(): String = body.use { it.readBytes() }.toString(Charsets.UTF_8)

    private fun CorsProxy.Reply.echoed(): JSONObject = JSONObject(text())

    private fun CorsProxy.Reply.header(name: String): String? =
        headers.entries.firstOrNull { it.key.equals(name, true) }?.value

    @Test
    fun `applies to cross-origin http requests carrying the extension origin, to permitted hosts`() {
        val hosts = MatchPattern.compileAll(listOf("http://127.0.0.1/*", "*://*.google.com/*"))
        assertTrue(proxy.applies(request("GET", "/echo"), origin, hosts))
        assertTrue(proxy.applies(CorsProxy.Request("GET", "https://www.google.com/a.png", mapOf("origin" to origin)), origin, hosts))
        // The extension's own origin, no Origin header (a plain <img>), another page's Origin, an unpermitted host, a data: URL.
        assertFalse(proxy.applies(CorsProxy.Request("GET", "$origin/popup.html", mapOf("Origin" to origin)), origin, hosts))
        assertFalse(proxy.applies(CorsProxy.Request("GET", url("/echo"), emptyMap()), origin, hosts))
        assertFalse(proxy.applies(CorsProxy.Request("GET", url("/echo"), mapOf("Origin" to "https://page.test")), origin, hosts))
        assertFalse(proxy.applies(CorsProxy.Request("GET", "https://api.other.test/x", mapOf("Origin" to origin)), origin, hosts))
        assertFalse(proxy.applies(CorsProxy.Request("GET", "data:text/plain,x", mapOf("Origin" to origin)), origin, hosts))
        // A request the bootstrap marked as its own to send (a body it could not read).
        assertFalse(proxy.applies(request("POST", "/body", PROXY_HEADER to SKIP), origin, hosts))
        assertFalse(proxy.applies(request("GET", "/echo"), origin, emptyList()))
    }

    @Test
    fun `a preflight is answered on the spot with what the page asked for`() {
        val reply = proxy.handle(
            request(
                "OPTIONS", "/echo",
                "Access-Control-Request-Method" to "PUT",
                "Access-Control-Request-Headers" to "content-type, x-custom"
            ),
            id, origin
        ) ?: throw AssertionError("a preflight is always answered")
        assertEquals(204, reply.status)
        assertEquals(origin, reply.header("Access-Control-Allow-Origin"))
        assertEquals("true", reply.header("Access-Control-Allow-Credentials"))
        assertEquals("PUT", reply.header("Access-Control-Allow-Methods"))
        assertEquals("content-type, x-custom", reply.header("Access-Control-Allow-Headers"))
        assertEquals("", reply.text())
    }

    @Test
    fun `a GET is forwarded with the page's headers, Origin rewritten, Referer and markers dropped`() {
        val reply = proxy.handle(
            request(
                "GET", "/echo",
                "Accept" to "image/avif,image/webp,*/*",
                "X-Custom" to "1",
                "Referer" to "$origin/background.html",
                "Accept-Encoding" to "gzip, deflate, br",
                CREDENTIALS_HEADER to "omit"
            ),
            id, origin
        ) ?: throw AssertionError("the server answered")
        assertEquals(200, reply.status)
        val seen = reply.echoed()
        assertEquals("GET", seen.getString("method"))
        assertEquals("chrome-extension://$id", seen.getString("origin"))
        assertEquals("image/avif,image/webp,*/*", seen.getString("accept"))
        assertEquals("1", seen.getString("x-custom"))
        assertEquals("Zenium/test", seen.getString("user-agent"))
        assertFalse(seen.has("referer"))
        assertFalse(seen.has("cookie"))
        assertFalse(seen.has(PROXY_HEADER.lowercase(Locale.ROOT)))
        assertFalse(seen.has(CREDENTIALS_HEADER.lowercase(Locale.ROOT)))
        assertTrue(jar.asked.isEmpty())
    }

    @Test
    fun `the response comes back with CORS headers for the extension origin and honest framing`() {
        val reply = proxy.handle(request("GET", "/echo"), id, origin) ?: throw AssertionError("the server answered")
        assertEquals("application/json", reply.mime)
        assertNull(reply.charset)
        assertEquals("OK", reply.reason)
        assertEquals(origin, reply.header("Access-Control-Allow-Origin"))
        assertEquals("true", reply.header("Access-Control-Allow-Credentials"))
        assertEquals("yes", reply.header("X-Server"))
        val exposed = reply.header("Access-Control-Expose-Headers")?.split(",")?.map { it.trim() } ?: emptyList()
        assertTrue("$exposed names X-Server", exposed.contains("X-Server"))
        assertFalse("$exposed does not name a dropped header", exposed.any { it.equals("Content-Length", true) })
        assertNull(reply.header("Content-Length"))
        assertNull(reply.header("Content-Encoding"))
        assertNull(reply.header("Connection"))
        assertEquals(1, reply.headers.keys.count { it.equals("Access-Control-Allow-Origin", true) })
    }

    @Test
    fun `a ticketed body reaches the target with its content type`() {
        val payload = "{\"a\":1}".toByteArray()
        proxy.putBody("ep:1", payload)
        val reply = proxy.handle(
            request("POST", "/body", PROXY_HEADER to "ep:1", "Content-Type" to "application/json"),
            id, origin
        ) ?: throw AssertionError("the server answered")
        assertEquals(200, reply.status)
        assertEquals("POST", reply.header("X-Method"))
        assertEquals("application/json", reply.mime)
        assertArrayEquals(payload, reply.body.use { it.readBytes() })
        assertNull("the ticket is consumed", proxy.takeBody("ep:1", 10))
    }

    @Test
    fun `a PUT body works the same, binary intact`() {
        val payload = ByteArray(70_000) { (it * 31 and 0xff).toByte() }
        proxy.putBody("ep:2", payload)
        val reply = proxy.handle(request("PUT", "/body", PROXY_HEADER to "ep:2"), id, origin) ?: throw AssertionError("answered")
        assertEquals("PUT", reply.header("X-Method"))
        assertArrayEquals(payload, reply.body.use { it.readBytes() })
    }

    @Test
    fun `the interceptor waits for a body still on its way over the bridge`() {
        val payload = "late".toByteArray()
        val deliver = Thread {
            Thread.sleep(150)
            proxy.putBody("ep:3", payload)
        }
        deliver.start()
        val reply = proxy.handle(request("POST", "/body", PROXY_HEADER to "ep:3"), id, origin) ?: throw AssertionError("answered")
        deliver.join()
        assertArrayEquals(payload, reply.body.use { it.readBytes() })
    }

    @Test
    fun `a body that never comes gives up after the wait`() {
        val started = System.currentTimeMillis()
        assertNull(proxy.takeBody("never", 50))
        assertTrue(System.currentTimeMillis() - started >= 50)
        // Tickets are one-shot and independent.
        proxy.putBody("a", byteArrayOf(1))
        proxy.putBody("b", byteArrayOf(2))
        assertArrayEquals(byteArrayOf(2), proxy.takeBody("b", 10))
        assertArrayEquals(byteArrayOf(1), proxy.takeBody("a", 10))
        assertNull(proxy.takeBody("a", 10))
    }

    @Test
    fun `only a credentialed fetch carries the jar's cookies and stores Set-Cookie`() {
        jar.cookieHeader = "sid=old"
        val plain = proxy.handle(request("GET", "/echo"), id, origin) ?: throw AssertionError("answered")
        assertFalse(plain.echoed().has("cookie"))
        val credentialed = proxy.handle(request("GET", "/echo", CREDENTIALS_HEADER to "include"), id, origin)
            ?: throw AssertionError("answered")
        assertEquals("sid=old", credentialed.echoed().getString("cookie"))
        assertEquals(listOf(url("/echo")), jar.asked)

        val anonymous = proxy.handle(request("GET", "/cookie"), id, origin) ?: throw AssertionError("answered")
        assertEquals("ok", anonymous.text())
        assertTrue(jar.stored.isEmpty())
        assertNull("Set-Cookie is never re-served to the page", anonymous.header("Set-Cookie"))
        val withCredentials = proxy.handle(request("GET", "/cookie", CREDENTIALS_HEADER to "include"), id, origin)
            ?: throw AssertionError("answered")
        assertEquals(listOf(url("/cookie") to "sid=1; Path=/"), jar.stored)
        assertNull(withCredentials.header("Set-Cookie"))
    }

    @Test
    fun `redirects follow fetch's rules`() {
        // 303, and 302 after a POST: a bodyless GET to the new place.
        proxy.putBody("ep:4", "x".toByteArray())
        val seeOther = proxy.handle(request("POST", "/see-other", PROXY_HEADER to "ep:4"), id, origin) ?: throw AssertionError("answered")
        assertEquals(200, seeOther.status)
        assertEquals("GET", seeOther.echoed().getString("method"))
        proxy.putBody("ep:5", "x".toByteArray())
        val found = proxy.handle(request("POST", "/found", PROXY_HEADER to "ep:5"), id, origin) ?: throw AssertionError("answered")
        assertEquals("GET", found.echoed().getString("method"))
        // 307 (a relative Location here): method and body survive.
        proxy.putBody("ep:6", "kept".toByteArray())
        val temporary = proxy.handle(request("POST", "/temporary", PROXY_HEADER to "ep:6", "Content-Type" to "text/plain"), id, origin)
            ?: throw AssertionError("answered")
        assertEquals("POST", temporary.header("X-Method"))
        assertEquals("kept", temporary.text())
        // A loop ends after the hop limit with the 3xx itself; the interceptor lets the WebView take it from there.
        val loop = proxy.handle(request("GET", "/loop"), id, origin) ?: throw AssertionError("answered")
        assertEquals(301, loop.status)
        loop.body.close()
    }

    @Test
    fun `an error status is re-served as such, body and charset included`() {
        val reply = proxy.handle(request("GET", "/fail"), id, origin) ?: throw AssertionError("answered")
        assertEquals(500, reply.status)
        assertEquals("text/plain", reply.mime)
        assertEquals("utf-8", reply.charset)
        assertEquals("boom", reply.text())
        assertEquals(origin, reply.header("Access-Control-Allow-Origin"))
    }

    @Test
    fun `a network failure is null so the WebView tries on its own`() {
        val closed = ServerSocket(0).use { it.localPort }
        assertNull(proxy.handle(CorsProxy.Request("GET", "http://127.0.0.1:$closed/echo", mapOf("Origin" to origin)), id, origin))
        // A 404 is an answer, not a failure.
        assertNotNull(proxy.handle(request("GET", "/nowhere"), id, origin)?.also { assertEquals(404, it.status); it.body.close() })
    }
}
