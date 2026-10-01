package app.zen.chromium.ext

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * The file service behind a content script's `fetch`/`XMLHttpRequest` of its own extension's file
 * (compat round 25, R25-2): the answer the served origin would give a page's request for the
 * file, read for the bridge.
 */
class ExtensionFileAnswerTest {
    private val id = "adbacgifemdbhdkfppmeilbgppmhaobf"
    private val origin = "https://$id${Extensions.ORIGIN_SUFFIX}"

    private fun bundle(): File {
        val dir = createTempDirectory("ext-file-answer").toFile()
        File(dir, "locales").mkdirs()
        File(dir, "locales/en.json").writeText("""{"hello":"world"}""")
        File(dir, "js").mkdirs()
        File(dir, "js/secret.js").writeText("secret")
        File(dir, "styles").mkdirs()
        File(dir, "styles/app.css").writeText(".a{background:url(chrome-extension://__MSG_@@extension_id__/i.png)}")
        File(dir, "data").mkdirs()
        File(dir, "data/big.bin").writeBytes(ByteArray(4096))
        File(dir, "data/two words.txt").writeText("spaced")
        return dir
    }

    private val webAccessible = listOf("locales/*", "styles/*", "data/*").map { Extensions.globToRegex(it) }

    @Test
    fun theOwnPathOfEitherSpellingIsTheFilesPathQueryAndFragmentDroppedEscapesDecoded() {
        assertEquals("locales/en.json", ExtensionFileAnswer.ownPath("$origin/locales/en.json", id))
        assertEquals("locales/en.json", ExtensionFileAnswer.ownPath("chrome-extension://$id/locales/en.json", id))
        assertEquals("locales/en.json", ExtensionFileAnswer.ownPath("$origin/locales/en.json?v=3#top", id))
        assertEquals("locales/en.json", ExtensionFileAnswer.ownPath("HTTPS://${id.uppercase()}${Extensions.ORIGIN_SUFFIX}/locales/en.json", id))
        assertEquals("data/two words.txt", ExtensionFileAnswer.ownPath("$origin/data/two%20words.txt", id))
        assertEquals("data/a+b.txt", ExtensionFileAnswer.ownPath("$origin/data/a+b.txt", id))
        assertEquals("data/100%", ExtensionFileAnswer.ownPath("$origin/data/100%", id))
        assertEquals("", ExtensionFileAnswer.ownPath(origin, id))
        assertEquals("", ExtensionFileAnswer.ownPath("$origin/?q", id))
        // Another extension's, another origin's, a lookalike host: not this extension's own.
        assertNull(ExtensionFileAnswer.ownPath("https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb${Extensions.ORIGIN_SUFFIX}/locales/en.json", id))
        assertNull(ExtensionFileAnswer.ownPath("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/locales/en.json", id))
        assertNull(ExtensionFileAnswer.ownPath("https://www.rovalra.com/config.json", id))
        assertNull(ExtensionFileAnswer.ownPath("$origin.evil.example/locales/en.json", id))
        assertNull(ExtensionFileAnswer.ownPath("http://$id${Extensions.ORIGIN_SUFFIX}/locales/en.json", id))
        assertNull(ExtensionFileAnswer.ownPath("", id))
    }

    @Test
    fun aWebAccessibleFileAnswersItsBytesAndTypeAStylesheetLocalized() {
        val dir = bundle()
        try {
            val json = ExtensionFileAnswer.answer(dir, "locales/en.json", webAccessible, emptyMap())
            assertTrue(json.ok)
            assertNull(json.error)
            assertEquals("application/json", json.mime)
            assertEquals("""{"hello":"world"}""", String(json.body!!, Charsets.UTF_8))

            val spaced = ExtensionFileAnswer.answer(dir, "data/two words.txt", webAccessible, emptyMap())
            assertTrue(spaced.ok)
            assertEquals("text/plain", spaced.mime)
            assertEquals("spaced", String(spaced.body!!, Charsets.UTF_8))

            val plain = ExtensionFileAnswer.answer(dir, "styles/app.css", webAccessible, emptyMap())
            assertEquals("text/css", plain.mime)
            assertTrue(String(plain.body!!, Charsets.UTF_8).contains("__MSG_@@extension_id__"))

            val localized = ExtensionFileAnswer.answer(dir, "styles/app.css", webAccessible, mapOf("@@extension_id" to id))
            assertEquals("text/css", localized.mime)
            assertEquals(".a{background:url(chrome-extension://$id/i.png)}", String(localized.body!!, Charsets.UTF_8))

            val binary = ExtensionFileAnswer.answer(dir, "data/big.bin", webAccessible, emptyMap())
            assertTrue(binary.ok)
            assertEquals("application/octet-stream", binary.mime)
            assertArrayEquals(ByteArray(4096), binary.body)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun theReasonsARequestIsNotAnsweredNotWebAccessibleMissingEscapingOverTheBridgesSize() {
        val dir = bundle()
        try {
            val secret = ExtensionFileAnswer.answer(dir, "js/secret.js", webAccessible, emptyMap())
            assertFalse(secret.ok)
            assertNull(secret.body)
            assertNull(secret.mime)
            assertEquals("js/secret.js is not a web-accessible resource", secret.error)

            val missing = ExtensionFileAnswer.answer(dir, "locales/fr.json", webAccessible, emptyMap())
            assertEquals("locales/fr.json was not found", missing.error)

            val directory = ExtensionFileAnswer.answer(dir, "locales", listOf(Extensions.globToRegex("*")), emptyMap())
            assertEquals("locales was not found", directory.error)

            val escaping = ExtensionFileAnswer.answer(dir, "locales/../../etc/passwd", listOf(Extensions.globToRegex("*")), emptyMap())
            assertEquals("locales/../../etc/passwd was not found", escaping.error)
            assertNull(ExtensionFileAnswer.fileIn(dir, "../outside.txt"))
            assertEquals(File(dir, "locales/en.json"), ExtensionFileAnswer.fileIn(dir, "/locales/en.json"))

            val big = ExtensionFileAnswer.answer(dir, "data/big.bin", webAccessible, emptyMap(), maxBytes = 1024)
            assertEquals("data/big.bin is 4096 bytes, more than the bridge carries (1024)", big.error)
            assertEquals(16 * 1024 * 1024, ExtensionFileAnswer.MAX_BYTES)

            val refused = ExtensionFileAnswer.refused("the extension is not attached")
            assertFalse(refused.ok)
            assertEquals("the extension is not attached", refused.error)
        } finally {
            dir.deleteRecursively()
        }
    }
}
