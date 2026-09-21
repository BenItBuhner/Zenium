package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The request mapping of the PDF viewer's origin (`PdfViewer`; the twin of `src/shared/pdfPage.ts`). */
class PdfViewerTest {
    @Test
    fun theViewerOriginIsRecognisedAndNothingElse() {
        assertTrue(PdfViewer.isViewerUrl("https://pdf.zenium.invalid/"))
        assertTrue(PdfViewer.isViewerUrl("https://pdf.zenium.invalid/viewer/viewer.mjs"))
        assertFalse(PdfViewer.isViewerUrl("https://pdf.zenium.invalid.example.com/"))
        assertFalse(PdfViewer.isViewerUrl("https://example.com/https://pdf.zenium.invalid/"))
        assertFalse(PdfViewer.isViewerUrl("zen://pdf?id=dl_1"))
        assertFalse(PdfViewer.isViewerUrl(null))
    }

    @Test
    fun viewerAssetsAndTheDocumentResolveByPath() {
        assertEquals("viewer.mjs", (PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/viewer.mjs") as PdfViewer.Request.Asset).name)
        assertEquals("pdf.worker.mjs", (PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/pdf.worker.mjs?v=1") as PdfViewer.Request.Asset).name)
        assertEquals("cmaps/Adobe-Japan1-6.bcmap", (PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/cmaps/Adobe-Japan1-6.bcmap") as PdfViewer.Request.Asset).name)
        assertEquals("wasm/openjpeg.wasm", (PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/wasm/openjpeg.wasm#x") as PdfViewer.Request.Asset).name)
        assertEquals(PdfViewer.Request.Document, PdfViewer.requestFor("https://pdf.zenium.invalid/document.pdf"))
        assertEquals(PdfViewer.Request.Document, PdfViewer.requestFor("https://pdf.zenium.invalid/document.pdf?t=2"))
    }

    @Test
    fun anythingThatCouldClimbOutOfTheAssetsIsA404() {
        assertNull(PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/../../AndroidManifest.xml"))
        assertNull(PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/.hidden"))
        assertNull(PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/a/b/c.js"))
        assertNull(PdfViewer.requestFor("https://pdf.zenium.invalid/viewer/"))
        assertNull(PdfViewer.requestFor("https://pdf.zenium.invalid/other.pdf"))
        assertNull(PdfViewer.requestFor("https://pdf.zenium.invalid/"))
        assertNull(PdfViewer.requestFor("https://example.com/viewer/viewer.mjs"))
    }

    @Test
    fun assetsAreServedWithTheirTypes() {
        assertEquals("text/javascript", PdfViewer.assetMime("viewer.mjs"))
        assertEquals("text/javascript", PdfViewer.assetMime("wasm/openjpeg_nowasm_fallback.js"))
        assertEquals("application/wasm", PdfViewer.assetMime("wasm/openjpeg.wasm"))
        assertEquals("font/ttf", PdfViewer.assetMime("standard_fonts/FoxitSans.ttf"))
        assertEquals("application/vnd.iccprofile", PdfViewer.assetMime("iccs/CGATS001Compat-v2-micro.icc"))
        assertEquals("application/octet-stream", PdfViewer.assetMime("cmaps/Adobe-Japan1-6.bcmap"))
        assertEquals("application/octet-stream", PdfViewer.assetMime("standard_fonts/FoxitSans.pfb"))
    }

    @Test
    fun theDocumentIsOnlyServedToTheViewerPageItself() {
        val doc = PdfViewer.Document("/sdcard/Download/a.pdf", "a.pdf")
        // A PDF with no address of its own: the document runs on the viewer's origin and fetches same-origin.
        val own = PdfViewer.Page("zen://pdf?id=dl_1", PdfViewer.BASE_URL, doc)
        assertEquals("https://pdf.zenium.invalid", PdfViewer.documentOrigin(own))
        assertTrue(PdfViewer.mayServeDocument(null, "https://pdf.zenium.invalid/", own))
        assertTrue(PdfViewer.mayServeDocument(null, "https://pdf.zenium.invalid/viewer/pdf.worker.mjs", own))
        // A web page that learned the address, or a tab that shows no viewer any more.
        assertFalse(PdfViewer.mayServeDocument(null, "https://evil.example/", own))
        assertFalse(PdfViewer.mayServeDocument("https://evil.example", "https://pdf.zenium.invalid/", own))
        assertFalse(PdfViewer.mayServeDocument(null, null, own))
        assertFalse(PdfViewer.mayServeDocument(null, "https://pdf.zenium.invalid/", null))
    }

    @Test
    fun theDocumentUnderThePdfsOwnUrlFetchesCrossOriginFromThatOrigin() {
        val doc = PdfViewer.Document("/sdcard/Download/a.pdf", "a.pdf")
        val page = PdfViewer.Page("zen://pdf?id=dl_2", "http://10.0.2.2:8765/sample.pdf", doc)
        assertEquals("http://10.0.2.2:8765", PdfViewer.documentOrigin(page))
        // fetch() from the document: its Origin, and the referrer cut to the origin.
        assertTrue(PdfViewer.mayServeDocument("http://10.0.2.2:8765", "http://10.0.2.2:8765/", page))
        assertTrue(PdfViewer.mayServeDocument(null, "http://10.0.2.2:8765/sample.pdf", page))
        // Another origin's page, or the viewer's own origin, which this document does not run on.
        assertFalse(PdfViewer.mayServeDocument("https://evil.example", "http://10.0.2.2:8765/", page))
        assertFalse(PdfViewer.mayServeDocument(null, "https://pdf.zenium.invalid/", page))
        assertFalse(PdfViewer.mayServeDocument(null, "http://10.0.2.2:87650/", page))
    }

    @Test
    fun aCallbackUrlOfTheViewerPagesDocumentIsRecognised() {
        val doc = PdfViewer.Document("/sdcard/Download/a.pdf", "a.pdf")
        val page = PdfViewer.Page("zen://pdf?id=dl_2", "https://example.com/files/a.pdf", doc)
        assertTrue(PdfViewer.isDocumentUrl("https://example.com/files/a.pdf", page))
        assertTrue(PdfViewer.isDocumentUrl("https://example.com/files/a.pdf#page=2", page))
        assertTrue(PdfViewer.isDocumentUrl("https://pdf.zenium.invalid/", page))
        assertFalse(PdfViewer.isDocumentUrl("https://example.com/files/b.pdf", page))
        assertFalse(PdfViewer.isDocumentUrl("https://example.com/", page))
        assertFalse(PdfViewer.isDocumentUrl(null, page))
        val own = PdfViewer.Page("zen://pdf?id=dl_1", PdfViewer.BASE_URL, doc)
        assertTrue(PdfViewer.isDocumentUrl("https://pdf.zenium.invalid/", own))
        assertFalse(PdfViewer.isDocumentUrl("https://example.com/files/a.pdf", own))
    }

    @Test
    fun theDocumentComesFromTheLoadHtmlArguments() {
        val doc = PdfViewer.documentOf(org.json.JSONObject().put("path", "content://media/downloads/12").put("name", "Report.pdf"))!!
        assertEquals("content://media/downloads/12", doc.path)
        assertEquals("Report.pdf", doc.name)
        assertNull(PdfViewer.documentOf(org.json.JSONObject().put("name", "Report.pdf")))
    }

    @Test
    fun aDispositionTypeIsReadOffTheHeader() {
        assertEquals("attachment", DownloadLogic.dispositionType("attachment; filename=\"a.pdf\""))
        assertEquals("inline", DownloadLogic.dispositionType("INLINE"))
        assertEquals("inline", DownloadLogic.dispositionType(" inline ; filename=a.pdf"))
        assertNull(DownloadLogic.dispositionType("filename=a.pdf"))
        assertNull(DownloadLogic.dispositionType(""))
        assertNull(DownloadLogic.dispositionType(null))
    }
}
