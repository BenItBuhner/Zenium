package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

class AgentPromptsTest {
    // --- the file chooser --------------------------------------------------------------------------

    @Test
    fun theChooserEventCarriesTheModeAndTheTrimmedAcceptList() {
        val event = AgentPrompts.fileChooserEvent("fc_1", multiple = true, acceptTypes = listOf(" image/*", "", ".pdf "))
        assertEquals("fc_1", event.getString("requestId"))
        assertTrue(event.getBoolean("multiple"))
        assertEquals(listOf("image/*", ".pdf"), event.getJSONArray("accept").let { a -> List(a.length()) { a.getString(it) } })
        assertFalse(AgentPrompts.fileChooserEvent("fc_2", multiple = false, acceptTypes = emptyList()).getBoolean("multiple"))
    }

    @Test
    fun theCoreWordUserHandsTheChooserToTheSystem() {
        assertEquals(AgentPrompts.FileChooserAnswer.User, AgentPrompts.fileChooserAnswer(json("kind" to "user")))
    }

    @Test
    fun aCancelAMalformedAnswerAndAnEmptyFileListAllCancelTheChooser() {
        // Nothing of the system's may open over an agent's page by mistake, and the page must not
        // sit on its callback: anything the answer does not say is a cancel.
        assertEquals(AgentPrompts.FileChooserAnswer.Cancel, AgentPrompts.fileChooserAnswer(json("kind" to "cancel")))
        assertEquals(AgentPrompts.FileChooserAnswer.Cancel, AgentPrompts.fileChooserAnswer(JSONObject()))
        assertEquals(AgentPrompts.FileChooserAnswer.Cancel, AgentPrompts.fileChooserAnswer(json("kind" to "files")))
        assertEquals(
            AgentPrompts.FileChooserAnswer.Cancel,
            AgentPrompts.fileChooserAnswer(json("kind" to "files", "files" to JSONArray(listOf(json("name" to "no-bytes.txt")))))
        )
    }

    @Test
    fun theFilesOfAnAnswerKeepTheirOrderPathsAndBytesAlike() {
        val answer = AgentPrompts.fileChooserAnswer(
            json(
                "kind" to "files",
                "files" to JSONArray(
                    listOf(
                        json("name" to "a.txt", "mimeType" to "text/plain", "base64" to "YQ=="),
                        json("path" to "/sdcard/Download/b.pdf"),
                        json("name" to "../c.png", "mimeType" to null, "base64" to "Yw==")
                    )
                )
            )
        )
        assertEquals(
            AgentPrompts.FileChooserAnswer.Files(
                listOf(
                    AgentPrompts.UploadFile.Inline("a.txt", "text/plain", "YQ=="),
                    AgentPrompts.UploadFile.Path("/sdcard/Download/b.pdf"),
                    // No folders in a name the page sees.
                    AgentPrompts.UploadFile.Inline(".._c.png", null, "Yw==")
                )
            ),
            answer
        )
    }

    @Test
    fun anUploadNameNeverNamesAFolderAndIsNeverEmpty() {
        assertEquals("report.pdf", AgentPrompts.uploadFileName(" report.pdf "))
        assertEquals("a_b_c", AgentPrompts.uploadFileName("a/b\\c"))
        assertEquals("upload", AgentPrompts.uploadFileName(""))
        assertEquals("upload", AgentPrompts.uploadFileName("."))
        assertEquals("upload", AgentPrompts.uploadFileName(".."))
    }

    @Test
    fun inlineFilesAreWrittenUnderTheirNamesInOneFreshFolderAndStaleFoldersAreSwept() {
        val root = Files.createTempDirectory("agent-uploads").toFile()
        try {
            val files = listOf(
                AgentPrompts.UploadFile.Inline("hello.txt", "text/plain", Base64.getEncoder().encodeToString("hello".toByteArray())),
                AgentPrompts.UploadFile.Inline("x/y.bin", null, Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)))
            )
            val written = AgentUploads.write(root, files, now = 1_000L)
            assertEquals(listOf("hello.txt", "x_y.bin"), written.map(File::getName))
            assertEquals("hello", written[0].readText())
            assertEquals(listOf<Byte>(1, 2, 3), written[1].readBytes().toList())
            assertEquals(written[0].parentFile, written[1].parentFile)
            assertEquals(root, written[0].parentFile.parentFile)

            // A folder written long ago goes at the next start; a fresh one stays.
            val old = written[0].parentFile
            old.setLastModified(1_000L)
            val fresh = File(root, "u-fresh").apply { mkdirs(); setLastModified(AgentUploads.KEEP_MS * 10) }
            assertEquals(1, AgentUploads.sweep(root, now = AgentUploads.KEEP_MS * 10))
            assertFalse(old.exists())
            assertTrue(fresh.exists())
            assertEquals(0, AgentUploads.sweep(File(root, "missing"), now = 0L))
        } finally {
            root.deleteRecursively()
        }
    }

    // --- the client certificate --------------------------------------------------------------------

    @Test
    fun theCertificateAnswerIsReadAgainstTheAliasesTheRequestOffered() {
        val aliases = listOf("work", "personal")
        assertEquals(AgentPrompts.CertificateAnswer.User, AgentPrompts.certificateAnswer(json("user" to true), aliases))
        assertEquals(AgentPrompts.CertificateAnswer.Proceed("personal"), AgentPrompts.certificateAnswer(json("index" to 1), aliases))
        assertEquals(AgentPrompts.CertificateAnswer.Cancel, AgentPrompts.certificateAnswer(json("index" to null), aliases))
        assertEquals(AgentPrompts.CertificateAnswer.Cancel, AgentPrompts.certificateAnswer(JSONObject(), aliases))
        // An index naming nothing – a list that was empty, a stale answer – continues without one.
        assertEquals(AgentPrompts.CertificateAnswer.Cancel, AgentPrompts.certificateAnswer(json("index" to 2), aliases))
        assertEquals(AgentPrompts.CertificateAnswer.Cancel, AgentPrompts.certificateAnswer(json("index" to 0), emptyList()))
    }

    @Test
    fun theCommonNameOfADistinguishedNameElseItsOrganisationElseTheNameWhole() {
        assertEquals("Ada Lovelace", AgentPrompts.commonNameOf("CN=Ada Lovelace,OU=Engines,O=Analytical,C=GB"))
        assertEquals("Ada Lovelace", AgentPrompts.commonNameOf("O=Analytical, cn=Ada Lovelace"))
        assertEquals("Analytical", AgentPrompts.commonNameOf("OU=Engines,O=Analytical,C=GB"))
        assertEquals("C=GB", AgentPrompts.commonNameOf("C=GB"))
        // Quoted and escaped commas stay inside their value.
        assertEquals("Lovelace, Ada", AgentPrompts.commonNameOf("CN=\"Lovelace, Ada\",O=Analytical"))
        assertEquals("Lovelace, Ada", AgentPrompts.commonNameOf("CN=Lovelace\\, Ada,O=Analytical"))
    }

    @Test
    fun aChainWithNoLeafDescribesNothing() {
        assertEquals(null, AgentPrompts.describeCertificate(null))
        assertEquals(null, AgentPrompts.describeCertificate(emptyArray()))
    }

    // --- the download ------------------------------------------------------------------------------

    @Test
    fun aDownloadTakesTheAgentNameWhenItGaveOneElseTheSuggested() {
        assertEquals("report.pdf", AgentPrompts.downloadName("report.pdf", "download.pdf"))
        assertEquals("download.pdf", AgentPrompts.downloadName(null, "download.pdf"))
        assertEquals("download.pdf", AgentPrompts.downloadName("  ", "download.pdf"))
        assertEquals("download.pdf", AgentPrompts.downloadName("..", "download.pdf"))
        assertEquals("a_b.pdf", AgentPrompts.downloadName("a/b.pdf", "download.pdf"))
    }
}
