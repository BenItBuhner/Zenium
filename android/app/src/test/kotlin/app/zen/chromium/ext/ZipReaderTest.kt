package app.zen.chromium.ext

import app.zen.chromium.ext.ZipFixtures.Member
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile

class ZipReaderTest {
    private val dir = ZipFixtures.tempDir("zip-reader")
    private val script = "console.log('hello from the background');\n".repeat(40).toByteArray()
    private val manifest = """{"manifest_version":3,"name":"Fixture","version":"1.0"}""".toByteArray()

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private fun open(bytes: ByteArray, offset: Long = 0): ZipReader =
        ZipReader.open(ZipFixtures.write(dir, "package-${System.nanoTime()}.zip", bytes), offset)

    private fun ZipReader.read(name: String): ByteArray {
        val out = ByteArrayOutputStream()
        copyTo(this[name] ?: error("no entry $name"), out)
        return out.toByteArray()
    }

    @Test
    fun listsEntriesFromTheCentralDirectoryAndInflatesThem() {
        val zip = ZipFixtures.zip(
            Member("manifest.json", manifest, stored = true),
            Member("js/background.js", script),
            Member("images\\icon.png", byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
        )
        open(zip).use { reader ->
            assertEquals(listOf("manifest.json", "js/background.js", "images/icon.png"), reader.entries.map { it.name })
            val stored = reader["manifest.json"]!!
            assertEquals(ZipReader.METHOD_STORED, stored.method)
            assertEquals(manifest.size.toLong(), stored.size)
            val deflated = reader["js/background.js"]!!
            assertEquals(ZipReader.METHOD_DEFLATED, deflated.method)
            assertTrue("a repetitive script compresses", deflated.compressedSize < deflated.size)
            assertArrayEquals(manifest, reader.read("manifest.json"))
            assertArrayEquals(script, reader.read("js/background.js"))
            assertArrayEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47), reader.read("images/icon.png"))
            assertNull(reader["missing.js"])
        }
    }

    @Test
    fun readsTheZipInsideACrx3Package() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest))
        val crx = ZipFixtures.crx(zip, headerBytes = 1234)
        val file = ZipFixtures.write(dir, "package.crx", crx)
        RandomAccessFile(file, "r").use { raf -> assertEquals(16L + 1234, ZipReader.crxZipOffset(raf)) }
        ZipReader.open(file, 16L + 1234).use { reader -> assertArrayEquals(manifest, reader.read("manifest.json")) }
        RandomAccessFile(ZipFixtures.write(dir, "plain.zip", zip), "r").use { raf -> assertEquals(0L, ZipReader.crxZipOffset(raf)) }
    }

    @Test
    fun refusesACrx2Package() {
        val crx = ZipFixtures.crx(ZipFixtures.zip(Member("manifest.json", manifest)), headerBytes = 8)
        crx[4] = 2
        RandomAccessFile(ZipFixtures.write(dir, "old.crx", crx), "r").use { raf ->
            try {
                ZipReader.crxZipOffset(raf)
                fail("a CRX2 header must be refused")
            } catch (e: ZipReader.ZipFormatException) {
                assertTrue(e.message!!.contains("CRX3"))
            }
        }
    }

    @Test
    fun aCorruptedEntryFailsItsCrcCheck() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest, stored = true), Member("js/background.js", script))
        // Flip a byte of the stored manifest's data (its local header is at the start of the file).
        val corrupt = zip.copyOf()
        val dataStart = 30 + "manifest.json".length
        corrupt[dataStart + 5] = (corrupt[dataStart + 5].toInt() xor 0x55).toByte()
        open(corrupt).use { reader ->
            try {
                reader.read("manifest.json")
                fail("a changed byte must fail the CRC check")
            } catch (e: ZipReader.ZipFormatException) {
                assertTrue(e.message!!.contains("CRC"))
            }
            // The other entry is untouched and still reads.
            assertArrayEquals(script, reader.read("js/background.js"))
        }
    }

    @Test
    fun refusesEncryptedEntries() {
        val zip = ZipFixtures.markEncrypted(ZipFixtures.zip(Member("manifest.json", manifest)))
        open(zip).use { reader ->
            assertTrue(reader["manifest.json"]!!.encrypted)
            try {
                reader.read("manifest.json")
                fail("an encrypted entry must be refused")
            } catch (e: ZipReader.ZipFormatException) {
                assertTrue(e.message!!.contains("encrypted"))
            }
        }
    }

    @Test
    fun refusesWhatIsNotAZip() {
        for (bytes in listOf(ByteArray(0), "not a zip at all, just text".toByteArray(), ByteArray(4096) { 0x50 })) {
            try {
                open(bytes).close()
                fail("${bytes.size} bytes of non-zip must be refused")
            } catch (e: ZipReader.ZipFormatException) {
                // expected
            }
        }
    }

    @Test
    fun refusesATruncatedArchive() {
        val zip = ZipFixtures.zip(Member("js/background.js", script))
        // Cut the tail off: the end-of-central-directory record is gone.
        try {
            open(zip.copyOf(zip.size - 10)).close()
            fail("an archive without its directory must be refused")
        } catch (e: ZipReader.ZipFormatException) {
            // expected
        }
    }

    @Test
    fun anOffsetOutsideTheFileIsRefused() {
        val file = ZipFixtures.write(dir, "short.zip", ZipFixtures.zip(Member("manifest.json", manifest)))
        try {
            ZipReader.open(file, file.length() + 1).close()
            fail("an offset past the end must be refused")
        } catch (e: IllegalArgumentException) {
            // expected
        }
        assertTrue("the file handle is released on failure", file.delete())
        assertTrue(!File(dir, "short.zip").exists())
    }
}
