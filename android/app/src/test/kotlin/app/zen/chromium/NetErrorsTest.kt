package app.zen.chromium

import android.net.http.SslError
import android.webkit.WebViewClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetErrorsTest {
    @Test
    fun `WebView's description names the Chromium error and wins over its coarse code`() {
        // WebView folds these three into ERROR_HOST_LOOKUP; the description tells them apart.
        assertEquals(-105, NetErrors.code(WebViewClient.ERROR_HOST_LOOKUP, "net::ERR_NAME_NOT_RESOLVED", false))
        assertEquals(-106, NetErrors.code(WebViewClient.ERROR_HOST_LOOKUP, "net::ERR_INTERNET_DISCONNECTED", false))
        assertEquals(-109, NetErrors.code(WebViewClient.ERROR_HOST_LOOKUP, "net::ERR_ADDRESS_UNREACHABLE", false))
        assertEquals(-102, NetErrors.code(WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_REFUSED", false))
        assertEquals(-101, NetErrors.code(WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_RESET", false))
    }

    @Test
    fun `a description without a known name falls back to the coarse code`() {
        assertEquals(-105, NetErrors.code(WebViewClient.ERROR_HOST_LOOKUP, null, false))
        assertEquals(-105, NetErrors.code(WebViewClient.ERROR_HOST_LOOKUP, "Unable to resolve host", false))
        assertEquals(-102, NetErrors.code(WebViewClient.ERROR_CONNECT, "net::ERR_SOCKET_NOT_CONNECTED", false))
        assertEquals(-118, NetErrors.code(WebViewClient.ERROR_TIMEOUT, "", false))
        assertEquals(-310, NetErrors.code(WebViewClient.ERROR_REDIRECT_LOOP, null, false))
        assertEquals(-300, NetErrors.code(WebViewClient.ERROR_BAD_URL, null, false))
        assertEquals(-2, NetErrors.code(WebViewClient.ERROR_UNKNOWN, "something else", false))
    }

    @Test
    fun `localhost colon 1 is a reserved port to Chromium, not a refused connection`() {
        // WebView reports ERR_UNSAFE_PORT as ERROR_UNKNOWN; the description carries the name.
        val failure = NetErrors.failure(WebViewClient.ERROR_UNKNOWN, "net::ERR_UNSAFE_PORT", false)
        assertEquals(-312, failure.code)
        assertEquals("ERR_UNSAFE_PORT", failure.name)
        // Not a failure to reach a host either: being offline does not explain it.
        assertEquals(-312, NetErrors.failure(WebViewClient.ERROR_UNKNOWN, "net::ERR_UNSAFE_PORT", true).code)
    }

    @Test
    fun `a failure carries the name the page prints`() {
        val refused = NetErrors.failure(WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_REFUSED", false)
        assertEquals(-102, refused.code)
        assertEquals("ERR_CONNECTION_REFUSED", refused.name)
        // The coarse code alone: the name is the one the code stands for.
        val lookup = NetErrors.failure(WebViewClient.ERROR_HOST_LOOKUP, "Unable to resolve host", false)
        assertEquals(-105, lookup.code)
        assertEquals("ERR_NAME_NOT_RESOLVED", lookup.name)
        assertEquals("ERR_FAILED", NetErrors.failure(WebViewClient.ERROR_UNKNOWN, "something else", false).name)
    }

    @Test
    fun `a Chromium name the table lacks is printed rather than the stand-in code's`() {
        val unlisted = NetErrors.failure(WebViewClient.ERROR_UNKNOWN, "net::ERR_HTTP2_PROTOCOL_ERROR", false)
        assertEquals(-2, unlisted.code)
        assertEquals("ERR_HTTP2_PROTOCOL_ERROR", unlisted.name)
        // …unless being offline is the explanation, when the offline code's name is the truth.
        val offline = NetErrors.failure(WebViewClient.ERROR_UNKNOWN, "net::ERR_HTTP2_PROTOCOL_ERROR", true)
        assertEquals(-106, offline.code)
        assertEquals("ERR_INTERNET_DISCONNECTED", offline.name)
    }

    @Test
    fun `offline turns an unreached host into ERR_INTERNET_DISCONNECTED`() {
        assertEquals(-106, NetErrors.code(WebViewClient.ERROR_HOST_LOOKUP, "net::ERR_NAME_NOT_RESOLVED", true))
        assertEquals(-106, NetErrors.code(WebViewClient.ERROR_TIMEOUT, "net::ERR_CONNECTION_TIMED_OUT", true))
        assertEquals(-106, NetErrors.code(WebViewClient.ERROR_UNKNOWN, null, true))
    }

    @Test
    fun `offline leaves a host that answered alone`() {
        // localhost:1 refuses the connection with or without a network.
        assertEquals(-102, NetErrors.code(WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_REFUSED", true))
        assertEquals(-101, NetErrors.code(WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_RESET", true))
        assertEquals(-202, NetErrors.code(0, "net::ERR_CERT_AUTHORITY_INVALID", true))
        assertEquals(-300, NetErrors.code(WebViewClient.ERROR_BAD_URL, null, true))
    }

    @Test
    fun `refused certificates map to Chromium's cert errors`() {
        assertEquals(-201, NetErrors.sslCode(SslError.SSL_EXPIRED))
        assertEquals(-201, NetErrors.sslCode(SslError.SSL_NOTYETVALID))
        assertEquals(-201, NetErrors.sslCode(SslError.SSL_DATE_INVALID))
        assertEquals(-200, NetErrors.sslCode(SslError.SSL_IDMISMATCH))
        assertEquals(-202, NetErrors.sslCode(SslError.SSL_UNTRUSTED))
        assertEquals(-207, NetErrors.sslCode(SslError.SSL_INVALID))
        assertEquals(-207, NetErrors.sslCode(42))
    }

    @Test
    fun `codes carry the name the page prints`() {
        assertEquals("ERR_NAME_NOT_RESOLVED", NetErrors.name(-105))
        assertEquals("ERR_CONNECTION_REFUSED", NetErrors.name(-102))
        assertEquals("ERR_INTERNET_DISCONNECTED", NetErrors.name(-106))
        assertEquals("ERR_CERT_DATE_INVALID", NetErrors.name(-201))
        assertNull(NetErrors.name(-999))
    }

    @Test
    fun `names are read with or without the net prefix`() {
        assertEquals("ERR_CONNECTION_REFUSED", NetErrors.nameIn("net::ERR_CONNECTION_REFUSED"))
        assertEquals("ERR_TIMED_OUT", NetErrors.nameIn(" ERR_TIMED_OUT "))
        assertNull(NetErrors.nameIn("net::ERR_FAILED extra"))
        assertNull(NetErrors.nameIn("Webpage not available"))
    }
}
