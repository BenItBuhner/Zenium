package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where back lands from the core's error page: over WebView's own entry for the load that
 * failed, when it sits right behind (`TabWebView.backIndexOf`, the pure half of `goBack`).
 */
class TabWebViewBackTest {
    private val entries = listOf("https://start.example/", "https://old.example/news", "data:text/html;charset=utf-8,<html>")

    private fun back(index: Int, onErrorPage: Boolean, skipped: String?) =
        TabWebView.backIndexOf(index, { entries.getOrNull(it) }, onErrorPage, skipped)

    @Test
    fun `from the core's error page, back steps over WebView's entry for the failed upgrade`() {
        assertEquals(0, back(2, onErrorPage = true, skipped = "https://old.example/news"))
    }

    @Test
    fun `the entry behind is kept when it is not the failed load's`() {
        // Another page, or a failure WebView made no entry for (the core's page cancelled it).
        assertEquals(1, back(2, onErrorPage = true, skipped = "https://elsewhere.example/"))
        assertEquals(1, back(2, onErrorPage = true, skipped = null))
    }

    @Test
    fun `off the error page the failed entry is a page like any other`() {
        assertEquals(1, back(2, onErrorPage = false, skipped = "https://old.example/news"))
    }

    @Test
    fun `nothing behind the failed entry means going back onto it, and nothing behind means nowhere`() {
        // [failed, core's page]: the failed load is the only way back; the reload asks again.
        assertEquals(0, TabWebView.backIndexOf(1, { listOf("https://old.example/news", "data:x")[it] }, true, "https://old.example/news"))
        assertEquals(-1, back(0, onErrorPage = true, skipped = "https://old.example/news"))
    }
}
