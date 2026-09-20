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
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The `hostState` round trip on real WebViews: a three-page list saved (`WebView.saveState`),
 * marshalled and base64-encoded ([NavigationState.hostStateOf]), decoded and unmarshalled again
 * ([NavigationState.decodeHostState], [NavigationState.bundleOf]) and restored into a fresh
 * WebView (`restoreState`), which then has the same three entries with the same current one; the
 * same with two internal pages (`loadDataWithBaseURL`: `data:` items, both under one and the
 * same placeholder URL, each committed under its `zen://` URL) on a list of four, a web page
 * between them, matched to the snapshot's entries off the lists alone and named by position,
 * the documents inside the state (what the bare view says past the restore – its title, the
 * restore's commit, Back – is logged, not held). And the refusals: a bundle that is not shaped like a WebView's state
 * (another host's, a hand-made one, one naming Parcelables) never reaches the WebView; one
 * shaped like a state but not holding one is refused by `restoreState`; bytes that are not a
 * bundle at all never become one; a private tab's view has no state to give. The pages come
 * from `shouldInterceptRequest`, so nothing depends on the network. Runs on a device in the
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
     * Two internal pages in the list – a reader page over the article it was made from, a web
     * page over that, a history page on top – the way `TabWebView.loadHtml` puts them there
     * (`loadDataWithBaseURL`, the page's `zen://` URL as its base and history URL), and the way
     * a tab's list holds two: with a page between them. One straight after another makes no
     * entry of its own – WebView folds a `loadDataWithBaseURL` document that follows another
     * into that other's entry (run 4: three loads, two entries) – so a list has no two adjacent
     * internal pages; the probe at the end logs what the fold leaves and what its state restores,
     * asserting nothing. The list holds each internal page as a `data:` item, the two under one
     * and the same URL (the header the document was loaded under; the document is the entry's),
     * while a load's commit is reported under the page's `zen://` URL – the base URL, which is
     * what `TabWebView` names the position by. Restored into a fresh WebView, the list is
     * matched to the snapshot's entries off the two lists alone, and the snapshot gives the
     * fresh view the names to publish, each at its position (the reader page two back is not
     * `about:blank`, nor the history page's name). That much is held: the list, the commits of
     * the four loads, the state, the restored list, the match and the names – each of it green
     * on the device in run 5. What a bare view says past that is logged, not held: `getUrl()`
     * (the placeholder on the device, after a fresh load and right after `restoreState`),
     * `getTitle()` at the instant the restore's page finished fired (the placeholder too, in
     * run 5: the display title off the URL, the entry's own not there yet), what the document
     * says its title is, the URL the restore's commit is reported under, and what three Backs
     * bring. The product's view is the one the names and the titles are read from, and the
     * phone's own list with two reader pages in it, closed and brought back, is the demo's
     * scene 8.
     */
    @Test
    fun internalPagesOnTheListComeBackAsTheirOwnDocumentsUnderTheirNames() {
        val source = webView()
        load(source) { it.loadUrl(PAGES[0]) }
        load(source) { it.loadDataWithBaseURL(READER, READER_HTML, "text/html", "utf-8", READER) }
        load(source) { it.loadUrl(PAGES[1]) }
        load(source) { it.loadDataWithBaseURL(HISTORY, HISTORY_HTML, "text/html", "utf-8", HISTORY) }
        val list = onMain { source.copyBackForwardList() }
        val items = (0 until list.size).map { list.getItemAtIndex(it).url }
        Log.i(TAG, "a page, a reader page, a page and a history page: ${list.size} entries, current ${list.currentIndex}: $items; the commits ${committed[source]}")
        assertEquals("four loads, four entries: $items", 4, list.size)
        assertEquals(3, list.currentIndex)
        assertEquals(PAGES[0], items[0])
        assertTrue("the list holds the reader page as a data: item, not: ${items[1]}", items[1].startsWith("data:"))
        assertEquals(PAGES[1], items[2])
        assertTrue("and the history page, not: ${items[3]}", items[3].startsWith("data:"))
        val shown = onMain { source.url }
        Log.i(TAG, "the internal pages' items: '${items[1]}' and '${items[3]}'${if (items[1] == items[3]) " (one and the same)" else ""}; getUrl() says '$shown' for the current one")
        // The commits were reported under the pages' own URLs: what TabWebView names the positions by.
        assertEquals("each commit under the page's URL", listOf(PAGES[0], READER, PAGES[1], HISTORY), committed[source])
        assertTrue(NavigationState.standsInFor(items[1], READER))
        assertTrue(NavigationState.standsInFor(items[3], HISTORY))
        // What the snapshot names the four entries by: the saving view's names, at their positions.
        val entries = listOf(PAGES[0], READER, PAGES[1], HISTORY)
        val names = mapOf(1 to READER, 3 to HISTORY)
        val listItems = (0 until list.size).map { list.getItemAtIndex(it).let { item -> NavigationState.Item(item.url, item.title, item.originalUrl) } }
        assertEquals(entries, urlsOf(NavigationState.snapshotJson(listItems, 3, names)))
        Log.i(TAG, "the saving view: getTitle() '${onMain { source.title }}', the items' titles ${listItems.map { it.title }}")

        val hostState = onMain { NavigationState.hostStateOf(source, private = false) }
        assertNotNull("a list with internal pages in it has a state to give", hostState)
        assertTrue("within the cap: ${hostState!!.length} chars", hostState.length <= NavigationState.HOST_STATE_MAX)
        // The documents are inside the state (saveState pickles each entry's document): what puts
        // a stack with a large internal page over the cap, and has it restore URL-only.
        val documents = READER_HTML.length + HISTORY_HTML.length
        assertTrue("the state carries the documents: ${hostState.length} chars for $documents chars of pages", hostState.length > documents)
        Log.i(TAG, "hostState of a page, a reader page, a page and a history page: ${hostState.length} chars (the documents are $documents)")
        val bundle = NavigationState.bundleOf(NavigationState.decodeHostState(hostState)!!)
        assertNotNull(bundle)

        val fresh = webView()
        var shownRightAfter: String? = null
        val restored = load(fresh) { view -> view.restoreState(bundle!!).also { shownRightAfter = view.url } }
        assertNotNull("restoreState accepts a list with data: documents in it", restored)
        Log.i(TAG, "right after restoreState getUrl() says '$shownRightAfter' for the current internal entry")
        assertEquals(4, restored!!.size)
        assertEquals(3, restored.currentIndex)
        val restoredItems = (0 until restored.size).map { restored.getItemAtIndex(it).url }
        assertEquals("the same items", items, restoredItems)
        assertTrue("the restored list is the one the snapshot describes", NavigationState.restoredMatches(restoredItems, restored.currentIndex, entries, 3))
        // A snapshot that named an internal entry as a web page would not be matched by the document.
        assertFalse(NavigationState.restoredMatches(restoredItems, restored.currentIndex, listOf(PAGES[0], "https://nav-snapshot.test/reader", PAGES[1], HISTORY), 3))
        // The fresh view names the entries the way the snapshot does, each at its position, from
        // its first list on; off nothing, both internal pages would be about:blank.
        val seeded = NavigationState.internalNamesOf(restoredItems, entries)
        assertEquals(names, seeded)
        val restoredListItems = restoredItems.map { NavigationState.Item(it, null, null) }
        assertEquals(entries, urlsOf(NavigationState.snapshotJson(restoredListItems, 3, seeded)))
        assertEquals(listOf(PAGES[0], NavigationState.BLANK_URL, PAGES[1], NavigationState.BLANK_URL), urlsOf(NavigationState.snapshotJson(restoredListItems, 3)))

        // What the bare view says past the restore goes to the log, none of it held: its title
        // at the instant page finished fired (the placeholder in run 5, the display title off
        // the URL), what the document says its title is, the URL the restore's commit was
        // reported under, the list after the commit and its items' titles, and what three
        // Backs bring (the page between, the reader page, the article). The product's view is
        // the one the names and the titles are read from; the demo's scene 8 is its proof.
        Log.i(TAG, "after the restore's page finished: getTitle() '${onMain { fresh.title }}', document.title ${documentTitleOf(fresh)}, getUrl() '${onMain { fresh.url }}', the commit reported under ${committed[fresh]}, the list ${describe(fresh)}")
        runCatching {
            for (step in 1..3) {
                load(fresh) { it.goBack() }
                Log.i(TAG, "Back $step: the list ${describe(fresh)}, getUrl() '${onMain { fresh.url }}', getTitle() '${onMain { fresh.title }}', document.title ${documentTitleOf(fresh)}, the commit reported under ${committed[fresh]?.lastOrNull()}")
            }
        }.onFailure { Log.i(TAG, "the walk back stopped: $it") }

        // The probe: an internal page straight after another. Logged for the record (which entry
        // the fold leaves, under which commit, with which title; and which document that
        // entry's state brings back into a fresh view), nothing asserted: it is WebView's doing,
        // not the snapshot's, and no list of the phone's has the shape.
        runCatching {
            val adjacent = webView()
            load(adjacent) { it.loadUrl(PAGES[0]) }
            load(adjacent) { it.loadDataWithBaseURL(READER, READER_HTML, "text/html", "utf-8", READER) }
            load(adjacent) { it.loadDataWithBaseURL(HISTORY, HISTORY_HTML, "text/html", "utf-8", HISTORY) }
            val folded = onMain { adjacent.copyBackForwardList() }
            val foldedItems = (0 until folded.size).map { folded.getItemAtIndex(it).url }
            Log.i(TAG, "probe, a history page straight after a reader page: ${folded.size} entries, current ${folded.currentIndex}: $foldedItems; the commits ${committed[adjacent]}; title '${onMain { adjacent.title }}'")
            val state = onMain { NavigationState.hostStateOf(adjacent, private = false) }
            val bundle = NavigationState.decodeHostState(state)?.let { NavigationState.bundleOf(it) }
            if (bundle == null) {
                Log.i(TAG, "probe: the folded list gave no state to restore")
            } else {
                val again = webView()
                val back = load(again) { it.restoreState(bundle) }
                Log.i(TAG, "probe, its state restored: ${back?.size} entries, current ${back?.currentIndex}; the commit ${committed[again]}; title '${onMain { again.title }}'")
            }
        }.onFailure { Log.i(TAG, "probe stopped: $it") }
    }

    /**
     * A bundle that is ours by encoding (marshalled, behind the prefix) but not a WebView's
     * state: one that is not shaped like one (two keys; one key of another kind; a Parcelable
     * named in it; nothing in it) is refused by shape and never reaches the WebView; one shaped
     * like a state but not holding one is the WebView's to refuse, and it does, leaving the
     * list empty. What `saveState` writes has the shape.
     */
    @Test
    fun aForeignBundleIsRefusedBeforeTheWebViewOrByIt() {
        val twoKeys = Bundle().apply {
            putString("hello", "world")
            putInt("count", 3)
        }
        val aString = Bundle().apply { putString("state", "not bytes") }
        val aParcelable = Bundle().apply { putBundle("state", Bundle().apply { putInt("inner", 1) }) }
        for ((name, foreign) in listOf("two keys" to twoKeys, "a string" to aString, "a Parcelable" to aParcelable, "nothing" to Bundle())) {
            assertFalse("$name is not a WebView state's shape", NavigationState.isWebViewState(foreign))
            val text = NavigationState.encodeHostState(NavigationState.marshall(foreign))
            assertNotNull(text)
            assertNull("$name: refused before the WebView", NavigationState.bundleOf(NavigationState.decodeHostState(text)!!))
        }

        // The shape without the substance: one key, bytes that are no pickle of the WebView's.
        val shaped = Bundle().apply { putByteArray("WEBVIEW_CHROMIUM_STATE", ByteArray(48) { (it * 13).toByte() }) }
        assertTrue(NavigationState.isWebViewState(shaped))
        val bundle = NavigationState.bundleOf(NavigationState.marshall(shaped))
        assertNotNull("it has the shape: the refusal is the WebView's", bundle)
        val fresh = webView()
        val restored = onMain { fresh.restoreState(bundle!!) }
        assertNull("restoreState returns null for bytes that are not its own", restored)
        assertEquals(0, onMain { fresh.copyBackForwardList().size })

        // And the real thing has the shape.
        val source = webView()
        load(source) { it.loadUrl(PAGES[0]) }
        val saved = Bundle().also { b -> onMain { source.saveState(b) } }
        assertTrue("saveState's bundle: one key, a byte array", NavigationState.isWebViewState(saved))
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
        val empty = webView()
        assertNull("a view with no list has nothing to give", onMain { NavigationState.hostStateOf(empty, private = false) })
    }

    // --- plumbing --------------------------------------------------------------------------------

    /** A WebView serving [PAGES] itself (scripts on, for [documentTitleOf]; the pages carry none); destroyed after the test. */
    private fun webView(): WebView = onMain {
        WebView(app).also { view ->
            view.settings.javaScriptEnabled = true
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

        override fun doUpdateVisitedHistory(view: WebView, rawUrl: String, isReload: Boolean) {
            committed.getOrPut(view) { CopyOnWriteArrayList() } += rawUrl
        }

        override fun onPageFinished(view: WebView, url: String) {
            finished[view]?.countDown()
        }
    }

    /**
     * The URL each view's commits were reported under (`doUpdateVisitedHistory`), in order: for
     * a `loadDataWithBaseURL` document the base URL it was loaded with, by WebView's contract
     * (`NavigationHandleProxy::DidFinish` hands the Java side the base URL where there is one),
     * which is what `TabWebView` names an internal page's position by.
     */
    private val committed = ConcurrentHashMap<WebView, CopyOnWriteArrayList<String>>()

    private fun urlsOf(snapshot: JSONObject): List<String> {
        val entries = snapshot.getJSONArray("entries")
        return (0 until entries.length()).map { entries.getJSONObject(it).getString("url") }
    }

    /** The view's list for the log: its size, the current index, whether Back is open, and the items' titles. */
    private fun describe(view: WebView): String = onMain {
        val list = view.copyBackForwardList()
        "${list.size} entries, current ${list.currentIndex}, canGoBack ${view.canGoBack()}, titles ${(0 until list.size).map { list.getItemAtIndex(it).title }}"
    }

    /** What the page on `view` says its `document.title` is (JSON-quoted, as evaluateJavascript returns it), null when it does not answer in time. */
    private fun documentTitleOf(view: WebView): String? {
        val latch = CountDownLatch(1)
        var answer: String? = null
        instrumentation.runOnMainSync {
            view.evaluateJavascript("document.title") { value ->
                answer = value
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return answer
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
        /** Another internal page over the reader page: two `data:` items in one list, under one and the same URL. */
        private const val HISTORY = "zen://history"
        private const val HISTORY_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>History</title></head><body><h1>History</h1><p>Today.</p></body></html>"
    }
}
