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
 * WebView (`restoreState`), which then has the same three entries with the same current one. And
 * the refusals: a bundle that is not a WebView's (another host's, a hand-made one) unmarshals but
 * `restoreState` returns null for it; bytes that are not a bundle at all never reach the WebView;
 * a private tab's view has no state to give. The pages come from `shouldInterceptRequest`, so
 * nothing depends on the network. Runs alongside `NavSnapshotDemo` in the emulator workflow.
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
        assertTrue(NavigationState.restoredMatches(restored.currentItem?.url, onMain { fresh.url }, PAGES[2]))
        assertEquals(listOf(PAGES[0], PAGES[1], PAGES[2]), (0 until 3).map { restored.getItemAtIndex(it).url })
        assertTrue(onMain { fresh.canGoBack() })
        assertFalse(onMain { fresh.canGoForward() })

        // The list is live: back goes to the second page, as the snapshot's entries say it should.
        val afterBack = load(fresh) { it.goBack() }
        assertEquals(1, onMain { fresh.copyBackForwardList().currentIndex })
        assertEquals(PAGES[1], onMain { fresh.url })
        assertNotNull(afterBack)
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
    }
}
