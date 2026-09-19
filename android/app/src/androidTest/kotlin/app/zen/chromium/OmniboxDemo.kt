package app.zen.chromium

import android.content.ClipboardManager
import android.content.Context
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The phone omnibox against Chrome for Android, under a REAL finger (UiAutomation injects the
 * touches; the WebView hit-tests them as a finger's), for the `android-omnibox-demo` workflow:
 *
 *  1. OMN-05: the pill on a page opens search-ready – the page's title and address in a header
 *     row over the suggestions with Share, Copy link and Edit; Copy link puts the address on the
 *     clipboard (read back here), Share opens the system sheet, Edit fills the field with the
 *     whole address, caret at its end, keyboard still up. OMN-25: the field's URL keyboard
 *     attributes, read from the DOM.
 *  2. OMN-09: a typed query lists the engine's suggestions with a Refine arrow each; a touch on
 *     one puts that row's text into the field and submits nothing – the tab stays where it was,
 *     the field keeps the focus, the suggestions refresh.
 *  3. OMN-14: a link copied from a page's long-press menu; the pill then lists "Link you copied"
 *     (the type, read from the clip's description alone) behind Show; Show reveals the address;
 *     a touch on the row opens it; the pill once more lists no clipboard row for the clip the
 *     row opened (used up until the clipboard changes, as Chrome's is).
 *  4. OMN-27: a page that links an OpenSearch description; its engine appears under Recently
 *     visited in Settings > Search > Default search engine, is picked there, and the next search
 *     from the pill goes to it.
 *
 * Two sites of the driver's own on the loopback (see [DemoServer]), so nothing depends on the
 * network: 127.0.0.1 is the seeded default engine's site (its suggest endpoint answers the query
 * rows), 127.0.0.2 the site that offers an engine. Findings in `android-omnibox-findings.txt`
 * next to the frames; the run FAILS when a claim does not hold (Share's system sheet is recorded,
 * not asserted: its timing is another app's). See [DemoHarness] for the plumbing and its rule on
 * real touches versus accessibility clicks.
 */
@RunWith(AndroidJUnit4::class)
class OmniboxDemo : DemoHarness("omnibox-demo-state.json", "android-omnibox", "omnibox-demo") {
    override val tag = "OmniboxDemo"
    private lateinit var brew: DemoServer
    private lateinit var roast: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        brew = DemoServer(PORT, brewRoutes()).also { it.start() }
        roast = DemoServer(PORT, roastRoutes(), address = ROAST_HOST).also { it.start() }
        try {
            runDemo()
        } finally {
            brew.close()
            roast.close()
        }
        if (failures.isNotEmpty()) error("the omnibox did not hold up under a finger: ${failures.joinToString("; ")}")
    }

    override fun warmUp() {
        findings = File(out, "android-omnibox-findings.txt")
        findings.writeText(
            "Zenium Android omnibox parity check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n" +
                "sites: ${brew.selfCheck()}; ${roast.selfCheck()}\n\n"
        )
        // The page: loaded before anything is read off it.
        val loaded = awaitChrome("true", 1_000) && awaitPage(BREW_ORIGIN + "/", 20_000)
        finding("warm-up: the seeded page ${if (loaded) "is up" else "did NOT report complete"}")
        // The first open pays for the editor's layout and the suggestions' first fetch: off camera.
        tapPill()
        val header = awaitNode(8_000) { it == EDIT_LABEL } != null
        SystemClock.sleep(800)
        closeUrlbar()
        finding("warm-up: the editor opened once off camera (header ${if (header) "seen" else "NOT seen"})")
        // The Settings page is a chunk of its own that loads on its first open: pay for it too.
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        awaitChrome("!!document.querySelector('$SETTINGS_SEARCH_FIELD')", 12_000)
        SystemClock.sleep(600)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(1_500)
        ensureForeground()
        // Closing the Settings tab activates a neighbour, not necessarily the seeded page: back to it.
        finding("warm-up: the demo page ${if (showBrewPage()) "is" else "is NOT"} the active tab")
    }

    override fun demo() {
        val pageUrl = BREW_ORIGIN + "/"

        // 1. OMN-05: the pill on a page opens search-ready, the page in a header row over the rows.
        step("OMN-05 search-ready: the pill on a page") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            tapPill()
            val chips = awaitNode(8_000) { it == COPY_LABEL } != null
            val ime = awaitIme(shown = true, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
            shot("01-search-ready")
            val header = chromeValue("String(!!document.querySelector('$HEADER'))") == "true"
            val title = chromeValue("(document.querySelector('$HEADER .zen-omnibox-page-title')||{}).textContent||''")
            val shown = chromeValue("(document.querySelector('$HEADER .zen-omnibox-page-url')||{}).textContent||''")
            val value = fieldValue()
            finding(
                "  header row in the DOM $header (title '$title', address '$shown'); chips on screen $chips; " +
                    "field '$value' (empty: search-ready); keyboard up $ime ${verdict(header && chips && value.isEmpty())}"
            )
            if (!header || !chips) failures += "the pill on a page did not open with the header row"
            // OMN-25: the URL keyboard, from the field's attributes.
            val attrs = chromeValue(
                "(function(){var i=document.querySelector('$FIELD');return i?[i.getAttribute('inputmode'),i.getAttribute('enterkeyhint')," +
                    "i.getAttribute('autocapitalize'),i.getAttribute('autocorrect'),i.getAttribute('autocomplete')].join(' '):''})()"
            )
            val urlKeyboard = attrs == "url go off off off"
            finding("  OMN-25 field attributes (inputmode enterkeyhint autocapitalize autocorrect autocomplete): '$attrs' ${verdict(urlKeyboard)}")
            if (!urlKeyboard) failures += "the field's keyboard attributes read '$attrs'"
        }

        // 2. Copy link: the address on the clipboard, read back here.
        step("OMN-05 Copy link under a finger") {
            val before = clipboardText()
            val touched = touchTapLabel(COPY_LABEL)
            val copied = awaitClipboard(pageUrl, 6_000)
            SystemClock.sleep(1_500)
            shot("02-copied")
            finding("  chip ${if (touched) "touched" else "not found"}; clipboard '$before' -> '${clipboardText()}' ${verdict(copied)}")
            if (!copied) failures += "Copy link did not put the address on the clipboard"
        }

        // 3. Share: the system sheet (the editor closes for it), recorded.
        step("OMN-05 Share under a finger") {
            val touched = touchTapLabel(SHARE_LABEL)
            val sheet = touched && awaitSystemWindow(10_000)
            SystemClock.sleep(3_000)
            shot("03-share-sheet")
            finding("  chip ${if (touched) "touched" else "not found"}; a system window came up $sheet ${verdict(sheet)} (recorded, not asserted)")
            back()
            SystemClock.sleep(1_500)
            ensureForeground()
            closeUrlbar()
        }

        // 4. Edit: the whole address into the field, caret at the end, keyboard kept.
        step("OMN-05 Edit under a finger") {
            tapPill()
            awaitNode(8_000) { it == EDIT_LABEL } ?: error("the header row did not come back")
            val touched = touchTapLabel(EDIT_LABEL)
            val filled = touched && awaitChrome("(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(pageUrl)}", 6_000)
            SystemClock.sleep(800)
            val caret = chromeValue("(function(){var i=document.querySelector('$FIELD');return i?i.selectionStart+'/'+i.selectionEnd+'/'+i.value.length:''})()")
            val atEnd = caret.isNotEmpty() && caret.split('/').let { it.size == 3 && it[0] == it[2] && it[1] == it[2] }
            val focused = chromeValue("String(document.activeElement===document.querySelector('$FIELD'))") == "true"
            val ime = imeShown()
            val header = chromeValue("String(!!document.querySelector('$HEADER'))") == "true"
            SystemClock.sleep(600)
            shot("04-edit-filled")
            finding(
                "  chip ${if (touched) "touched" else "not found"}; field '${fieldValue()}' (the address) $filled; " +
                    "caret start/end/length $caret at the end $atEnd; field focused $focused; keyboard up $ime; header row gone ${!header} " +
                    verdict(filled && atEnd && focused)
            )
            if (!filled || !atEnd || !focused) failures += "Edit did not fill the field with the address, caret at the end"
        }

        // 5. OMN-09: a query, the engine's rows with Refine arrows, one touched.
        step("OMN-09 Refine under a finger") {
            touchTapLabel(CLEAR_LABEL)
            SystemClock.sleep(600)
            instrumentation.sendStringSync(QUERY)
            val refine = awaitNode(12_000) { it == REFINE_LABEL }
            SystemClock.sleep(1_200)
            shot("05-query-suggestions")
            val rows = chromeValue(
                "Array.from(document.querySelectorAll('$ROWS')).map(function(r){return r.getAttribute('data-kind')+':'+" +
                    "(r.querySelector('span')||{}).textContent+(r.querySelector('.zen-omnibox-refine')?' [Refine]':'')}).join(' | ')"
            )
            finding("  typed '$QUERY'; rows: $rows")
            val expected = chromeValue(
                "(function(){var b=document.querySelector('$ROWS .zen-omnibox-refine');var r=b&&b.closest('li');" +
                    "return r?(r.querySelector('span')||{}).textContent||'':''})()"
            )
            val urlBefore = activeCoreTab()?.optString("url").orEmpty()
            if (refine == null) error("no row grew a Refine arrow for '$QUERY'")
            // THE touch: the first Refine as the tree has it now (the node found above is stale once
            // the list re-rendered under it), else where the DOM lays the first arrow out.
            var touched = touchTapFresh(6_000) { it == REFINE_LABEL }
            if (!touched) {
                val dom = refineDomRect()
                val point = dom?.let { touchPoint(it) }
                if (point != null) {
                    finding("  the tree lost the Refine node; finger at ${point.x},${point.y} from the DOM rect $dom")
                    Finger().tap(point.x, point.y)
                    touched = true
                }
            }
            val set = touched && expected.isNotEmpty() && awaitChrome("(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(expected)}", 6_000)
            SystemClock.sleep(2_000)
            val urlAfter = activeCoreTab()?.optString("url").orEmpty()
            val focused = chromeValue("String(document.activeElement===document.querySelector('$FIELD'))") == "true"
            // The suggestions refreshed for the refined text: the verbatim row now reads it.
            val first = chromeValue("(function(){var r=document.querySelector('$ROWS');return r?(r.querySelector('span')||{}).textContent||'':''})()")
            shot("06-refined")
            val ok = set && urlBefore == urlAfter && focused
            finding(
                "  Refine ${if (touched) "touched" else "not touched"} on '$expected'; field '${fieldValue()}' $set; " +
                    "tab URL '$urlBefore' -> '$urlAfter' (unchanged ${urlBefore == urlAfter}); field focused $focused; " +
                    "first row now '$first' (refreshed ${first == expected}) ${verdict(ok)}"
            )
            if (!ok) failures += "Refine did not set the field without submitting (field '${fieldValue()}', tab '$urlAfter')"
            closeUrlbar()
        }

        // 6. OMN-14: a link copied from the page's long-press menu, then the pill: the clipboard row.
        step("OMN-14 clipboard row: copy a link, reveal, open") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            val link = linkPoint() ?: error("the page's link was not found")
            Finger().apply {
                press(link.x, link.y)
                up()
            }
            val menu = awaitNode(8_000) { it == COPY_LINK_ITEM }
            SystemClock.sleep(1_000)
            shot("07-link-menu")
            var copied = menu != null && touchTapFresh(6_000) { it == COPY_LINK_ITEM } && awaitClipboard(GUIDE_URL, 6_000)
            var how = if (menu != null) "touched" else "not in the menu"
            // The link menu is the way to the state, not the claim: when the finger did not copy,
            // the tree's click gets there and the findings say so.
            if (!copied && menu != null && clickByLabel(COPY_LINK_ITEM)) {
                copied = awaitClipboard(GUIDE_URL, 6_000)
                how = "touched, NOT taken (copied through the accessibility click instead)"
            }
            finding("  long press on the link at ${link.x},${link.y}; '$COPY_LINK_ITEM' $how; clipboard '${clipboardText()}' ${verdict(copied)}")
            if (!copied) error("the link's address did not reach the clipboard")
            val copiedAt = SystemClock.uptimeMillis()
            SystemClock.sleep(1_500)
            ensureForeground()
            if (chromeSurfaceUp()) {
                back()
                SystemClock.sleep(1_000)
            }
            // The system's clipboard overlay sits over the bar for some six seconds after the copy;
            // the pill's touch waits it out (a touch on its nearby-device chip sent the clip to
            // Nearby Share instead, twice).
            val overlayGone = awaitClipboardOverlayGone(copiedAt)
            finding("  clipboard overlay gone before the pill $overlayGone (${SystemClock.uptimeMillis() - copiedAt} ms after the copy)")
            ensureForeground()
            tapPill()
            // Should a chip have taken the touch all the same (another app's window is up), back
            // out of it and touch the pill once more; the findings say so.
            if (awaitSystemWindow(1_500)) {
                finding("  another app's window (${ui.rootInActiveWindow?.packageName}) came up on the pill's touch; backing out, the pill again")
                ensureForeground()
                SystemClock.sleep(800)
                tapPill()
            }
            val show = awaitNode(8_000) { it == SHOW_LABEL }
            SystemClock.sleep(1_200)
            shot("08-clipboard-peek")
            val peek = chromeValue("(function(){var r=document.querySelector('$ROWS[data-kind=clipboard]');return r?(r.querySelector('span')||{}).textContent||'':''})()")
            finding("  the pill again: clipboard row '$peek' with Show ${show != null} ${verdict(show != null && peek.endsWith("you copied"))}")
            if (show == null) error("no clipboard row behind Show")
            val revealed = touchTapFresh(6_000) { it == SHOW_LABEL } && awaitChrome("(function(){var r=document.querySelector('$ROWS[data-kind=clipboard]');return !!r&&(r.querySelector('span')||{}).textContent===${JSONObject.quote(GUIDE_URL)}})()", 6_000)
            SystemClock.sleep(1_200)
            shot("09-clipboard-revealed")
            // The option reads its title and subtitle together ("<address> Link you copied").
            val row = awaitNode(6_000) { it.startsWith(GUIDE_URL) }
            finding("  Show touched; the row reads '${chromeValue("(function(){var r=document.querySelector('$ROWS[data-kind=clipboard]');return r?r.textContent:''})()")}' $revealed")
            if (!revealed || row == null) error("Show did not reveal the copied address")
            val opened = touchTapFresh(6_000) { it.startsWith(GUIDE_URL) } && awaitPageUrl(GUIDE_URL, 10_000)
            SystemClock.sleep(2_500)
            shot("10-clipboard-opened")
            finding("  the revealed row touched; tab URL '${activeCoreTab()?.optString("url")}' ${verdict(opened)}")
            if (!opened) failures += "the revealed clipboard row did not open the address"
            // The clip the row opened is used up: the pill again lists the header over the opened
            // page and no clipboard row for it (Chrome's SuppressClipboardContent), until the
            // clipboard changes. The bar is closed again for the next step.
            SystemClock.sleep(1_000)
            tapPill()
            val headerAgain = awaitNode(8_000) { it == EDIT_LABEL }
            SystemClock.sleep(1_500)
            shot("10b-clipboard-used")
            val rowAgain = chromeValue("String(!!document.querySelector('$ROWS[data-kind=clipboard]'))") == "true"
            val showAgain = findNode { it == SHOW_LABEL } != null
            finding("  the pill again after the open: header ${headerAgain != null}; clipboard row offered again $rowAgain (Show $showAgain) ${verdict(headerAgain != null && !rowAgain && !showAgain)}")
            if (rowAgain || showAgain) failures += "the clip the row opened was offered again on the next focus"
            back()
            SystemClock.sleep(1_000)
        }

        // 7. OMN-27: a page that offers an engine; discovered on load.
        step("OMN-27 OpenSearch discovery") {
            tapPill()
            awaitNode(8_000) { it == EDIT_LABEL }
            instrumentation.sendStringSync(ROAST_ORIGIN + "/")
            SystemClock.sleep(800)
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
            val there = awaitPageUrl(ROAST_ORIGIN + "/", 12_000)
            val engine = awaitEngine(ROAST_ENGINE_ID, 15_000)
            SystemClock.sleep(1_500)
            shot("11-opensearch-page")
            finding(
                "  '${ROAST_ORIGIN}/' loaded $there; discovered engine: ${engine?.toString() ?: "none"} " +
                    verdict(engine != null && engine.optString("name") == ROAST_NAME && engine.optString("suggestUrl").isNotEmpty())
            )
            if (engine == null) failures += "the page's OpenSearch description was not discovered"
        }

        // 8. The engine picked in Settings > Search under a finger.
        step("OMN-27 the engine picked in Settings") {
            val menu = openMenuItem("Settings")
            val landing = menu && awaitChrome("!!document.querySelector('$SETTINGS_SEARCH_FIELD')", 10_000)
            SystemClock.sleep(1_000)
            var section = landing && touchTapLabel("Search") && awaitSurface(up = true, timeoutMs = 6_000)
            if (!section) {
                finding("  Settings > Search not reached under a finger (menu $menu, landing $landing); opened through the core instead")
                coreInvoke("page.open", "{\"id\":\"settings\",\"section\":\"search\"}")
                section = awaitChrome("!!document.querySelector('$SETTINGS_SEARCH_FIELD')||true", 8_000)
            }
            SystemClock.sleep(1_200)
            val rowBefore = rowText(ENGINE_ROW)
            val touched = touchTapLabel(ENGINE_ROW, prefix = true)
            val option = if (touched) awaitOption(ROAST_NAME, 8_000) else null
            val dom = optionDomRect(ROAST_NAME)
            val rested = (option != null || dom != null) && awaitSheetAtRest(6_000)
            SystemClock.sleep(600)
            shot("12-engine-picker")
            val heading = chromeValue("String(Array.from(document.querySelectorAll('.zen-sheet h3, .zen-sheet .zen-settings-heading')).some(function(h){return /Recently visited/.test(h.textContent)}))") == "true"
            val favicon = chromeValue("String(!!document.querySelector('.zen-sheet [role=radio] img.zen-settings-engine-favicon'))") == "true"
            finding(
                "  row '$rowBefore' ${if (touched) "touched" else "not found"}; option '$ROAST_NAME' in the tree ${option != null}, in the DOM at $dom; " +
                    "Recently visited heading $heading; favicon drawn $favicon; sheet at rest $rested ${verdict(rested)}"
            )
            if (option == null && dom == null) error("the picker did not list '$ROAST_NAME'")
            // THE touch: on the option where the tree says it is, else where the DOM lays it out.
            val picked = if (option != null) {
                touchTap(option)
            } else {
                val point = touchPoint(dom!!) ?: error("no part of the option $dom is inside the touchable window $touchable")
                finding("  the tree has no node for the option; finger at ${point.x},${point.y} from the DOM")
                Finger().tap(point.x, point.y)
                true
            }
            val closed = awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 8_000)
            val rowAfter = awaitRowText(ENGINE_ROW, ROAST_NAME, 8_000)
            val id = coreState().getJSONObject("settings").optString("searchEngineId")
            SystemClock.sleep(1_200)
            shot("13-engine-picked")
            val ok = picked && closed && rowAfter.endsWith(ROAST_NAME) && id == ROAST_ENGINE_ID
            finding("  option touched $picked; picker closed $closed; row '$rowBefore' -> '$rowAfter'; core searchEngineId '$id' ${verdict(ok)}")
            if (!ok) failures += "the discovered engine was not picked under a finger (row '$rowAfter', id '$id')"
        }

        // 9. A search from the pill goes to the picked engine.
        step("OMN-27 a search with the picked engine") {
            // Back to a web page first: the pill over the Settings tab is not where a search starts.
            val left = leaveSettings()
            finding("  Settings left, a web page active $left (tab '${activeCoreTab()?.optString("url")}')")
            tapPill()
            awaitNode(8_000) { it == EDIT_LABEL }
            instrumentation.sendStringSync(ROAST_QUERY)
            // The option may read its title and subtitle as one ("<query> Search with <engine>").
            val verbatim = awaitNode(8_000) { it.contains("Search with $ROAST_NAME") } != null
            SystemClock.sleep(1_000)
            shot("14-search-typed")
            // Whether the keyboard still had the last word composing when Enter came (Gboard keeps
            // the typed word underlined and lets a hardware Enter through with it open): the field
            // records the key's isComposing, read back once the editor has gone.
            chromeJs(
                "window.__enterComposing=null;var f=document.querySelector('$FIELD');" +
                    "if(f)f.addEventListener('keydown',function(e){if(e.key==='Enter')window.__enterComposing=e.isComposing},true)"
            )
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
            val searched = awaitPageUrlPrefix(ROAST_ORIGIN + "/search?q=", 12_000)
            SystemClock.sleep(3_000)
            shot("15-searched")
            val composing = chromeValue("String(window.__enterComposing)")
            val url = activeCoreTab()?.optString("url").orEmpty()
            val ok = searched && url.contains("single")
            finding("  verbatim row 'Search with $ROAST_NAME' $verbatim; Enter (isComposing $composing) -> tab URL '$url' ${verdict(ok)}")
            if (!ok) failures += "the search did not go to the picked engine (tab '$url')"
        }

        finding("\nend: ${failures.size} failure(s)")
    }

    // --- the pill, the field, the page -----------------------------------------------------------

    /** A finger on the bar's address pill: where the tree says it is, else where the bar has it. */
    private fun tapPill() {
        ensureForeground()
        val target = findByLabelPrefix(PILL_LABEL) ?: pill
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    private fun fieldValue(): String = chromeValue("(document.querySelector('$FIELD')||{}).value||''")

    /**
     * The seeded demo page (`tab_brew` at the default engine's site) as the active tab, loaded:
     * activated through the core when another tab is up, its document re-navigated there when the
     * tab has moved on (the clipboard row and the OpenSearch step navigate it). False when it is
     * not there in time.
     */
    private fun showBrewPage(): Boolean {
        val url = BREW_ORIGIN + "/"
        closeUrlbar()
        if (activeCoreTab()?.optString("id") != BREW_TAB_ID) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(BREW_TAB_ID)}}")
            SystemClock.sleep(800)
        }
        if (activeCoreTab()?.optString("url") != url) {
            coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(BREW_TAB_ID)},\"input\":${JSONObject.quote(url)}}")
        }
        val there = awaitPageUrl(url, 10_000) && awaitPage(url, 10_000)
        SystemClock.sleep(600)
        ensureForeground()
        return there
    }

    /**
     * Out of Settings: its sheet and section go with backs, its tab through the core, until a web
     * page is the active tab. False when none is in time.
     */
    private fun leaveSettings(): Boolean {
        repeat(3) {
            if (!chromeSurfaceUp()) return@repeat
            back()
            SystemClock.sleep(900)
        }
        val settings = activeCoreTab()
        if (settings != null && settings.optString("url").startsWith("zen://settings")) {
            coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(settings.getString("id"))}}")
            SystemClock.sleep(1_200)
        }
        val web = awaitTab(8_000) { it.startsWith("http") }
        ensureForeground()
        return web
    }

    /** Poll the core until the active tab is at `url`. */
    private fun awaitPageUrl(url: String, timeoutMs: Long): Boolean = awaitTab(timeoutMs) { it == url }

    private fun awaitPageUrlPrefix(prefix: String, timeoutMs: Long): Boolean = awaitTab(timeoutMs) { it.startsWith(prefix) }

    private fun awaitTab(timeoutMs: Long, matches: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val url = runCatching { activeCoreTab()?.optString("url") }.getOrNull().orEmpty()
            if (matches(url)) return true
            SystemClock.sleep(300)
        }
        return false
    }

    /** The active tab's document is `url` and complete, per the page's own WebView. */
    private fun awaitPage(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val web = pageWebView()
            if (web != null && evalJs(web, "location.href + ' ' + document.readyState") == "$url complete") return true
            SystemClock.sleep(500)
        }
        return false
    }

    /** Where the page's link is on screen (px), through the tab's WebView; null when there is none. */
    private fun linkPoint(): PointF? {
        val web = pageWebView() ?: return null
        val origin = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(origin) }
        val text = evalJs(web, LINK_POINT_JS) ?: return null
        val point = runCatching { JSONObject(text) }.getOrNull() ?: return null
        return PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
    }

    /** The tab's WebView that is on screen (the test shares the app's process and its views). */
    private fun pageWebView(): TabWebView? {
        var found: TabWebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: View) {
                if (found != null) return
                if (view is TabWebView && view.isShown) {
                    found = view
                    return
                }
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return found
    }

    /** The string a script evaluates to in the page, or null when it did not answer in time. */
    private fun evalJs(web: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            web.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    // --- the clipboard, the engines --------------------------------------------------------------

    /** The clipboard's text as the app (in the foreground, so allowed to read it) sees it. */
    private fun clipboardText(): String {
        var text = ""
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            text = runCatching {
                manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(app)?.toString()
            }.getOrNull().orEmpty()
        }
        return text
    }

    private fun awaitClipboard(text: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (clipboardText() == text) return true
            SystemClock.sleep(250)
        }
        return clipboardText() == text
    }

    /** Poll the core's settings for the engine with `id`; null when it never appears. */
    private fun awaitEngine(id: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val engines = runCatching { coreState().getJSONObject("settings").optJSONArray("searchEngines") }.getOrNull()
            if (engines != null) {
                for (i in 0 until engines.length()) {
                    val engine = engines.getJSONObject(i)
                    if (engine.optString("id") == id) return engine
                }
            }
            SystemClock.sleep(500)
        }
        return null
    }

    // --- rows and sheets -------------------------------------------------------------------------

    /** The accessible text of the first node reading `prefix`… (a Settings row runs label and value together); "" when none. */
    private fun rowText(prefix: String): String =
        findNode { it.startsWith(prefix) }?.let { (it.text ?: it.contentDescription)?.toString() }.orEmpty()

    /** Poll until the row reading `prefix`… ends with `value` (the tree trails the screen); the text it reads then. */
    private fun awaitRowText(prefix: String, value: String, timeoutMs: Long): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var text = rowText(prefix)
        while (SystemClock.uptimeMillis() < deadline) {
            if (text.endsWith(value)) return text
            SystemClock.sleep(250)
            text = rowText(prefix)
        }
        return text
    }

    /**
     * The picker's option labelled `label`, in the tree: the checkable node (the `role=radio`
     * row) over the label's text, so the touch lands on the sheet's row and never on the section's
     * row of the same name behind the scrim; when the tree reports no checkable, the labelled
     * node lying inside the option's DOM rect. Null when none is on screen in time.
     */
    private fun awaitOption(label: String, timeoutMs: Long): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val labelled = findNodesLabelled(label)
            labelled.firstNotNullOfOrNull { checkableAncestor(it) }?.let { return it }
            val dom = optionDomRect(label)
            if (dom != null) {
                labelled.firstOrNull { node ->
                    val bounds = Rect().also { node.getBoundsInScreen(it) }
                    !bounds.isEmpty && dom.contains(bounds.centerX(), bounds.centerY())
                }?.let { return it }
            }
            SystemClock.sleep(250)
        }
        return null
    }

    /** Every node in the active window whose text or label is `label`, breadth first. */
    private fun findNodesLabelled(label: String): List<AccessibilityNodeInfo> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            val text = (node.text ?: node.contentDescription)?.toString()
            if (text == label) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    private fun checkableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        var depth = 0
        while (current != null && depth < 8) {
            if (current.isCheckable) return current
            current = current.parent
            depth++
        }
        return null
    }

    /**
     * The sheet's option whose text starts with `label` (its host follows the name), as the DOM
     * lays it out, in screen px: the chrome fills the window from its top-left corner, so CSS px
     * times the density are screen px. Null when the sheet lists no such option.
     */
    private fun optionDomRect(label: String): Rect? {
        val text = chromeValue(
            "(function(){var b=Array.from(document.querySelectorAll('.zen-sheet [role=radio]'))" +
                ".find(function(e){return e.textContent.trim().indexOf(${JSONObject.quote(label)})===0});" +
                "if(!b)return '';var r=b.getBoundingClientRect();" +
                "return [r.left,r.top,r.right,r.bottom].map(function(v){return Math.round(v*$density)}).join(',')})()"
        )
        val px = text.split(',').map { it.toIntOrNull() ?: return null }
        if (px.size != 4) return null
        return Rect(px[0], px[1], px[2], px[3])
    }

    /** The first row's Refine arrow as the DOM lays it out, in screen px (as [optionDomRect]); null when no row has one. */
    private fun refineDomRect(): Rect? {
        val text = chromeValue(
            "(function(){var b=document.querySelector('$ROWS .zen-omnibox-refine');if(!b)return '';var r=b.getBoundingClientRect();" +
                "return [r.left,r.top,r.right,r.bottom].map(function(v){return Math.round(v*$density)}).join(',')})()"
        )
        val px = text.split(',').map { it.toIntOrNull() ?: return null }
        if (px.size != 4) return null
        return Rect(px[0], px[1], px[2], px[3])
    }

    /** The sheet's spring has landed (`--zen-recede` at 1 once a sheet rests, §11.1). */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = awaitChrome(
            "document.querySelectorAll('.zen-sheet').length>=1&&" +
                "Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99",
            timeoutMs
        )
        SystemClock.sleep(800)
        return rested
    }

    // --- the chrome ------------------------------------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
            // Whatever the step left up (a menu, the editor, a sheet) goes before the next one.
            ensureForeground()
            repeat(3) {
                if (!chromeSurfaceUp() && findByLabelPrefix(PILL_LABEL) != null) return@repeat
                back()
                SystemClock.sleep(1_000)
            }
        }
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the two sites ---------------------------------------------------------------------------

    /** The seeded default engine's site: the page the demo starts on, a guide it links, the engine's search and suggest endpoints. */
    private fun brewRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html(
            "Brew notes",
            "",
            "<p>Notes on brewing coffee at home: ratios, grind sizes and water temperatures.</p>" +
                "<a id=\"guide\" href=\"/guide.html\" style=\"display:block;margin:24px;padding:22px 18px;border-radius:14px;" +
                "background:#f1f3f5;color:#1d1d2c;text-decoration:none;font:600 20px/1.3 sans-serif\">Brewing guide</a>"
        ),
        "/guide.html" to html("Brewing guide", "", "<p>Start with 15 g of coffee to 250 g of water.</p>"),
        "/search" to results("Brew notes"),
        "/suggest" to suggestions("how to brew coffee", "how to brew tea", "how to brew kombucha", "how to brew cold brew")
    )

    /** The site that offers an engine: the page links its OpenSearch description. */
    private fun roastRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html(
            ROAST_NAME,
            "<link rel=\"search\" type=\"application/opensearchdescription+xml\" title=\"$ROAST_NAME\" href=\"/opensearch.xml\">",
            "<p>An index of roasters and their beans. This site offers a search engine of its own.</p>"
        ),
        "/opensearch.xml" to ("application/opensearchdescription+xml; charset=utf-8" to (
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
                "<OpenSearchDescription xmlns=\"http://a9.com/-/spec/opensearch/1.1/\">\n" +
                "  <ShortName>$ROAST_NAME</ShortName>\n" +
                "  <Description>Search the roast index</Description>\n" +
                "  <Image width=\"16\" height=\"16\" type=\"image/svg+xml\">$ROAST_ORIGIN/icon.svg</Image>\n" +
                "  <Url type=\"text/html\" method=\"get\" template=\"$ROAST_ORIGIN/search?q={searchTerms}\"/>\n" +
                "  <Url type=\"application/x-suggestions+json\" template=\"$ROAST_ORIGIN/suggest?q={searchTerms}\"/>\n" +
                "</OpenSearchDescription>\n"
            ).toByteArray()),
        "/icon.svg" to ("image/svg+xml" to (
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><circle cx=\"8\" cy=\"8\" r=\"8\" fill=\"#b5651d\"/>" +
                "<text x=\"8\" y=\"11.5\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"10\" font-weight=\"700\" fill=\"#fff\">R</text></svg>"
            ).toByteArray()),
        "/search" to results(ROAST_NAME),
        "/suggest" to suggestions("single origin ethiopia", "single origin colombia", "single origin kenya")
    )

    private fun html(title: String, head: String, body: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>$head" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px 8px}" +
                "p{padding:0 24px;font-size:20px}</style></head><body><h1>$title</h1>$body</body></html>"
            ).toByteArray()

    /** A results page that names the query it was asked (the title the tab shows, from `?q=`). */
    private fun results(site: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$site</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px 8px}" +
                "p{padding:0 24px;font-size:20px}</style></head><body><h1>$site</h1><p id=q></p>" +
                "<script>var q=new URLSearchParams(location.search).get('q')||'';document.title='$site: '+q;" +
                "document.getElementById('q').textContent='Results for \"'+q+'\"';</script></body></html>"
            ).toByteArray()

    /** The engine's suggest endpoint: the same rows whatever the query (the shape the core parses). */
    private fun suggestions(vararg rows: String): Pair<String, ByteArray> =
        "application/json; charset=utf-8" to
            ("[\"\",[" + rows.joinToString(",") { JSONObject.quote(it) } + "]]").toByteArray()

    companion object {
        private const val PORT = 18135
        private const val ROAST_HOST = "127.0.0.2"
        private const val BREW_ORIGIN = "http://127.0.0.1:$PORT"
        private const val ROAST_ORIGIN = "http://$ROAST_HOST:$PORT"
        private const val GUIDE_URL = "$BREW_ORIGIN/guide.html"
        /** The seeded tab on the demo page (omnibox-demo-state.json). */
        private const val BREW_TAB_ID = "tab_brew"
        private const val ROAST_NAME = "Roast index"
        /** `discovered:<host>` (shared/search.ts `discoveredSearchEngine`). */
        private const val ROAST_ENGINE_ID = "discovered:$ROAST_HOST"
        private const val QUERY = "how to brew"
        private const val ROAST_QUERY = "single origin"
        /** The header row's chips (Urlbar.tsx `PageHeader`), by their text. */
        private const val SHARE_LABEL = "Share"
        private const val COPY_LABEL = "Copy link"
        private const val EDIT_LABEL = "Edit"
        /** The Refine arrow's aria-label and the clipboard row's Show. */
        private const val REFINE_LABEL = "Refine"
        private const val SHOW_LABEL = "Show"
        /** The field's clear button, there once something is typed. */
        private const val CLEAR_LABEL = "Clear"
        /** The link long-press menu's copy item (core/menus.ts). */
        private const val COPY_LINK_ITEM = "Copy Link Address"
        /** The Settings > Search picker row: reads "Default search engine <value>" in the tree. */
        private const val ENGINE_ROW = "Default search engine"
        /**
         * The chrome's DOM: the field, the header row, the suggestion rows (each `li` an option
         * with its Show or Refine control beside it; `data-kind` on the row), the Settings
         * landing's search.
         */
        private const val FIELD = "[data-testid=\"urlbar-input\"]"
        private const val HEADER = "[data-testid=\"urlbar-page-header\"]"
        private const val ROWS = ".zen-omnibox-sheet [role=\"listbox\"] > li"
        private const val SETTINGS_SEARCH_FIELD = ".zen-settings-search-field"

        /** The centre of the page's link in device pixels relative to the WebView (through the visual viewport and the pixel ratio). */
        private val LINK_POINT_JS = """
            (function () {
              var a = document.getElementById('guide');
              if (!a) return null;
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var dx = vv ? vv.offsetLeft : 0;
              var dy = vv ? vv.offsetTop : 0;
              var r = a.getBoundingClientRect();
              return JSON.stringify({ x: (r.left + r.width / 2 - dx) * scale, y: (r.top + r.height / 2 - dy) * scale });
            })()
        """.trimIndent()
    }
}
