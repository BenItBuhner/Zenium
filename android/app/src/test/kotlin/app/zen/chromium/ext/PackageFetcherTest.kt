package app.zen.chromium.ext

import app.zen.chromium.ext.TinyHttpServer.Response
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException

/** The fetcher against a local server: bodies land in token files, redirects are followed, limits and errors hold. */
class PackageFetcherTest {
    private val dir = ZipFixtures.tempDir("ext-packages")
    private val server = TinyHttpServer()
    private val payload = ByteArray(300_000) { (it * 7 and 0xff).toByte() }
    private val seenUserAgents = ArrayList<String?>()

    @Before
    fun startServer() {
        server.route("/package.crx") { request ->
            synchronized(seenUserAgents) { seenUserAgents.add(request.header("User-Agent")) }
            Response(200, payload)
        }
        server.route("/redirect") { Response(302, headers = mapOf("Location" to "/hop2")) }
        // A relative location, and a 307 on the way: both are followed.
        server.route("/hop2") { Response(307, headers = mapOf("Location" to "package.crx")) }
        server.route("/loop") { Response(301, headers = mapOf("Location" to "/loop")) }
        server.route("/missing") { Response(404, "no such extension".toByteArray()) }
        server.route("/update.xml") { Response(200, "<gupdate/>".toByteArray()) }
        server.start()
    }

    @After
    fun stopServer() {
        server.close()
        dir.deleteRecursively()
    }

    private fun url(path: String) = "http://127.0.0.1:${server.port}$path"

    @Test
    fun aBodyLandsInATokenFile() {
        val result = PackageFetcher(dir, "Zenium test agent").fetch(url("/package.crx"), 1L shl 30)
        assertEquals(200, result.status)
        assertEquals(url("/package.crx"), result.url)
        assertEquals(payload.size.toLong(), result.size)
        val file = result.file ?: throw AssertionError("a 200 must come with a file")
        assertTrue("the token names the file", PackageFetcher.isToken(file.name))
        assertEquals(dir, file.parentFile)
        assertArrayEquals(payload, file.readBytes())
        assertEquals(listOf("Zenium test agent"), seenUserAgents)
    }

    @Test
    fun redirectsAreFollowedToTheFinalUrl() {
        val result = PackageFetcher(dir).fetch(url("/redirect"), 1L shl 30)
        assertEquals(200, result.status)
        assertEquals("the final URL is reported", url("/package.crx"), result.url)
        assertArrayEquals(payload, result.file!!.readBytes())
    }

    @Test
    fun aRedirectLoopGivesUp() {
        try {
            PackageFetcher(dir).fetch(url("/loop"), 1L shl 30)
            fail("a loop must not run forever")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("redirects"))
        }
        assertTrue(dir.listFiles().isNullOrEmpty())
    }

    @Test
    fun anErrorStatusComesBackWithoutAFile() {
        val result = PackageFetcher(dir).fetch(url("/missing"), 1L shl 30)
        assertEquals(404, result.status)
        assertNull(result.file)
        assertEquals(0L, result.size)
        assertTrue(dir.listFiles().isNullOrEmpty())
    }

    @Test
    fun aBodyOverTheLimitIsRefusedAndDeleted() {
        try {
            PackageFetcher(dir).fetch(url("/package.crx"), 100_000)
            fail("a body over the limit must be refused")
        } catch (e: IOException) {
            assertTrue(e.message!!, e.message!!.contains("limit"))
        }
        assertTrue("nothing is left in the cache", dir.listFiles().isNullOrEmpty())
    }

    @Test
    fun smallTextResponsesWorkTheSameWay() {
        val result = PackageFetcher(dir).fetch(url("/update.xml"), 1L shl 20)
        assertEquals(200, result.status)
        assertEquals("<gupdate/>", result.file!!.readText())
    }

    @Test
    fun aServerThatIsNotThereFails() {
        server.close()
        try {
            PackageFetcher(dir).fetch(url("/package.crx"), 1L shl 30)
            fail("a refused connection must fail")
        } catch (e: IOException) {
            // expected
        }
        assertTrue(dir.listFiles().isNullOrEmpty())
    }

    @Test
    fun tokensAreThirtyTwoHexCharacters() {
        val token = PackageFetcher.newToken()
        assertTrue(token, PackageFetcher.isToken(token))
        for (bad in listOf("", "..", "../x", "ABCDEF0123456789ABCDEF0123456789", "0123456789abcdef", "$token/x")) {
            assertTrue(bad, !PackageFetcher.isToken(bad))
        }
    }
}
