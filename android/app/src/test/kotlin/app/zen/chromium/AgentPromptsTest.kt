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
    fun theFilesOfAnAnswerKeepTheirOrderAndTheirNamesLoseTheirFolders() {
        val answer = AgentPrompts.fileChooserAnswer(
            json(
                "kind" to "files",
                "files" to JSONArray(
                    listOf(
                        json("name" to "a.txt", "mimeType" to "text/plain", "base64" to "YQ=="),
                        json("name" to "../c.png", "mimeType" to null, "base64" to "Yw==")
                    )
                )
            )
        )
        assertEquals(
            AgentPrompts.FileChooserAnswer.Files(
                listOf(
                    AgentPrompts.UploadFile("a.txt", "text/plain", "YQ=="),
                    // No folders in a name the page sees.
                    AgentPrompts.UploadFile(".._c.png", null, "Yw==")
                )
            ),
            answer
        )
    }

    @Test
    fun anAnswerNamingAPathCancelsTheChooserWhole() {
        // A path would be opened as this app and handed to the page: not thinned out, refused.
        // The core told the agent why before the answer came here.
        val withPath = json(
            "kind" to "files",
            "files" to JSONArray(
                listOf(
                    json("name" to "a.txt", "mimeType" to "text/plain", "base64" to "YQ=="),
                    json("path" to "/data/data/app.zen.chromium/app_webview/Default/Cookies")
                )
            )
        )
        assertEquals(AgentPrompts.FileChooserAnswer.Cancel, AgentPrompts.fileChooserAnswer(withPath))
        val onlyPaths = json("kind" to "files", "files" to JSONArray(listOf(json("path" to "/sdcard/Download/b.pdf"))))
        assertEquals(AgentPrompts.FileChooserAnswer.Cancel, AgentPrompts.fileChooserAnswer(onlyPaths))
        // Even an empty path, or one beside the bytes of the same entry.
        val emptyPath = json("kind" to "files", "files" to JSONArray(listOf(json("path" to "", "name" to "a.txt", "base64" to "YQ=="))))
        assertEquals(AgentPrompts.FileChooserAnswer.Cancel, AgentPrompts.fileChooserAnswer(emptyPath))
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
    fun inlineFilesAreWrittenUnderTheirNamesEachInItsOwnFolderAndStaleFoldersAreSwept() {
        val root = Files.createTempDirectory("agent-uploads").toFile()
        try {
            val files = listOf(
                AgentPrompts.UploadFile("hello.txt", "text/plain", Base64.getEncoder().encodeToString("hello".toByteArray())),
                AgentPrompts.UploadFile("x/y.bin", null, Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3))),
                // The same name twice stays two files: the page sees both under the agent's name.
                AgentPrompts.UploadFile("hello.txt", "text/plain", Base64.getEncoder().encodeToString("again".toByteArray()))
            )
            val written = AgentUploads.write(root, files, now = 1_000L)
            assertEquals(listOf("hello.txt", "x_y.bin", "hello.txt"), written.files.map(File::getName))
            assertEquals("hello", written.files[0].readText())
            assertEquals(listOf<Byte>(1, 2, 3), written.files[1].readBytes().toList())
            assertEquals("again", written.files[2].readText())
            assertEquals(listOf("0", "1", "2"), written.files.map { it.parentFile!!.name })
            for (f in written.files) assertEquals(written.folder, f.parentFile!!.parentFile)
            assertEquals(root, written.folder.parentFile)

            // A folder written long ago goes at the next start; a fresh one stays.
            written.folder.setLastModified(1_000L)
            val fresh = File(root, "u-fresh").apply { mkdirs(); setLastModified(AgentUploads.KEEP_MS * 10) }
            assertEquals(1, AgentUploads.sweep(root, now = AgentUploads.KEEP_MS * 10))
            assertFalse(written.folder.exists())
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
    fun theAgentIsOfferedOnlyThePicksTheUserMadeForTheSameHost() {
        val picks = mapOf(
            "intranet.example:443" to "work",
            "intranet.example:8443" to "work-alt",
            "other.example:443" to "personal",
            "INTRANET.example:9443" to "work"
        )
        // The exact host and port is remembered before the agent is asked; the same host on
        // another port is offered, once per alias; another host's pick never is.
        assertEquals(listOf("work", "work-alt"), AgentPrompts.candidateAliases(picks, "intranet.example"))
        assertEquals(listOf("personal"), AgentPrompts.candidateAliases(picks, "other.example"))
        assertEquals(emptyList<String>(), AgentPrompts.candidateAliases(picks, "fresh.example"))
        assertEquals(emptyList<String>(), AgentPrompts.candidateAliases(emptyMap(), "intranet.example"))
    }

    @Test
    fun aCandidateMustAnswerTheServersKeyTypesAndIssuersWhenItNamedAny() {
        val chain = listOf("cn=ada,o=analytical", "cn=analytical ca,o=analytical", "cn=analytical ca,o=analytical", "cn=root,o=analytical")
        assertTrue(AgentPrompts.certificateFits("RSA", chain, emptyList(), emptyList()))
        assertTrue(AgentPrompts.certificateFits("RSA", chain, listOf("EC", "rsa"), emptyList()))
        assertFalse(AgentPrompts.certificateFits("RSA", chain, listOf("EC"), emptyList()))
        assertTrue(AgentPrompts.certificateFits("EC", chain, emptyList(), listOf("cn=root,o=analytical")))
        assertTrue(AgentPrompts.certificateFits("EC", chain, emptyList(), listOf("cn=analytical ca,o=analytical")))
        assertFalse(AgentPrompts.certificateFits("EC", chain, emptyList(), listOf("cn=other ca,o=elsewhere")))
        assertFalse(AgentPrompts.certificateFits("EC", chain, listOf("EC"), listOf("cn=other ca,o=elsewhere")))
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
        val ext: (String) -> String? = { mime -> mapOf("application/pdf" to "pdf", "text/plain" to "txt")[mime] }
        assertEquals("report.pdf", AgentPrompts.downloadName("report.pdf", "download.pdf", "application/pdf", ext))
        assertEquals("download.pdf", AgentPrompts.downloadName(null, "download.pdf", "application/pdf", ext))
        assertEquals("download.pdf", AgentPrompts.downloadName("  ", "download.pdf", "application/pdf", ext))
        assertEquals("download.pdf", AgentPrompts.downloadName("..", "download.pdf", "application/pdf", ext))
        assertEquals("a_b.pdf", AgentPrompts.downloadName("a/b.pdf", "download.pdf", "application/pdf", ext))
    }

    @Test
    fun theAgentNameIsSanitisedAndGivenItsExtensionAsEveryDownloadNameIs() {
        val ext: (String) -> String? = { mime -> mapOf("application/pdf" to "pdf", "text/plain" to "txt")[mime] }
        // A leading dot would hide the file; the sanitiser trims it as it does for a server's name.
        assertEquals("hidden.pdf", AgentPrompts.downloadName(".hidden.pdf", "download.pdf", "application/pdf", ext))
        // Path tricks and control characters go, exactly as the sanitiser takes a server's name.
        val tricked = AgentPrompts.downloadName("../../etc/passwd", "download", "", ext)
        assertEquals(DownloadLogic.sanitizeFilename("../../etc/passwd"), tricked)
        assertFalse(tricked.contains('/'))
        assertFalse(tricked.startsWith("."))
        assertEquals("report.pdf", AgentPrompts.downloadName("re\u0007port.pdf", "download.pdf", "application/pdf", ext))
        // Reserved device names get their suffix.
        assertEquals("CON_.txt", AgentPrompts.downloadName("CON.txt", "download.txt", "text/plain", ext))
        // A name beyond the cap is cut, keeping its extension.
        val long = AgentPrompts.downloadName("a".repeat(300) + ".pdf", "download.pdf", "application/pdf", ext)
        assertTrue(long.length <= 200)
        assertTrue(long.endsWith(".pdf"))
        // A name without an extension takes the type's; without a type it stays as it is.
        assertEquals("report.pdf", AgentPrompts.downloadName("report", "download.pdf", "application/pdf", ext))
        assertEquals("report", AgentPrompts.downloadName("report", "download", "", ext))
        assertEquals("report", AgentPrompts.downloadName("report", "download", "application/x-unknown", ext))
        // A name that is nothing once cleaned falls back to the response's.
        assertEquals("download.pdf", AgentPrompts.downloadName("...", "download.pdf", "application/pdf", ext))
    }
}
