package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The saved page's name (CT-27): the core suggests the title under the format's extension, the
 * WebView writes one MHTML archive, so the archive is the title under `.mhtml` – in the public
 * Downloads, whose names must be safe and, below Q, free.
 */
class SavePageLogicTest {
    @Test
    fun theSuggestedNameLosesItsPageExtensionForTheArchives() {
        assertEquals("Example Domain.mhtml", SavePageLogic.archiveName("Example Domain.html"))
        assertEquals("Example Domain.mhtml", SavePageLogic.archiveName("Example Domain.htm"))
        // The desktop's Single File name and an old `.mht` are the archive's already.
        assertEquals("Example Domain.mhtml", SavePageLogic.archiveName("Example Domain.mhtml"))
        assertEquals("Example Domain.mhtml", SavePageLogic.archiveName("Example Domain.mht"))
        assertEquals("Example Domain.mhtml", SavePageLogic.archiveName("Example Domain.HTML"))
    }

    @Test
    fun aNameWithoutAPageExtensionKeepsItsStemWhole() {
        assertEquals("Report v1.2.mhtml", SavePageLogic.archiveName("Report v1.2"))
        assertEquals("page.mhtml", SavePageLogic.archiveName("page"))
        // Another extension is part of the title, not the archive's.
        assertEquals("notes.txt.mhtml", SavePageLogic.archiveName("notes.txt"))
    }

    @Test
    fun theArchiveIsNamedTheDownloadersSafeWay() {
        // The core already replaced the file system's unsafe characters; whatever slipped through
        // (a control character, a trailing dot, a reserved device name) goes the downloader's way.
        assertEquals("a_b_c.mhtml", SavePageLogic.archiveName("a_b_c.html"))
        assertEquals("Title.mhtml", SavePageLogic.archiveName("Title..html"))
        assertEquals("CON_.mhtml", SavePageLogic.archiveName("CON.html"))
        assertEquals("tabbed.mhtml", SavePageLogic.archiveName("tab\tbed.html"))
        assertEquals("page.mhtml", SavePageLogic.archiveName(".html"))
        assertEquals("page.mhtml", SavePageLogic.archiveName(""))
        assertEquals("page.mhtml", SavePageLogic.archiveName("..."))
    }

    @Test
    fun theArchiveTypeIsRfc2557s() {
        assertEquals("multipart/related", SavePageLogic.MIME_TYPE)
        assertEquals("mhtml", SavePageLogic.EXTENSION)
    }

    @Test
    fun aTakenNameCountsUpTheDownloadersWay() {
        val taken = setOf("Example Domain.mhtml", "Example Domain (1).mhtml")
        assertEquals("Example Domain (2).mhtml", SavePageLogic.uniqueArchiveName("Example Domain.mhtml") { it in taken })
        assertEquals("Other.mhtml", SavePageLogic.uniqueArchiveName("Other.mhtml") { it in taken })
    }
}
