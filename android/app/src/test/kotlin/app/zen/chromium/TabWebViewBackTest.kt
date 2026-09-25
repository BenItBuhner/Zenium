package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Where back lands from the core's error page: over the entry the page stands in for – WebView's
 * own entry for the load that failed, or the lookalike a link reached that the core turned into
 * its question – when it sits right behind (`TabWebView.backIndexOf`, the pure half of `goBack`);
 * which committed page a `zen://error` page arriving through `loadHtml` stands in for
 * (`interstitialOver`, the pure half of the mark there); and when a load from the page runs from
 * the skipped entry instead (`retriesFailedEntryOf`, `loadUrl`'s).
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
    fun `nothing behind the skipped entry means nowhere, as nothing behind at all does`() {
        // [failed, core's page]: going back onto the failed load would only run it again, and
        // the chrome's Back takes its no-history way instead (the tab a link opened closes).
        assertEquals(-1, TabWebView.backIndexOf(1, { listOf("https://old.example/news", "data:x")[it] }, true, "https://old.example/news"))
        assertEquals(-1, back(0, onErrorPage = true, skipped = "https://old.example/news"))
    }

    // --- The lookalike a link reached, turned into the question after its commit ---------------

    private val lookalike = "http://paypa1.com/"
    private val question = "zen://error?code=-20&description=ERR_BLOCKED_BY_CLIENT&url=http%3A%2F%2Fpaypa1.com%2F&kind=lookalike&target=paypal.com&reason=digit&source=top"

    @Test
    fun `from the question over a lookalike a link reached, back lands on the page before it`() {
        // [before, lookalike, question]: the phone's Back must not land on the lookalike and ask again.
        val list = listOf("https://news.example/link", lookalike, question)
        assertEquals(0, TabWebView.backIndexOf(2, { list.getOrNull(it) }, true, lookalike))
    }

    @Test
    fun `a lookalike question as a tab's first page has no way back through history`() {
        // [lookalike, question]: the question was a new tab's first page; canGoBack reads this.
        val list = listOf(lookalike, question)
        assertEquals(-1, TabWebView.backIndexOf(1, { list.getOrNull(it) }, true, lookalike))
    }

    @Test
    fun `the question over the committed lookalike stands in for it`() {
        assertEquals(lookalike, TabWebView.interstitialOver(question, committed = lookalike, awaitingCommit = false))
    }

    @Test
    fun `the question over a typed lookalike leaves the committed page the way back`() {
        // The core held the typed address before any request: the page before is still the way back.
        assertNull(TabWebView.interstitialOver(question, committed = "https://news.example/link", awaitingCommit = false))
    }

    @Test
    fun `a page still on its way, no page, a page not the web's, a page not the core's error page mark nothing`() {
        // The failed load's case is marked at its commit (`doUpdateVisitedHistory`), not here.
        assertNull(TabWebView.interstitialOver(question, committed = lookalike, awaitingCommit = true))
        assertNull(TabWebView.interstitialOver(question, committed = null, awaitingCommit = false))
        assertNull(TabWebView.interstitialOver("zen://error?code=-20&url=zen%3A%2F%2Fsettings", committed = "zen://settings", awaitingCommit = false))
        assertNull(TabWebView.interstitialOver("zen://reader?url=http%3A%2F%2Fpaypa1.com%2F", committed = lookalike, awaitingCommit = false))
    }

    @Test
    fun `the address a core error page is about is its form-encoded url parameter`() {
        assertEquals("https://a.example/p?q=1 2&r=%20", TabWebView.errorPageStandsFor("zen://error?code=-6&url=https%3A%2F%2Fa.example%2Fp%3Fq%3D1+2%26r%3D%2520&kind=blocked"))
        assertNull(TabWebView.errorPageStandsFor("zen://error?code=-6&kind=blocked"))
        assertNull(TabWebView.errorPageStandsFor("zen://error"))
    }

    // --- Proceed past the certificate interstitial: the failed address asked for again ----------

    private val refused = "https://expired.badssl.com/"

    @Test
    fun `from the core's error page, a load of the failed address runs from WebView's entry for it`() {
        assertTrue(TabWebView.retriesFailedEntryOf(onErrorPage = true, target = refused, behindUrl = refused, skipped = refused))
    }

    @Test
    fun `any other load from the error page is a load like any other`() {
        // Another address; the failed entry not right behind; WebView made no entry for the failure.
        assertFalse(TabWebView.retriesFailedEntryOf(onErrorPage = true, target = "https://other.example/", behindUrl = refused, skipped = refused))
        assertFalse(TabWebView.retriesFailedEntryOf(onErrorPage = true, target = refused, behindUrl = "https://start.example/", skipped = refused))
        assertFalse(TabWebView.retriesFailedEntryOf(onErrorPage = true, target = refused, behindUrl = null, skipped = refused))
        assertFalse(TabWebView.retriesFailedEntryOf(onErrorPage = true, target = refused, behindUrl = refused, skipped = null))
    }

    @Test
    fun `off the error page nothing is retried through history`() {
        assertFalse(TabWebView.retriesFailedEntryOf(onErrorPage = false, target = refused, behindUrl = refused, skipped = refused))
    }
}
