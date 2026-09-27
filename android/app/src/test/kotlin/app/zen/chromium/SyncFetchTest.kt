package app.zen.chromium

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * `SyncFetch` against a loopback server, as the WebDAV transport drives it: the request as it
 * went on the wire (method, headers, body), the answer as the transport reads it (status,
 * lower-cased headers, text), and the paths where there is no answer – the abort, the timeout,
 * a body over the cap, a redirect that is not taken.
 */
class SyncFetchTest {
    private lateinit var server: MockWebServer
    private val fetch = SyncFetch()

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun run(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: String? = null,
        noStore: Boolean = true,
        id: String = "1",
        client: SyncFetch = fetch
    ): SyncFetch.Outcome = client.run(client.begin(id), server.url(path).toString(), method, headers, body, noStore)

    private fun response(outcome: SyncFetch.Outcome): SyncFetch.Outcome.Response {
        assertTrue("expected a response, got ${describe(outcome)}", outcome is SyncFetch.Outcome.Response)
        return outcome as SyncFetch.Outcome.Response
    }

    private fun failure(outcome: SyncFetch.Outcome): SyncFetch.Outcome.Failure {
        assertTrue("expected a failure, got ${describe(outcome)}", outcome is SyncFetch.Outcome.Failure)
        return outcome as SyncFetch.Outcome.Failure
    }

    private fun describe(outcome: SyncFetch.Outcome): String = when (outcome) {
        is SyncFetch.Outcome.Response -> "response ${outcome.status}"
        is SyncFetch.Outcome.Failure -> "failure ${outcome.kind}: ${outcome.message}"
    }

    private fun recorded(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS) ?: error("no request reached the server")

    // --- the WebDAV verbs on the wire ------------------------------------------------------------

    @Test
    fun `PROPFIND carries its Depth, its body and the caller's content type, and reads the multistatus back`() {
        val multistatus = "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response/></d:multistatus>"
        server.enqueue(
            MockResponse().setResponseCode(207)
                .setHeader("Content-Type", "application/xml; charset=utf-8")
                .setHeader("ETag", "\"abc\"")
                .setBody(multistatus)
        )
        val outcome = response(
            run(
                "PROPFIND",
                "/remote.php/dav/files/alice/Zenium/zenium-sync/",
                headers = mapOf(
                    "Authorization" to "Basic YWxpY2U6YXBwLXBhc3M=",
                    "Depth" to "1",
                    "Content-Type" to "application/xml; charset=utf-8"
                ),
                body = "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:getetag/></d:prop></d:propfind>"
            )
        )
        assertEquals(207, outcome.status)
        assertEquals("\"abc\"", outcome.headers["etag"])
        assertEquals("application/xml; charset=utf-8", outcome.headers["content-type"])
        assertEquals(multistatus, outcome.body)

        val request = recorded()
        assertEquals("PROPFIND", request.method)
        assertEquals("/remote.php/dav/files/alice/Zenium/zenium-sync/", request.path)
        assertEquals("1", request.getHeader("Depth"))
        assertEquals("Basic YWxpY2U6YXBwLXBhc3M=", request.getHeader("Authorization"))
        // The caller's content type stays; OkHttp does not put its own over it.
        assertEquals("application/xml; charset=utf-8", request.getHeader("Content-Type"))
        assertEquals("<d:propfind xmlns:d=\"DAV:\"><d:prop><d:getetag/></d:prop></d:propfind>", request.body.readUtf8())
        assertEquals("no-store", request.getHeader("Cache-Control"))
    }

    @Test
    fun `PUT then MOVE carry the ETag preconditions, the destination and the overwrite flag`() {
        server.enqueue(MockResponse().setResponseCode(201).setHeader("ETag", "\"v1\""))
        server.enqueue(MockResponse().setResponseCode(204))

        val put = response(
            run(
                "PUT",
                "/dav/zenium-sync/device_a.zensync.tmp-x1",
                headers = mapOf("If-None-Match" to "*", "Content-Type" to "application/json"),
                body = "{\"deviceId\":\"a\"}"
            )
        )
        assertEquals(201, put.status)
        assertEquals("\"v1\"", put.headers["etag"])
        assertEquals("", put.body)
        val putRequest = recorded()
        assertEquals("PUT", putRequest.method)
        assertEquals("*", putRequest.getHeader("If-None-Match"))
        assertEquals("{\"deviceId\":\"a\"}", putRequest.body.readUtf8())
        assertEquals("16", putRequest.getHeader("Content-Length"))

        val move = response(
            run(
                "MOVE",
                "/dav/zenium-sync/device_a.zensync.tmp-x1",
                headers = mapOf(
                    "Destination" to server.url("/dav/zenium-sync/device_a.zensync").toString(),
                    "Overwrite" to "T",
                    "If-Match" to "\"v0\""
                )
            )
        )
        assertEquals(204, move.status)
        assertEquals("", move.body)
        val moveRequest = recorded()
        assertEquals("MOVE", moveRequest.method)
        assertEquals(server.url("/dav/zenium-sync/device_a.zensync").toString(), moveRequest.getHeader("Destination"))
        assertEquals("T", moveRequest.getHeader("Overwrite"))
        assertEquals("\"v0\"", moveRequest.getHeader("If-Match"))
        // A MOVE has no body; none is invented for it.
        assertEquals(0L, moveRequest.bodySize)
    }

    @Test
    fun `a 412 is a response for the transport to class, not a failure, and a PUT without a body sends an empty one`() {
        server.enqueue(MockResponse().setResponseCode(412).setBody("Precondition Failed"))
        val outcome = response(run("PUT", "/dav/x", headers = mapOf("If-Match" to "\"stale\"")))
        assertEquals(412, outcome.status)
        assertEquals("Precondition Failed", outcome.body)
        val request = recorded()
        assertEquals("PUT", request.method)
        assertEquals("0", request.getHeader("Content-Length"))
    }

    @Test
    fun `MKCOL and DELETE go out as given and read a bodiless answer as empty text`() {
        server.enqueue(MockResponse().setResponseCode(201))
        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(201, response(run("MKCOL", "/dav/Zenium/")).status)
        assertEquals("MKCOL", recorded().method)
        assertEquals(204, response(run("DELETE", "/dav/Zenium/zenium-sync/old")).status)
        assertEquals("DELETE", recorded().method)
    }

    // --- what never leaves the origin --------------------------------------------------------------

    @Test
    fun `a redirect is not followed, to another origin or to the same one, so the credential travels once`() {
        val elsewhere = MockWebServer()
        elsewhere.start()
        try {
            server.enqueue(
                MockResponse().setResponseCode(302)
                    .setHeader("Location", elsewhere.url("/dav/").toString())
            )
            val outcome = response(run("PROPFIND", "/dav/", headers = mapOf("Authorization" to "Basic c2VjcmV0")))
            assertEquals(302, outcome.status)
            assertEquals(elsewhere.url("/dav/").toString(), outcome.headers["location"])
            assertEquals(1, server.requestCount)
            assertEquals(0, elsewhere.requestCount)

            server.enqueue(MockResponse().setResponseCode(301).setHeader("Location", "/dav/moved/"))
            server.enqueue(MockResponse().setResponseCode(200).setBody("never read"))
            assertEquals(301, response(run("GET", "/dav/")).status)
            assertEquals(2, server.requestCount)
        } finally {
            elsewhere.shutdown()
        }
    }

    @Test
    fun `no cookie jar - a Set-Cookie is not sent back on the next request`() {
        server.enqueue(MockResponse().setResponseCode(200).addHeader("Set-Cookie", "session=abc; Path=/"))
        server.enqueue(MockResponse().setResponseCode(200))
        response(run("GET", "/dav/"))
        recorded()
        response(run("GET", "/dav/"))
        assertNull(recorded().getHeader("Cookie"))
    }

    @Test
    fun `no store - a cacheable answer is asked for again, and the caller's own Cache-Control is kept`() {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Cache-Control", "max-age=3600").setBody("one"))
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Cache-Control", "max-age=3600").setBody("two"))
        assertEquals("one", response(run("GET", "/dav/doc")).body)
        assertEquals("two", response(run("GET", "/dav/doc")).body)
        assertEquals(2, server.requestCount)
        assertEquals("no-store", recorded().getHeader("Cache-Control"))
        recorded()

        server.enqueue(MockResponse().setResponseCode(200))
        response(run("GET", "/dav/doc", headers = mapOf("Cache-Control" to "no-cache")))
        assertEquals("no-cache", recorded().getHeader("Cache-Control"))

        server.enqueue(MockResponse().setResponseCode(200))
        response(run("GET", "/dav/doc", noStore = false))
        assertNull(recorded().getHeader("Cache-Control"))
    }

    // --- the answer's shape ------------------------------------------------------------------------

    @Test
    fun `response headers come back by lower-cased name, repeats joined with a comma`() {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .addHeader("ETag", "\"E\"")
                .addHeader("DAV", "1")
                .addHeader("DAV", "3")
                .addHeader("X-Mixed-Case", "kept")
        )
        val outcome = response(run("OPTIONS", "/dav/"))
        assertEquals("\"E\"", outcome.headers["etag"])
        assertEquals("1, 3", outcome.headers["dav"])
        assertEquals("kept", outcome.headers["x-mixed-case"])
        assertFalse(outcome.headers.keys.any { it != it.lowercase() })
    }

    @Test
    fun `a body over the cap is a too-large failure, announced or streamed`() {
        val small = SyncFetch(maxBodyBytes = 64)
        server.enqueue(MockResponse().setResponseCode(200).setBody("x".repeat(100)))
        assertEquals(SyncFetch.TOO_LARGE, failure(run("GET", "/dav/big", client = small)).kind)
        server.enqueue(MockResponse().setResponseCode(200).setChunkedBody("y".repeat(100), 16))
        assertEquals(SyncFetch.TOO_LARGE, failure(run("GET", "/dav/big", client = small)).kind)
        server.enqueue(MockResponse().setResponseCode(200).setChunkedBody("z".repeat(64), 16))
        assertEquals("z".repeat(64), response(run("GET", "/dav/fits", client = small)).body)
    }

    @Test
    fun `a body is read in the charset its content type names, UTF-8 when none`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("héllo"))
        assertEquals("héllo", response(run("GET", "/dav/a")).body)
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/plain; charset=iso-8859-1")
                .setBody(okio.Buffer().write("héllo".toByteArray(Charsets.ISO_8859_1)))
        )
        assertEquals("héllo", response(run("GET", "/dav/b")).body)
    }

    // --- no answer -----------------------------------------------------------------------------------

    @Test
    fun `an abort while the request waits on the server cuts it with the aborted kind`() {
        // The server holds the connection open and never answers, until the client closes it.
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val ticket = fetch.begin("slow")
        val outcome = AtomicReference<SyncFetch.Outcome>()
        val done = CountDownLatch(1)
        Thread {
            outcome.set(fetch.run(ticket, server.url("/dav/").toString(), "PROPFIND", emptyMap(), "<d:propfind/>", true))
            done.countDown()
        }.start()
        recorded() // the request is at the server, which will not answer
        assertTrue(fetch.abort("slow"))
        assertTrue("the abort did not cut the request", done.await(5, TimeUnit.SECONDS))
        assertEquals(SyncFetch.ABORTED, failure(outcome.get()).kind)
        // Retired: a second abort finds nothing.
        assertFalse(fetch.abort("slow"))
    }

    @Test
    fun `an abort that lands before the worker starts is honoured and nothing reaches the server`() {
        val ticket = fetch.begin("early")
        assertTrue(fetch.abort("early"))
        val outcome = fetch.run(ticket, server.url("/dav/").toString(), "PROPFIND", emptyMap(), null, true)
        assertEquals(SyncFetch.ABORTED, failure(outcome).kind)
        assertEquals(0, server.requestCount)
        assertFalse(fetch.abort("early"))
        assertFalse(fetch.abort("never-begun"))
    }

    @Test
    fun `a server that answers too slowly is a timeout, one that is gone is a network failure`() {
        val impatient = SyncFetch(connectTimeoutMs = 2_000, ioTimeoutMs = 300)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        assertEquals(SyncFetch.TIMEOUT, failure(run("GET", "/dav/", client = impatient)).kind)

        val gone = MockWebServer()
        gone.start()
        val url = gone.url("/dav/").toString()
        gone.shutdown()
        val outcome = failure(fetch.run(fetch.begin("g"), url, "PROPFIND", mapOf("Authorization" to "Basic c2VjcmV0"), null, true))
        assertEquals(SyncFetch.NETWORK, outcome.kind)
        assertFalse(outcome.message.contains("c2VjcmV0"))
    }

    @Test
    fun `a URL that is not http, a method that is not a token and a header HTTP forbids are refused before the wire`() {
        assertEquals(SyncFetch.BAD_URL, failure(fetch.run(fetch.begin(""), "ftp://cloud.test/dav/", "PROPFIND", emptyMap(), null, true)).kind)
        assertEquals(SyncFetch.BAD_URL, failure(fetch.run(fetch.begin(""), "not a url", "GET", emptyMap(), null, true)).kind)
        assertEquals(SyncFetch.BAD_METHOD, failure(run("propfind", "/dav/")).kind)
        assertEquals(SyncFetch.BAD_METHOD, failure(run("GET /", "/dav/")).kind)
        val header = failure(run("PROPFIND", "/dav/", headers = mapOf("Authorization" to "Basic c2Vj\ncmV0")))
        assertEquals(SyncFetch.BAD_HEADER, header.kind)
        // The refusal names the header, never its value.
        assertTrue(header.message.contains("Authorization"))
        assertFalse(header.message.contains("c2Vj"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `an empty id is a request nobody can abort, and it does not linger`() {
        server.enqueue(MockResponse().setResponseCode(200))
        val ticket = fetch.begin("")
        response(fetch.run(ticket, server.url("/dav/").toString(), "GET", emptyMap(), null, true))
        assertFalse(fetch.abort(""))
    }

    // --- the sides that read these --------------------------------------------------------------------

    /** A file of the repository, from wherever Gradle runs the test (the module directory, or the root). */
    private fun repoFile(path: String): File? {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val file = File(dir, path)
            if (file.isFile) return file
            dir = dir.parentFile
        }
        return null
    }

    @Test
    fun `the chrome's side reads the same prefix and kinds, and Host dispatches the two verbs off the main thread`() {
        val ts = repoFile("src/android/syncFetch.ts")
        val host = repoFile("android/app/src/main/kotlin/app/zen/chromium/Host.kt")
        assumeTrue("the repository is not beside the module", ts != null && host != null)
        val chrome = ts!!.readText()
        assertTrue(chrome.contains("export const FETCH_REJECTION_PREFIX = '${SyncFetch.REJECTION_PREFIX}'"))
        assertTrue(chrome.contains("export const FETCH_ABORTED = '${SyncFetch.ABORTED}'"))
        assertTrue(chrome.contains("bridge.call('sync.fetchAbort', { id })"))
        val dispatch = host!!.readText()
        assertTrue(dispatch.contains("\"sync.fetch\" -> syncFetch(args, reply)"))
        assertTrue(dispatch.contains("\"sync.fetchAbort\" -> reply(syncFetch?.abort(args.str(\"id\")) == true)"))
        assertTrue(dispatch.contains("Rejection(\"\${SyncFetch.REJECTION_PREFIX}\${outcome.kind}: \${outcome.message}\")"))
        // The ticket is taken on the main thread, the request runs on the io executor.
        val body = dispatch.substringAfter("private fun syncFetch(args: JSONObject").substringBefore("private fun secretsOp")
        assertTrue(body.indexOf("fetch.begin(") < body.indexOf("io.execute {"))
        assertTrue(body.contains("main.post { reply(result) }"))
    }

    @Test
    fun `the transport asks for no-store and reads the etag by its lower-case name`() {
        val webdav = repoFile("src/core/sync/webdav.ts")
        assumeTrue("the core's transport is not beside the module", webdav != null)
        val source = webdav!!.readText()
        assertTrue(source.contains("cache: 'no-store'"))
        assertTrue(source.contains("headers.get('etag')"))
    }
}
