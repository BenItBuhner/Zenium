package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import kotlin.math.roundToInt

/**
 * OMN-04, zero-suggest on focus (W6-S25-d), under a REAL finger, for the
 * `android-omnibox-zero-suggest-demo` workflow – five scenes, each with its claim read off the
 * chrome's DOM or the core's state, never off the still alone:
 *
 *  1. The empty field over a web page offers, before anything is typed: the MOST VISITED sites
 *     as a row of tiles first (Chrome's `MostVisitedSitesProvider` carousel; the new tab page's
 *     own list – `NewTabService.mostVisited()` – at most 8 of the 9 hosts the history holds),
 *     then the RECENT SEARCHES read back out of the history through the default engine's
 *     template (the two searches seeded on it, most recent first, each under the clock glyph –
 *     Chrome's `SEARCH_HISTORY` glyph), then the RECENTLY VISITED pages that are neither a tile
 *     nor a search (the two inner pages and the ninth host). On the tablet the field holds the
 *     page's address selected, untyped, and asks for the same list (Chrome's on-focus
 *     `kInteractionFocus` zero-prefix suggest). Typing one letter takes the tiles away: the
 *     typed branch is as it was.
 *  2. A REAL touch on the first recent search runs the search: the engine's results page for the
 *     terms is the active tab (the server saw the request), the field closed.
 *  3. A REAL touch on a tile opens its site.
 *  4. The new tab page's field offers the recent searches and no tiles – the page has them
 *     (Chrome's `SupportsMostVisitedSites` leaves the NTP out).
 *
 * The list is composed per focus, never at boot: `SuggestionService.emptyState`
 * (core/suggestions.ts) runs from `rows()` when the chrome asks with an empty query; the boot
 * path (P0) is untouched. Two sites of the driver's own on the loopback ([DemoServer]):
 * 127.0.0.1 is the seeded default engine's and the demo page's, 127.0.0.2 the tile touched in
 * scene 3; the other seven hosts of the history are never navigated to and need no server (a tile
 * for a closed site asks the network for nothing – HB-47). Findings in
 * `android-omnibox-zero-suggest-findings.txt` next to the frames; the run FAILS when a claim does
 * not hold, and a touch that does not take is a fault ([DemoHarness.touchTapLabelExpecting]).
 * On the tablet the keyboard is put away before each still and touch ([keyboardAway]: the
 * chassis's list runs under it); each still is taken behind a frame fence ([steadyShot], the
 * group suggestion demo's). See [DemoHarness] for the plumbing and its rule on real touches
 * versus accessibility clicks.
 */
@RunWith(AndroidJUnit4::class)
class OmniboxZeroSuggestDemo : DemoHarness("omnibox-zero-suggest-demo-state.json", "android-omnibox-zero-suggest", "omnibox-zero-suggest-demo") {
    override val tag = "OmniboxZeroSuggestDemo"
    private lateinit var home: DemoServer
    private lateinit var weather: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var formFactor = "phone"

    @Test
    fun record() {
        home = DemoServer(PORT, homeRoutes()).also { it.start() }
        weather = DemoServer(PORT, weatherRoutes(), address = WEATHER_HOST).also { it.start() }
        try {
            runDemo()
        } finally {
            if (THEME == "dark") shell("cmd uimode night no")
            home.close()
            weather.close()
        }
        if (failures.isNotEmpty()) error("zero-suggest did not hold up under a finger: ${failures.joinToString("; ")}")
    }

    /** The theme the profile is born in. */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /**
     * The history the list is read from: the demo page and two searches on the default engine
     * (127.0.0.1), eight more hosts (127.0.0.2 … 127.0.0.9) so the tile row's cap of 8 shows, and
     * two inner pages on tile hosts plus the ninth host for the recently visited rows. Stamps in
     * minutes, each distinct, so the order is the seed's.
     */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val history = STAMP.replace(readAsset("omnibox-zero-suggest-demo-history.json")) { m ->
            val minutes = m.groupValues[1].toLongOrNull() ?: 0L
            (now - minutes * 60_000L).toString()
        }
        File(zen, "history.json").writeText(history)
    }

    /** The system's colour scheme before the app starts, so the app is born in it. */
    override fun beforeLaunch() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    override fun warmUp() {
        findings = File(out, "android-omnibox-zero-suggest-findings.txt")
        findings.writeText(
            "Zenium Android omnibox zero-suggest check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, $THEME)\n" +
                "sites: ${home.selfCheck()}; ${weather.selfCheck()}\n\n"
        )
        val loaded = awaitChrome("true", 1_000) && awaitPageUrl(HOME_URL, 20_000)
        formFactor = chromeValue("document.documentElement.dataset.formFactor||''").ifEmpty { "phone" }
        finding("warm-up: the seeded page ${if (loaded) "is up" else "did NOT report complete"}; form factor $formFactor")
        // The first open pays for the editor's layout and the list's first fetch: off camera.
        armFingerProbe()
        tapPill()
        var field = awaitField(8_000)
        if (!field && fingers() == 0) {
            finding("warm-up: the pill's tap opened no field and the chrome's document saw no finger (pointerdowns 0): the emulator's input pipeline, not the chrome; the display override ${reapplyDisplayOverride()}; the pill again")
            tapPill()
            field = awaitField(8_000)
        }
        SystemClock.sleep(1_000)
        closeField()
        settle(6_000)
        finding("warm-up: the editor opened once off camera (field ${if (field) "seen" else "NOT seen"}; fingers the document saw ${fingers()})")
    }

    /** Whether a finger reaches the chrome's document at all: a count of the pointerdowns on it (the group suggestion demo's probe). */
    private fun armFingerProbe() {
        chromeJs("(function(){if(window.__zenFingers==null){window.__zenFingers=0;document.addEventListener('pointerdown',function(){window.__zenFingers++},true)}return 1})()")
    }

    private fun fingers(): Int = chromeValue("String(window.__zenFingers||0)").toIntOrNull() ?: 0

    /** The display's size and density overrides read back and applied afresh (the group suggestion demo's remedy for a dropped input pipeline). */
    private fun reapplyDisplayOverride(): String {
        val size = shell("wm size")
        val density = shell("wm density")
        val was = (size.trim() + "; " + density.trim()).replace(Regex("\\s*\\n\\s*"), ", ")
        val overrideSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1) ?: return "$was – no size override to apply afresh"
        val overrideDensity = Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
        Log.w(tag, "the finger never reached the document; the display override applied afresh ($was)")
        shell("wm size reset")
        SystemClock.sleep(2_000)
        shell("wm size $overrideSize")
        if (overrideDensity != null) shell("wm density $overrideDensity")
        SystemClock.sleep(4_000)
        ensureForeground()
        return "$was – applied afresh"
    }

    override fun demo() {
        // 1. The list on focus, and the typed branch untouched.
        step("OMN-04 the empty field over a web page offers the most visited tiles, the recent searches and the recently visited pages") {
            if (!showHomePage()) error("the demo page is not the active tab")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 4_000)
            val listed = awaitZeroSuggest()
            keyboardAway("the still")
            steadyShot("01-zero-suggest")
            val card = readCard()
            finding("  field reads '${fieldValue()}'; tiles: ${card.tiles.joinToString(" | ") { "'${it.label}' ${it.url}" }}")
            finding("  rows from the field outward: ${card.rows.joinToString(" | ") { "${it.kind} '${it.title}'" + (if (it.section.isNotEmpty()) " [${it.section}]" else "") + (if (it.clock) " (clock)" else "") }}")
            if (card.headings.isNotEmpty()) finding("  headings: ${card.headings.joinToString(" | ")}")
            // The tiles: first in the list, the new tab page's eight of the nine hosts, most visited first.
            val eight = card.tiles.size == 8
            val theSites = card.tiles.map { it.url } == TILE_URLS
            val tileSize = card.tiles.firstOrNull()?.let { "${it.w.roundToInt()}x${it.h.roundToInt()}" } ?: "-"
            finding("  the tile row first in the list ${card.tilesFirst}; ${card.tiles.size} tiles of 9 hosts (the cap of 8) $eight; the new tab page's sites, most visited first $theSites; a tile $tileSize CSS px, the row ${"%.0f".format(card.tilesHeight)} tall, ${card.tiles.count { it.onScreen }} of them in view before a scroll ${verdict(card.tilesFirst && eight && theSites)}")
            if (!card.tilesFirst || !eight || !theSites) failures += "the tile row is not the new tab page's eight, first (first ${card.tilesFirst}, tiles ${card.tiles.map { it.url }})"
            // The recent searches: the two the history holds on the default engine, most recent first, under the clock.
            val searches = card.rows.filter { it.kind == "search" }
            val terms = searches.map { it.title } == listOf(FIRST_TERMS, SECOND_TERMS)
            val clocks = searches.isNotEmpty() && searches.all { it.clock }
            val headed = card.headings.contains(RECENT_SEARCHES) && (formFactor == "tablet" || searches.all { it.section == RECENT_SEARCHES })
            finding("  recent searches read out of the history: ${searches.map { "'${it.title}'" }} (most recent first) $terms; each under the clock $clocks; headed '$RECENT_SEARCHES' $headed ${verdict(terms && clocks && headed)}")
            if (!terms || !clocks || !headed) failures += "the recent searches are not the history's two under the clock (rows ${searches.map { it.title }}, clocks ${searches.map { it.clock }}, headings ${card.headings})"
            // The recently visited pages: neither a tile's page nor a search's results page.
            val visited = card.rows.filter { it.kind == "history" }
            val pages = visited.map { it.title } == VISITED_TITLES
            val ordered = card.rows.indexOfFirst { it.kind == "history" } > card.rows.indexOfLast { it.kind == "search" }
            finding("  recently visited: ${visited.map { "'${it.title}'" }} – the pages that are no tile and no search $pages; after the searches $ordered ${verdict(pages && ordered)}")
            if (!pages || !ordered) failures += "the recently visited rows are not the pages left over (rows ${visited.map { it.title }})"
            val row = searches.firstOrNull()
            if (row != null) finding("  the first recent search: spoken '${row.label}', ${"%.0f".format(row.height)} CSS px tall; ${if (formFactor == "tablet") "the list's" else "the sheet's"} row")
            if (!listed) failures += "the zero-suggest list did not stand still with tiles, searches and pages within 15 s"
            // Typing a letter: the typed branch, no tiles.
            instrumentation.sendStringSync(TYPED)
            val typed = awaitChrome("(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(TYPED)}&&!document.querySelector('$TILES')&&!document.querySelector('$ROWS_LEAVING')", 12_000)
            awaitEngineRows()
            keyboardAway("the typed still")
            steadyShot("02-typed-no-tiles")
            val typedCard = readCard()
            val noTiles = typedCard.tiles.isEmpty() && !typedCard.headings.contains(RECENT_SEARCHES)
            finding("  typed '$TYPED': rows ${typedCard.rows.joinToString(" | ") { "${it.kind} '${it.title}'" }}; headings ${typedCard.headings}; no tiles and no zero-suggest heading $noTiles ${verdict(typed && noTiles)}")
            if (!typed || !noTiles) failures += "typing left the zero-suggest tiles up (tiles ${typedCard.tiles.size}, headings ${typedCard.headings})"
            closeField()
            settle(6_000)
        }

        // 2. The touch on a recent search.
        step("OMN-04 the touch on a recent search runs the search") {
            if (!showHomePage()) error("the demo page is not the active tab")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 4_000)
            awaitZeroSuggest()
            keyboardAway("the touch")
            val before = home.hits(SEARCH_PATH)
            // THE touch: the row, found by its text (the terms lead the option's spoken text).
            val took = touchTapLabelExpecting(FIRST_TERMS, "the engine's results page for the terms is the active tab", timeoutMs = 10_000, prefix = true) {
                runCatching { activeCoreTab()?.optString("url") }.getOrNull() == FIRST_SEARCH_URL
            }
            val closed = awaitChrome("!document.querySelector('$FIELD')", 8_000)
            val landed = awaitPageUrl(FIRST_SEARCH_URL, 10_000)
            val served = awaitTrue(8_000) { home.hits(SEARCH_PATH) > before }
            SystemClock.sleep(1_500)
            steadyShot("03-recent-search-run")
            val active = activeCoreTab()
            finding("  the touch ${if (took) "took" else "did NOT take"}; field closed $closed; active tab at '${active?.optString("url")}' titled '${active?.optString("title")}' (loaded $landed); the engine's results page requested $served ${verdict(took && closed && landed && served)}")
            if (!took || !closed || !landed || !served) failures += "the touch on the recent search did not run the search (took $took, closed $closed, landed $landed, served $served)"
        }

        // 3. The touch on a tile.
        step("OMN-04 the touch on a most visited tile opens the site") {
            if (!showHomePage()) error("the demo page is not the active tab")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 4_000)
            awaitZeroSuggest()
            keyboardAway("the touch")
            val before = weather.hits("/")
            val took = touchTapLabelExpecting(WEATHER_LABEL, "the tile's site is the active tab", timeoutMs = 10_000) {
                runCatching { activeCoreTab()?.optString("url") }.getOrNull() == WEATHER_URL
            }
            val closed = awaitChrome("!document.querySelector('$FIELD')", 8_000)
            val landed = awaitPageUrl(WEATHER_URL, 10_000)
            val served = awaitTrue(8_000) { weather.hits("/") > before }
            SystemClock.sleep(1_500)
            steadyShot("04-tile-opened")
            finding("  the touch on the '$WEATHER_LABEL' tile ${if (took) "took" else "did NOT take"}; field closed $closed; the site up $landed (requested $served) ${verdict(took && closed && landed)}")
            if (!took || !closed || !landed) failures += "the touch on the tile did not open its site (took $took, closed $closed, landed $landed)"
        }

        // 4. The new tab page: no tiles, the page has them.
        step("OMN-04 the new tab page's field offers the recent searches and no tiles") {
            settle(8_000)
            closeField()
            coreInvoke("tab.new")
            val page = awaitChrome("!!document.querySelector('$NTP_FIELD')", 10_000)
            SystemClock.sleep(1_500)
            ensureForeground()
            finding("  a new tab: the page's field up $page")
            if (!page) error("the new tab page did not come up")
            val fieldAt = rectOnScreen("document.querySelector('$NTP_FIELD')") ?: error("the page's field has no place on screen")
            Finger().tap(fieldAt.exactCenterX(), fieldAt.exactCenterY())
            if (!awaitField(8_000)) error("the tap on the page's field opened no editor")
            awaitIme(shown = true, timeoutMs = 4_000)
            val listed = awaitChrome("document.querySelectorAll('$SEARCH_ROWS').length>=2&&!document.querySelector('$ROWS_LEAVING')", 15_000)
            SystemClock.sleep(800)
            keyboardAway("the still")
            steadyShot("05-new-tab-page-no-tiles")
            val card = readCard()
            val noTiles = card.tiles.isEmpty()
            val searches = card.rows.filter { it.kind == "search" }.map { it.title } == listOf(FIRST_TERMS, SECOND_TERMS)
            finding("  over the new tab page: tiles ${card.tiles.size} (the page shows them) $noTiles; recent searches ${card.rows.filter { it.kind == "search" }.map { "'${it.title}'" }} $searches; rows ${card.rows.joinToString(" | ") { "${it.kind} '${it.title}'" }} ${verdict(listed && noTiles && searches)}")
            if (!listed || !noTiles || !searches) failures += "the new tab page's list is not the recent searches without tiles (tiles ${card.tiles.size}, searches ${card.rows.filter { it.kind == "search" }.map { it.title }})"
            closeField()
            settle(6_000)
        }

        finding("\nend: ${failures.size} failure(s)")
    }

    // --- the card ---------------------------------------------------------------------------------

    private class Tile(val label: String, val url: String, val w: Double, val h: Double, val onScreen: Boolean)

    private class Row(val kind: String, val title: String, val subtitle: String, val section: String, val clock: Boolean, val label: String, val height: Double)

    private class Card(val headings: List<String>, val tiles: List<Tile>, val tilesFirst: Boolean, val tilesHeight: Double, val rows: List<Row>)

    /** The card as it stands, from the field outward: the headings' labels, the tile row and every row that is not on its way out. */
    private fun readCard(): Card {
        val json = runCatching { JSONObject(chromeValue(CARD_JS).ifEmpty { "{}" }) }.getOrElse { JSONObject() }
        val headings = json.optJSONArray("headings") ?: JSONArray()
        val tiles = json.optJSONArray("tiles") ?: JSONArray()
        val rows = json.optJSONArray("rows") ?: JSONArray()
        return Card(
            (0 until headings.length()).map { headings.getString(it) },
            (0 until tiles.length()).map { i ->
                val t = tiles.getJSONObject(i)
                Tile(t.optString("label"), t.optString("url"), t.optDouble("w", 0.0), t.optDouble("h", 0.0), t.optBoolean("onScreen"))
            },
            json.optBoolean("tilesFirst"),
            json.optDouble("tilesHeight", 0.0),
            (0 until rows.length()).map { i ->
                val r = rows.getJSONObject(i)
                Row(r.optString("kind"), r.optString("title"), r.optString("subtitle"), r.optString("section"), r.optBoolean("clock"), r.optString("label"), r.optDouble("h", 0.0))
            }
        )
    }

    /** The zero-suggest list standing still: the tile row, two search rows, a history row, nothing on its way out. */
    private fun awaitZeroSuggest(): Boolean = awaitChrome(
        "document.querySelector('$TILES')&&document.querySelectorAll('$SEARCH_ROWS').length>=2&&document.querySelectorAll('$HISTORY_ROWS').length>=1&&!document.querySelector('$ROWS_LEAVING')",
        15_000
    ).also { SystemClock.sleep(800) }

    /** The engine's rows – asynchronous, from the suggest endpoint – in the card before a still: the typed row alone is one search row. */
    private fun awaitEngineRows(): Boolean = awaitChrome("document.querySelectorAll('$SEARCH_ROWS').length>=2", 6_000)

    // --- the pill, the field, the page --------------------------------------------------------------

    /**
     * A finger on the address pill: on the phone where the harness's [pillPoint] says; on the
     * tablet the toolbar's pill by its own name (a group labelled `Address`), guarded by the
     * touchable band – the group suggestion demo's lesson.
     */
    private fun tapPill() {
        val p = if (formFactor == "tablet") tabletPillPoint() else pillPoint()
        Finger().tap(p.x, p.y)
    }

    private fun tabletPillPoint(): PointF {
        ensureForeground()
        val found = findByLabelPrefix(PILL_LABEL)
        if (found != null && touchable.contains(found.centerX(), found.centerY())) return PointF(found.exactCenterX(), found.exactCenterY())
        Log.w(tag, "the tablet toolbar's pill is not in the tree where a finger can reach it ($found, touchable $touchable); the harness's pill point")
        return pillPoint()
    }

    private fun openField(): Boolean {
        settle(8_000)
        SystemClock.sleep(500)
        tapPill()
        if (awaitField(8_000)) return true
        finding("  the pill's tap opened no field in 8 s (bar open ${urlbarOpen()}); the pill again")
        settle(6_000)
        SystemClock.sleep(500)
        tapPill()
        return awaitField(8_000)
    }

    private fun awaitField(timeoutMs: Long): Boolean = awaitChrome("!!document.querySelector('$FIELD')", timeoutMs)

    /**
     * The first search row's place against the keyboard, measured and reported on both chassis;
     * on the tablet the keyboard is then put away (one back; the field and the list survive it),
     * since that chassis's list runs under the keyboard and a row there is nowhere a finger can
     * reach – the group suggestion demo's finding. The phone's sheet stands above the keyboard
     * by design; there this only measures.
     */
    private fun keyboardAway(what: String) {
        val row = rowOnScreen()
        val inset = imeInset()
        val keyboardTop = height - inset
        if (row != null) {
            finding("  the first search row on screen at y ${row.top}–${row.bottom}; the keyboard's top edge at $keyboardTop (inset $inset px): ${if (inset == 0) "no keyboard up" else if (row.bottom <= keyboardTop) "the row in a finger's reach" else "the row UNDER the keyboard"}")
        }
        if (formFactor != "tablet" || inset == 0) return
        back()
        val down = awaitIme(shown = false, timeoutMs = 6_000)
        val stayed = awaitChrome("!!document.querySelector('$FIELD')&&!!document.querySelector('$LIST')", 4_000)
        SystemClock.sleep(800)
        finding("  the tablet's keyboard put away before $what: the keyboard ${if (down) "down" else "still up"}; the field and the list ${if (stayed) "stayed" else "did NOT stay"}")
        if (!stayed) failures += "the back that put the tablet's keyboard away before $what took the field or the list with it"
    }

    /** Where the first search row is on screen once the list stands still (two reads 300 ms apart agree, nothing leaving); null when there is none. */
    private fun rowOnScreen(): Rect? {
        var last: Rect? = null
        val deadline = SystemClock.uptimeMillis() + 3_000
        while (SystemClock.uptimeMillis() < deadline) {
            val now = rectOnScreen("document.querySelector('$SEARCH_ROWS')") ?: return null
            val leaving = chromeValue("String(!!document.querySelector('$ROWS_LEAVING'))") == "true"
            if (now == last && !leaving) return now
            last = now
            SystemClock.sleep(300)
        }
        Log.w(tag, "the search row still moving after 3 s: $last")
        return last
    }

    /** An element's place on screen: the document's rect scaled into the chrome view's place; null when `elementJs` finds nothing. */
    private fun rectOnScreen(elementJs: String): Rect? {
        val edges = chromeValue("(function(){var r=$elementJs;if(!r)return '';var b=r.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom].join(',')})()")
            .split(',').mapNotNull { it.toDoubleOrNull() }
        if (edges.size != 4) return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also((activity as MainActivity).host.chrome::getLocationOnScreen) }
        return Rect(
            (origin[0] + edges[0] * density).roundToInt(), (origin[1] + edges[1] * density).roundToInt(),
            (origin[0] + edges[2] * density).roundToInt(), (origin[1] + edges[3] * density).roundToInt()
        )
    }

    /**
     * The still once the pixels have caught up with the DOM, by a FRAME FENCE (the group
     * suggestion demo's, in full there): two frames of the document, a magenta marker drawn over
     * the field's or the pill's leading edge, the screen read until the marker shows, the marker
     * removed, the screen read until it is gone – that read is the still.
     */
    private fun steadyShot(name: String) {
        chromeJs("(function(){window.__zenPainted=false;requestAnimationFrame(function(){requestAnimationFrame(function(){window.__zenPainted=true})});return 1})()")
        awaitChrome("window.__zenPainted===true", 8_000)
        val started = SystemClock.uptimeMillis()
        chromeJs(
            "(function(){var m=document.getElementById('$FENCE_ID');if(!m){m=document.createElement('div');m.id='$FENCE_ID';document.body.appendChild(m)}" +
                "var a=$FENCE_ANCHOR_JS;var b=a?a.getBoundingClientRect():{left:0,top:0,height:20};" +
                "m.style.cssText='position:fixed;left:'+(b.left+2)+'px;top:'+(b.top+(b.height-10)/2)+'px;width:10px;height:10px;background:#ff00ff;z-index:2147483647;pointer-events:none';return 1})()"
        )
        val at = rectOnScreen("document.getElementById('$FENCE_ID')")
        val seen = at?.let { awaitFence(it, present = true) }
        seen?.recycle()
        if (seen == null) Log.w(tag, "still $name: the fence's marker never showed on the screen in $FENCE_MS ms (at $at)")
        chromeJs("(function(){var m=document.getElementById('$FENCE_ID');if(m)m.parentNode.removeChild(m);return 1})()")
        val still = at?.let { awaitFence(it, present = false) }
        if (still == null) {
            Log.w(tag, "still $name: the fence's marker never left the screen in $FENCE_MS ms (at $at); the next read")
            shot(name, softBitmap(ui.takeScreenshot() ?: return))
            return
        }
        Log.i(tag, "still $name: the fence passed in ${SystemClock.uptimeMillis() - started} ms (the marker ${if (seen != null) "seen" else "NOT seen"} at $at)")
        shot(name, still)
    }

    private fun awaitFence(at: Rect, present: Boolean): Bitmap? {
        val deadline = SystemClock.uptimeMillis() + FENCE_MS
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(FENCE_STEP_MS)
            val read = softBitmap(ui.takeScreenshot() ?: continue)
            if (markerAt(read, at) == present) return read
            read.recycle()
        }
        return null
    }

    private fun markerAt(read: Bitmap, at: Rect): Boolean {
        val sx = if (width > 0) read.width.toDouble() / width else 1.0
        val sy = if (height > 0) read.height.toDouble() / height else 1.0
        val x = (at.centerX() * sx).roundToInt().coerceIn(0, read.width - 1)
        val y = (at.centerY() * sy).roundToInt().coerceIn(0, read.height - 1)
        val p = read.getPixel(x, y)
        return Color.red(p) > 180 && Color.green(p) < 90 && Color.blue(p) > 180
    }

    private fun softBitmap(shot: Bitmap): Bitmap =
        if (shot.config == Bitmap.Config.HARDWARE) shot.copy(Bitmap.Config.ARGB_8888, false).also { shot.recycle() } else shot

    private fun fieldUp(): Boolean = chromeValue("String(!!document.querySelector('$FIELD'))") == "true"

    private fun fieldValue(): String = chromeValue("(document.querySelector('$FIELD')||{}).value||''")

    /** The chrome at rest between scenes: the store's word on the field agreeing with the DOM's, no sheet up. */
    private fun settle(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(150)
        }
        val ok = settled()
        if (!ok) Log.w(tag, "the chrome did not settle in $timeoutMs ms: bar open ${urlbarOpen()}, field up ${fieldUp()}")
        return ok
    }

    private fun settled(): Boolean {
        val storeOpen = "(((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true)"
        return chromeValue("String(($storeOpen===!!document.querySelector('$FIELD'))&&document.querySelectorAll('.zen-sheet').length===0)") == "true"
    }

    /** The shared close of the field (DemoHarness.closeUrlField, by the chrome's state); a field left open fails the run by name. */
    private fun closeField() {
        val close = closeUrlField()
        if (!close.ok) {
            finding("  the field's close: ${close.describe()} ${verdict(false)}")
            failures += "the field's close: ${close.describe()}"
        }
    }

    /** The seeded demo page (`tab_home`) as the active tab at its own address, the field closed – navigated back when a scene left it on another page. */
    private fun showHomePage(): Boolean {
        settle(8_000)
        closeField()
        settle(8_000)
        if (activeCoreTab()?.optString("id") != HOME_TAB_ID) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(HOME_TAB_ID)}}")
            SystemClock.sleep(800)
        }
        if (activeCoreTab()?.optString("url") != HOME_URL) {
            coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(HOME_TAB_ID)},\"input\":${JSONObject.quote(HOME_URL)}}")
            SystemClock.sleep(1_200)
        }
        val there = awaitPageUrl(HOME_URL, 10_000)
        SystemClock.sleep(600)
        ensureForeground()
        return there
    }

    private fun awaitPageUrl(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val at = runCatching { activeCoreTab()?.optString("url") }.getOrNull().orEmpty()
            if (at == url) return true
            SystemClock.sleep(300)
        }
        return false
    }

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    // --- the chrome -------------------------------------------------------------------------------

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
            // Whatever the step left up (the editor, a sheet) goes before the next one.
            ensureForeground()
            for (i in 1..4) {
                settle(6_000)
                if (!chromeSurfaceUp() && !urlbarOpen() && !fieldUp() && findByLabelPrefix(PILL_LABEL) != null) break
                back()
                SystemClock.sleep(1_000)
            }
            settle(8_000)
        }
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the two sites ----------------------------------------------------------------------------

    /** The seeded default engine's site: the demo page and the engine's endpoints. */
    private fun homeRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html("Zero-suggest demo", "<p>Focus the empty address bar to see your most visited sites, your recent searches and the pages you visited.</p>"),
        SEARCH_PATH to results("Notes"),
        "/suggest" to suggestions("weather radar", "weekend walks", "what time is it")
    )

    /** The tile touched in scene 3. */
    private fun weatherRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html("Weather radar", "<p>The most visited site after the demo page: a tile.</p>"),
        "/forecast.html" to html("Ten-day forecast", "<p>An inner page: recently visited, no tile.</p>")
    )

    private fun html(title: String, body: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a}h1{font-size:28px;padding:40px 24px 8px}" +
                "p{padding:0 24px;font-size:20px}</style></head><body><h1>$title</h1>$body</body></html>"
            ).toByteArray()

    /** A results page that names the query it was asked (from `?q=`). */
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
        private const val PORT = 18194
        private const val WEATHER_HOST = "127.0.0.2"
        private const val HOME_SITE = "127.0.0.1:$PORT"
        private const val HOME_URL = "http://$HOME_SITE/"
        private const val WEATHER_URL = "http://$WEATHER_HOST:$PORT/"
        private const val WEATHER_LABEL = "Weather radar"
        private const val SEARCH_PATH = "/search"
        /** The seeded tab (omnibox-zero-suggest-demo-state.json). */
        private const val HOME_TAB_ID = "tab_home"
        /** The two searches the history holds on the default engine, most recent first, and the address the first one's row runs. */
        private const val FIRST_TERMS = "weather tomorrow"
        private const val SECOND_TERMS = "pasta recipes"
        private const val FIRST_SEARCH_URL = "http://$HOME_SITE/search?q=weather%20tomorrow"
        /** The letter typed to show the typed branch untouched. */
        private const val TYPED = "w"
        /** Chrome's / Zenium's heading for the searches (`RECENT_SEARCHES_GROUP` in shared/zeroSuggest.ts). */
        private const val RECENT_SEARCHES = "Recent searches"
        /** The new tab page's eight of the nine seeded hosts, by summed frecency (history.topSites), as the tiles' addresses. */
        private val TILE_URLS = (1..8).map { "http://127.0.0.$it:$PORT/" }
        /** The recently visited pages left once the tiles' pages and the searches' results pages are out: most recent first. */
        private val VISITED_TITLES = listOf("Ten-day forecast", "Lasagne al forno", "Ninth site")
        private const val FENCE_ID = "__zenFence"
        private const val FENCE_ANCHOR_JS = "(document.querySelector('[data-testid=\"urlbar-input\"]')||document.querySelector('[role=\"group\"][aria-label=\"Address\"]')||document.querySelector('button[aria-label^=\"Address\"]'))"
        private const val FENCE_STEP_MS = 200L
        private const val FENCE_MS = 15_000L
        /** History stamps in minutes before the run: `"{{now-50m}}"`. */
        private val STAMP = Regex("\"\\{\\{now-(\\d+)m\\}\\}\"")
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /**
         * The chrome's DOM: the field; the list on either chassis; the tile row (one presentational
         * li first in the list, `MostVisitedTiles`); the search and the history rows not on their
         * way out; a row on its way out; the new tab page's own field. Each a selector LIST with
         * the condition spelled on every alternative (the group suggestion demo's lesson).
         */
        private const val FIELD = "[data-testid=\"urlbar-input\"]"
        private const val LIST = ".zen-omnibox-sheet [role=\"listbox\"], #zen-omnibox-results"
        private const val TILES = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-testid=\"urlbar-most-visited\"], #zen-omnibox-results > li[data-testid=\"urlbar-most-visited\"]"
        private const val SEARCH_ROWS = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-kind=\"search\"]:not([data-leaving]), #zen-omnibox-results > li[data-kind=\"search\"]:not([data-leaving])"
        private const val HISTORY_ROWS = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-kind=\"history\"]:not([data-leaving]), #zen-omnibox-results > li[data-kind=\"history\"]:not([data-leaving])"
        private const val ROWS_LEAVING = ".zen-omnibox-sheet [role=\"listbox\"] > li[data-leaving], #zen-omnibox-results > li[data-leaving]"
        private const val NTP_FIELD = ".zen-ntp-field-main"

        /**
         * The card as it stands, from the field outward on either chassis: the headings (the
         * phone's sections, the tablet's one), the tile row (each tile's name, address, size and
         * whether it is inside the row's box before a scroll; whether the row is the list's first
         * item; its height) and every row not on its way out – its kind, title, subtitle (the
         * sheet's second span, or the list's ` — host` with the dash off), section, whether its
         * glyph is the clock, the option's spoken text and its height in CSS px.
         */
        private val CARD_JS = """
            (function () {
              var list = document.querySelector('.zen-omnibox-sheet [role="listbox"]') || document.getElementById('zen-omnibox-results');
              if (!list) return '{}';
              var items = Array.prototype.slice.call(list.children).filter(function (el) { return !el.hasAttribute('data-leaving'); });
              var tilesLi = items.filter(function (el) { return el.getAttribute('data-testid') === 'urlbar-most-visited'; })[0] || null;
              var headings = items.filter(function (el) { return el.getAttribute('data-testid') === 'urlbar-group-heading'; });
              var rows = items.filter(function (el) { return el.getAttribute('data-testid') !== 'urlbar-group-heading' && el !== tilesLi; });
              function text(el) { return el ? el.textContent.trim() : ''; }
              var rowBox = tilesLi ? tilesLi.getBoundingClientRect() : null;
              return JSON.stringify({
                headings: headings.map(function (h) { return h.textContent.trim(); }),
                tilesFirst: !!tilesLi && items[0] === tilesLi,
                tilesHeight: rowBox ? rowBox.height : 0,
                tiles: tilesLi ? Array.prototype.slice.call(tilesLi.querySelectorAll('button[data-url]')).map(function (b) {
                  var r = b.getBoundingClientRect();
                  return { label: b.getAttribute('aria-label') || '', url: b.getAttribute('data-url') || '', w: r.width, h: r.height, onScreen: r.left >= rowBox.left - 1 && r.right <= rowBox.right + 1 };
                }) : [],
                rows: rows.map(function (r) {
                  var option = r.querySelector('[role="option"]');
                  var host = text(r.querySelector('.zen-omnibox-row-host')).replace(/^\u2014\s*/, '');
                  return {
                    kind: r.getAttribute('data-kind') || '?',
                    title: text(r.querySelector('[data-testid="urlbar-row-title"], .zen-omnibox-row-title')),
                    subtitle: r.querySelector('[data-testid="urlbar-row-subtitle"]') ? text(r.querySelector('[data-testid="urlbar-row-subtitle"]')) : host,
                    section: r.getAttribute('data-section') || '',
                    clock: !!r.querySelector('svg.lucide-clock'),
                    label: option ? (option.getAttribute('aria-label') || option.textContent.trim()) : '',
                    h: r.getBoundingClientRect().height
                  };
                })
              });
            })()
        """.trimIndent()
    }
}
