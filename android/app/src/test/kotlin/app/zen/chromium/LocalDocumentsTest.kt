package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * "Open with Zenium" for a document on the device: the manifest offers it for the four kinds
 * under `file:` and `content:`, and the host opens exactly those (LocalDocuments), refusing the
 * app's own files – the twin of the desktop's file associations (`electron-builder.yml`).
 */
class LocalDocumentsTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    @Test
    fun theManifestOffersTheFourKindsUnderBothLocalSchemesOnTheLinkActivity() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val activity = manifest.substringAfter("android:name=\".LinkDispatchActivity\"").substringBefore("</activity>")
        val filters = activity.split("<intent-filter>").drop(1).map { it.substringBefore("</intent-filter>") }
        val local = filters.filter { """<data android:scheme="content" />""" in it }
        assertEquals("one filter carries the local schemes", 1, local.size)
        val filter = local.single()
        assertTrue("""<action android:name="android.intent.action.VIEW" />""" in filter)
        assertTrue("""<category android:name="android.intent.category.DEFAULT" />""" in filter)
        assertTrue("""<data android:scheme="file" />""" in filter)
        val mimeTypes = Regex("""<data android:mimeType="([^"]+)" />""").findAll(filter).map { it.groupValues[1] }.toList()
        assertEquals(LocalDocuments.MIME_TYPES, mimeTypes)
        assertEquals(listOf("text/html", "application/xhtml+xml", "application/pdf", "image/svg+xml"), mimeTypes)
        // The web filter stays as it was: http and https, no local scheme.
        val web = filters.first { """<data android:scheme="https" />""" in it }
        assertFalse("content" in web)
        assertFalse("file" in web)
    }

    @Test
    fun onlyLocalAddressesAreLocal() {
        assertTrue(LocalDocuments.isLocal("content://com.android.providers.downloads.documents/document/12"))
        assertTrue(LocalDocuments.isLocal("file:///sdcard/Download/page.html"))
        assertTrue(LocalDocuments.isLocal("FILE:///sdcard/x.svg"))
        assertFalse(LocalDocuments.isLocal("https://example.com/page.html"))
        assertFalse(LocalDocuments.isLocal("zen://pdf?id=1"))
        assertFalse(LocalDocuments.isLocal("data:text/html,hi"))
        assertFalse(LocalDocuments.isLocal("about:blank"))
        assertFalse(LocalDocuments.isLocal(null))
    }

    @Test
    fun theKindComesFromTheTypeFirstAndTheNameWhenTheTypeSaysNothing() {
        assertEquals(LocalDocuments.Kind.HTML, LocalDocuments.kindOf("text/html", "12"))
        assertEquals(LocalDocuments.Kind.HTML, LocalDocuments.kindOf("text/html; charset=utf-8", null))
        assertEquals(LocalDocuments.Kind.XHTML, LocalDocuments.kindOf("application/xhtml+xml", "x.bin"))
        assertEquals(LocalDocuments.Kind.PDF, LocalDocuments.kindOf("Application/PDF", "statement"))
        assertEquals(LocalDocuments.Kind.SVG, LocalDocuments.kindOf("image/svg+xml", "logo"))
        // No type, or a type that says nothing: the name decides.
        assertEquals(LocalDocuments.Kind.HTML, LocalDocuments.kindOf(null, "page.HTML"))
        assertEquals(LocalDocuments.Kind.HTML, LocalDocuments.kindOf("", "index.htm"))
        assertEquals(LocalDocuments.Kind.XHTML, LocalDocuments.kindOf("application/octet-stream", "doc.xhtml"))
        assertEquals(LocalDocuments.Kind.PDF, LocalDocuments.kindOf("*/*", "Download/report.pdf"))
        assertEquals(LocalDocuments.Kind.SVG, LocalDocuments.kindOf(null, "drawing.svg"))
        // A type of its own that is not one of ours is not overruled by the name.
        assertNull(LocalDocuments.kindOf("text/plain", "notes.html"))
        assertNull(LocalDocuments.kindOf("image/png", "photo.svg"))
        assertNull(LocalDocuments.kindOf(null, "archive.zip"))
        assertNull(LocalDocuments.kindOf(null, "README"))
        assertNull(LocalDocuments.kindOf(null, ".pdf"))
        assertNull(LocalDocuments.kindOf(null, null))
        assertEquals(listOf("text/html", "application/xhtml+xml", "application/pdf", "image/svg+xml"), LocalDocuments.MIME_TYPES)
    }

    @Test
    fun theAppsOwnFilesAreRefusedAndEverythingElseIsNot() {
        val private = listOf("/data/user/0/app.zen.chromium", "/storage/emulated/0/Android/data/app.zen.chromium")
        assertTrue(LocalDocuments.refused("file:///data/user/0/app.zen.chromium/app_webview/Cookies", private))
        assertTrue(LocalDocuments.refused("file:///data/user/0/app.zen.chromium", private))
        assertTrue(LocalDocuments.refused("file:///data/user/0/app.zen.chromium/files/../databases/x.db", private))
        assertTrue(LocalDocuments.refused("file:///storage/emulated/0/Android/data/app.zen.chromium/files/a.html", private))
        assertTrue("an address without a path names nothing", LocalDocuments.refused("file://", private))
        assertFalse(LocalDocuments.refused("file:///sdcard/Download/page.html", private))
        assertFalse(LocalDocuments.refused("file:///data/user/0/app.zen.chromium2/x.html", private))
        assertFalse(LocalDocuments.refused("file:///storage/emulated/0/Download/r%C3%A9sum%C3%A9.pdf", private))
        // A content address is its provider's to refuse.
        assertFalse(LocalDocuments.refused("content://app.zen.chromium.files/private/x", private))
        assertFalse(LocalDocuments.refused("https://example.com/", private))
    }

    @Test
    fun namesComeFromTheLastSegment() {
        assertEquals("page.html", LocalDocuments.nameFromPath("page.html"))
        assertEquals("report.pdf", LocalDocuments.nameFromPath("primary:Download/report.pdf"))
        assertEquals("document", LocalDocuments.nameFromPath(null))
        assertEquals("document", LocalDocuments.nameFromPath("  "))
        assertEquals("document", LocalDocuments.nameFromPath("Download/"))
    }

    @Test
    fun textIsDecodedByItsMarkOrDeclarationElseAsUtf8() {
        val plain = "<!doctype html><title>Tidé</title>".toByteArray(Charsets.UTF_8)
        assertEquals("<!doctype html><title>Tidé</title>", LocalDocuments.decode(plain))
        val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + plain
        assertEquals("<!doctype html><title>Tidé</title>", LocalDocuments.decode(bom))
        val latin = "<html><head><meta charset=\"windows-1252\"></head><body>caf\u00e9 \u20ac</body></html>"
        assertEquals(latin, LocalDocuments.decode(latin.toByteArray(charset("windows-1252"))))
        val http = "<meta http-equiv=\"Content-Type\" content=\"text/html; charset=ISO-8859-1\"><p>na\u00efve</p>"
        assertEquals(http, LocalDocuments.decode(http.toByteArray(Charsets.ISO_8859_1)))
        val xml = "<?xml version=\"1.0\" encoding=\"ISO-8859-15\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><title>\u20ac</title></svg>"
        assertEquals(xml, LocalDocuments.decode(xml.toByteArray(charset("ISO-8859-15"))))
        val utf16 = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "<p>hi</p>".toByteArray(Charsets.UTF_16LE)
        assertEquals("<p>hi</p>", LocalDocuments.decode(utf16))
        // A charset the runtime does not know falls back to UTF-8 rather than failing.
        val odd = "<meta charset=\"x-made-up\"><p>ok</p>"
        assertEquals(odd, LocalDocuments.decode(odd.toByteArray(Charsets.UTF_8)))
        assertEquals("", LocalDocuments.decode(ByteArray(0)))
    }
}
