package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files

/**
 * The PDF viewer's print verb (`view.printPdf`, CT-44), the part that runs without a print
 * service: the job's shape (exactly one of `path` and `data`), the queue's name, the guard
 * that lets only a file under the app's own directories through the bridge, and the copy into
 * the spooler's descriptor with its cancellation. The adapter itself is the framework's to
 * drive.
 */
class PdfPrintTest {
    private fun job(vararg pairs: Pair<String, Any?>): PdfPrint.Job? = PdfPrint.parse(json(*pairs))

    @Test
    fun aJobNamesExactlyOneOfPathAndData() {
        val byPath = job("tabId" to "t1", "name" to "mooring.pdf", "path" to "/data/x.pdf", "data" to null)
        assertNotNull(byPath)
        assertEquals("/data/x.pdf", byPath!!.path)
        assertNull(byPath.data)
        assertEquals("t1", byPath.tabId)
        assertEquals("mooring.pdf", byPath.name)
        val byData = job("tabId" to "t1", "name" to "mooring.pdf", "path" to null, "data" to "JVBERi0x")
        assertNotNull(byData)
        assertNull(byData!!.path)
        assertEquals("JVBERi0x", byData.data)
        // Both, neither, or the empty string for either: not a job – the verb answers false
        // (a malformed job is refused, not repaired into the one of its values that would do).
        assertNull(job("tabId" to "t1", "name" to "a.pdf", "path" to "/data/x.pdf", "data" to "JVBERi0x"))
        assertNull(job("tabId" to "t1", "name" to "a.pdf", "path" to null, "data" to null))
        assertNull(job("tabId" to "t1", "name" to "a.pdf"))
        assertNull(job("tabId" to "t1", "name" to "a.pdf", "path" to "", "data" to ""))
        assertNull(job("tabId" to "t1", "name" to "a.pdf", "path" to "/data/x.pdf", "data" to ""))
        assertNull(job("tabId" to "t1", "name" to "a.pdf", "path" to "", "data" to "JVBERi0x"))
        assertNull(job("tabId" to "t1", "name" to "a.pdf", "path" to "", "data" to null))
        // A job of no tab's is none either; a missing name is an empty one, named in the queue by the default.
        assertNull(job("name" to "a.pdf", "data" to "JVBERi0x"))
        assertNull(job("tabId" to "", "name" to "a.pdf", "data" to "JVBERi0x"))
        assertEquals("", job("tabId" to "t1", "data" to "JVBERi0x")!!.name)
    }

    @Test
    fun theQueueNameIsTheFilesWithoutItsExtension() {
        assertEquals("mooring", PdfPrint.jobName("mooring.pdf"))
        assertEquals("Mooring application", PdfPrint.jobName("Mooring application.PDF"))
        assertEquals("report", PdfPrint.jobName("  report.pdf  "))
        // One extension goes, not a second; another extension is the name's own.
        assertEquals("a.pdf", PdfPrint.jobName("a.pdf.pdf"))
        assertEquals("notes.txt", PdfPrint.jobName("notes.txt"))
        assertEquals("Document", PdfPrint.jobName(".pdf"))
        assertEquals("Document", PdfPrint.jobName(""))
        assertEquals("Document", PdfPrint.jobName("   "))
        assertEquals(PdfPrint.DEFAULT_JOB_NAME, PdfPrint.jobName(".PDF"))
    }

    @Test
    fun onlyAFileUnderTheAppsOwnDirectoriesIsLetThrough() {
        val files = Files.createTempDirectory("zen-files").toFile()
        val cache = Files.createTempDirectory("zen-cache").toFile()
        val elsewhere = Files.createTempDirectory("zen-elsewhere").toFile()
        try {
            val roots = listOf(files, cache)
            val inFiles = File(files, "print.pdf").apply { writeBytes(byteArrayOf(0x25, 0x50)) }
            val inCache = File(File(cache, "print").apply { mkdirs() }, "copy.pdf").apply { writeBytes(byteArrayOf(0x25)) }
            val outside = File(elsewhere, "secret.pdf").apply { writeBytes(byteArrayOf(0x25)) }
            assertEquals(inFiles.canonicalFile, PdfPrint.allowed(inFiles.path, roots))
            assertEquals(inCache.canonicalFile, PdfPrint.allowed(inCache.path, roots))
            // The public Downloads, another app's files, anything not under the roots: refused.
            assertNull(PdfPrint.allowed(outside.path, roots))
            assertNull(PdfPrint.allowed("/storage/emulated/0/Download/report.pdf", roots))
            assertNull(PdfPrint.allowed("content://media/external/downloads/1000000025", roots))
            // A path that starts under a root and climbs out of it is where it ends up.
            assertNull(PdfPrint.allowed("${files.path}/../${elsewhere.name}/secret.pdf", roots))
            // A relative path, the root itself, a directory under it, a file that is not there.
            assertNull(PdfPrint.allowed("print.pdf", roots))
            assertNull(PdfPrint.allowed(files.path, roots))
            assertNull(PdfPrint.allowed(inCache.parentFile!!.path, roots))
            assertNull(PdfPrint.allowed(File(files, "missing.pdf").path, roots))
            // A link under a root that leads out of it is followed, and refused for where it leads.
            val link = File(files, "link.pdf")
            val linked = runCatching { Files.createSymbolicLink(link.toPath(), outside.toPath()) }.isSuccess
            assumeTrue("symbolic links are not available on this file system", linked)
            assertNull(PdfPrint.allowed(link.path, roots))
        } finally {
            files.deleteRecursively()
            cache.deleteRecursively()
            elsewhere.deleteRecursively()
        }
    }

    @Test
    fun theCopyMovesEveryByteAndStopsAtTheSpoolersCancellation() {
        // Past one buffer, and not a multiple of it: the pieces' seams hold.
        val bytes = ByteArray(200_003) { i -> ((i * 7919 + 13) and 0xff).toByte() }
        val out = ByteArrayOutputStream()
        assertEquals(bytes.size.toLong(), PdfPrint.copy(ByteArrayInputStream(bytes), out) { false })
        assertArrayEquals(bytes, out.toByteArray())
        // An empty document is a write of nothing, finished.
        assertEquals(0L, PdfPrint.copy(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream()) { false })
        // Cancelled before a byte moved: nothing written.
        val none = ByteArrayOutputStream()
        assertEquals(-1L, PdfPrint.copy(ByteArrayInputStream(bytes), none) { true })
        assertEquals(0, none.size())
        // Cancelled after the first piece: that piece went, the rest did not, and the copy says so.
        var looks = 0
        val some = ByteArrayOutputStream()
        assertEquals(-1L, PdfPrint.copy(ByteArrayInputStream(bytes), some) { looks++ >= 1 })
        assertEquals(64 * 1024, some.size())
        assertArrayEquals(bytes.copyOfRange(0, 64 * 1024), some.toByteArray())
    }

    @Test
    fun theSourceIsTheFileOrTheBytesAndNothingElse() {
        val files = Files.createTempDirectory("zen-files").toFile()
        try {
            val inFiles = File(files, "print.pdf").apply { writeBytes(byteArrayOf(0x25, 0x50, 0x44, 0x46)) }
            val byPath = PdfPrint.source(PdfPrint.Job("t1", "print.pdf", inFiles.path, null), listOf(files))
            assertTrue(byPath is PdfPrint.Source.Path)
            assertArrayEquals(byteArrayOf(0x25, 0x50, 0x44, 0x46), byPath!!.open().use { it.readBytes() })
            assertNull(PdfPrint.source(PdfPrint.Job("t1", "print.pdf", "/storage/emulated/0/Download/print.pdf", null), listOf(files)))
            assertNull(PdfPrint.source(PdfPrint.Job("t1", "print.pdf", inFiles.path, null), emptyList()))
        } finally {
            files.deleteRecursively()
        }
    }
}
