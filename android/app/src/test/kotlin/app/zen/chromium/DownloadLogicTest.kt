package app.zen.chromium

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.FileNotFoundException
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import app.zen.chromium.DownloadLogic.InterruptReason as R

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
        assertEquals(DownloadLogic.Continuation.Fail(R.SERVER_BAD_CONTENT), DownloadLogic.continuation(206, null, 500, 1000))
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
        assertEquals(DownloadLogic.Continuation.Fail(R.SERVER_UNAUTHORIZED), DownloadLogic.continuation(401, null, 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail(R.SERVER_FORBIDDEN), DownloadLogic.continuation(403, null, 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail(R.SERVER_BAD_CONTENT), DownloadLogic.continuation(404, null, 500, 1000))
        assertEquals(DownloadLogic.Continuation.Fail(R.SERVER_FAILED), DownloadLogic.continuation(503, null, 0, 1000))
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
            assertTrue("attempt $attempt", DownloadLogic.shouldAutoResume(R.NETWORK_FAILED, true, attempt, false))
            assertTrue("attempt $attempt", DownloadLogic.shouldAutoResume(R.NETWORK_TIMEOUT, true, attempt, false))
        }
        // The sixth failure in a row reaches the user.
        assertFalse(DownloadLogic.shouldAutoResume(R.NETWORK_FAILED, true, DownloadLogic.MAX_AUTO_RESUMES, false))
        // Server answers and local problems are never retried on their own.
        assertFalse(DownloadLogic.shouldAutoResume(R.SERVER_BAD_CONTENT, true, 0, false))
        assertFalse(DownloadLogic.shouldAutoResume(R.SERVER_NO_RANGE, true, 0, false))
        assertFalse(DownloadLogic.shouldAutoResume(R.FILE_FAILED, true, 0, false))
        // Nor a transfer that cannot append, or one the user paused or cancelled meanwhile.
        assertFalse(DownloadLogic.shouldAutoResume(R.NETWORK_FAILED, false, 0, false))
        assertFalse(DownloadLogic.shouldAutoResume(R.NETWORK_FAILED, true, 0, true))
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

    // --- the file behind a savePath --------------------------------------------------------------

    @Test
    fun aSavePathNamesItsStore() {
        val media = "content://media/external_primary/downloads/1000000025"
        assertEquals(DownloadLogic.SinkKind.MEDIA_STORE, DownloadLogic.sinkKind(media, 29))
        assertEquals(DownloadLogic.SinkKind.MEDIA_STORE, DownloadLogic.sinkKind(media, 34))
        // Before scoped storage the public directory was written directly; a media uri is another app's document.
        assertEquals(DownloadLogic.SinkKind.DOCUMENT, DownloadLogic.sinkKind(media, 28))
        assertEquals(
            DownloadLogic.SinkKind.DOCUMENT,
            DownloadLogic.sinkKind("content://com.android.externalstorage.documents/document/primary%3ADownload%2Freport.pdf", 34)
        )
        assertEquals(
            DownloadLogic.SinkKind.DOCUMENT,
            DownloadLogic.sinkKind("content://com.android.providers.downloads.documents/document/msf%3A42", 30)
        )
        assertEquals(DownloadLogic.SinkKind.FILE, DownloadLogic.sinkKind("/storage/emulated/0/Download/report.pdf", 34))
        assertEquals(DownloadLogic.SinkKind.FILE, DownloadLogic.sinkKind("/storage/emulated/0/Download/report.pdf.zeniumdownload", 28))
        assertEquals(DownloadLogic.SinkKind.NONE, DownloadLogic.sinkKind("", 34))
        assertEquals(DownloadLogic.SinkKind.NONE, DownloadLogic.sinkKind("   ", 34))
    }

    @Test
    fun deleteFileAnswersFromBeforeAndAfter() {
        assertEquals("deleted", DownloadLogic.deleteResult(existedBefore = true, existsAfter = false))
        assertEquals("failed", DownloadLogic.deleteResult(existedBefore = true, existsAfter = true))
        assertEquals("missing", DownloadLogic.deleteResult(existedBefore = false, existsAfter = false))
        // A file that appears during the attempt was never ours to report on.
        assertEquals("missing", DownloadLogic.deleteResult(existedBefore = false, existsAfter = true))
    }

    // --- failures --------------------------------------------------------------------------------

    @Test
    fun theReasonsAreTheCoresClosedSet() {
        // The 22 members of `DownloadInterruptReason` (src/shared/types.ts), same wire names.
        val wires = listOf(
            "network-failed", "network-timeout", "network-disconnected", "network-server-down",
            "server-failed", "server-no-range", "server-bad-content", "server-unauthorized", "server-forbidden", "server-unreachable",
            "file-failed", "file-access-denied", "file-no-space", "file-name-too-long", "file-too-large",
            "file-virus-infected", "file-blocked", "file-security-check-failed", "file-same-as-source",
            "user-canceled", "user-shutdown", "crash"
        )
        assertEquals(wires, R.entries.map { it.wire })
        for (reason in R.entries) {
            assertEquals(reason, R.fromWire(reason.wire))
            assertEquals(reason, R.fromWire(" ${reason.wire} "))
            assertTrue(reason.wire, reason.message.isNotEmpty())
            // Chrome's constant name is the wire name upper-cased, as in the core's `chromeInterruptReasonName`.
            assertEquals(reason.name, reason.wire.uppercase().replace('-', '_'))
        }
        assertNull(R.fromWire("interrupted"))
        assertNull(R.fromWire(null))
        assertTrue(R.NETWORK_TIMEOUT.isNetwork)
        assertFalse(R.SERVER_FAILED.isNetwork)
        assertEquals("Check internet connection", R.NETWORK_FAILED.message)
        assertEquals("Out of storage space", R.FILE_NO_SPACE.message)
        assertEquals("Couldn’t finish download", R.USER_SHUTDOWN.message)
        assertEquals("Check internet connection", DownloadNotifications.describe("network-timeout"))
        assertEquals("Something went wrong", DownloadNotifications.describe("nonsense"))
    }

    @Test
    fun exceptionsOutOfTheTransferAreNamed() {
        assertEquals(R.NETWORK_TIMEOUT, DownloadLogic.failureReason(SocketTimeoutException("x")))
        // Chromium leaves ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED and ERR_ADDRESS_UNREACHABLE
        // at NETWORK_FAILED; their Java analogues read the same.
        assertEquals(R.NETWORK_FAILED, DownloadLogic.failureReason(ConnectException("Connection refused")))
        assertEquals(R.NETWORK_FAILED, DownloadLogic.failureReason(UnknownHostException("x")))
        assertEquals(R.NETWORK_FAILED, DownloadLogic.failureReason(NoRouteToHostException("x")))
        assertEquals(R.NETWORK_FAILED, DownloadLogic.failureReason(IOException("connect failed: ENETUNREACH (Network is unreachable)")))
        assertEquals(R.NETWORK_DISCONNECTED, DownloadLogic.failureReason(IOException("connect failed: ENETDOWN (Network is down)")))
        assertEquals(R.SERVER_FAILED, DownloadLogic.failureReason(SSLHandshakeException("bad cert")))
        assertEquals(R.FILE_NO_SPACE, DownloadLogic.failureReason(IOException("write failed: ENOSPC (No space left on device)")))
        assertEquals(R.FILE_ACCESS_DENIED, DownloadLogic.failureReason(IOException("open failed: EACCES (Permission denied)")))
        assertEquals(R.FILE_ACCESS_DENIED, DownloadLogic.failureReason(IOException("open failed: EROFS (Read-only file system)")))
        assertEquals(R.FILE_ACCESS_DENIED, DownloadLogic.failureReason(SecurityException("Permission Denial: reading document")))
        assertEquals(R.FILE_NAME_TOO_LONG, DownloadLogic.failureReason(IOException("open failed: ENAMETOOLONG (File name too long)")))
        assertEquals(R.FILE_TOO_LARGE, DownloadLogic.failureReason(IOException("write failed: EFBIG (File too large)")))
        assertEquals(R.FILE_FAILED, DownloadLogic.failureReason(FileNotFoundException("/x/y")))
        assertEquals(R.NETWORK_FAILED, DownloadLogic.failureReason(IOException("unexpected end of stream")))
        assertEquals(R.NETWORK_FAILED, DownloadLogic.failureReason(IOException(null as String?)))
        assertEquals(R.FILE_FAILED, DownloadLogic.failureReason(IllegalStateException("x")))
    }

    @Test
    fun httpStatusesAreReadAsChromiumsDownloadCoreReadsThem() {
        assertEquals(R.SERVER_BAD_CONTENT, DownloadLogic.serverReason(204))
        assertEquals(R.SERVER_BAD_CONTENT, DownloadLogic.serverReason(205))
        assertEquals(R.SERVER_BAD_CONTENT, DownloadLogic.serverReason(404))
        assertEquals(R.SERVER_UNAUTHORIZED, DownloadLogic.serverReason(401))
        assertEquals(R.SERVER_UNAUTHORIZED, DownloadLogic.serverReason(407))
        assertEquals(R.SERVER_FORBIDDEN, DownloadLogic.serverReason(403))
        assertEquals(R.SERVER_NO_RANGE, DownloadLogic.serverReason(416))
        assertEquals(R.SERVER_FAILED, DownloadLogic.serverReason(410))
        assertEquals(R.SERVER_FAILED, DownloadLogic.serverReason(429))
        assertEquals(R.SERVER_FAILED, DownloadLogic.serverReason(500))
        assertEquals(R.SERVER_FAILED, DownloadLogic.serverReason(503))
    }
}
