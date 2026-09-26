package app.zen.chromium

import app.zen.chromium.CustomTabPageInfo.Connection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CustomTabPageInfoTest {
    @Test
    fun httpsIsSecureWhateverTheHost() {
        assertEquals(Connection.SECURE, CustomTabPageInfo.connectionOf("https://en.wikipedia.org/wiki/Damping"))
        assertEquals(Connection.SECURE, CustomTabPageInfo.connectionOf("HTTPS://127.0.0.1:8443/"))
    }

    @Test
    fun httpOnTheLoopbackIsALocalSiteAsTheBrowsersSheetRules() {
        assertEquals(Connection.LOCAL, CustomTabPageInfo.connectionOf("http://127.0.0.1:8137/story.html"))
        assertEquals(Connection.LOCAL, CustomTabPageInfo.connectionOf("http://127.5.6.7/"))
        assertEquals(Connection.LOCAL, CustomTabPageInfo.connectionOf("http://localhost/"))
        assertEquals(Connection.LOCAL, CustomTabPageInfo.connectionOf("http://app.localhost:3000/x"))
    }

    @Test
    fun anyOtherHttpPageIsNotSecure() {
        assertEquals(Connection.INSECURE, CustomTabPageInfo.connectionOf("http://example.com/"))
        assertEquals(Connection.INSECURE, CustomTabPageInfo.connectionOf("http://10.0.2.2:8080/"))
        assertEquals(Connection.INSECURE, CustomTabPageInfo.connectionOf("http://127.0.0.1.example.com/"))
        assertEquals(Connection.INSECURE, CustomTabPageInfo.connectionOf("not a url"))
    }

    @Test
    fun theHostIsWhatTheParserAcceptsOrNothing() {
        assertEquals("en.wikipedia.org", CustomTabPageInfo.hostOf("https://en.wikipedia.org/wiki/Damping"))
        assertEquals("127.0.0.1", CustomTabPageInfo.hostOf("http://127.0.0.1:8137/story.html"))
        assertNull(CustomTabPageInfo.hostOf("not a url"))
        assertNull(CustomTabPageInfo.hostOf("about:blank"))
    }
}
