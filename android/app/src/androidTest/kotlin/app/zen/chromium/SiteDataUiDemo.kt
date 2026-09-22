package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * Records the Cookies and site data UI on the phone (PS-23, PS-24, PS-25; the UI half of #310),
 * in two acts around a process death (see .github/scripts/android-site-data-ui-demo.sh):
 *
 *  - [SiteDataUiDemo], act one: a loopback page that sets two cookies with every visit and
 *    says what the request carried; the site-information sheet's cookies level reading "Use the
 *    default" for it; Settings › Privacy and Security › Cookies and site data – the default's
 *    picker (Block all cookies, browser-wide, and back), the never list's Add sheet with the
 *    site's host typed into it, the row it makes; the page reloaded and asking with no cookies
 *    (the header stage relays a never-site's documents without them); the sheet's cookies level
 *    reading "Never allow · Listed as 127.0.0.1" and its picker moving the site to "Clear when
 *    Zenium closes"; the allow list's Add and the pattern row's Remove; the viewer with a row's
 *    Clear (the cookies gone from the jar) and Clear all's prompt cancelled; the on-exit type
 *    "Browsing history" switched on; the page holding its cookies again, the jar flushed to disk,
 *    and the app sent home – the pending-clear marker written by the core on the way.
 *  - [SiteDataRestoreDemo], act two, after `am force-stop`: the cold start with the marker and
 *    the restored session. The first request the restored page makes must carry no cookie (the
 *    loopback server keeps every request's Cookie header), the document must hold none, the
 *    control site on no list keeps its cookies, the history is empty and the marker consumed.
 *
 * Every control inside a sheet is pressed with a real injected finger and the effect asserted
 * against the core's state (the rule in [DemoHarness]); the frames of the sheets' open and
 * dismiss are measured with the chrome's Blink trace around them ([traceFrames]: the renderer
 * main thread's layouts and paints per frame are the numbers that carry over to a phone, the
 * software GPU's frame times do not). Findings go to `<shotPrefix>-notes.txt` beside the stills.
 */
abstract class SiteDataUiDemoBase(
    stateAsset: String?,
    private val prefix: String,
    handshakeDir: String,
    keepProfile: Boolean
) : DemoHarness(stateAsset, prefix, handshakeDir, keepProfile = keepProfile) {
    protected lateinit var server: CookiePage
    protected lateinit var notes: File

    @Test
    fun record() {
        server = CookiePage(readAsset("site-data-demo-page.html"), PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    protected fun openNotes(title: String) {
        notes = File(out, "$prefix-notes.txt")
        notes.writeText("$title\n\n")
        note("demo server: ${server.selfCheck()}")
    }

    protected fun note(line: String) {
        Log.i(tag, line)
        if (::notes.isInitialized) notes.appendText(line + "\n")
    }

    /** A claim of the run: noted, and a [touchFault] (the run fails at its end) when it does not hold. */
    protected fun claim(what: String, held: Boolean, detail: String = "") {
        val line = "  ${if (held) "OK  " else "FAIL"} $what${if (detail.isNotEmpty()) " ($detail)" else ""}"
        note(line)
        if (!held) touchFault("claim failed: $what${if (detail.isNotEmpty()) " ($detail)" else ""}")
    }

    protected val host: Host get() = (activity as MainActivity).host

    // --- the jar and the core --------------------------------------------------------------------

    /** The default container's cookie header for `url`, as the WebView's jar would send it; null for none. */
    protected fun jarCookie(url: String): String? =
        Profiles.cookieManager(Profiles.DEFAULT_CONTAINER).getCookie(url)?.takeIf { it.isNotBlank() }

    protected fun siteData(): JSONObject = coreState().getJSONObject("siteData")

    protected fun listHolds(list: String, pattern: String): Boolean {
        val patterns = siteData().optJSONArray(list) ?: return false
        return (0 until patterns.length()).any { patterns.getString(it) == pattern }
    }

    protected fun exitTypes(): List<String> {
        val types = coreState().getJSONObject("settings").optJSONObject("privacy")?.optJSONObject("clearOnExit")?.optJSONArray("types")
            ?: return emptyList()
        return (0 until types.length()).map { types.getString(it) }
    }

    /** The site-data marker as the core wrote it (`files/zen/sitedata.json`), or null when the file has none. */
    protected fun pendingMarker(): JSONObject? {
        val file = File(app.filesDir, "zen/sitedata.json")
        if (!file.exists()) return null
        return runCatching { JSONObject(file.readText()).optJSONObject("pendingClear") }.getOrNull()
    }

    protected fun tabTitle(tabId: String): String =
        coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("title") ?: ""

    /** The history's recent entries, newest first (`history.recent`). */
    protected fun historyEntries(): List<JSONObject> {
        val entries = JSONArray(coreInvoke("history.recent", """{"limit":50}"""))
        return (0 until entries.length()).mapNotNull { entries.optJSONObject(it) }
    }

    /** An entry as "host@firstVisit" (wall-clock ms), for the notes. */
    protected fun describeEntry(entry: JSONObject): String {
        val url = entry.optString("url")
        val host = runCatching { java.net.URI(url).host ?: url }.getOrDefault(url)
        return "$host@${entry.optLong("firstVisit", entry.optLong("lastVisit"))}"
    }

    protected fun historyHosts(): List<String> = historyEntries().map { describeEntry(it).substringBefore('@') }

    /** Poll the tab's title until it starts with `prefix` and the tab is not loading; the title then, or what stood. */
    protected fun awaitTitle(tabId: String, prefix: String, timeoutMs: Long = 20_000): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = coreState().getJSONObject("tabs").optJSONObject(tabId)
            val title = tab?.optString("title") ?: ""
            if (title.startsWith(prefix) && tab?.optBoolean("loading") != true) {
                SystemClock.sleep(800)
                return title
            }
            SystemClock.sleep(400)
        }
        return tabTitle(tabId)
    }

    protected fun reload(tabId: String): String {
        val visits = server.visits(hostOf(tabId))
        coreInvoke("tab.reload", """{"tabId":"$tabId","skipCache":true}""")
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline && server.visits(hostOf(tabId)) == visits) SystemClock.sleep(200)
        return awaitTitle(tabId, "sent:")
    }

    protected fun hostOf(tabId: String): String = if (tabId == KEEP_TAB) KEEP_HOST else DEMO_HOST

    protected fun activateTab(tabId: String) {
        if (activeCoreTab()?.optString("id") == tabId) return
        coreInvoke("tab.activate", """{"tabId":"$tabId"}""")
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline && activeCoreTab()?.optString("id") != tabId) SystemClock.sleep(250)
        SystemClock.sleep(1_000)
    }

    protected fun awaitSettled(timeoutMs: Long, settled: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(250)
        }
        return settled()
    }

    // --- the site-information sheet --------------------------------------------------------------

    /** The pill's site icon opens the site-information sheet (a finger; the start of the pill without the icon in the tree). */
    protected fun openSiteInfo() {
        ensureForeground()
        val icon = findByLabel(SITE_ICON_LABEL)?.takeIf { it.top > height * 0.6 }
        if (icon != null) Finger().tap(icon.exactCenterX(), icon.exactCenterY())
        else {
            note("  (site icon not in the accessibility tree; tapping the start of the pill)")
            Finger().tap(pill.left + 22 * density, pill.exactCenterY())
        }
    }

    // --- the tree read afresh ---------------------------------------------------------------------
    //
    // UiAutomation's view of the chrome WebView trails the screen by seconds after a Settings
    // drill-in on the emulator's software GPU (DemoHarness: "the tree read afresh"), and a static
    // section runs no frame of its own for Blink to serialise the change with. The first run
    // (35696836639) polled the cached tree for the section's heading for 12 s and never saw it
    // while the chrome document had it. Every read of a Settings row here drops the cache and
    // asks the document for a frame first; a finger that the tree keeps waiting lands on the box
    // the document gives for the same row. Not inside a measured scene: a frame asked of the
    // document is a frame in the statistics.

    /** UiAutomation's cache dropped and a frame asked of the chrome document, so the next tree read is the screen's. */
    protected fun fresh() {
        dropTreeCache()
        nudgeFrame()
    }

    /** The first node whose label or text `matches`, read afresh. */
    protected fun freshNode(matches: (String) -> Boolean): AccessibilityNodeInfo? {
        fresh()
        return findNode(matches)
    }

    /**
     * The whole accessible name of the first node whose name starts with `text` (read afresh),
     * else the chrome document's text for the Settings row or heading of those words (its label
     * and description as one line, marked "by the document"), else null.
     */
    protected fun nodeText(text: String): String? =
        freshNode { it.startsWith(text) }?.let { it.contentDescription ?: it.text }?.toString()
            ?: documentRowText(text)?.let { "$it (by the document)" }

    /**
     * Poll for a node whose name starts with `label` (a sheet row is named "label, value,
     * description" as parts, so [waitFor]'s exact match never sees it); its bounds, or null.
     */
    protected fun awaitPrefix(label: String, timeoutMs: Long = 8_000): Rect? =
        awaitNode(timeoutMs) { it.startsWith(label) }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    /** The BUTTON reading `label` exactly – a sheet's action, not its title of the same words (read afresh). */
    protected fun buttonNode(label: String): AccessibilityNodeInfo? {
        fresh()
        return findNodeWhere { n ->
            n.className?.toString() == "android.widget.Button" &&
                (n.text ?: n.contentDescription)?.toString()?.trim() == label
        }
    }

    /**
     * A finger on the button reading `label` (a sheet's control: the rule in [DemoHarness]), then
     * up to `timeoutMs` for `took` – the claim of the step, named by `effect`. False and a
     * warning when no such button shows within `findTimeoutMs`; a [touchFault] when the touch
     * went in and `took` never held.
     */
    protected fun touchButtonExpecting(
        label: String,
        effect: String,
        timeoutMs: Long = 5_000,
        findTimeoutMs: Long = 8_000,
        took: () -> Boolean
    ): Boolean {
        val deadline = SystemClock.uptimeMillis() + findTimeoutMs
        var node = buttonNode(label)
        while (node == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            node = buttonNode(label)
        }
        if (node == null) {
            Log.w(tag, "no button reading '$label' on screen")
            return false
        }
        if (!touchTap(node)) {
            touchFault("the '$label' button has no bounds on screen to touch")
            return false
        }
        if (awaitSettled(timeoutMs, took)) {
            Log.i(tag, "the touch on the '$label' button took: $effect")
            return true
        }
        touchFault("a touch on the '$label' button did not take: not $effect within $timeoutMs ms")
        return false
    }

    /** The soft keyboard, if it is up, sent away with a back (the IME takes the key before the app does). */
    protected fun dismissIme() {
        if (!imeShown()) return
        back()
        if (!awaitIme(shown = false, timeoutMs = 5_000)) note("  (the keyboard did not go)")
        SystemClock.sleep(500)
    }

    protected fun sheetCount(): Int = chromeValue("String(document.querySelectorAll('.zen-sheet').length)").toIntOrNull() ?: -1

    protected fun awaitNoSheet(timeoutMs: Long = 6_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline && sheetCount() != 0) SystemClock.sleep(200)
    }

    /** Back out of the sheets that are up, a few at most; each back is given until the closing sheet has left. */
    protected fun closeSheets() {
        var count = sheetCount()
        repeat(3) {
            if (count <= 0) return
            back()
            val deadline = SystemClock.uptimeMillis() + 6_000
            while (SystemClock.uptimeMillis() < deadline && sheetCount() >= count) SystemClock.sleep(200)
            count = sheetCount()
        }
    }

    // --- the Settings tab ------------------------------------------------------------------------

    /**
     * Settings › Privacy and Security: through the app menu's Settings row and the landing's
     * category row (fingers, each asserted) the first time, through `page.open` after. True once
     * the section's first row is in the tree.
     */
    protected fun openPrivacySettings(throughMenu: Boolean): Boolean {
        ensureForeground()
        if (throughMenu) {
            if (!openMenuItem("Settings")) {
                touchFault("no Settings row in the app menu to touch")
                closeSheets()
                coreInvoke("page.open", """{"id":"settings"}""")
            } else if (awaitPage(SETTINGS_URL, 12_000) == null) {
                touchFault("the touch on the app menu's Settings row did not open the Settings tab")
                closeSheets()
                coreInvoke("page.open", """{"id":"settings"}""")
            }
            if (awaitPage(SETTINGS_URL, 12_000) == null) return false
            SystemClock.sleep(1_200)
            if (rowBounds(SECTION, 8_000) == null) {
                Log.w(tag, "no $SECTION category on the landing")
            } else if (!touchTapLabelExpecting(SECTION, "the tab is at the section", prefix = true) {
                    activeCoreTab()?.optString("url") == PRIVACY_URL
                }
            ) {
                Log.w(tag, "the landing's $SECTION row did not take the tab to the section")
            }
            if (activeCoreTab()?.optString("url") != PRIVACY_URL) coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        } else {
            coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        }
        if (awaitPage(PRIVACY_URL, 12_000) == null) return false
        awaitSurface(up = true, timeoutMs = 6_000)
        // The section is there once the chrome document lays out the Cookies and site data group;
        // the tree is given a while to list its heading too, and noted when it does not (the
        // fingers go by the document's boxes either way).
        val inDocument = awaitChrome("document.querySelector('[data-group=\"site-data\"]')", 12_000)
        val start = SystemClock.uptimeMillis()
        val inTree = rowBounds("Cookies and site data", if (inDocument) 8_000 else 12_000) != null
        if (inDocument && !inTree) {
            note("  (the section is in the chrome document; the tree did not list its heading within ${SystemClock.uptimeMillis() - start} ms)")
        }
        SystemClock.sleep(800)
        return inDocument || inTree
    }

    /** Poll the chrome document until `code` is truthy, up to `timeoutMs`. */
    protected fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    protected fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url) return tab
            SystemClock.sleep(250)
        }
        return null
    }

    /**
     * The bounds of the first node whose accessible text reads `text` exactly or as a prefix (a
     * Settings row runs its label and description together); a node below the fold is scrolled
     * into view first. Polls the tree afresh each round ([fresh]), since it trails the screen on
     * the emulator; when it never lists the row within `timeoutMs`, the box the chrome document
     * gives for the Settings row or heading of those words, scrolled into view ([documentRowBounds]).
     */
    protected fun rowBounds(text: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var revealed = false
        do {
            val node = freshNode { it == text || it.startsWith(text) }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val onScreen = bounds.width() > 0 && bounds.height() > 0 &&
                    bounds.centerY() in 0 until height && bounds.centerX() in 0 until width
                if (onScreen) return bounds
                if (!revealed) {
                    revealed = true
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_000)
                    continue
                }
            }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        return documentRowBounds(text)?.also {
            Log.w(tag, "the tree did not list '$text' within $timeoutMs ms; the document has it at $it")
        }
    }

    protected fun revealRow(text: String): Rect? = rowBounds(text, 6_000)

    /** The chrome document's Settings rows and group headings (the phone page's), as a JS array expression. */
    private fun settingsRowsJs(): String =
        "Array.from(document.querySelectorAll('.zen-settings-phone [data-row], .zen-settings-phone .zen-settings-heading, .zen-sheet [data-row]'))"

    /** The first Settings row or heading whose text reads `text` exactly or as a prefix, as a JS expression over [settingsRowsJs]. */
    private fun documentRowJs(text: String): String =
        "(function(){var t=${JSONObject.quote(text)};return ${settingsRowsJs()}.find(function(x){" +
            "var s=(x.innerText||x.textContent||'').replace(/\\s+/g,' ').trim();return s===t||s.indexOf(t)===0})||null})()"

    /**
     * The screen rectangle of the Settings row or heading reading `text` by the chrome document,
     * scrolled into view first; null when the document has no such row.
     */
    protected fun documentRowBounds(text: String): Rect? {
        val raw = chromeJs(
            "(function(){var e=${documentRowJs(text)};if(!e)return null;e.scrollIntoView({block:'center'});" +
                "var r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()"
        )
        val box = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 4 } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        SystemClock.sleep(400)
        return Rect(
            origin[0] + (box.getDouble(0) * density).roundToInt(),
            origin[1] + (box.getDouble(1) * density).roundToInt(),
            origin[0] + (box.getDouble(2) * density).roundToInt(),
            origin[1] + (box.getDouble(3) * density).roundToInt()
        )
    }

    /** The text of the Settings row or heading reading `text` by the chrome document (its lines joined with ", "), or null. */
    protected fun documentRowText(text: String): String? =
        chromeValue("(function(){var e=${documentRowJs(text)};return e?(e.innerText||e.textContent||'').replace(/\\s*\\n+\\s*/g,', ').trim():null})()")
            .takeIf { it.isNotEmpty() }

    /** Where the middle of the first chrome element matching `selector` is on screen (scrolled into view), or null. */
    protected fun chromePoint(selector: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        SystemClock.sleep(400)
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    /** Where the PAGE row `rowId` (`data-row`) is on screen, scrolled into view; read before a measured scene. */
    protected fun pageRowPoint(rowId: String): PointF? = chromePoint("[data-row=${JSONObject.quote(rowId)}]")

    /**
     * A finger on the PAGE row `rowId` (`data-row`) at the chrome's own rectangle – the page's rows
     * repeat their labels ("Add a site" once per list), so the row is found by its id, scrolled
     * into view, and pressed where the chrome lays it out – and wait for `settled`.
     */
    protected fun tapPageRow(rowId: String, settled: () -> Boolean): Boolean {
        if (settled()) return true
        val point = pageRowPoint(rowId) ?: run {
            Log.w(tag, "no row $rowId in the chrome")
            return false
        }
        SystemClock.sleep(300)
        Finger().tap(point.x, point.y)
        if (awaitSettled(5_000, settled)) return true
        // The list may have moved under the first read (the tree trails a scroll): once more.
        val again = pageRowPoint(rowId) ?: return false
        Finger().tap(again.x, again.y)
        return awaitSettled(5_000, settled)
    }

    /**
     * Give the add sheet's field the focus with a finger at its own rectangle and type `text`
     * into it, read back from the chrome; typed over once when the emulator dropped keys
     * (AutofillDemo's lesson). True when the field holds the text.
     */
    protected fun typeIntoAddField(text: String): Boolean {
        val field = chromePoint("[data-testid=\"add-pattern-form\"] input")
        if (field != null) Finger().tap(field.x, field.y)
        else findNodeWhere { n -> n.isEditable }?.let { touchTap(it) } ?: note("  (no field to touch)")
        SystemClock.sleep(700)
        typeText(text)
        if (awaitSettled(3_000) { fieldValue() == text }) return true
        note("  typed '$text' but the field holds '${fieldValue()}'; typing it again")
        chromeJs("(function(){var i=document.querySelector('[data-testid=\"add-pattern-form\"] input');if(i){i.focus();i.select()}})()")
        SystemClock.sleep(400)
        typeText(text)
        return awaitSettled(3_000) { fieldValue() == text }
    }

    /** The picker's checkable row whose text starts with `option` (read afresh). */
    protected fun optionNode(option: String): AccessibilityNodeInfo? {
        fresh()
        return findNodeWhere { n -> n.isCheckable && (n.text?.toString() ?: n.contentDescription?.toString())?.startsWith(option) == true }
    }

    /**
     * A finger on the picker's option reading `option` (a sheet's control: the rule in
     * [DemoHarness]); `settled` must hold on it, else a [touchFault], and the accessibility click
     * is the way on so the recording goes on.
     */
    protected fun pickOption(option: String, effect: String, settled: () -> Boolean): Boolean {
        var node = optionNode(option) ?: run {
            Log.w(tag, "no option reading '$option' in the picker")
            return false
        }
        var touched = touchTap(node)
        if (!touched) {
            SystemClock.sleep(500)
            node = optionNode(option) ?: node
            touched = touchTap(node)
        }
        if (touched) {
            if (awaitSettled(5_000, settled)) {
                Log.i(tag, "the touch on the '$option' option took: $effect")
                return true
            }
            touchFault("the touch on the picker's '$option' option did not take: not $effect within 5000 ms")
        } else {
            touchFault("the picker's '$option' option has no bounds on screen to touch")
        }
        (optionNode(option) ?: node).performAction(AccessibilityNodeInfo.ACTION_CLICK)
        return awaitSettled(5_000, settled)
    }

    /** Type `text` as key events, each stamped as it is injected (a whole string at once goes stale on a slow emulator). */
    protected fun typeText(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (ch in text) {
            val events = map.getEvents(charArrayOf(ch)) ?: continue
            for (event in events) {
                val now = SystemClock.uptimeMillis()
                if (!ui.injectInputEvent(KeyEvent.changeTimeRepeat(event, now, 0), true)) note("  (a key was not injected)")
                SystemClock.sleep(40)
            }
        }
    }

    protected fun chromeValue(code: String): String =
        runCatching { org.json.JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Evaluate in the page of tab `tabId` (the demo page's WebView); the raw JSON-encoded result ("" when it never answered or has no view). */
    protected fun pageJs(code: String, tabId: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** How many cookies the page's `document.cookie` holds (the demo page's own view of its jar); -1 when the page did not answer. */
    protected fun pageCookieCount(tabId: String): Int {
        val raw = pageJs("String(document.cookie.split(';').filter(function(c){return c.trim()}).length)", tabId)
        return runCatching { org.json.JSONTokener(raw).nextValue() }.getOrNull()?.toString()?.toIntOrNull() ?: -1
    }

    /** The value of the add sheet's field, as the chrome holds it. */
    protected fun fieldValue(): String =
        chromeValue("(function(){var i=document.querySelector('[data-testid=\"add-pattern-form\"] input');return i?String(i.value):''})()")

    protected fun goHome() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    // --- the page's server -----------------------------------------------------------------------

    /**
     * Serves the demo page on the IPv4 loopback for two hosts told apart by the Host header
     * (`127.0.0.1`, the site the lists act on; `localhost`, the control on no list): every `/`
     * sets two cookies with a day to live and says which cookie names the request carried;
     * each request is kept (host, path, the Cookie header) for the driver's claims.
     */
    protected class CookiePage(private val template: String, port: Int) : Thread("site-data-demo-server") {
        class Request(val at: Long, val host: String, val path: String, val cookies: List<String>)

        // Every loopback address (dual-stack): `localhost` resolves to ::1 first on the emulator.
        private val socket = ServerSocket(port, 16)
        @Volatile private var closed = false
        val requests: MutableList<Request> = Collections.synchronizedList(ArrayList())
        private val visitsByHost = HashMap<String, Int>()

        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", socket.localPort).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET /ping HTTP/1.1\r\nHost: 127.0.0.1:${socket.localPort}\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                "listening on ${socket.localSocketAddress}, GET /ping -> ${s.getInputStream().bufferedReader().readLine()}"
            }
        }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET /ping failed: $e" }

        /** Page visits (`/`) the host has made so far. */
        fun visits(host: String): Int = synchronized(visitsByHost) { visitsByHost[host] ?: 0 }

        /** The page requests of `host` (no favicon, no ping), oldest first. */
        fun pageRequests(host: String): List<Request> = synchronized(requests) { requests.filter { it.host == host && it.path == "/" } }

        override fun run() {
            while (!closed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    if (closed) return else continue
                }
                Thread { serve(client) }.start()
            }
        }

        private fun serve(client: Socket) {
            client.use {
                val request = it.getInputStream().bufferedReader()
                val line = request.readLine() ?: return
                var hostHeader = ""
                var cookieHeader = ""
                while (true) {
                    val header = request.readLine()
                    if (header.isNullOrEmpty()) break
                    val colon = header.indexOf(':')
                    if (colon < 0) continue
                    val name = header.substring(0, colon).trim().lowercase()
                    val value = header.substring(colon + 1).trim()
                    if (name == "host") hostHeader = value
                    if (name == "cookie") cookieHeader = value
                }
                val path = line.split(' ').getOrNull(1)?.substringBefore('?') ?: "/"
                val host = hostHeader.substringBefore(':').ifEmpty { "127.0.0.1" }
                val names = cookieHeader.split(';').map { c -> c.trim().substringBefore('=') }.filter { c -> c.isNotEmpty() }
                requests += Request(SystemClock.uptimeMillis(), host, path, names)
                val out = it.getOutputStream()
                if (path != "/") {
                    val body = "ok\n".toByteArray()
                    out.write(("HTTP/1.1 ${if (path == "/ping") "200 OK" else "404 Not Found"}\r\nContent-Type: text/plain\r\nContent-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray())
                    out.write(body)
                    out.flush()
                    return
                }
                val visit = synchronized(visitsByHost) { ((visitsByHost[host] ?: 0) + 1).also { n -> visitsByHost[host] = n } }
                val sent = if (names.isEmpty()) "none" else names.joinToString(", ")
                val body = template
                    .replace("{{HOST}}", host)
                    .replace("{{VISIT}}", visit.toString())
                    .replace("{{SENT_COUNT}}", "${names.size} cookie${if (names.size == 1) "" else "s"} sent")
                    .replace("{{SENT_ATTR}}", if (names.isEmpty()) " data-none" else "")
                    .replace("{{SENT}}", sent)
                    .toByteArray()
                out.write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
                        "Set-Cookie: zen_demo=${host.replace('.', '-')}; Max-Age=86400; Path=/; SameSite=Lax\r\n" +
                        "Set-Cookie: zen_visit=$visit; Max-Age=86400; Path=/; SameSite=Lax\r\n" +
                        "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                )
                out.write(body)
                out.flush()
            }
        }

        fun close() {
            closed = true
            runCatching { socket.close() }
        }
    }

    companion object {
        const val PORT = 18131
        const val DEMO_TAB = "tab_demo"
        const val KEEP_TAB = "tab_keep"
        const val DEMO_HOST = "127.0.0.1"
        const val KEEP_HOST = "localhost"
        const val DEMO_URL = "http://$DEMO_HOST:$PORT/"
        const val KEEP_URL = "http://$KEEP_HOST:$PORT/"
        /** The demo site as the viewer names its row (an http origin is named whole; only https:// is dropped). */
        const val DEMO_ORIGIN = "http://$DEMO_HOST:$PORT"
        /** What `siteData.addSite` and the typed host make of the demo site (an IP literal stays exact). */
        const val DEMO_PATTERN = DEMO_HOST
        const val SECTION = "Privacy and Security"
        const val SITE_ICON_LABEL = "Site information"
        const val SETTINGS_URL = "zen://settings"
        const val PRIVACY_URL = "zen://settings/privacy"
        const val MOTION_MS = 1_800L
    }
}

/** Act one: the UI, the never-site, the viewer's Clear, the on-exit type, the app sent home with the marker written. */
@RunWith(AndroidJUnit4::class)
class SiteDataUiDemo : SiteDataUiDemoBase("site-data-demo-state.json", "services-site-data-android-ui", "site-data-ui-demo", keepProfile = false) {
    override val tag = "SiteDataUiDemo"

    override fun warmUp() {
        openNotes("Zenium Android site data UI demo, act one")
        // Both pages once, so each host's cookies are in the jar and the second load sends them.
        awaitTitle(DEMO_TAB, "sent:", 30_000)
        activateTab(KEEP_TAB)
        awaitTitle(KEEP_TAB, "sent:", 30_000)
        reload(KEEP_TAB)
        activateTab(DEMO_TAB)
        reload(DEMO_TAB)
        note("warm-up: demo ${tabTitle(DEMO_TAB)} | keep ${tabTitle(KEEP_TAB)} | jar demo=${jarCookie(DEMO_URL)} keep=${jarCookie(KEEP_URL)}")
        // The Settings page is a chunk of its own that loads on its first open: pay for it off camera.
        val warm = coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        val painted = awaitChrome("document.querySelector('[data-row=\"site-data-default\"]')", 20_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        activateTab(DEMO_TAB)
        note("warm-up: the Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera")
        val close = closeUrlField()
        note("URL field: ${close.describe()}")
    }

    override fun demo() {
        // 1. The page with its cookies: the second visit sent both.
        note("\n1. the page holding its cookies")
        val title = tabTitle(DEMO_TAB)
        claim("the demo page's second visit sent its two cookies", title == "sent: zen_demo, zen_visit", title)
        shot("01-page-cookies")
        beat()

        // 2. The site-information sheet: the cookies level's per-site row reads the default.
        note("\n2. the site-information sheet, cookies level")
        traceFrames("siteinfo-sheet-open", JankBudget.Kind.OPEN) {
            openSiteInfo()
            awaitPrefix("Cookies and site data", 8_000)
            SystemClock.sleep(MOTION_MS)
        }
        note("  root row: ${nodeText("Cookies and site data") ?: "(not in the tree)"}")
        shot("02-siteinfo-root")
        if (touchTapLabelExpecting("Cookies and site data", "the cookies level is up", prefix = true) { freshNode { it.startsWith("Cookies for this site") } != null }) {
            SystemClock.sleep(800)
            val row = nodeText("Cookies for this site")
            note("  per-site row: $row")
            claim("the per-site row reads Use the default", row?.contains("Use the default") == true, row ?: "")
            shot("03-siteinfo-cookies-default")
            beat()
            // The level pops first (a back at depth > 0 is the level's motion, not the sheet's).
            back()
            SystemClock.sleep(1_200)
        }
        if (sheetCount() > 0) {
            traceFrames("siteinfo-sheet-dismiss", JankBudget.Kind.SPRING) {
                back()
                SystemClock.sleep(MOTION_MS)
            }
        }
        awaitNoSheet()

        // 3. Settings › Privacy and Security › Cookies and site data.
        note("\n3. Settings > Privacy and Security > Cookies and site data")
        if (!openPrivacySettings(throughMenu = true)) {
            touchFault("the Settings tab never came to the Privacy and Security section")
            return
        }
        revealRow("Default behaviour")
        SystemClock.sleep(800)
        note("  default row: ${nodeText("Default behaviour")}")
        shot("04-settings-cookies-section")
        beat()

        // 4. The default's picker: Block all cookies (browser-wide), then back to Block third-party.
        note("\n4. the default's picker")
        val defaultRow = pageRowPoint("site-data-default")
        SystemClock.sleep(300)
        traceFrames("default-picker-open", JankBudget.Kind.OPEN, baseline = "siteinfo-sheet-open") {
            if (defaultRow != null) Finger().tap(defaultRow.x, defaultRow.y)
            awaitNode(6_000) { it.startsWith("Block all cookies") }
            SystemClock.sleep(MOTION_MS)
        }
        if (tapPageRow("site-data-default") { optionNode("Block all cookies") != null }) {
            SystemClock.sleep(800)
            note("  block-all option: ${optionNode("Block all cookies")?.let { it.text ?: it.contentDescription }}")
            shot("05-default-picker")
            beat()
            if (pickOption("Block all cookies", "the core's default is block-all") { siteData().optString("default") == "block-all" }) {
                awaitNoSheet()
                SystemClock.sleep(800)
                note("  default=${siteData().optString("default")} row: ${nodeText("Default behaviour")}")
                shot("06-default-block-all")
                beat()
            } else {
                closeSheets()
            }
            if (tapPageRow("site-data-default") { optionNode("Block third-party cookies") != null } &&
                pickOption("Block third-party cookies", "the core's default is block-third-party") { siteData().optString("default") == "block-third-party" }
            ) {
                awaitNoSheet()
            } else {
                closeSheets()
                coreInvoke("siteData.setDefault", """{"default":"block-third-party"}""")
            }
        } else {
            note("  the Default behaviour row did not open its picker")
        }

        // 5. The never list: Add a site, the host typed, Add; the row it makes; the jar swept.
        note("\n5. the never list: Add a site")
        revealRow("Sites that can never use cookies")
        SystemClock.sleep(600)
        shot("07-never-list-empty")
        val addRow = pageRowPoint("site-data-block-add")
        SystemClock.sleep(300)
        traceFrames("add-site-sheet-open", JankBudget.Kind.OPEN, baseline = "siteinfo-sheet-open") {
            if (addRow != null) Finger().tap(addRow.x, addRow.y)
            // The sheet's Cancel: nothing on the page reads it (the row's own label span does "Add a site").
            awaitNode(6_000) { it == "Cancel" }
            SystemClock.sleep(MOTION_MS)
        }
        if (tapPageRow("site-data-block-add") { awaitChrome("document.querySelector('[data-testid=\"add-pattern-form\"] input')", 1_000) }) {
            SystemClock.sleep(1_000)
            shot("08-add-site-sheet")
            beat()
            val typed = typeIntoAddField(DEMO_HOST)
            note("  typed: '${fieldValue()}'${if (typed) "" else " (not what was typed)"}")
            SystemClock.sleep(600)
            shot("09-add-site-typed")
            dismissIme()
            if (touchButtonExpecting("Add a site", "the pattern is on the never list") { listHolds("block", DEMO_PATTERN) }) {
                awaitNoSheet(8_000)
                SystemClock.sleep(1_000)
                revealRow(DEMO_PATTERN)
                SystemClock.sleep(600)
                claim("the never list's row reads the host", nodeText(DEMO_PATTERN)?.contains("Can never use cookies") == true, nodeText(DEMO_PATTERN) ?: "(no row)")
                claim("the site's cookies left the jar when it went on the never list", awaitSettled(5_000) { jarCookie(DEMO_URL) == null }, "jar=${jarCookie(DEMO_URL)}")
                shot("10-never-list-row")
                beat()
            } else {
                closeSheets()
                coreInvoke("siteData.add", """{"list":"block","pattern":"$DEMO_PATTERN"}""")
            }
        } else {
            note("  the never list's Add row did not open its sheet")
            coreInvoke("siteData.add", """{"list":"block","pattern":"$DEMO_PATTERN"}""")
        }

        // 6. The page asks again: the header stage relays a never-site's document without cookies.
        note("\n6. the never-site's page")
        activateTab(DEMO_TAB)
        val stripped = reload(DEMO_TAB)
        val last = server.pageRequests(DEMO_HOST).lastOrNull()
        claim("the never-site's request carried no cookie", stripped == "sent: none" && last?.cookies?.isEmpty() == true, "title=$stripped request cookies=${last?.cookies}")
        claim("no Set-Cookie of the relayed document reached the jar", jarCookie(DEMO_URL) == null, "jar=${jarCookie(DEMO_URL)}")
        shot("11-page-never-no-cookies")
        beat()
        openSiteInfo()
        awaitPrefix("Cookies and site data", 8_000)
        SystemClock.sleep(MOTION_MS)
        val root = nodeText("Cookies and site data")
        claim("the sheet's root row says Never allowed", root?.contains("Never allowed") == true, root ?: "")
        shot("12-siteinfo-never")
        if (touchTapLabelExpecting("Cookies and site data", "the cookies level is up", prefix = true) { freshNode { it.startsWith("Cookies for this site") } != null }) {
            SystemClock.sleep(800)
            val row = nodeText("Cookies for this site")
            claim("the per-site row reads Never allow · Listed as $DEMO_PATTERN", row?.contains("Never allow") == true && row.contains("Listed as $DEMO_PATTERN"), row ?: "")
            shot("13-siteinfo-cookies-never")
            beat()

            // 7. The row's picker moves the site to the clear-on-exit list.
            note("\n7. the per-site picker: Clear on exit")
            if (touchTapLabelExpecting("Cookies for this site", "the picker is up", prefix = true) { optionNode("Clear on exit") != null }) {
                SystemClock.sleep(800)
                shot("14-siteinfo-picker")
                beat()
                if (pickOption("Clear on exit", "the site is on the clear-on-exit list") { listHolds("clearOnExit", DEMO_PATTERN) && !listHolds("block", DEMO_PATTERN) }) {
                    awaitSettled(6_000) { nodeText("Cookies for this site")?.contains("Clear on exit") == true }
                    SystemClock.sleep(600)
                    note("  per-site row: ${nodeText("Cookies for this site")}")
                    shot("15-siteinfo-cookies-clear-on-exit")
                    beat()
                } else {
                    closeSheets()
                }
            }
        }
        closeSheets()
        awaitNoSheet()
        if (!listHolds("clearOnExit", DEMO_PATTERN)) {
            note("  (the picker did not move the site; moving it through the command)")
            coreInvoke("siteData.addSite", """{"list":"clearOnExit","url":"$DEMO_URL"}""")
        }

        // 8. Settings again: the allow list's Add and the pattern row's Remove.
        note("\n8. the allow list: Add, then the row's Remove")
        if (openPrivacySettings(throughMenu = false) && tapPageRow("site-data-allow-add") { awaitChrome("document.querySelector('[data-testid=\"add-pattern-form\"] input')", 1_000) }) {
            SystemClock.sleep(800)
            val typed = typeIntoAddField(ALLOW_PATTERN)
            note("  typed: '${fieldValue()}'${if (typed) "" else " (not what was typed)"}")
            SystemClock.sleep(400)
            dismissIme()
            if (touchButtonExpecting("Add a site", "the pattern is on the allow list") { listHolds("allow", ALLOW_PATTERN) }) {
                awaitNoSheet(8_000)
                SystemClock.sleep(1_000)
                revealRow(ALLOW_PATTERN)
                SystemClock.sleep(600)
                shot("16-allow-list-row")
                if (tapPageRow("site-data-site:$ALLOW_PATTERN") { freshNode { it.startsWith("Remove from the list") } != null }) {
                    SystemClock.sleep(800)
                    shot("17-pattern-sheet")
                    beat()
                    if (touchTapLabelExpecting("Remove", "the pattern left the allow list", prefix = true) { !listHolds("allow", ALLOW_PATTERN) }) {
                        awaitNoSheet(8_000)
                        SystemClock.sleep(800)
                        shot("18-allow-list-removed")
                    } else {
                        closeSheets()
                        coreInvoke("siteData.remove", """{"pattern":"$ALLOW_PATTERN"}""")
                    }
                }
            } else {
                closeSheets()
            }
        } else {
            note("  the allow list's Add row did not open its sheet")
        }
        closeSheets()

        // 9. The pages hold their cookies again (the never list's sweep took the demo site's).
        note("\n9. the pages' cookies back")
        activateTab(DEMO_TAB)
        reload(DEMO_TAB)
        val again = reload(DEMO_TAB)
        claim("the demo page sends its cookies again off the never list", again == "sent: zen_demo, zen_visit", again)
        activateTab(KEEP_TAB)
        val keep = reload(KEEP_TAB)
        claim("the control page sends its cookies", keep == "sent: zen_demo, zen_visit", keep)
        activateTab(DEMO_TAB)

        // 10. The viewer: the two origins, a row's Clear, Clear all's prompt cancelled.
        note("\n10. See all site data")
        if (openPrivacySettings(throughMenu = false)) {
            revealRow("See all site data and permissions")
            SystemClock.sleep(600)
            val clearDemo = "Clear $DEMO_ORIGIN"
            val viewerUp = { freshNode { it.startsWith(clearDemo) || it == "Clear all" } != null }
            val seeAll = pageRowPoint("site-data-see-all")
            SystemClock.sleep(300)
            traceFrames("viewer-sheet-open", JankBudget.Kind.OPEN, baseline = "siteinfo-sheet-open") {
                if (seeAll != null) Finger().tap(seeAll.x, seeAll.y)
                awaitNode(8_000) { it == "Clear all" }
                SystemClock.sleep(MOTION_MS)
            }
            if (!viewerUp()) tapPageRow("site-data-see-all", viewerUp)
            if (viewerUp()) {
                awaitSettled(8_000) { freshNode { it.startsWith(clearDemo) } != null }
                SystemClock.sleep(600)
                note("  viewer rows: ${chromeValue("JSON.stringify(Array.from(document.querySelectorAll('[data-row^=\"site-data-origin:\"]')).map(function(e){return e.getAttribute('data-row')+' :: '+e.innerText.replace(/\\n+/g,' | ')}))")}")
                note("  count aside: ${chromeValue("(function(){var e=document.querySelector('[data-testid=\"site-data-count\"]');return e?e.textContent:''})()")}")
                claim("the viewer lists the demo site with its cookies", freshNode { it.startsWith(clearDemo) } != null)
                shot("19-viewer")
                beat()
                if (touchButtonExpecting(clearDemo, "the demo site's cookies left the jar", timeoutMs = 10_000) { jarCookie(DEMO_URL) == null }) {
                    awaitSettled(6_000) { freshNode { it.startsWith(clearDemo) } == null }
                    SystemClock.sleep(800)
                    claim("the cleared origin's row left the viewer", freshNode { it.startsWith(clearDemo) } == null)
                    claim("the control site kept its cookies", jarCookie(KEEP_URL) != null, "jar=${jarCookie(KEEP_URL)}")
                    shot("20-viewer-cleared-row")
                    beat()
                }
                if (touchButtonExpecting("Clear all", "the prompt is up") { freshNode { it.startsWith("Clear all site data?") } != null }) {
                    SystemClock.sleep(800)
                    shot("21-clear-all-prompt")
                    beat()
                    if (touchButtonExpecting("Cancel", "the prompt left, the viewer stays") { freshNode { it.startsWith("Clear all site data?") } == null && buttonNode("Clear all") != null }) {
                        claim("Cancel kept the control site's cookies", jarCookie(KEEP_URL) != null, "jar=${jarCookie(KEEP_URL)}")
                    }
                }
                awaitSettled(4_000) { sheetCount() == 1 }
                traceFrames("viewer-sheet-dismiss", JankBudget.Kind.SPRING, baseline = "siteinfo-sheet-dismiss") {
                    back()
                    SystemClock.sleep(MOTION_MS)
                }
                awaitNoSheet()
            } else {
                note("  the viewer did not open")
            }
        }

        // 11. Delete browsing data on exit: Browsing history on (it stays on for act two).
        note("\n11. Delete browsing data on exit")
        if (revealRow("Delete browsing data on exit") != null) {
            SystemClock.sleep(600)
            shot("22-exit-types")
            if (tapPageRow("site-data-exit:history") { exitTypes().contains("history") }) {
                SystemClock.sleep(800)
                note("  types=${exitTypes()} description: ${chromeValue("(function(){var g=document.querySelector('[data-group=\"site-data-exit\"] .zen-settings-group-description');return g?g.textContent:''})()")}")
                shot("23-exit-history-on")
                beat()
            } else {
                note("  the Browsing history row did not toggle; setting it through the command")
                val privacy = coreState().getJSONObject("settings").optJSONObject("privacy") ?: JSONObject()
                privacy.put("clearOnExit", JSONObject().put("types", JSONArray().put("history")))
                coreInvoke("settings.update", JSONObject().put("privacy", privacy).toString())
            }
        }
        val historyBefore = historyHosts()
        note("  history before the close: ${historyBefore.size} entries, hosts $historyBefore")
        claim("the control site is in the history before the close (what act two must find gone)", historyBefore.contains(KEEP_HOST), historyBefore.toString())

        // 12. The pages hold their cookies; the jar flushed; the app sent home: the marker.
        note("\n12. cookies held, the app sent home")
        activateTab(DEMO_TAB)
        reload(DEMO_TAB)
        val held = reload(DEMO_TAB)
        claim("the demo page sends its cookies before the close", held == "sent: zen_demo, zen_visit", held)
        claim("both hosts hold cookies in the jar", jarCookie(DEMO_URL) != null && jarCookie(KEEP_URL) != null, "demo=${jarCookie(DEMO_URL)} keep=${jarCookie(KEEP_URL)}")
        Profiles.cookieManager(Profiles.DEFAULT_CONTAINER).flush()
        SystemClock.sleep(1_500)
        shot("24-page-before-close")
        val closeField = closeUrlField()
        note("  URL field: ${closeField.describe()}")
        beat()
        goHome()
        val marker = awaitMarker(15_000)
        claim("the core wrote the pending-clear marker on the way to the background", marker != null, marker?.toString() ?: "no marker in sitedata.json")
        note("  marker: $marker")
        note("  siteData status: ${siteData()}")
        SystemClock.sleep(1_500)
        shot("25-home-marker-written")
        note("\nact one done: the process is stopped by the script; act two starts cold")
    }

    private fun awaitMarker(timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            pendingMarker()?.let { return it }
            SystemClock.sleep(300)
        }
        return pendingMarker()
    }

    companion object {
        private const val ALLOW_PATTERN = "[*.]example.org"
    }
}

/**
 * Act two: the cold start with the pending clear and the restored session – the profile and the
 * WebView's caches as act one's process left them (`keepProfile`). The first request the
 * restored demo page makes must carry no cookie, the control site's must, the history must be
 * empty, the marker consumed.
 */
@RunWith(AndroidJUnit4::class)
class SiteDataRestoreDemo : SiteDataUiDemoBase(null, "services-site-data-android-restore", "site-data-restore-demo", keepProfile = true) {
    override val tag = "SiteDataRestoreDemo"

    /** Wall-clock ms a little before this act's launch: what act one wrote is minutes older. */
    private var coldStartMs = 0L

    override fun warmUp() {
        coldStartMs = System.currentTimeMillis() - 60_000
        openNotes("Zenium Android site data UI demo, act two: the cold start with the pending clear")
        // The restored session's active tab should be the demo page (act one left it there); a
        // tab the restore does not show is restored when it is activated, and its first load
        // after the cold start is what the claims read – the saved title says "sent: …" from
        // before the close until then, so the wait is on the server's request, not the title.
        val active = activeCoreTab()?.optString("id")
        note("active tab after the cold start: $active (tabs ${coreState().getJSONObject("tabs").length()})")
        if (active != DEMO_TAB) {
            note("  (act one did not leave the demo tab active; activating it)")
            activateTab(DEMO_TAB)
        }
        val first = awaitFirstRequest(DEMO_HOST, 40_000)
        note("first request of $DEMO_HOST after the cold start: ${first?.let { "cookies=${it.cookies}" } ?: "(none within 40 s)"}")
        val title = awaitTitle(DEMO_TAB, "sent:", 20_000)
        note("restored page title: $title")
        note("server requests so far: ${describeRequests()}")
        val close = closeUrlField()
        note("URL field: ${close.describe()}")
    }

    /** Poll for the first page request `host` makes of the server, up to `timeoutMs`. */
    private fun awaitFirstRequest(host: String, timeoutMs: Long): CookiePage.Request? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            server.pageRequests(host).firstOrNull()?.let { return it }
            SystemClock.sleep(250)
        }
        return server.pageRequests(host).firstOrNull()
    }

    /** Every page request the server saw, oldest first, as "host cookies=[…]". */
    private fun describeRequests(): String =
        (server.pageRequests(DEMO_HOST) + server.pageRequests(KEEP_HOST)).sortedBy { it.at }
            .joinToString("; ") { "${it.host} cookies=${it.cookies}" }
            .ifEmpty { "none" }

    override fun demo() {
        // 1. The restored page: its first request carried no cookie; the document holds none.
        note("\n1. the restored page after the cold start")
        val requests = server.pageRequests(DEMO_HOST)
        val first = requests.firstOrNull()
        claim("the restored page's first request carried no cookie", first != null && first.cookies.isEmpty(), "requests=${requests.map { it.cookies }}")
        claim("the restored page's title says none was sent", awaitSettled(10_000) { tabTitle(DEMO_TAB) == "sent: none" }, tabTitle(DEMO_TAB))
        // The visit that just answered set the two cookies again (Set-Cookie on the response), so
        // the document reads them now: what it must not hold is the pair from before the close,
        // which the request above shows gone. Noted, not claimed.
        note("  document.cookie after the restored visit: ${pageCookieCount(DEMO_TAB)} cookie(s)")
        claim("the clear-on-exit list still holds the site", listHolds("clearOnExit", DEMO_PATTERN), siteData().optJSONArray("clearOnExit")?.toString() ?: "")
        claim("the marker was consumed", awaitSettled(15_000) { !siteData().optBoolean("pendingClear") && pendingMarker() == null }, "status=${siteData().optBoolean("pendingClear")} file=${pendingMarker()}")
        claim("the control site on no list kept its cookies", jarCookie(KEEP_URL) != null, "keep=${jarCookie(KEEP_URL)}")
        // The restored page's own visit is recorded after the launch-time clear; every entry from
        // before the close – minutes older than this act's launch – must be gone.
        val history = historyEntries()
        val stale = history.filter { it.optLong("firstVisit", it.optLong("lastVisit")) < coldStartMs }
        claim("the on-exit type Browsing history ran at the launch: no entry from before the close remains", stale.isEmpty(), "entries=${history.map { describeEntry(it) }} launch=$coldStartMs")
        note("  jar now: demo=${jarCookie(DEMO_URL)} (the visit just set them again) keep=${jarCookie(KEEP_URL)}")
        shot("01-restored-page-no-cookies")
        beat()

        // 2. The site-information sheet: the site still on the clear-on-exit list.
        note("\n2. the site-information sheet after the restore")
        traceFrames("siteinfo-sheet-open-restored", JankBudget.Kind.OPEN) {
            openSiteInfo()
            awaitPrefix("Cookies and site data", 8_000)
            SystemClock.sleep(MOTION_MS)
        }
        note("  root row: ${nodeText("Cookies and site data")}")
        if (touchTapLabelExpecting("Cookies and site data", "the cookies level is up", prefix = true) { freshNode { it.startsWith("Cookies for this site") } != null }) {
            SystemClock.sleep(800)
            val row = nodeText("Cookies for this site")
            claim("the per-site row still reads Clear on exit", row?.contains("Clear on exit") == true, row ?: "")
            shot("02-siteinfo-after-restore")
            beat()
            back()
            SystemClock.sleep(1_200)
        }
        if (sheetCount() > 0) {
            traceFrames("siteinfo-sheet-dismiss-restored", JankBudget.Kind.SPRING) {
                back()
                SystemClock.sleep(MOTION_MS)
            }
        }
        awaitNoSheet()

        // 3. The control tab: its page sends the cookies it kept.
        note("\n3. the control site")
        activateTab(KEEP_TAB)
        val keep = awaitTitle(KEEP_TAB, "sent:", 30_000)
        val keepTitle = if (keep == "sent: zen_demo, zen_visit") keep else reload(KEEP_TAB)
        claim("the control page sends the cookies it kept across the close", keepTitle == "sent: zen_demo, zen_visit", keepTitle)
        shot("03-control-page-kept-cookies")
        beat()

        // 4. Settings: the list's row and the on-exit type as they were left.
        note("\n4. Settings after the restore")
        if (openPrivacySettings(throughMenu = false)) {
            revealRow("Always clear cookies when Zenium closes")
            SystemClock.sleep(800)
            note("  clear-on-exit row: ${nodeText(DEMO_PATTERN)}")
            shot("04-settings-after-restore")
            revealRow("Delete browsing data on exit")
            SystemClock.sleep(800)
            note("  exit types: ${exitTypes()}")
            shot("05-settings-exit-after-restore")
        }
        note("\nact two done")
    }
}
