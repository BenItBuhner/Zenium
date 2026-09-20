package app.zen.chromium

import android.content.Context
import android.os.Bundle
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The `hostState` round trip on real WebViews: a three-page list saved (`WebView.saveState`),
 * marshalled and base64-encoded ([NavigationState.hostStateOf]), decoded and unmarshalled again
 * ([NavigationState.decodeHostState], [NavigationState.bundleOf]) and restored into a fresh
 * WebView (`restoreState`), which then has the same three entries with the same current one; the
 * same with an internal page (`loadDataWithBaseURL`, a `data:` item shown as `zen://…`) on top,
 * matched to the snapshot's entries off the lists alone and back as one document, its document
 * inside the state. And the refusals: a bundle that is not a WebView's (another host's, a
 * hand-made one) unmarshals but `restoreState` returns null for it; bytes that are not a bundle
 * at all never reach the WebView; a private tab's view has no state to give. The pages come from
 * `shouldInterceptRequest`, so nothing depends on the network. Runs on a device in the
 * emulator workflow (`android-nav-snapshot-demo.yml` lists it in `DEMO_CLASS` ahead of
 * `NavSnapshotDemo`, in the same instrumentation run), so a failure here fails the recording.
 */
@RunWith(AndroidJUnit4::class)
class NavigationStateWebViewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app: Context = instrumentation.targetContext
    private val views = ArrayList<WebView>()

    @After
    fun destroyViews() {
        instrumentation.runOnMainSync {
            for (view in views) view.destroy()
            views.clear()
        }
    }

    @Test
    fun aSavedListComesBackWholeIntoAFreshWebView() {
        val source = webView()
        for (page in PAGES) load(source) { it.loadUrl(page) }
        val list = onMain { source.copyBackForwardList() }
        assertEquals(3, list.size)
        assertEquals(2, list.currentIndex)

        val hostState = onMain { NavigationState.hostStateOf(source, private = false) }
        assertNotNull("a three-page list has a state to give", hostState)
        assertTrue(hostState!!.startsWith(NavigationState.HOST_STATE_PREFIX))
        assertTrue("within the cap: ${hostState.length} chars", hostState.length <= NavigationState.HOST_STATE_MAX)
        Log.i(TAG, "hostState of a three-page list: ${hostState.length} chars")

        val bytes = NavigationState.decodeHostState(hostState)
        assertNotNull(bytes)
        val bundle = NavigationState.bundleOf(bytes!!)
        assertNotNull("the bytes read as a bundle again", bundle)

        val fresh = webView()
        val restored = load(fresh) { it.restoreState(bundle!!) }
        assertNotNull("restoreState accepts its own state", restored)
        assertEquals(3, restored!!.size)
        assertEquals(2, restored.currentIndex)
        assertEquals(PAGES[2], restored.currentItem?.url)
        val items = (0 until 3).map { restored.getItemAtIndex(it).url }
        assertEquals(listOf(PAGES[0], PAGES[1], PAGES[2]), items)
        assertTrue(NavigationState.restoredMatches(items, restored.currentIndex, PAGES, 2))
        assertFalse("another current entry is not the list described", NavigationState.restoredMatches(items, restored.currentIndex, PAGES, 1))
        assertTrue(onMain { fresh.canGoBack() })
        assertFalse(onMain { fresh.canGoForward() })

        // The list is live: back goes to the second page, as the snapshot's entries say it should.
        val afterBack = load(fresh) { it.goBack() }
        assertEquals(1, onMain { fresh.copyBackForwardList().currentIndex })
        assertEquals(PAGES[1], onMain { fresh.url })
        assertNotNull(afterBack)
    }

    /**
     * An internal page as the current entry (a reader page over the article it was made from):
     * the list holds it as its `data:` document while the view shows it under its `zen://` name,
     * the way `TabWebView.loadHtml` puts one there. Restored into a fresh WebView, the list is
     * matched to the snapshot's entries off the two lists alone – the item's `data:` document
     * where the snapshot names the `zen://` page – with nothing asked of `getUrl()`, whose word
     * right after `restoreState` is logged for the record; the page comes back as one document
     * with its title, under its name, and the snapshot gives the fresh view the name to publish.
     */
    @Test
    fun anInternalPageOnTopOfTheListComesBackAsItsOwnDocument() {
        val source = webView()
        load(source) { it.loadUrl(PAGES[0]) }
        load(source) { it.loadDataWithBaseURL(READER, READER_HTML, "text/html", "utf-8", READER) }
        val list = onMain { source.copyBackForwardList() }
        assertEquals(2, list.size)
        val document = list.getItemAtIndex(1).url
        assertTrue("the list holds the page as its data: document, not: $document", document.startsWith("data:"))
        assertEquals("the view shows it under its name", READER, onMain { source.url })
        assertTrue(NavigationState.standsInFor(document, READER))
        // What the snapshot names the two entries by (the saving view's publicUrl).
        val entries = listOf(PAGES[0], READER)

        val hostState = onMain { NavigationState.hostStateOf(source, private = false) }
        assertNotNull("a list with an internal page on top has a state to give", hostState)
        assertTrue("within the cap: ${hostState!!.length} chars", hostState.length <= NavigationState.HOST_STATE_MAX)
        // The document is inside the state (saveState pickles the entry's data: URL whole): what
        // puts a stack with a large internal page over the cap, and has it restore URL-only.
        assertTrue("the state carries the document: ${hostState.length} chars for a ${READER_HTML.length}-char page", hostState.length > READER_HTML.length)
        Log.i(TAG, "hostState of a page and a reader page: ${hostState.length} chars (the reader document is ${READER_HTML.length})")
        val bundle = NavigationState.bundleOf(NavigationState.decodeHostState(hostState)!!)
        assertNotNull(bundle)

        val fresh = webView()
        var shownRightAfter: String? = null
        val restored = load(fresh) { view -> view.restoreState(bundle!!).also { shownRightAfter = view.url } }
        assertNotNull("restoreState accepts a list with a data: document in it", restored)
        Log.i(TAG, "right after restoreState the view shows ${if (shownRightAfter == READER) "the internal page's name" else "'$shownRightAfter'"} for the internal entry")
        assertEquals(2, restored!!.size)
        assertEquals(1, restored.currentIndex)
        val items = (0 until restored.size).map { restored.getItemAtIndex(it).url }
        assertEquals("the same data: document", document, items[1])
        assertTrue("the restored list is the one the snapshot describes", NavigationState.restoredMatches(items, restored.currentIndex, entries, 1))
        // A snapshot that named the entry as a web page would not be matched by the document.
        assertFalse(NavigationState.restoredMatches(items, restored.currentIndex, listOf(PAGES[0], "https://nav-snapshot.test/reader"), 1))

        // One document, with its title, under its name: nothing for the core to load on top.
        assertEquals(READER, onMain { fresh.url })
        assertEquals("Story", onMain { fresh.title })
        assertEquals(2, onMain { fresh.copyBackForwardList().size })
        assertTrue(onMain { fresh.canGoBack() })
        // The fresh view names the entry the way the snapshot does, from its first list on.
        val names = NavigationState.internalNamesOf(items, entries)
        assertEquals(entries, items.map { NavigationState.publicUrl(it) { key -> names[key] } })

        // And the list is live: back is the article.
        load(fresh) { it.goBack() }
        assertEquals(PAGES[0], onMain { fresh.url })
        assertEquals(0, onMain { fresh.copyBackForwardList().currentIndex })
    }

    @Test
    fun aForeignBundleIsRefusedByTheWebView() {
        // Ours by shape (a marshalled bundle behind the prefix), but not a WebView's state.
        val foreign = Bundle().apply {
            putString("hello", "world")
            putInt("count", 3)
        }
        val text = NavigationState.encodeHostState(NavigationState.marshall(foreign))
        assertNotNull(text)
        val bundle = NavigationState.bundleOf(NavigationState.decodeHostState(text)!!)
        assertNotNull("it unmarshals: the refusal is the WebView's", bundle)
        val fresh = webView()
        val restored = onMain { fresh.restoreState(bundle!!) }
        assertNull("restoreState returns null for a bundle that is not its own", restored)
        assertEquals(0, onMain { fresh.copyBackForwardList().size })
    }

    @Test
    fun bytesThatAreNoBundleNeverReachTheWebView() {
        assertNull(NavigationState.bundleOf(ByteArray(0)))
        assertNull(NavigationState.bundleOf(ByteArray(64) { 0x7f }))
        assertNull(NavigationState.bundleOf(ByteArray(16) { it.toByte() }))
        // A real state cut in half: a length that asks for more than there is.
        val source = webView()
        load(source) { it.loadUrl(PAGES[0]) }
        val whole = NavigationState.marshall(Bundle().also { b -> onMain { source.saveState(b) } })
        assertTrue(whole.isNotEmpty())
        assertNull(NavigationState.bundleOf(whole.copyOf(whole.size / 2)))
        assertNull(NavigationState.bundleOf(whole.copyOf(8)))
    }

    @Test
    fun aPrivateTabAndAnEmptyViewHaveNoState() {
        val source = webView()
        load(source) { it.loadUrl(PAGES[0]) }
        assertNotNull(onMain { NavigationState.hostStateOf(source, private = false) })
        assertNull("nothing of a private session is written", onMain { NavigationState.hostStateOf(source, private = true) })
        assertNull("a view with no list has nothing to give", onMain { NavigationState.hostStateOf(webView(), private = false) })
    }

    // --- plumbing --------------------------------------------------------------------------------

    /** A WebView serving [PAGES] itself; destroyed after the test. */
    private fun webView(): WebView = onMain {
        WebView(app).also { view ->
            view.settings.javaScriptEnabled = false
            view.webViewClient = client
            views += view
        }
    }

    /**
     * Run `action` on `view` on the main thread and wait for the page finished it brings about,
     * returning what the action returned (a `WebBackForwardList` for `restoreState`).
     */
    private fun <T> load(view: WebView, action: (WebView) -> T): T {
        val latch = CountDownLatch(1)
        finished[view] = latch
        val result = onMain { action(view) }
        assertTrue("the page finished loading", latch.await(20, TimeUnit.SECONDS))
        return result
    }

    /** The latch each view's next page finished counts down (set on the test thread, read on the main thread). */
    private val finished = ConcurrentHashMap<WebView, CountDownLatch>()

    private val client = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url.toString()
            val index = PAGES.indexOf(url)
            if (index < 0) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            val html = "<!doctype html><title>Page ${index + 1}</title><h1>Page ${index + 1}</h1>"
            return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
        }

        override fun onPageFinished(view: WebView, url: String) {
            finished[view]?.countDown()
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private companion object {
        private const val TAG = "NavStateTest"
        private val PAGES = listOf("https://nav-snapshot.test/one", "https://nav-snapshot.test/two", "https://nav-snapshot.test/three")
        /** A reader page's name, the way the core makes one (`zen://reader?id=…&url=…`). */
        private const val READER = "zen://reader?id=article_test&url=https%3A%2F%2Fnav-snapshot.test%2Fone"
        private const val READER_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Story</title></head><body><h1>Story</h1><p>The article, read.</p></body></html>"
    }
}
