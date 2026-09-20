package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records the navigation snapshot on the phone (the ask of #207: a tab brought back by Undo lost
 * its back/forward stack), every press a real touch and every outcome read off the host's
 * WebView, the core's state or the page server, never off the chrome's word:
 *
 *  1. a three-page stack built with two touches on the pages' links: the host's list holds the
 *     three entries with the third current, the core reads the same list synchronously, the
 *     `hostState` for it is there and under the 64 KB cap, each page was fetched once;
 *  2. the tab closed from the Tabs button's quick menu (a hold, then a touch on Close Tab): the
 *     tab is gone at once and the toast reads `Closed Page three` with Undo;
 *  3. Undo touched: the tab is back and active on page three, the host answered
 *     `restored: true` (the list was rebuilt from `hostState`, not loaded), the list has its
 *     three entries again, and page three came back without a request to the server;
 *  4. Back touched twice on the bar: page two, then page one, each without a request (the
 *     WebView's history navigation serves them from its cache), the list standing at its first
 *     entry with two forward entries;
 *  5. the design gate: a hold on the bar's Back button opens the bar editor – the phone has no
 *     long-press history list (that is the desktop's) – so the full stack is read from the core
 *     (`tab.navigationEntries`, what such a list would draw) and nothing new is built here;
 *  6. a `zen://` page as the current entry: the tab goes on to an article and into Reader View
 *     (`zen://reader?…`, the chrome's own document in the WebView's list as a `data:` item), is
 *     closed from the quick menu and brought back with Undo: the host answered `restored: true`,
 *     the restore was one `navigated` (no second copy of the page loaded on top), the URL shown
 *     is the virtual one, the list has its three entries under their names, nothing was fetched;
 *     then Back brings the article without a request;
 *  7. a same-document entry as the current one: on the article, `history.pushState` puts `#x`
 *     on top of the list with no load of its own (the commit the host hears of in
 *     `doUpdateVisitedHistory` alone, where the list and the state are refreshed), the tab is
 *     closed from the quick menu and brought back with Undo: `restored: true`, one `navigated`,
 *     the list with `#x` current, nothing fetched;
 *  8. two internal pages in one list: from the article at `#x` the tab goes into Reader View,
 *     on to a second article and into Reader View again – two `data:` items in the WebView's
 *     list, both under one and the same item URL, the case that named the older one after the
 *     newer until the names went by position – is closed from the quick menu and brought back
 *     with Undo: `restored: true`, one `navigated`, the top reader page's virtual URL shown,
 *     the six entries with both reader pages under their own names in the host's and the core's
 *     lists, nothing fetched; then Back lands on the second article, on the first reader page
 *     under its name, and on the article at `#x`, none of it fetched.
 *
 * Across all of it the chrome's view events are watched for a `crashed` (the state is now
 * taken inside the WebView's own callbacks): none is the last check.
 *
 * The pages come from a loopback server inside this process ([DemoServer]) with `max-age`
 * caching, so a page coming back without a request can be told from one fetched again
 * ([DemoServer.hits]). Findings go to `nav-snapshot-findings.txt` next to the stills (one PASS
 * or FAIL per claim, ALL CHECKS PASSED at the end); the run fails on any FAIL. Profile
 * `nav-snapshot-demo-state.json`: the Work space with `tab_other` and `tab_demo` (active, on
 * page one). Driven by `android-nav-snapshot-demo.yml`. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class NavSnapshotDemo : DemoHarness("nav-snapshot-demo-state.json", "nav-snapshot", "nav-snapshot-demo") {
    override val tag = "NavSnapshotDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/one.html" to DemoServer.page("Page one", "<p id=\"next\"><a href=\"/two.html\">On to page two</a></p>${tint("#e3f2fd")}"),
                "/two.html" to DemoServer.page("Page two", "<p id=\"next\"><a href=\"/three.html\">On to page three</a></p>${tint("#e8f5e9")}"),
                "/three.html" to DemoServer.page("Page three", "<p>The top of a three-page stack.</p>${tint("#fff3e0")}"),
                "/article.html" to DemoServer.page(ARTICLE_TITLE, ARTICLE_BODY),
                "/article2.html" to DemoServer.page(ARTICLE2_TITLE, ARTICLE2_BODY),
                "/other.html" to DemoServer.page("Another tab", "<p>Stays open while the demo's tab is closed.</p>")
            ),
            cacheable = setOf("/one.html", "/two.html", "/three.html", "/article.html", "/article2.html")
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) error("$failures check(s) failed; see nav-snapshot-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "nav-snapshot-findings.txt")
        findings.writeText(
            "Zenium Android navigation snapshot checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded(ONE)
        SystemClock.sleep(2_000)
        calibrate()
        finding("start: ${describeActive()}")
    }

    override fun demo() {
        expect("the chrome's view events can be watched (navigated per tab, crashed anywhere)", watchViewEvents())
        still("page-one")
        buildStack()
        closeFromQuickMenu()
        undoRestores()
        backTwice()
        holdOnBack()
        internalPageUndo()
        sameDocumentUndo()
        twoInternalPagesUndo()
        still("end")
        expect("no view crashed across the scenes (the state taken inside the WebView's callbacks): ${crashes()} crashed event(s)", crashes() == 0)
        finding("\nend: ${describeActive()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** 1. Two touches on the pages' links: a three-page stack, known to the host and the core. */
    private fun buildStack() {
        finding("\n1. A three-page stack from two touches on the pages' links")
        tapPage("#next a")
        expect("page two loads", awaitLoaded(TWO))
        SystemClock.sleep(1_500)
        tapPage("#next a")
        expect("page three loads", awaitLoaded(THREE))
        settle()
        val list = hostList()
        expect("the host's list holds one, two, three with the third current: ${describe(list)}", urlsOf(list) == listOf(ONE, TWO, THREE) && list?.optInt("index") == 2)
        val core = coreList()
        expect("the core reads the same list synchronously: ${describe(core)}", urlsOf(core) == listOf(ONE, TWO, THREE) && core.optInt("index") == 2)
        val hostState = onMain { host.tabs.get(TAB)?.hostState() }
        expect("the hostState for it is there and under the cap (${hostState?.length ?: 0} chars of ${NavigationState.HOST_STATE_MAX})", hostState != null && hostState.length <= NavigationState.HOST_STATE_MAX)
        expect("each page was fetched once (${hitsLine()})", hits() == listOf(1, 1, 1, 0, 0))
        still("stack-of-three")
    }

    /** 2. A hold on the Tabs button, a touch on Close Tab: the tab goes, the toast offers Undo. */
    private fun closeFromQuickMenu() {
        finding("\n2. Close Tab from the Tabs button's quick menu")
        closeActiveTabFromQuickMenu("Closed Page three", "quick-menu")
        still("closed-toast")
    }

    /**
     * The touches that close the active tab ([TAB]): a hold on the Tabs button for its quick
     * menu (a still of it as `menuStill`), a touch on Close Tab; then the toast, which has to
     * read `toastText` and offer Undo, and another tab on screen. The host's mirror of the tab's
     * state is described as the tab goes: what the core is about to pick up for the snapshot,
     * and how long ago the view refreshed it.
     */
    private fun closeActiveTabFromQuickMenu(toastText: String, menuStill: String) {
        val tabs = tabsButton() ?: error("no Tabs button on the bar")
        val opened = holdUntil(tabs, "the Tabs button") { inDom(QUICK_MENU) }
        expect("a hold on Tabs opens its quick menu", opened)
        // The menu pops in over a few frames: the still once its rows are at rest.
        val closeTab = steadyRect { textRect("$QUICK_MENU-item", "Close Tab") }
        still(menuStill)
        finding("  ${mirrorLine()}")
        val closed = touchUntil("Close Tab in the quick menu", { closeTab ?: steadyRect { textRect("$QUICK_MENU-item", "Close Tab") } }, { !tabExists(TAB) })
        expect("the touch on Close Tab closes the tab at once", closed)
        val toast = awaitToast("Closed ")
        expect("the toast reads '$toastText' with Undo: '${toast.orEmpty()}'", toast == toastText && awaitRect({ undoRect() }, 3_000) != null)
        expect("another tab is on screen meanwhile: ${activeTabId()}", activeTabId() == OTHER)
    }

    /** The host's mirror of the demo tab's state at this moment: its size and its age, or its absence. */
    private fun mirrorLine(): String {
        val state = host.navigation.hostState(TAB)
        val age = host.navigation.stateAge(TAB)
        return if (state == null || age == null) "the host's mirror holds no state for the tab"
        else "the host's mirror holds the tab's state: ${state.length} chars, refreshed $age ms ago"
    }

    /** 3. Undo: the tab comes back with its list rebuilt from the host's state, page three from the cache. */
    private fun undoRestores() {
        finding("\n3. Undo on the toast")
        val before = hits()
        expect("the touch on Undo takes", undo())
        expect("the tab is back", awaitTab(TAB, exists = true))
        expect("and active", awaitUntil(8_000) { activeTabId() == TAB })
        expect("on page three", awaitLoaded(THREE))
        settle()
        val restored = onMain { host.tabs.get(TAB)?.lastRestore }
        expect("the host answered restored: true (the list rebuilt from hostState, nothing loaded by the core)", restored == true)
        val list = hostList()
        expect("the host's list holds the three entries again, the third current: ${describe(list)}", urlsOf(list) == listOf(ONE, TWO, THREE) && list?.optInt("index") == 2)
        val core = coreList()
        expect("so does the core's: ${describe(core)}", urlsOf(core) == listOf(ONE, TWO, THREE) && core.optInt("index") == 2)
        expect("page three came back without a request (${hitsLine()})", hits() == before)
        still("undone")
        awaitToastGone()
    }

    /** 4. Back twice, real touches on the bar: pages two and one come back without a request. */
    private fun backTwice() {
        finding("\n4. Back twice on the bar")
        val before = hits()
        expect("the first Back brings page two", pressBack(TWO))
        SystemClock.sleep(1_500)
        still("back-to-two")
        expect("the second Back brings page one", pressBack(ONE))
        SystemClock.sleep(1_500)
        still("back-to-one")
        expect("neither page was fetched again (${hitsLine()})", hits() == before)
        val list = hostList()
        expect("the list stands at its first entry with two forward entries: ${describe(list)}", urlsOf(list) == listOf(ONE, TWO, THREE) && list?.optInt("index") == 0)
        val forward = onMain { host.tabs.get(TAB)?.canGoForward() }
        expect("the WebView can go forward", forward == true)
    }

    /** 5. The design gate: a hold on Back opens the bar editor; the phone has no long-press history list. */
    private fun holdOnBack() {
        finding("\n5. Design gate: a hold on the bar's Back button")
        val back = backButton() ?: error("no Back button on the bar")
        val editor = holdUntil(back, "the Back button") { inDom(BAR_EDITOR) }
        finding(
            if (editor) "  a hold on Back opens the bar editor ('In the bar'), as a hold on any bar button does: the phone has no long-press history list (the desktop's); none is built here (separate row)"
            else "  a hold on Back opened nothing the driver knows (no bar editor, no list): the phone has no long-press history list; none is built here (separate row)"
        )
        // The editor is a sheet on its way up when its heading enters the DOM: the still once it rests.
        if (editor) {
            steadyRect { domRect(BAR_EDITOR) }
            SystemClock.sleep(800)
        }
        still("hold-on-back")
        val core = coreList()
        expect("the full stack such a list would draw is in the core: ${describe(core)}", urlsOf(core) == listOf(ONE, TWO, THREE) && core.optInt("index") == 0)
        if (editor) {
            back()
            expect("the system back closes the editor", awaitDom("!document.querySelector('$BAR_EDITOR')", 8_000))
            SystemClock.sleep(1_000)
        }
    }

    /**
     * 6. A `zen://` page as the current entry. The tab (on page one, two forward entries) goes on
     * to the article and into Reader View through the core (`tab.navigate`, `reader.toggle`: the
     * page that is under test is the internal one, not the way there), which puts the chrome's
     * document in the WebView's list as a `data:` item shown as `zen://reader?…`. Then the
     * touches: Close Tab from the quick menu, Undo on the toast, Back on the bar. Undo has to be
     * one restore and nothing on top of it: were the host to answer `restored: false` with the
     * list already rebuilt, the core's `loadURL` -> `loadHtml` would land a second copy of the
     * page (a fourth entry, a second `navigated`, the shown URL the `data:` one on the way).
     */
    private fun internalPageUndo() {
        finding("\n6. A zen:// page (Reader View) as the current entry: close, Undo, Back")
        coreInvoke("tab.navigate", JSONObject().put("tabId", TAB).put("input", ARTICLE).toString())
        expect("the article loads", awaitLoaded(ARTICLE))
        SystemClock.sleep(1_500)
        var list = hostList()
        expect("the list is page one and the article, the article current (the forward entries gone): ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE) && list?.optInt("index") == 1)
        val fetched = hits()

        coreInvoke("reader.toggle", JSONObject().put("tabId", TAB).toString())
        val entered = awaitLoadedWhere { it.startsWith(READER_PREFIX) }
        val reader = onMain { host.tabs.get(TAB)?.url }.orEmpty()
        expect("Reader View opens as the current entry, shown as $reader", entered && reader.startsWith(READER_PREFIX))
        settle()
        list = hostList()
        expect("the host's list names it by that URL, third of three: ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE, reader) && list?.optInt("index") == 2)
        val core = coreList()
        expect("so does the core's: ${describe(core)}", urlsOf(core) == listOf(ONE, ARTICLE, reader) && core.optInt("index") == 2)
        val hostState = onMain { host.tabs.get(TAB)?.hostState() }
        expect("the hostState for it, the reader document inside, is there and under the cap (${hostState?.length ?: 0} chars of ${NavigationState.HOST_STATE_MAX})", hostState != null && hostState.length <= NavigationState.HOST_STATE_MAX)
        expect("the reader page fetched nothing (${hitsLine()})", hits() == fetched)
        still("reader-view")

        closeActiveTabFromQuickMenu("Closed $ARTICLE_TITLE", "reader-quick-menu")
        val navigatedBefore = navigations()
        expect("the touch on Undo takes", undo())
        expect("the tab is back", awaitTab(TAB, exists = true))
        expect("and active", awaitUntil(8_000) { activeTabId() == TAB })
        expect("on the reader page", awaitLoadedWhere { it.startsWith(READER_PREFIX) })
        settle()
        val restored = onMain { host.tabs.get(TAB)?.lastRestore }
        expect("the host answered restored: true (the list rebuilt from hostState, the internal entry matched by its document)", restored == true)
        val navigated = navigations() - navigatedBefore
        expect("the restore was one navigated event for the tab, no second copy of the page: $navigated (${navigationUrls()})", navigated == 1)
        val shown = onMain { host.tabs.get(TAB)?.url }
        expect("the URL shown is the virtual one: $shown", shown == reader)
        expect("and the core's tab is on it: ${activeCoreTab()?.optString("url")}", activeCoreTab()?.optString("url") == reader)
        list = hostList()
        expect("the host's list is the same three entries under their names, the reader page current: ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE, reader) && list?.optInt("index") == 2)
        val coreAfter = coreList()
        expect("so is the core's: ${describe(coreAfter)}", urlsOf(coreAfter) == listOf(ONE, ARTICLE, reader) && coreAfter.optInt("index") == 2)
        expect("nothing was fetched for the restore (${hitsLine()})", hits() == fetched)
        still("reader-undone")
        awaitToastGone()

        expect("Back brings the article", pressBack(ARTICLE))
        SystemClock.sleep(1_500)
        expect("without a request (${hitsLine()})", hits() == fetched)
        list = hostList()
        expect("the list stands at the article with the reader page ahead: ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE, reader) && list?.optInt("index") == 1)
        still("back-to-article")
    }

    /**
     * 7. A same-document entry as the current one. On the article (the reader entry ahead of
     * it), `history.pushState` puts `…/article.html#x` on top of the list, the entry ahead goes,
     * and nothing loads: no `onPageStarted`, the commit heard of in `doUpdateVisitedHistory`
     * alone, where the host refreshes the list and the state behind it before the `navigated`
     * the core records them on. Close Tab and Undo then have to bring the list back with `#x`
     * current: the state the core took at close time was the one of that commit.
     */
    private fun sameDocumentUndo() {
        finding("\n7. A pushState entry as the current one: close, Undo")
        val fetched = hits()
        tabJs("history.pushState({}, '', ${JSONObject.quote("/article.html#x")})")
        expect("the page takes the new URL in place", awaitLoaded(ARTICLE_X))
        settle()
        var list = hostList()
        expect("the host's list is page one, the article and the article at #x, the third current (the reader entry ahead gone): ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE, ARTICLE_X) && list?.optInt("index") == 2)
        val core = coreList()
        expect("so is the core's: ${describe(core)}", urlsOf(core) == listOf(ONE, ARTICLE, ARTICLE_X) && core.optInt("index") == 2)
        expect("nothing was fetched for it (${hitsLine()})", hits() == fetched)
        val title = activeCoreTab()?.optString("title").orEmpty()

        closeActiveTabFromQuickMenu("Closed $title", "pushstate-quick-menu")
        val navigatedBefore = navigations()
        expect("the touch on Undo takes", undo())
        expect("the tab is back", awaitTab(TAB, exists = true))
        expect("and active", awaitUntil(8_000) { activeTabId() == TAB })
        expect("on the article at #x", awaitLoaded(ARTICLE_X))
        settle()
        val restored = onMain { host.tabs.get(TAB)?.lastRestore }
        expect("the host answered restored: true (the same-document entry was in the state taken at its commit)", restored == true)
        val navigated = navigations() - navigatedBefore
        expect("the restore was one navigated event for the tab: $navigated (${navigationUrls()})", navigated == 1)
        list = hostList()
        expect("the host's list is the three entries again with #x current: ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE, ARTICLE_X) && list?.optInt("index") == 2)
        val coreAfter = coreList()
        expect("so is the core's: ${describe(coreAfter)}", urlsOf(coreAfter) == listOf(ONE, ARTICLE, ARTICLE_X) && coreAfter.optInt("index") == 2)
        expect("the article came back without a request (${hitsLine()})", hits() == fetched)
        still("pushstate-undone")
        awaitToastGone()
    }

    /**
     * 8. Two internal pages in one list. From the article at `#x` the tab goes into Reader View
     * (`reader.toggle`: the first internal page), on to a second article (`tab.navigate`) and
     * into Reader View again (the second, on top): two `data:` items in the WebView's list, and
     * WebView gives both one and the same item URL (the `data:` header, nothing behind the
     * comma), which is what run 3's WebView test found and what named the older page after the
     * newer while the names went by item URL; they go by position now. So: both reader pages
     * under their own names in the host's list and the core's, before and after Close Tab and
     * Undo (`restored: true`, one `navigated`, the top page's virtual URL shown, nothing
     * fetched), and Back on the bar landing on the second article, on the first reader page
     * under its name, and on the article at `#x`, none of it fetched.
     */
    private fun twoInternalPagesUndo() {
        finding("\n8. Two internal pages (two Reader View pages) in one list: close, Undo, Back")
        var fetched = hits()
        coreInvoke("reader.toggle", JSONObject().put("tabId", TAB).toString())
        expect("Reader View of the article at #x opens as the current entry", awaitLoadedWhere { it.startsWith(READER_PREFIX) })
        val first = onMain { host.tabs.get(TAB)?.url }.orEmpty()
        settle()
        var list = hostList()
        expect("the host's list is page one, the article, the article at #x and the reader page, the reader page current: ${describe(list)}", urlsOf(list) == listOf(ONE, ARTICLE, ARTICLE_X, first) && list?.optInt("index") == 3)
        expect("the reader page fetched nothing (${hitsLine()})", hits() == fetched)

        coreInvoke("tab.navigate", JSONObject().put("tabId", TAB).put("input", ARTICLE2).toString())
        expect("the second article loads", awaitLoaded(ARTICLE2))
        SystemClock.sleep(1_500)
        expect("fetched once (${hitsLine()})", hits() == fetched.toMutableList().also { it[4] = it[4] + 1 })
        fetched = hits()
        coreInvoke("reader.toggle", JSONObject().put("tabId", TAB).toString())
        expect("Reader View of the second article opens as the current entry", awaitLoadedWhere { it.startsWith(READER_PREFIX) && it != first })
        val second = onMain { host.tabs.get(TAB)?.url }.orEmpty()
        settle()
        expect("the two reader pages are two pages: $first and $second", first != second && first.startsWith(READER_PREFIX) && second.startsWith(READER_PREFIX))
        val stack = listOf(ONE, ARTICLE, ARTICLE_X, first, ARTICLE2, second)
        list = hostList()
        expect("the host's list holds the six entries, both reader pages under their own names, the second current: ${describe(list)}", urlsOf(list) == stack && list?.optInt("index") == 5)
        val core = coreList()
        expect("so does the core's: ${describe(core)}", urlsOf(core) == stack && core.optInt("index") == 5)
        val hostState = onMain { host.tabs.get(TAB)?.hostState() }
        expect("the hostState for it, both reader documents inside, is there and under the cap (${hostState?.length ?: 0} chars of ${NavigationState.HOST_STATE_MAX})", hostState != null && hostState.length <= NavigationState.HOST_STATE_MAX)
        expect("the second reader page fetched nothing (${hitsLine()})", hits() == fetched)
        still("two-readers")

        val title = activeCoreTab()?.optString("title").orEmpty()
        closeActiveTabFromQuickMenu("Closed $title", "two-readers-quick-menu")
        val navigatedBefore = navigations()
        expect("the touch on Undo takes", undo())
        expect("the tab is back", awaitTab(TAB, exists = true))
        expect("and active", awaitUntil(8_000) { activeTabId() == TAB })
        expect("on the second reader page", awaitLoaded(second))
        settle()
        val restored = onMain { host.tabs.get(TAB)?.lastRestore }
        expect("the host answered restored: true (the list rebuilt from hostState, both internal entries matched by their documents)", restored == true)
        val navigated = navigations() - navigatedBefore
        expect("the restore was one navigated event for the tab, no second copy of a page: $navigated (${navigationUrls()})", navigated == 1)
        val shown = onMain { host.tabs.get(TAB)?.url }
        expect("the URL shown is the top entry's virtual one: $shown", shown == second)
        list = hostList()
        expect("the host's list is the six entries again, both reader pages under their own names, the second current: ${describe(list)}", urlsOf(list) == stack && list?.optInt("index") == 5)
        val coreAfter = coreList()
        expect("so is the core's: ${describe(coreAfter)}", urlsOf(coreAfter) == stack && coreAfter.optInt("index") == 5)
        expect("nothing was fetched for the restore (${hitsLine()})", hits() == fetched)
        still("two-readers-undone")
        awaitToastGone()

        expect("Back brings the second article", pressBack(ARTICLE2))
        SystemClock.sleep(1_500)
        expect("Back again brings the first reader page, under its name", pressBack(first))
        SystemClock.sleep(1_500)
        list = hostList()
        expect("the list stands at the first reader page with two entries ahead: ${describe(list)}", urlsOf(list) == stack && list?.optInt("index") == 3)
        expect("and the core's tab is on it: ${activeCoreTab()?.optString("url")}", activeCoreTab()?.optString("url") == first)
        still("back-to-first-reader")
        expect("Back once more brings the article at #x", pressBack(ARTICLE_X))
        SystemClock.sleep(1_500)
        expect("none of it fetched (${hitsLine()})", hits() == fetched)
        list = hostList()
        expect("the list stands at the article at #x with three entries ahead: ${describe(list)}", urlsOf(list) == stack && list?.optInt("index") == 2)
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * A real touch on Back that has to bring `url`: the touch is made again when the page did not
     * change, and a touch read as a hold (the bar editor coming up instead) is taken back first.
     */
    private fun pressBack(url: String): Boolean {
        for (attempt in 1..TOUCH_ATTEMPTS) {
            val back = backButton() ?: run {
                finding("  (no Back button to touch)")
                return false
            }
            touch(back, "Back on the bar")
            if (awaitLoaded(url, 12_000)) return true
            if (inDom(BAR_EDITOR)) {
                finding("  (the touch on Back was read as a hold: the bar editor is up; dismissed)")
                back()
                awaitDom("!document.querySelector('$BAR_EDITOR')", 6_000)
                SystemClock.sleep(800)
            }
            if (attempt < TOUCH_ATTEMPTS) finding("  (the touch on Back did not take, attempt $attempt: touching again)")
        }
        return false
    }

    /**
     * A real touch on the middle of `box` (screen px), logged: the finger's down and up a frame
     * apart, so a long task on the main thread between them cannot turn the tap into a hold.
     */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
    }

    /** A touch that has to take: touched where `read` finds it, `took` watched, again when nothing came of it. */
    private fun touchUntil(what: String, read: () -> Rect?, took: () -> Boolean, attempts: Int = TOUCH_ATTEMPTS, waitMs: Long = TOUCH_TOOK_WAIT): Boolean {
        for (attempt in 1..attempts) {
            val box = read() ?: run {
                finding("  ($what is not there to touch)")
                return took()
            }
            if (touchPoint(box) == null) {
                finding("  ($what is off the screen at $box, attempt $attempt)")
                SystemClock.sleep(STEADY_MS)
                continue
            }
            touch(box, what)
            if (awaitUntil(waitMs, took)) return true
            if (attempt < attempts) finding("  (the touch on $what did not take, attempt $attempt: touching again)")
        }
        return took()
    }

    /**
     * A real hold on the middle of `box`: the finger down until `took` holds (the chrome's hold
     * fires at 400 ms; the emulator's main thread may lag) or [HOLD_MAX] has passed, then up.
     * The release's click is the chrome's to swallow.
     */
    private fun holdUntil(box: Rect, what: String, took: () -> Boolean): Boolean {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  hold at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        val held = awaitUntil(HOLD_MAX, took)
        f.hold(200)
        f.up()
        if (!held) return awaitUntil(1_500, took)
        return true
    }

    /** Touch the toast's Undo once the toast is at rest; the toast leaving or the tab back is the touch taking. */
    private fun undo(): Boolean {
        if (awaitRect({ undoRect() }, 6_000) == null) {
            finding("  the toast's Undo never showed")
            return false
        }
        awaitDom("(function(){var e=document.querySelector('.zen-message-toast');return !!e&&!e.hasAttribute('data-moving')})()", 1_500)
        return touchUntil("the toast's Undo", { undoRect() }, { toastLeavingOrGone() || tabExists(TAB) }, waitMs = UNDO_TOOK_WAIT)
    }

    private fun tabsButton(): Rect? =
        findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
            ?: domRect("[aria-label^=\"Tabs (\"]")

    private fun backButton(): Rect? = domRect("[data-bar-item=\"back\"]") ?: findByLabel("Back")

    // --- where things are: the chrome's DOM ----------------------------------------------------

    private var originX = 0f
    private var originY = 0f

    /** A JS expression's string result in the chrome ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    private fun rectFrom(text: String): Rect? {
        if (text.isEmpty()) return null
        val o = JSONObject(text)
        val d = o.getDouble("d")
        return Rect(
            (o.getDouble("l") * d + originX).roundToInt(),
            (o.getDouble("t") * d + originY).roundToInt(),
            (o.getDouble("r") * d + originX).roundToInt(),
            (o.getDouble("b") * d + originY).roundToInt()
        )
    }

    /** The on-screen box of the first element `selector` matches, null when nothing does. */
    private fun domRect(selector: String): Rect? =
        rectFrom(jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';$RECT_JS})()"))

    /** The box of the first element matching `selector` whose text starts with `prefix`. */
    private fun textRect(selector: String, prefix: String): Rect? =
        rectFrom(
            jsString(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return '';$RECT_JS})()"
            )
        )

    /** A box read from the DOM once two reads [STEADY_MS] apart agree (a menu popping in moves on each frame). */
    private fun steadyRect(read: () -> Rect?): Rect? {
        var last = awaitRect(read, LOOKUP_WAIT) ?: return null
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(STEADY_MS)
            val again = read() ?: return last
            if (again == last) return again
            last = again
        }
        return last
    }

    private fun undoRect(): Rect? = domRect(".zen-message-toast .zen-message-button")

    private fun toastLeavingOrGone(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-message-toast');return !e||e.hasAttribute('data-moving')?'yes':''})()") == "yes"

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    private fun awaitRect(read: () -> Rect?, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitUntil(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

    /** The toast's text once one starting with `prefix` is up; null when none comes in time. */
    private fun awaitToast(prefix: String, timeoutMs: Long = 8_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val text = jsString("(function(){var e=document.querySelector('.zen-message-toast .zen-message-text');return e?e.textContent:''})()")
            if (text.startsWith(prefix)) return text
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(150)
        }
    }

    private fun awaitToastGone() {
        if (!awaitDom("!document.querySelector('.zen-message-toast')", 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    /**
     * Check the DOM's coordinates against the accessibility tree once, on the bar's Back button,
     * which does not move; an offset (a chrome not at the window's origin) applies to every box
     * read from the DOM from then on.
     */
    private fun calibrate() {
        val fromDom = domRect("[data-bar-item=\"back\"]") ?: return
        val fromTree = waitFor("Back", 4_000) ?: return
        val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
        val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
        finding("coordinates: Back button at $fromDom from the DOM, $fromTree from the accessibility tree (offset ${dx.roundToInt()}, ${dy.roundToInt()})")
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            originX = dx
            originY = dy
        }
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    /** A real touch on the page element `selector` (a link). */
    private fun tapPage(selector: String) {
        val p = pagePoint(selector) ?: run {
            finding("  (nothing matches $selector on the page)")
            return
        }
        finding("  touch at ${p.x.roundToInt()},${p.y.roundToInt()} on the page's $selector")
        Finger().tap(p.x, p.y)
    }

    /** Whether the demo tab's WebView comes to show `url`, loaded, in time. */
    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000): Boolean = awaitLoadedWhere(timeoutMs) { it == url }

    /** Whether the demo tab's WebView comes to show a URL `accepted` takes, loaded, in time. */
    private fun awaitLoadedWhere(timeoutMs: Long = 20_000, accepted: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { host.tabs.get(TAB).let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (accepted(current) && progress == 100) return true
            last = current
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for a page; the tab shows '$last'")
        return false
    }

    /**
     * Watch the view events the host delivers to the chrome from now on (a wrapper on
     * `__zenHost.viewEvent`, which the chrome's core hears through): the `navigated` events of
     * the demo tab other than in-page ones, and a `crashed` from any tab; true once it is in
     * place. What [navigations], [navigationUrls] and [crashes] read.
     */
    private fun watchViewEvents(): Boolean = jsString(
        "(function(){if(window.__demoNav)return 'yes';var h=window.__zenHost;if(!h||typeof h.viewEvent!=='function')return '';" +
            "var orig=h.viewEvent;window.__demoNav=[];window.__demoCrashed=[];h.viewEvent=function(tabId,name,json){" +
            "if(name==='navigated'&&tabId===${JSONObject.quote(TAB)}){try{var p=JSON.parse(json);if(!p.inPage)window.__demoNav.push(String(p.url))}catch(e){}}" +
            "if(name==='crashed'){window.__demoCrashed.push(String(tabId))}" +
            "return orig.call(h,tabId,name,json)};return 'yes'})()"
    ) == "yes"

    /** How many document navigations the chrome has heard of for the demo tab since [watchViewEvents]. */
    private fun navigations(): Int = jsString("(function(){return String((window.__demoNav||[]).length)})()").toIntOrNull() ?: -1

    /** How many `crashed` events the chrome has heard of, from any tab, since [watchViewEvents] (-1 when it cannot be read). */
    private fun crashes(): Int = jsString("(function(){return String((window.__demoCrashed||[]).length)})()").toIntOrNull() ?: -1

    /** The URLs of those navigations, newest last, for the findings. */
    private fun navigationUrls(): String =
        jsString("(function(){return (window.__demoNav||[]).map(function(u){return u.length>60?u.slice(0,60)+'…':u}).join(' | ')})()")

    /** The host's list for the demo tab (`navigationEntries()` on its WebView), null without a WebView. */
    private fun hostList(): JSONObject? = onMain { host.tabs.get(TAB)?.navigationEntries() }

    /** The core's list for the demo tab (`tab.navigationEntries`: the host's, read synchronously). */
    private fun coreList(): JSONObject = JSONObject(coreInvoke("tab.navigationEntries", JSONObject().put("tabId", TAB).toString()))

    private fun urlsOf(list: JSONObject?): List<String> {
        val entries = list?.optJSONArray("entries") ?: return emptyList()
        return (0 until entries.length()).map { entries.getJSONObject(it).optString("url") }
    }

    private fun describe(list: JSONObject?): String =
        if (list == null) "no list" else "${urlsOf(list).map { it.substringAfterLast('/') }} at ${list.optInt("index", -1)}"

    /** The server's requests so far for pages one, two, three and the two articles. */
    private fun hits(): List<Int> =
        listOf(server.hits("/one.html"), server.hits("/two.html"), server.hits("/three.html"), server.hits("/article.html"), server.hits("/article2.html"))

    private fun hitsLine(): String = hits().let { "one ${it[0]}, two ${it[1]}, three ${it[2]}, article ${it[3]}, article2 ${it[4]}" }

    // --- the core's state ------------------------------------------------------------------------

    private fun tabExists(tabId: String): Boolean = coreState().getJSONObject("tabs").has(tabId)

    private fun awaitTab(tabId: String, exists: Boolean, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { tabExists(tabId) == exists }

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${coreState().getJSONObject("tabs").length()} tabs; ${hitsLine()}" }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $label ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `nav-snapshot-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val PORT = 18131
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val ONE = "$ORIGIN/one.html"
        private const val TWO = "$ORIGIN/two.html"
        private const val THREE = "$ORIGIN/three.html"
        private const val ARTICLE = "$ORIGIN/article.html"
        /** The article's same-document entry (`history.pushState`), scene 7. */
        private const val ARTICLE_X = "$ARTICLE#x"
        /** Where the core's Reader View pages live (`zen://reader?id=…&url=…`). */
        private const val READER_PREFIX = "zen://reader"
        private const val ARTICLE_TITLE = "The long read"
        /** Enough of an article for Readability to make a reader page of it (its threshold is 500 characters of text). */
        private val ARTICLE_BODY = """
            <article>
            <p>The Undo on a closed tab's toast used to bring the page back on its own, without the pages behind it: a tab restored by Undo or from Recently closed had no back/forward stack, because the core kept only the URL of the page on screen and the WebView that showed it was gone.</p>
            <p>The navigation snapshot changes that. The host keeps the WebView's list current for the core with every commit, hands over the state a fresh WebView rebuilds the whole list from when the core records a stack, and rebuilds it on the way back, so the pages behind the one on screen are there again and come back without a request.</p>
            <p>A page of the chrome's own, like this reader page, sits in that list as its document rather than as an address on the network. Restored, it has to be one document under its own name, not a second copy loaded on top of the first, which is what this scene watches for.</p>
            <p>The pages here are served from inside the test process and may be cached for an hour, so a page coming back from the list can be told from one fetched again.</p>
            </article>${tint("#f3e5f5")}
        """.trimIndent()
        /** A second article, for a second reader page in the same list (scene 8). */
        private const val ARTICLE2 = "$ORIGIN/article2.html"
        private const val ARTICLE2_TITLE = "The second read"
        private val ARTICLE2_BODY = """
            <article>
            <p>Two of the chrome's own pages can sit in one tab's list: an article read in Reader View, then another, read the same way. The WebView keeps each as its document under a data URL, and it gives both items one and the same URL, the header of the data they were loaded under with nothing behind its comma.</p>
            <p>So the host cannot tell the two items apart by what the list says of them. It names them by where they are: the URL the page was shown as, at the position the commit put it, kept as long as that position holds such an item, and taken from the snapshot when the list is rebuilt for a tab brought back with Undo.</p>
            <p>Before that, the names went by the item's URL, and the two pages shared one: the older took the newer's name, and a stack with two reader pages came back with the wrong one behind the first Back. This scene is the check that each page is under its own name, before the tab is closed and after it is brought back.</p>
            <p>Like the first article, this one is served from inside the test process and may be cached, so a page coming back from the list can be told from one fetched again.</p>
            </article>${tint("#e0f7fa")}
        """.trimIndent()
        private const val TAB = "tab_demo"
        private const val OTHER = "tab_other"
        private const val QUICK_MENU = ".zen-quick-menu"
        /** The bar editor's heading: what a hold on any bar button but Tabs opens. */
        private const val BAR_EDITOR = ".zen-bar-heading"
        private const val POLL_MS = 200L
        private const val STEADY_MS = 350L
        private const val LOOKUP_WAIT = 8_000L
        private const val MAX_OFFSET = 200f
        private const val TOUCH_ATTEMPTS = 4
        private const val TAP_HOLD_MS = 16L
        private const val TOUCH_TOOK_WAIT = 1_500L
        private const val UNDO_TOOK_WAIT = 650L
        /** The chrome's hold fires at 400 ms; the finger stays down this long at most for it to. */
        private const val HOLD_MAX = 4_000L
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"

        /** A page's own background, so the recording tells the three apart. */
        private fun tint(color: String) = "<style>body{background:$color}</style>"
    }
}
