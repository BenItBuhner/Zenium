package app.zen.chromium

import java.util.Locale

/**
 * What a saved page is called on this host (Save Page As, the phone's Download Page; CT-27). The
 * WebView writes one format – an MHTML archive (`WebView.saveWebArchive`) – whatever the core asked
 * for, so the name the core suggests (the page's title under the format's extension) loses that
 * extension for the archive's, `.mhtml`, Chrome Android's offline pages' and the desktop's Single
 * File name. Pure: [Host.savePage] writes the file, the JUnit test pins the names.
 */
object SavePageLogic {
    /** An MHTML archive's type (RFC 2557): the MediaStore row's, and what the core lists the file as. */
    const val MIME_TYPE = "multipart/related"
    const val EXTENSION = "mhtml"
    /** The extensions a suggested name may carry that the archive's replaces. */
    private val PAGE_EXTENSIONS = setOf("html", "htm", "mhtml", "mht")

    /**
     * `Example Domain.html` → `Example Domain.mhtml`; a name without a page extension keeps its
     * stem whole (`Report v1.2` → `Report v1.2.mhtml`); one the file system would refuse is made
     * safe the downloader's way ([DownloadLogic.sanitizeFilename]); nothing left → `page.mhtml`.
     */
    fun archiveName(suggested: String): String {
        val dot = suggested.lastIndexOf('.')
        val ext = if (dot >= 0) suggested.substring(dot + 1).lowercase(Locale.ROOT) else ""
        val stem = if (ext in PAGE_EXTENSIONS) suggested.substring(0, dot) else suggested
        val safe = DownloadLogic.sanitizeFilename(stem).ifEmpty { "page" }
        return "$safe.$EXTENSION"
    }

    /**
     * The name free in a folder: `Title.mhtml`, `Title (1).mhtml`, … until `taken` says no – the
     * downloader's rule ([DownloadLogic.uniqueName], Chrome's and Android's), for the public folder
     * below Q; MediaStore keeps its rows' names unique by itself on Q+.
     */
    fun uniqueArchiveName(name: String, taken: (String) -> Boolean): String = DownloadLogic.uniqueName(name, taken)
}
