package app.zen.chromium.ext

import app.zen.chromium.ext.ZipFixtures.Member
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

class ExtensionFilesTest {
    private val base = ZipFixtures.tempDir("ext-files")
    private val root = File(base, "extensions")
    private val files = ExtensionFiles(root)
    private val manifest = """{"manifest_version":3,"name":"Fixture","version":"1.0.0"}""".toByteArray()
    private val script = "self.addEventListener('install', () => {});\n".repeat(30).toByteArray()

    @After
    fun cleanUp() {
        base.deleteRecursively()
    }

    // --- layout ----------------------------------------------------------------------------------

    @Test
    fun installWritesToStagingAndMovesIntoTheVersionDirectory() {
        var stagingSeen: File? = null
        val dir = files.install(ID, "1.2.3") { staging ->
            stagingSeen = staging
            assertEquals(File(root, ExtensionFiles.STAGING_DIR), staging.parentFile)
            File(staging, "manifest.json").writeBytes(manifest)
        }
        assertEquals(File(root, "$ID/1.2.3"), dir)
        assertArrayEquals(manifest, File(dir, "manifest.json").readBytes())
        assertFalse("the staging folder moved away", stagingSeen!!.exists())
        assertEquals(emptyList<File>(), files.staging.listFiles()?.toList() ?: emptyList<File>())
    }

    @Test
    fun aSecondInstallOfTheSameVersionGetsItsOwnDirectory() {
        val first = files.install(ID, "1.2.3") { File(it, "a").writeText("first") }
        val second = files.install(ID, "1.2.3") { File(it, "a").writeText("second") }
        assertEquals(File(root, "$ID/1.2.3"), first)
        assertEquals(File(root, "$ID/1.2.3_1"), second)
        assertEquals("first", File(first, "a").readText())
        assertEquals("second", File(second, "a").readText())
    }

    @Test
    fun aFailedWriteLeavesNothingBehind() {
        try {
            files.install(ID, "1.0") { staging ->
                File(staging, "half.js").writeText("...")
                throw IOException("disk full")
            }
            fail("the failure must propagate")
        } catch (e: IOException) {
            assertEquals("disk full", e.message)
        }
        assertTrue(files.staging.listFiles().isNullOrEmpty())
        assertFalse(File(root, ID).exists())
    }

    @Test
    fun oddVersionsBecomeSafeDirectoryNames() {
        assertEquals("1.2.3", ExtensionFiles.versionDirName("1.2.3"))
        assertEquals("1.0_beta_x", ExtensionFiles.versionDirName("1.0 beta/x"))
        assertEquals("unversioned", ExtensionFiles.versionDirName(""))
        assertEquals("unversioned", ExtensionFiles.versionDirName(".."))
        assertEquals(File(root, "$ID/unversioned"), files.install(ID, "") { })
    }

    @Test
    fun onlyExtensionIdsNameInstallDirectories() {
        for (bad in listOf("", "..", "../..", "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", "abcdefghijklmnopabcdefghijklmnoq", "short")) {
            try {
                files.installDir(bad)
                fail("'$bad' is not an extension id")
            } catch (e: IOException) {
                // expected
            }
        }
        assertEquals(File(root, ID), files.installDir(ID))
    }

    @Test
    fun pruneKeepsOneVersionAndRemoveTakesTheTree() {
        val old = files.install(ID, "1.0") { File(it, "a").writeText("old") }
        val current = files.install(ID, "2.0") { File(it, "a").writeText("new") }
        val other = files.install(OTHER_ID, "1.0") { File(it, "a").writeText("other") }
        assertEquals(listOf(old.absolutePath), files.prune(ID, current))
        assertFalse(old.exists())
        assertTrue(current.exists())
        assertTrue(other.exists())
        files.remove(ID)
        assertFalse(File(root, ID).exists())
        assertTrue("another extension is untouched", File(other, "a").exists())
    }

    @Test
    fun sweepClearsStagingLeftovers() {
        val stale = File(files.staging, "abc-0123").apply { mkdirs(); File(this, "half.js").writeText("...") }
        val installed = files.install(ID, "1.0") { File(it, "a").writeText("ok") }
        assertEquals(listOf(stale.absolutePath), files.sweepStaging())
        assertFalse(stale.exists())
        assertTrue(installed.exists())
        assertEquals(emptyList<String>(), files.sweepStaging())
    }

    // --- paths -----------------------------------------------------------------------------------

    @Test
    fun safeSegmentsFollowTheCoresRules() {
        assertEquals(listOf("js", "background.js"), ExtensionFiles.safeSegments("js/background.js"))
        assertEquals(listOf("images", "icon.png"), ExtensionFiles.safeSegments("images\\icon.png"))
        assertEquals(listOf("_locales", "en"), ExtensionFiles.safeSegments("_locales/en/"))
        for (bad in listOf("", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "C:\\x", "c:/x", "a\u0000b", "a\u001fb", "a\u007fb", ".", "..", "a/..")) {
            try {
                ExtensionFiles.safeSegments(bad)
                fail("'$bad' must be refused")
            } catch (e: IOException) {
                // expected
            }
        }
    }

    @Test
    fun resolveInsideNeverLeavesTheDirectory() {
        val dir = File(base, "target").apply { mkdirs() }
        assertEquals(File(dir, "js/bg.js"), ExtensionFiles.resolveInside(dir, "js/bg.js"))
        for (bad in listOf("../outside", "/outside", "..")) {
            try {
                ExtensionFiles.resolveInside(dir, bad)
                fail("'$bad' must be refused")
            } catch (e: IOException) {
                // expected
            }
        }
    }

    // --- serving ---------------------------------------------------------------------------------

    @Test
    fun servedBodyStreamsTheFileWithTheLengthItIsToldAndNoCopyOfItInTheHeap() {
        val dir = File(base, "served").apply { mkdirs() }
        val text = "export const s = \"héllo \uD83D\uDE00\";\n" + "// pad\n".repeat(20_000)
        val file = File(dir, "chunk.js").apply { writeBytes(text.toByteArray(Charsets.UTF_8)) }

        val plain = ExtensionFiles.servedBody(file)!!
        assertTrue(plain.stream is java.io.FileInputStream)
        assertEquals(file.length(), plain.length)
        assertArrayEquals(text.toByteArray(Charsets.UTF_8), plain.stream.use { it.readBytes() })

        val id = "egjidjbpglichdcondbcbdnbeeppgdph"
        val wrapped = ExtensionFiles.servedBody(file, ExtensionScripts.moduleChromeOpen(id), ExtensionScripts.moduleChromeClose(id))!!
        val bytes = wrapped.stream.use { it.readBytes() }
        assertEquals(bytes.size.toLong(), wrapped.length)
        assertArrayEquals(ExtensionScripts.moduleChromeWrap(text, id).toByteArray(Charsets.UTF_8), bytes)

        val missing = File(dir, "gone.js")
        assertEquals(null, ExtensionFiles.servedBody(missing))

        // The head the bracket's prologue is chosen by: the first bytes as text, a cut character
        // reading as U+FFFD, and "" for a file that is not there.
        assertEquals("export const s = \"h", ExtensionFiles.head(file, 19))
        assertEquals("export const s = \"h\uFFFD", ExtensionFiles.head(file, 20))
        assertEquals(text, ExtensionFiles.head(file, text.toByteArray(Charsets.UTF_8).size + 10))
        assertEquals(text, ExtensionFiles.head(file, ExtensionScripts.MODULE_SCAN_HEAD))
        assertEquals("", ExtensionFiles.head(missing, 512))
        assertEquals("", ExtensionFiles.head(File(dir, "empty.js").apply { writeBytes(ByteArray(0)) }, 512))
    }

    // --- unpacking -------------------------------------------------------------------------------

    private fun request(
        files: List<String>,
        directories: List<String> = emptyList(),
        manifestOverride: String? = null,
        rootPrefix: String = "",
        zipOffset: Long = 0,
        totalSize: Long = Long.MAX_VALUE,
        version: String = "1.0.0"
    ) = ExtensionFiles.UnpackRequest(
        id = ID,
        version = version,
        zipOffset = zipOffset,
        rootPrefix = rootPrefix,
        files = files,
        directories = directories,
        manifest = manifestOverride,
        totalSize = totalSize
    )

    @Test
    fun unpackWritesTheListedEntriesAndTheManifestOverride() {
        val zip = ZipFixtures.zip(
            Member("manifest.json", manifest, stored = true),
            Member("js/background.js", script),
            Member("images/icon.png", byteArrayOf(1, 2, 3, 4)),
            // Not in the request: what the core did not list is not written.
            Member("unlisted.txt", "no".toByteArray())
        )
        val rewritten = """{"manifest_version":3,"name":"Fixture","version":"1.0.0","key":"MIIB..."}"""
        val dir = files.unpack(
            ZipFixtures.write(base, "p.zip", zip),
            request(
                files = listOf("manifest.json", "js/background.js", "images/icon.png"),
                directories = listOf("js/", "images/", "_locales/en/"),
                manifestOverride = rewritten,
                totalSize = (rewritten.length + script.size + 4).toLong()
            )
        )
        assertEquals(File(root, "$ID/1.0.0"), dir)
        assertEquals(rewritten, File(dir, "manifest.json").readText())
        assertArrayEquals(script, File(dir, "js/background.js").readBytes())
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), File(dir, "images/icon.png").readBytes())
        assertTrue("listed directories exist even when empty", File(dir, "_locales/en").isDirectory)
        assertFalse(File(dir, "unlisted.txt").exists())
        assertTrue(files.staging.listFiles().isNullOrEmpty())
    }

    @Test
    fun unpackStripsTheRootFolderOfASideloadedZip() {
        val zip = ZipFixtures.zip(
            Member("uBlock0.chromium/manifest.json", manifest),
            Member("uBlock0.chromium/js/background.js", script)
        )
        val dir = files.unpack(
            ZipFixtures.write(base, "p.zip", zip),
            request(files = listOf("manifest.json", "js/background.js"), rootPrefix = "uBlock0.chromium/")
        )
        assertArrayEquals(manifest, File(dir, "manifest.json").readBytes())
        assertArrayEquals(script, File(dir, "js/background.js").readBytes())
    }

    @Test
    fun unpackReadsTheZipAtTheCrxOffset() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest), Member("js/background.js", script))
        val crx = ZipFixtures.crx(zip, headerBytes = 600)
        val dir = files.unpack(
            ZipFixtures.write(base, "p.crx", crx),
            request(files = listOf("manifest.json", "js/background.js"), zipOffset = 616)
        )
        assertArrayEquals(manifest, File(dir, "manifest.json").readBytes())
        assertArrayEquals(script, File(dir, "js/background.js").readBytes())
    }

    @Test
    fun unpackRefusesPathsThatEscapeAndLeavesNothingBehind() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest), Member("../escape.js", script))
        val outside = File(root, "escape.js")
        for (bad in listOf("../escape.js", "/etc/x", "a/../../escape.js")) {
            try {
                files.unpack(ZipFixtures.write(base, "p.zip", zip), request(files = listOf("manifest.json", bad)))
                fail("'$bad' must be refused")
            } catch (e: IOException) {
                assertTrue(e.message!!, e.message!!.contains("escapes") || e.message!!.contains("absolute"))
            }
        }
        assertFalse(outside.exists())
        assertFalse("nothing is installed", File(root, ID).exists())
        assertTrue(files.staging.listFiles().isNullOrEmpty())
    }

    @Test
    fun unpackRefusesAFileTheArchiveDoesNotHave() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest))
        try {
            files.unpack(ZipFixtures.write(base, "p.zip", zip), request(files = listOf("manifest.json", "js/missing.js")))
            fail("a missing entry must fail the install")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("js/missing.js"))
        }
        assertFalse(File(root, ID).exists())
    }

    @Test
    fun unpackStopsAnArchiveThatOutgrowsItsDeclaredSize() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest), Member("js/background.js", script))
        try {
            files.unpack(
                ZipFixtures.write(base, "p.zip", zip),
                request(files = listOf("manifest.json", "js/background.js"), totalSize = manifest.size + 10L)
            )
            fail("more bytes than declared must fail the install")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("larger than declared"))
        }
        assertFalse(File(root, ID).exists())
        assertTrue(files.staging.listFiles().isNullOrEmpty())
    }

    @Test
    fun unpackRefusesACorruptEntry() {
        val zip = ZipFixtures.zip(Member("manifest.json", manifest, stored = true))
        val corrupt = zip.copyOf()
        corrupt[30 + "manifest.json".length + 3] = 0x21
        try {
            files.unpack(ZipFixtures.write(base, "p.zip", corrupt), request(files = listOf("manifest.json")))
            fail("a CRC mismatch must fail the install")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("CRC"))
        }
        assertFalse(File(root, ID).exists())
    }

    // --- bridge answers --------------------------------------------------------------------------

    @Test
    fun bridgeTextAnswersASmallFileAndNeverAMultiMegabyteOne() {
        base.mkdirs()
        val small = File(base, "rules.json").apply { writeText("""[{"id":1}]""") }
        assertEquals("""[{"id":1}]""", ExtensionFiles.bridgeText(small))
        assertEquals(null, ExtensionFiles.bridgeText(null))
        assertEquals(null, ExtensionFiles.bridgeText(File(base, "missing.json")))
        assertEquals(null, ExtensionFiles.bridgeText(base))
        val large = File(base, "base.json")
        FileOutputStream(large).use { out ->
            val chunk = ByteArray(64 * 1024) { 'a'.code.toByte() }
            var written = 0L
            while (written < ExtensionFiles.BRIDGE_TEXT_LIMIT) {
                out.write(chunk)
                written += chunk.size
            }
        }
        assertTrue(large.length() >= ExtensionFiles.BRIDGE_TEXT_LIMIT)
        assertEquals("a file at the limit is not quoted into a bridge answer", null, ExtensionFiles.bridgeText(large))
    }

    // --- served stylesheets ----------------------------------------------------------------------

    @Test
    fun localizeCssSubstitutesTheMapsNamesCaseInsensitivelyAndLeavesTheRest() {
        val map = mapOf(
            "@@extension_id" to ID,
            "@@bidi_start_edge" to "left",
            "accentcolor" to "#1b2838"
        )
        // Steam Inventory Helper's `<link>`-loaded sheets name their images by the extension's id.
        val css = ".flag{background:url(chrome-extension://__MSG_@@extension_id__/img/flags/de.svg)}" +
            ".panel{float:__MSG_@@bidi_start_edge__;color:__MSG_AccentColor__;--x:__MSG_missing__}"
        assertEquals(
            ".flag{background:url(chrome-extension://$ID/img/flags/de.svg)}" +
                ".panel{float:left;color:#1b2838;--x:__MSG_missing__}",
            ExtensionFiles.localizeCss(css, map)
        )
        val plain = "body{color:red}"
        assertTrue("a sheet without placeholders is the same object", plain === ExtensionFiles.localizeCss(plain, map))
        assertTrue("no map, no substitution", css === ExtensionFiles.localizeCss(css, emptyMap()))
    }

    companion object {
        const val ID = "ddkjiahejlhfcafbddmgiahcphecmpfh"
        const val OTHER_ID = "eimadpbcbfnmbkopoojfekhnkhdbieeh"
    }
}
