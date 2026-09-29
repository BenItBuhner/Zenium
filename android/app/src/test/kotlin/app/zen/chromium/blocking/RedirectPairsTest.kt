package app.zen.chromium.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The pair a main-frame redirect hop makes, stamped by the tab's navigation hook and spent by
 * the target's intercept ([RedirectPairs]; `Request.redirectedFrom`, the extension runtime's
 * `webRequest.onBeforeRedirect`). The stamp is the hook's (`shouldOverrideUrlLoading` with
 * `isRedirect`, the one place WebView marks a hop), never the intercept's.
 */
class RedirectPairsTest {
    private class FakeTab(override val tabId: String = "tab-1", override val containerId: String = "default") : BlockingTab {
        override val documentUrl: String? = null
        override fun onRequestsBlocked(count: Int) {}
        override fun onDocumentBlocked(url: String) {}
        override fun onDocumentUnsafe(url: String, hit: SafeBrowsingHit) {}
        override fun onDocumentRedirected(url: String) {}
        override fun onDocumentUpgraded(from: String, to: String) {}
    }

    private val pairs = RedirectPairs()
    private val tab = FakeTab()

    @Test
    fun `the target's main-frame intercept is answered with the stamped from, once`() {
        pairs.note(tab, "https://short.example/x", "https://news.example/story")
        assertEquals("https://short.example/x", pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
        // Spent: a second main-frame request for the same URL (a reload) is a plain load.
        assertNull(pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
    }

    @Test
    fun `a fresh navigation without a stamp has no pair`() {
        assertNull(pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
        assertNull(pairs.redirectedFrom(tab, "https://cdn.example/app.js", isMainFrame = false))
    }

    @Test
    fun `a subresource is never paired and leaves the hop waiting for the document`() {
        pairs.note(tab, "https://short.example/x", "https://news.example/story")
        assertNull(pairs.redirectedFrom(tab, "https://cdn.example/app.js", isMainFrame = false))
        // Even a subresource at the target's own URL (an image served from the same address).
        assertNull(pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = false))
        assertEquals("https://short.example/x", pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
    }

    @Test
    fun `a main-frame request for another URL gets no pair and drops the hop`() {
        pairs.note(tab, "https://short.example/x", "https://news.example/story")
        // The navigation went elsewhere (the hook's target never came): no pair for the other page…
        assertNull(pairs.redirectedFrom(tab, "https://other.example/", isMainFrame = true))
        // …and a later plain load of the hop's target is not the hop's.
        assertNull(pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
    }

    @Test
    fun `a chain pairs every hop with the address before it`() {
        // A→B→C: the hook stamps A→B, B's intercept spends it, the hook stamps B→C before C's request.
        pairs.note(tab, "https://a.example/", "https://b.example/")
        assertEquals("https://a.example/", pairs.redirectedFrom(tab, "https://b.example/", isMainFrame = true))
        pairs.note(tab, "https://b.example/", "https://c.example/")
        assertEquals("https://b.example/", pairs.redirectedFrom(tab, "https://c.example/", isMainFrame = true))
        assertNull(pairs.redirectedFrom(tab, "https://c.example/", isMainFrame = true))
    }

    @Test
    fun `a hop back to the same URL is still a hop`() {
        pairs.note(tab, "https://news.example/story", "https://news.example/story")
        assertEquals("https://news.example/story", pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
        assertNull(pairs.redirectedFrom(tab, "https://news.example/story", isMainFrame = true))
    }

    @Test
    fun `a newer stamp replaces a hop still waiting`() {
        // B's request never came (an app or an interstitial took the navigation); the next hop is the one in flight.
        pairs.note(tab, "https://a.example/", "https://b.example/")
        pairs.note(tab, "https://c.example/", "https://d.example/")
        assertEquals("https://c.example/", pairs.redirectedFrom(tab, "https://d.example/", isMainFrame = true))
        assertNull(pairs.redirectedFrom(tab, "https://b.example/", isMainFrame = true))
    }

    @Test
    fun `a cancelled hop's pair is replaced by the document's next stamp – the new target is paired, the old one is not`() {
        // The hook stamped A→B, B's navigation was cancelled before its request, the hook stamped A→C
        // (Extensions' edge case: "Replace the pair on every noteRedirect").
        pairs.note(tab, "https://a.example/", "https://b.example/")
        pairs.note(tab, "https://a.example/", "https://c.example/")
        assertEquals("https://a.example/", pairs.redirectedFrom(tab, "https://c.example/", isMainFrame = true))
        // The replaced hop is gone for good: B is a plain load, C's pair was spent once.
        assertNull(pairs.redirectedFrom(tab, "https://b.example/", isMainFrame = true))
        assertNull(pairs.redirectedFrom(tab, "https://c.example/", isMainFrame = true))
    }

    @Test
    fun `a cancelled hop's pair never attaches to the next navigation, whichever URL it is for`() {
        // A→B stamped, cancelled, A→C stamped; before C's request the tab navigates to B on its own
        // (Extensions' edge case: "clear it on a main-frame intercept whose url is not `to`").
        pairs.note(tab, "https://a.example/", "https://b.example/")
        pairs.note(tab, "https://a.example/", "https://c.example/")
        assertNull(pairs.redirectedFrom(tab, "https://b.example/", isMainFrame = true))
        // That request was not the hop's target, so the pending pair is cleared with it: nothing attaches to C either.
        assertNull(pairs.redirectedFrom(tab, "https://c.example/", isMainFrame = true))
    }

    @Test
    fun `tabs keep their own hop`() {
        val second = FakeTab(tabId = "tab-2")
        pairs.note(tab, "https://a.example/", "https://b.example/")
        // The other tab's request for the same target is a plain load of its own.
        assertNull(pairs.redirectedFrom(second, "https://b.example/", isMainFrame = true))
        pairs.note(second, "https://x.example/", "https://y.example/")
        assertEquals("https://a.example/", pairs.redirectedFrom(tab, "https://b.example/", isMainFrame = true))
        assertEquals("https://x.example/", pairs.redirectedFrom(second, "https://y.example/", isMainFrame = true))
        // Spending one tab's hop leaves the other's alone, and nothing of either remains.
        assertNull(pairs.redirectedFrom(tab, "https://b.example/", isMainFrame = true))
        assertNull(pairs.redirectedFrom(second, "https://y.example/", isMainFrame = true))
    }
}
