package app.zen.chromium.ext

import android.webkit.WebViewClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NavigationReportsTest {
    @Test
    fun `names a WebView error code the way Chrome does`() {
        assertEquals(
            "net::ERR_NAME_NOT_RESOLVED",
            NavigationReports.errorName(WebViewClient.ERROR_HOST_LOOKUP, "net::ERR_NAME_NOT_RESOLVED", 0)
        )
        // A description WebView reports with a name the table has no copy for is still Chromium's name.
        assertEquals(
            "net::ERR_SOME_NEW_FAILURE",
            NavigationReports.errorName(WebViewClient.ERROR_UNKNOWN, "net::ERR_SOME_NEW_FAILURE", 0)
        )
    }

    @Test
    fun `falls back to the HTTP failure and then to nothing`() {
        assertEquals("net::ERR_HTTP_RESPONSE_CODE_FAILURE", NavigationReports.errorName(null, null, 503))
        assertNull(NavigationReports.errorName(null, null, 200))
        assertNull(NavigationReports.errorName(null, null, 0))
    }
}
