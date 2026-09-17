package app.zen.chromium

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class DownloadLogicTest {
    private val ext: (String) -> String? = { mime -> DownloadLogic.fallbackExtension(mime) }

    // --- resuming --------------------------------------------------------------------------------

    @Test
    fun parsesContentRange() {
        assertEquals(DownloadLogic.ContentRange(100, 999, 1000), DownloadLogic.parseContentRange("bytes 100-999/1000"))
        assertEquals(DownloadLogic.ContentRange(100, 999, -1), DownloadLogic.parseContentRange("bytes 100-999/*"))
        assertEquals(DownloadLogic.ContentRange(-1, -1, 1000), DownloadLogic.parseContentRange("bytes */1000"))
        assertEquals(DownloadLogic.ContentRange(0, 9, 10), DownloadLogic.parseContentRange(" BYTES 0-9/10 "))
        assertNull(DownloadLogic.parseContentRange(null))
        assertNull(DownloadLogic.parseContentRange("items 0-9/10"))
        assertNull(DownloadLogic.parseContentRange("bytes 0-9"))
    }

    @Test
    fun a206AtTheRightOffsetAppends() {
        assertEquals(DownloadLogic.Continuation.Append, DownloadLogic.continuation(206, "bytes 500-999/1000", 500, 1000))
        // The total was unknown before; a 206 still appends.
        assertEquals(DownloadLogic.Continuation.Append, DownloadLogic.continuation(206, "bytes 500-999/*", 500, -1))
    }

    @Test
    fun aMismatchedRangeOrLengthRestarts() {
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(206, "bytes 0-999/1000", 500, 1000))
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(206, "bytes 500-1999/2000", 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail("server-bad-content"), DownloadLogic.continuation(206, null, 500, 1000))
    }

    @Test
    fun a200ToARangeRequestMeansStartOver() {
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(200, null, 500, 1000))
        // A fresh request (offset 0) is always a start.
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(200, null, 0, -1))
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(206, "bytes 0-999/1000", 0, -1))
    }

    @Test
    fun a416IsOnlyFineWhenTheFileIsWhole() {
        assertEquals(DownloadLogic.Continuation.AlreadyComplete, DownloadLogic.continuation(416, "bytes */1000", 1000, 1000))
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(416, "bytes */1000", 500, 1000))
        assertEquals(DownloadLogic.Continuation.Restart, DownloadLogic.continuation(416, null, 500, 1000))
    }

    @Test
    fun otherStatusesFailWithChromiumsReasons() {
        assertEquals(DownloadLogic.Continuation.Fail("server-unauthorized"), DownloadLogic.continuation(401, null, 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail("server-forbidden"), DownloadLogic.continuation(403, null, 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail("server-bad-content"), DownloadLogic.continuation(404, null, 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail("server-failed"), DownloadLogic.continuation(503, null, 0, 1000))
    }

    @Test
    fun resumabilityNeedsRangesOrAValidator() {
        assertTrue(DownloadLogic.canResume("bytes", null, null))
        assertTrue(DownloadLogic.canResume(null, "\"etag\"", null))
        assertTrue(DownloadLogic.canResume(null, null, "Wed, 21 Oct 2015 07:28:00 GMT"))
        assertFalse(DownloadLogic.canResume(null, "W/\"weak\"", null))
        assertFalse(DownloadLogic.canResume("none", "\"etag\"", null))
        assertFalse(DownloadLogic.canResume(null, null, null))
    }

    @Test
    fun ifRangePrefersAStrongEtag() {
        assertEquals("\"etag\"", DownloadLogic.strongValidator("\"etag\"", "date"))
        assertEquals("date", DownloadLogic.strongValidator("W/\"weak\"", "date"))
        assertEquals("date", DownloadLogic.strongValidator("", "date"))
        assertNull(DownloadLogic.strongValidator("W/\"weak\"", ""))
    }

    // --- automatic retries -----------------------------------------------------------------------

    @Test
    fun flakyConnectionsRetryQuietlyABoundedNumberOfTimes() {
        for (attempt in 0 until DownloadLogic.MAX_AUTO_RESUMES) {
            assertTrue("attempt $attempt", DownloadLogic.shouldAutoResume("network-failed", true, attempt, false))
            assertTrue("attempt $attempt", DownloadLogic.shouldAutoResume("network-timeout", true, attempt, false))
        }
        // The sixth failure in a row reaches the user.
        assertFalse(DownloadLogic.shouldAutoResume("network-failed", true, DownloadLogic.MAX_AUTO_RESUMES, false))
        // Server answers and local problems are never retried on their own.
        assertFalse(DownloadLogic.shouldAutoResume("server-bad-content", true, 0, false))
        assertFalse(DownloadLogic.shouldAutoResume("server-precondition", true, 0, false))
        assertFalse(DownloadLogic.shouldAutoResume("file-failed", true, 0, false))
        // Nor a transfer that cannot append, or one the user paused or cancelled meanwhile.
        assertFalse(DownloadLogic.shouldAutoResume("network-failed", false, 0, false))
        assertFalse(DownloadLogic.shouldAutoResume("network-failed", true, 0, true))
    }

    @Test
    fun retryBackoffGrowsThenPlateaus() {
        assertEquals(1000L, DownloadLogic.autoResumeDelayMs(1))
        assertEquals(2000L, DownloadLogic.autoResumeDelayMs(2))
        assertEquals(4000L, DownloadLogic.autoResumeDelayMs(3))
        assertEquals(8000L, DownloadLogic.autoResumeDelayMs(4))
        assertEquals(8000L, DownloadLogic.autoResumeDelayMs(5))
        assertEquals(1000L, DownloadLogic.autoResumeDelayMs(0))
    }

    // --- naming ----------------------------------------------------------------------------------

    @Test
    fun contentDispositionWins() {
        assertEquals("report.pdf", DownloadLogic.filenameFor("https://x/y.bin", "attachment; filename=\"report.pdf\"", "application/pdf", ext))
        assertEquals("report.pdf", DownloadLogic.filenameFor("https://x/y.bin", "attachment;filename=report.pdf", null, ext))
        assertEquals("résumé.pdf", DownloadLogic.filenameFor("https://x/y", "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", null, ext))
        assertEquals("semi;colon.txt", DownloadLogic.filenameFor("https://x/y", "attachment; filename=\"semi;colon.txt\"", null, ext))
        assertEquals("inline.png", DownloadLogic.filenameFor("https://x/y", "inline; filename=inline.png", null, ext))
    }

    @Test
    fun thenTheUrlThenTheMimeType() {
        assertEquals("archive.zip", DownloadLogic.filenameFor("https://cdn.example.com/files/archive.zip?token=1#frag", null, null, ext))
        assertEquals("my file.txt", DownloadLogic.filenameFor("https://x/my%20file.txt", null, null, ext))
        assertEquals("download.png", DownloadLogic.filenameFor("https://x/", null, "image/png", ext))
        assertEquals("download.pdf", DownloadLogic.filenameFor("data:application/pdf;base64,AAAA", null, "application/pdf", ext))
        assertEquals("download", DownloadLogic.filenameFor("blob:https://x/uuid", null, null, ext))
        assertEquals("image.jpg", DownloadLogic.filenameFor("blob:https://x/uuid", "attachment; filename=image.jpg", "image/jpeg", ext))
        assertEquals("image.jpg", DownloadLogic.filenameFor("https://x/image", null, "image/jpeg", ext))
    }

    @Test
    fun theAnchorsDownloadAttributeNamesBlobsAndDataUrls() {
        // The page remembered `<a download="hello-blob.txt">`; it beats the URL but not the server.
        assertEquals("hello-blob.txt", DownloadLogic.filenameFor("blob:https://x/uuid", null, "text/plain", ext, "hello-blob.txt"))
        assertEquals("notes.txt", DownloadLogic.filenameFor("data:text/plain;base64,AAAA", null, "text/plain", ext, "notes"))
        assertEquals("attribute.bin", DownloadLogic.filenameFor("https://x/path/file.bin", null, null, ext, "attribute.bin"))
        assertEquals("server.bin", DownloadLogic.filenameFor("https://x/y", "attachment; filename=server.bin", null, ext, "attribute.bin"))
        assertEquals("y.bin", DownloadLogic.filenameFor("https://x/y.bin", null, null, ext, "  "))
        // A hostile attribute cannot climb out of the folder: separators become underscores.
        assertEquals("_.._etc_passwd", DownloadLogic.filenameFor("blob:https://x/uuid", null, null, ext, "../../etc/passwd"))
    }

    @Test
    fun registryKeysAndOrigins() {
        val short = "blob:https://x/3f1a"
        assertEquals("$short#${short.length}", DownloadLogic.downloadNameKey(short))
        val long = "data:application/octet-stream;base64," + "A".repeat(5000)
        val key = DownloadLogic.downloadNameKey(long)
        assertEquals(200 + 1 + long.length.toString().length, key.length)
        assertTrue(key.endsWith("#5037"))
        assertTrue(DownloadLogic.sameOrigin("https://x.example/a", "https://x.example:443/b"))
        assertTrue(DownloadLogic.sameOrigin("http://10.0.2.2:18923/file", "http://10.0.2.2:18923/page.html"))
        assertFalse(DownloadLogic.sameOrigin("https://x.example/a", "http://x.example/a"))
        assertFalse(DownloadLogic.sameOrigin("https://cdn.example/a", "https://x.example/a"))
        assertFalse(DownloadLogic.sameOrigin("https://x.example/a", ""))
        assertFalse(DownloadLogic.sameOrigin("blob:https://x/uuid", "https://x/"))
    }

    @Test
    fun namesAreMadeSafe() {
        assertEquals("a_b_c_d.txt", DownloadLogic.sanitizeFilename("a/b\\c:d.txt"))
        assertEquals("hidden.txt", DownloadLogic.sanitizeFilename("...hidden.txt"))
        assertEquals("CON_.txt", DownloadLogic.sanitizeFilename("CON.txt"))
        assertEquals("trailing", DownloadLogic.sanitizeFilename("trailing. "))
        assertEquals("", DownloadLogic.sanitizeFilename("   "))
        val long = DownloadLogic.sanitizeFilename("x".repeat(300) + ".pdf")
        assertTrue(long.length <= 200)
        assertTrue(long.endsWith(".pdf"))
        assertEquals("download", DownloadLogic.filenameFor("https://x/\u0007", "attachment; filename=\"\u0007\"", null, ext))
    }

    @Test
    fun uniqueNamesCountUpLikeChrome() {
        val taken = setOf("report.pdf", "report (1).pdf", "notes")
        assertEquals("report (2).pdf", DownloadLogic.uniqueName("report.pdf") { it in taken })
        assertEquals("notes (1)", DownloadLogic.uniqueName("notes") { it in taken })
        assertEquals("fresh.txt", DownloadLogic.uniqueName("fresh.txt") { it in taken })
    }

    @Test
    fun extensionsAndMimeBase() {
        assertEquals("pdf", DownloadLogic.extensionOf("report.pdf"))
        assertEquals("gz", DownloadLogic.extensionOf("archive.tar.gz"))
        assertEquals("", DownloadLogic.extensionOf("README"))
        assertEquals("", DownloadLogic.extensionOf("odd.name with spaces"))
        assertEquals("text/html", DownloadLogic.mimeBase("Text/HTML; charset=utf-8"))
        assertEquals("apk", DownloadLogic.fallbackExtension("application/vnd.android.package-archive"))
        assertNull(DownloadLogic.fallbackExtension("application/x-unknown"))
    }

    // --- data: URLs ------------------------------------------------------------------------------

    @Test
    fun decodesDataUrls() {
        val base64 = DownloadLogic.parseDataUrl("data:text/plain;base64,SGVsbG8sIFdvcmxk")!!
        assertEquals("text/plain", base64.mimeType)
        assertEquals("Hello, World", String(base64.bytes))
        val plain = DownloadLogic.parseDataUrl("data:,A%20brief%20note")!!
        assertEquals("text/plain", plain.mimeType)
        assertEquals("A brief note", String(plain.bytes))
        val typed = DownloadLogic.parseDataUrl("data:application/json;charset=utf-8,%7B%22a%22%3A1%7D")!!
        assertEquals("application/json", typed.mimeType)
        assertEquals("{\"a\":1}", String(typed.bytes))
        val unpadded = DownloadLogic.parseDataUrl("data:application/octet-stream;base64,AQID")!!
        assertArrayEquals(byteArrayOf(1, 2, 3), unpadded.bytes)
        assertNull(DownloadLogic.parseDataUrl("data:text/plain;base64"))
        assertNull(DownloadLogic.parseDataUrl("https://x/y"))
    }

    // --- failures --------------------------------------------------------------------------------

    @Test
    fun failuresGetShortReasons() {
        assertEquals("network-disconnected", DownloadLogic.failureReason(UnknownHostException("x")))
        assertEquals("network-timeout", DownloadLogic.failureReason(SocketTimeoutException("x")))
        assertEquals("file-no-space", DownloadLogic.failureReason(IOException("write failed: ENOSPC (No space left on device)")))
        assertEquals("file-access-denied", DownloadLogic.failureReason(IOException("open failed: EACCES (Permission denied)")))
        assertEquals("network-failed", DownloadLogic.failureReason(IOException("unexpected end of stream")))
        assertEquals("file-failed", DownloadLogic.failureReason(IllegalStateException("x")))
    }
}
