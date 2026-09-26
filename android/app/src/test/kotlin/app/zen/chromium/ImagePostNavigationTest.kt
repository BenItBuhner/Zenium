package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImagePostNavigationTest {
    private val bing = "https://www.bing.com/images/detail/search?iss=sbiupload&FORM=CHROMI#enterInsights"
    private val lens = "https://lens.google.com/v3/upload"

    @Test
    fun anUrlencodedBodyGoesThroughPostUrlAsUtf8Bytes() {
        val plan = ImagePostNavigation.plan(bing, "imageBin=%2F9j%2F", null)
        assertEquals(
            ImagePostNavigation.Plan.PostUrl(bing, "imageBin=%2F9j%2F".toByteArray(Charsets.UTF_8)),
            plan
        )
        assertEquals("imageBin=%2F9j%2F", String((plan as ImagePostNavigation.Plan.PostUrl).body, Charsets.UTF_8))
    }

    @Test
    fun aMultipartUploadGoesAsTheFormDocument() {
        val html = "<!doctype html><form id=\"f\" method=\"post\" enctype=\"multipart/form-data\"></form>"
        assertEquals(ImagePostNavigation.Plan.FormDocument(lens, html), ImagePostNavigation.plan(lens, null, html))
        assertEquals(ImagePostNavigation.Plan.FormDocument(lens, html), ImagePostNavigation.plan(lens, "", html))
    }

    @Test
    fun theFormDocumentLoadsUnderAnOpaqueOriginNeverTheEngines() {
        assertNull(ImagePostNavigation.FORM_DOCUMENT_BASE)
        assertEquals("text/html", ImagePostNavigation.FORM_DOCUMENT_MIME)
        assertEquals("utf-8", ImagePostNavigation.FORM_DOCUMENT_ENCODING)
    }

    @Test
    fun aBodyWinsWhenBothCome() {
        assertEquals(
            ImagePostNavigation.Plan.PostUrl(bing, "a=1".toByteArray()),
            ImagePostNavigation.plan(bing, "a=1", "<form></form>")
        )
    }

    @Test
    fun anEmptyWireLoadsTheAddress() {
        assertEquals(ImagePostNavigation.Plan.Load(lens), ImagePostNavigation.plan(lens, null, null))
        assertEquals(ImagePostNavigation.Plan.Load(lens), ImagePostNavigation.plan(lens, "", ""))
    }
}
