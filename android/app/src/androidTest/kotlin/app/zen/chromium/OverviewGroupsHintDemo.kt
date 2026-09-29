package app.zen.chromium

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
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The drag-to-group hint bubble in the tab overview on a device (TB-19, W6-L2; Chrome 152's
 * `IPH_TabGroupsDragAndDrop` dialog as a §9.33 bubble, opened from the Zenium tips card), every
 * act a finger's:
 *
 *  1. The tip: a seeded profile of twelve loose tabs and no group, the tip module's memory
 *     standing eight days past the theme tip (tapped) and the default browser tip (at its cap),
 *     so a fresh new tab page draws the stack with one card – the tab-groups tip, "Tidy up with
 *     tab groups" over Chrome's sentence and one filled "Try it now" – alone at full width.
 *  2. Try it now opens the tab overview (#695's CTA) and, once the overview is at rest, the
 *     bubble stands on the card of the page the finger came from – the active tab's, the card
 *     the page morphed into – in §9.33's dress: 320 wide, the accent fill with the on-accent
 *     ink and no hairline, the body 15/400, `role="status"`; in §9.20's pose against the card –
 *     flush under it at gap 0, or over it when the room below runs out, start- or end-aligned
 *     with it by the card's half of the screen, 8 inside the frame; the card wearing §9.23's
 *     halo (`data-iph-anchor`, the card-shaped ring breathing on the 1.25 s alternate) and
 *     naming the bubble as its description for TalkBack (`aria-describedby`). The sentence is
 *     Chrome's dialog's folded into one: "Touch and hold a tab, then drag it onto another to
 *     group them". The record (`settings.iph.tabGroupsDragAndDrop`) is spent as the bubble goes
 *     up. Shot on the light scheme and the dark – the bubble stands through the scheme's flip.
 *  3. A touch anywhere takes it down (§9.33; Chrome's dialog cancels on a touch outside): the
 *     finger lands on the bubble itself – nothing under it is picked, the overview stays open –
 *     and the bubble fades out over 200 ms, the halo and the description going with it.
 *  4. The gesture it teaches: a card held and dragged onto its neighbour – the merge ring on the
 *     target, and on release the two are a group, the dropped card right behind the card it was
 *     dropped on (v2 §11.4). The bubble is not up to be dismissed by the drag here (the touch
 *     took it); that dismissal is the unit tests'.
 *  5. Once and for all: the overview closed by the system back and opened again by the bar's
 *     Tabs button shows no bubble – the record is spent, and the overview was not the tip's.
 *
 * The seeded tabs point at loopback pages served from this process ([DemoServer]). Every claim
 * is a line in `overview-groups-hint-findings.txt` next to the recording and a failed one fails
 * the run; the recording goes on to the end either way. The tree on this image trails the screen
 * by seconds after a transition, so a finger that waits on it only waits so long and then lands
 * on the DOM's box for the same control (the harness's `touchControl`).
 */
@RunWith(AndroidJUnit4::class)
class OverviewGroupsHintDemo : DemoHarness("overview-groups-hint-demo-state.json", "android-overview-groups-hint", "overview-groups-hint-demo") {
    override val tag = "OverviewGroupsHintDemo"

    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var shotIndex = 0
    private lateinit var demoTabId: String
    /** The new tab page the tip stands on, once opened: the overview's hero and the bubble's card. */
    private var pageTabId = ""

    /** A loopback page: its path, the page's title and a heading colour. */
    private class Site(val path: String, val title: String, val hex: String) {
        val caption get() = title.substringBefore(" - ")
    }

    private val sites = listOf(
        Site("/", "Orchard - Fresh fruit, delivered", "#2E7D32"),
        Site("/tides", "Tides - Coastal weather", "#0277BD"),
        Site("/atlas", "Atlas - Maps for walkers", "#EF6C00"),
        Site("/ledger", "Ledger - Personal finance", "#5E35B1"),
        Site("/kiln", "Kiln - Pottery classes", "#AD1457"),
        Site("/grove", "Grove - Community garden", "#558B2F"),
        Site("/harbour", "Harbour - Ferry times", "#00838F"),
        Site("/loom", "Loom - Weaving patterns", "#6D4C41"),
        Site("/meadow", "Meadow - Wildflower guide", "#9E9D24"),
        Site("/quarry", "Quarry - Stone and slate", "#455A64"),
        Site("/summit", "Summit - Trail conditions", "#283593"),
        Site("/willow", "Willow - Basketry", "#00695C")
    )

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            sites.associate { site -> site.path to ("text/html; charset=utf-8" to pageHtml(site).toByteArray()) }
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures.isNotEmpty()) error("${failures.size} claim(s) did not hold: ${failures.joinToString("; ")}")
    }

    /** The seeded tabs point at this driver's server. */
    override fun patchState(json: String): String = json.replace("127.0.0.1:18192", "127.0.0.1:$PORT")

    override fun warmUp() {
        findings = File(out, "overview-groups-hint-findings.txt")
        findings.writeText("Zenium Android overview drag-to-group hint checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        demoTabId = activeCoreTab()?.optString("id").orEmpty()
        val state = coreState()
        finding(
            "start: ${describeActive()}; groups ${groupCount(state)}; the record ${hintRecord(state)}; " +
                "the Tabs button's record ${state.optJSONObject("settings")?.optJSONObject("iph")?.optJSONObject("tabSwitcher")}; " +
                "tip memory ${state.optJSONObject("newTabEducationalTips")}"
        )
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_000)
        // The first new tab page pays for the stack's layout and compilation: open one off camera
        // and close it again (a blank page never visited leaves no "Recently closed" entry, so no
        // Continue card follows it; `tabs.ts` captureClosed).
        if (tapLabel(Finger(), NEW_TAB_LABEL)) {
            SystemClock.sleep(2_500)
            val fresh = activeCoreTab()
            if (fresh != null && fresh.optString("url") == BLANK_URL) {
                val stack = awaitChrome("document.querySelectorAll('.zen-mstack-card').length>0", 8_000)
                finding("warm-up: the stack ${if (stack) "painted" else "did NOT paint"} on the off-camera page; cards ${cardIds()}; tip memory ${tipMemory()}")
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(fresh.optString("id"))}}")
                SystemClock.sleep(1_500)
            } else {
                finding("warm-up: the off-camera page did not open (${describeActive()})")
            }
        }
        // The tip module's memory as a profile's stands eight days after the theme tip was tapped
        // and the default browser tip reached its cap of three: the next tip in Chrome's order the
        // profile qualifies for is tab groups (twelve tabs, no group; `educationalTips.ts`). Seeded
        // after the off-camera page, whose impression it replaces.
        setTipMemory(tipMemorySeed())
        finding("warm-up: the tip module's memory seeded (${tipMemory()}); tabs ${tabCount()}, groups ${groupCount()}, recently closed ${coreState().optJSONArray("recentlyClosed")?.length() ?: 0}")
        val close = closeUrlField()
        if (!close.ok) finding("warm-up: ${close.describe()}")
        calibrateDomBoxes()
        finding("warm-up done: ${describeActive()}")
    }

    override fun demo() {
        theTip()
        theBubble()
        theTouch()
        theDrag()
        onceAndForAll()
        awaitShots()
        finding("\nend: ${failures.size} claim(s) did not hold")
    }

    // --- 1. the tip ------------------------------------------------------------------------------

    private fun theTip() {
        step("1. The tip: a fresh new tab page draws the stack with the tab-groups tip alone – Chrome's title over Chrome's sentence, one filled Try it now") {
            val before = tabCount()
            if (!tapLabel(Finger(), NEW_TAB_LABEL)) error("no '$NEW_TAB_LABEL' button on the bar")
            SystemClock.sleep(2_000)
            val up = awaitChrome("document.querySelectorAll('.zen-mstack-card').length===1", 10_000)
            SystemClock.sleep(800)
            pageTabId = activeCoreTab()?.optString("id").orEmpty()
            val ids = cardIds()
            finding("  ${describeActive()} (tabs were $before); cards $ids")
            expect("the page draws one card, the tip card: $ids (${tabCount()} tabs, no group – the tip wants more than ten and none)", up && ids == listOf("tips") && activeUrl() == BLANK_URL && tabCount() == before + 1 && groupCount() == 0, "tip-page")
            val face = runCatching { JSONObject(chromeValue(TIP_FACE_JS)) }.getOrElse { JSONObject() }
            finding("  the tip card's face: $face")
            expect("the card is the tab-groups tip: '$TIP_TITLE' over '$TIP_DESCRIPTION' ('${face.optString("title")}' / '${face.optString("description")}')", face.optString("card") == "tab-groups" && face.optString("title") == TIP_TITLE && face.optString("description") == TIP_DESCRIPTION, "tip-face")
            expect("one filled button '$TIP_BUTTON' named '$TIP_BUTTON: $TIP_TITLE' (${face.optInt("buttons")} button(s): '${face.optString("button")}' / '${face.optString("buttonLabel")}', primary ${face.optBoolean("primary")})", face.optInt("buttons") == 1 && face.optString("button") == TIP_BUTTON && face.optString("buttonLabel") == "$TIP_BUTTON: $TIP_TITLE" && face.optBoolean("primary"), "tip-button")
            expect("the record is unseen before the finger: ${hintRecord()}", !hintRecord().optBoolean("shown"), "record-unseen")
            still("tip-tab-groups-light")
        }
    }

    // --- 2. the bubble ---------------------------------------------------------------------------

    private fun theBubble() {
        step("2. Try it now opens the overview; at its rest the bubble stands on the page's own card in §9.33's dress and §9.20's pose, the card haloed and describing it; the record spent as it goes up; light and dark") {
            val opened = touchControlExpecting("$TIP_BUTTON: $TIP_TITLE", TIP_ACTION_JS, "the overview is open", 10_000) { overviewOpen() }
            expect("$TIP_BUTTON opens the tab overview – as Chrome's tip shows the Hub (ChromeTabbedActivity.java l.3500–3508)", opened, "cta-opens-overview")
            val up = awaitChrome("!!document.getElementById('$BUBBLE_ID')", 8_000)
            SystemClock.sleep(900)
            val b = bubble()
            finding("  the bubble: $b")
            expect("the bubble is up once the overview rests, on the overview kind (data-at '${b.optString("at")}', edge '${b.optString("edge")}')", up && b.optBoolean("up") && b.optString("at") == "overview" && b.optString("edge").isEmpty(), "bubble-up")
            expect("it says Chrome's dialog's sentence folded into one: '$HINT_TEXT' ('${b.optString("text")}')", b.optString("text") == HINT_TEXT, "bubble-text")
            expect("it stands on the page's own card – the active tab's, the one the page morphed into (anchor '${b.optString("anchor")}', the page $pageTabId; the active card ${activeCoreTab()?.optString("id")})", b.optString("anchor") == pageTabId && b.optString("anchor") == activeCoreTab()?.optString("id"), "bubble-anchor")
            val cell = b.optJSONObject("cell")
            val side = b.optString("side")
            val flush = cell != null && when (side) {
                "below" -> near(b.optDouble("top"), cell.optDouble("bottom"))
                "above" -> near(b.optDouble("bottom"), cell.optDouble("top"))
                else -> false
            }
            // The message layer is the content frame's box, `--zen-padding` in from the screen's
            // sides (main.css, `.zen-message-frame`): the clamp is 8 inside THAT box.
            val layer = b.optJSONObject("layer") ?: JSONObject()
            val frameLeft = layer.optDouble("left", 0.0)
            val frameRight = layer.optDouble("right", b.optDouble("vw", 0.0))
            val aligned = cell != null && (
                near(b.optDouble("left"), cell.optDouble("left")) || near(b.optDouble("right"), cell.optDouble("right")) ||
                    near(b.optDouble("left"), frameLeft + MESSAGE_INSET) || near(b.optDouble("right"), frameRight - MESSAGE_INSET)
                )
            val inside = b.optDouble("left") >= frameLeft + MESSAGE_INSET - 0.5 && b.optDouble("right") <= frameRight - MESSAGE_INSET + 0.5 &&
                b.optDouble("top") >= layer.optDouble("top", 0.0) - 0.5 && b.optDouble("bottom") <= layer.optDouble("bottom", Double.MAX_VALUE) + 0.5
            expect("§9.20's pose against the card: flush ${side.ifEmpty { "(no side)" }} it at gap 0 (bubble ${b.px("top")}–${b.px("bottom")}, card ${cell.px("top")}–${cell.px("bottom")}), start- or end-aligned with it or clamped $MESSAGE_INSET inside the frame (bubble ${b.px("left")}–${b.px("right")}, card ${cell.px("left")}–${cell.px("right")}, frame ${frameLeft.roundToInt()}–${frameRight.roundToInt()} of ${b.px("vw")}), inside the frame ($inside)", flush && aligned && inside, "bubble-pose")
            expect("§9.33's dress: 320 wide (${b.optDouble("width")}), the accent fill with the on-accent ink (${b.optString("fill")} on ${b.optString("accent")}; ${b.optString("ink")} on ${b.optString("onAccent")}), no hairline (border ${b.optString("border")}), the body 15/400 (${b.optString("font")})", near(b.optDouble("width"), 320.0) && b.optString("fill") == b.optString("accent") && b.optString("ink") == b.optString("onAccent") && b.optString("border") == "0px" && b.optString("font").startsWith("15px/400"), "bubble-dress")
            expect("the card wears the halo (data-iph-anchor ${b.optBoolean("haloed")}, its ring's animation '${b.optString("halo")}') and names the bubble as its description ('${b.optString("describedBy")}'); the bubble is a status (role '${b.optString("role")}')", b.optBoolean("haloed") && b.optString("halo") == "zen-iph-pulse-card" && b.optString("describedBy") == BUBBLE_ID && b.optString("role") == "status", "bubble-a11y")
            val spent = hintRecord()
            expect("the record is spent as the bubble goes up: $spent", spent.optBoolean("shown") && !spent.isNull("availableAt"), "record-spent")
            still("overview-bubble-light")
            darkStill("overview-bubble-dark")
            val after = bubble()
            expect("the bubble stands through the scheme's flip and back (up ${after.optBoolean("up")}, leaving ${after.optBoolean("leaving")})", after.optBoolean("up") && !after.optBoolean("leaving"), "bubble-through-flip")
        }
    }

    // --- 3. the touch ----------------------------------------------------------------------------

    private fun theTouch() {
        step("3. A touch anywhere takes the bubble down – the finger on the bubble itself: nothing under it is picked, the overview stays open, the halo and the description go with it") {
            val box = domBox("document.getElementById('$BUBBLE_ID')")
            expect("the bubble is there to touch ($box)", box != null, "touch-target")
            if (box == null) return@step
            val tabsBefore = tabCount()
            finding("  touch at ${box.exactCenterX().roundToInt()},${box.exactCenterY().roundToInt()} on the bubble $box")
            Finger().tap(box.exactCenterX(), box.exactCenterY())
            val leaving = awaitChrome("(function(){var b=document.getElementById('$BUBBLE_ID');return !b||b.hasAttribute('data-leaving')})()", 3_000)
            val gone = awaitChrome("!document.getElementById('$BUBBLE_ID')", 3_000)
            SystemClock.sleep(600)
            val halo = chromeValue("String(document.querySelectorAll('.zen-overview-grid [data-cell][data-iph-anchor]').length)")
            val described = chromeValue("String(document.querySelectorAll('[aria-describedby=\"$BUBBLE_ID\"]').length)")
            finding("  after the touch: leaving $leaving, gone $gone, haloed cells $halo, described $described; ${describeActive()}; overview open ${overviewOpen()}")
            expect("the touch takes the bubble down – leaving on the touch, gone after the 200 ms fade – and the halo and the description with it (haloed $halo, described $described)", leaving && gone && halo == "0" && described == "0", "touch-dismisses")
            expect("nothing else happened: the overview stays open, no tab picked or closed (${tabCount()} tabs, active ${activeCoreTab()?.optString("id")})", overviewOpen() && tabCount() == tabsBefore && activeCoreTab()?.optString("id") == pageTabId, "touch-passes")
            still("overview-after-touch-light")
        }
    }

    // --- 4. the drag -----------------------------------------------------------------------------

    private fun theDrag() {
        step("4. The gesture it teaches: a card held and dragged onto its neighbour – the merge ring on the target, and on release the two are a group, the dropped card right behind its target") {
            val pair = neighbours() ?: error("no two loose cards side by side in view")
            val (source, target) = pair
            val from = domBox("document.querySelector('.zen-overview-grid [data-cell=\"$source\"]')") ?: error("no cell for $source")
            val onto = domBox("document.querySelector('.zen-overview-grid [data-cell=\"$target\"]')") ?: error("no cell for $target")
            finding("  drag $source $from onto $target $onto")
            // The overview motion driver's carry: hold until the card lifts, cross the slop, pause
            // where nothing is pending, then ONE instant move onto the target – a slow approach
            // crosses the neighbours' edge bands, each a slot, and a UI-thread stall there (the
            // emulator's software GPU) lets a slot take hold before the finger arrives.
            val f = Finger()
            f.press(from.exactCenterX(), from.exactCenterY())
            f.moveBy(0f, -NUDGE, 120)
            f.hold(EDGE_PAUSE)
            f.moveBy(onto.exactCenterX() - from.exactCenterX(), onto.exactCenterY() - (from.exactCenterY() - NUDGE), 0)
            f.hold(REST)
            val ring = chromeValue("String(document.querySelectorAll('.zen-overview-card-target,[data-targeted]').length)")
            finding("  over the target: merge targets in the DOM $ring")
            expect("the merge ring is on the target while the finger rests over it ($ring target(s))", ring != "0" && ring.isNotEmpty(), "drag-ring")
            still("drag-merge-ring-light")
            f.up()
            val grouped = awaitCore(8_000) { s -> folderOf(source, s) != null && folderOf(source, s) == folderOf(target, s) }
            SystemClock.sleep(2_500)
            val state = coreState()
            val made = folderOf(target, state)
            val order = made?.let { groupOrder(it, state) } ?: emptyList()
            finding("  after the drop: groups ${groupCount(state)}, the group $made holds $order; ${describeActive(state)}")
            expect("$source and $target are a group (${groupCount(state)} group(s))", grouped && made != null && groupCount(state) == 1, "drag-groups")
            expect("the group is $target, $source: the dropped card right behind the card it was dropped on (v2 §11.4; $order)", order == listOf(target, source), "drag-order")
            expect("the record stays spent, not written again by the drag: ${hintRecord(state)}", hintRecord(state).optBoolean("shown"), "record-stays")
            still("group-made-light")
        }
    }

    // --- 5. once and for all ---------------------------------------------------------------------

    private fun onceAndForAll() {
        step("5. Once and for all: the overview closed and opened again by the bar's Tabs button shows no bubble") {
            back()
            val closed = awaitChrome("!document.querySelector('.zen-overview')", 8_000)
            SystemClock.sleep(1_200)
            finding("  the system back: overview gone $closed; ${describeActive()}")
            expect("the system back closes the overview", closed, "back-closes")
            val tabs = tabsButton() ?: error("no Tabs button on the bar")
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            val open = awaitTrue(8_000) { overviewOpen() }
            SystemClock.sleep(2_000)
            val bubbleUp = chromeValue("String(!!document.getElementById('$BUBBLE_ID'))")
            finding("  the Tabs button: overview open $open; bubble in the DOM $bubbleUp; the record ${hintRecord()}")
            expect("the overview the Tabs button opened shows no bubble – the record is spent, and the opening was not the tip's (bubble $bubbleUp)", open && bubbleUp == "false" && hintRecord().optBoolean("shown"), "once-only")
            still("overview-again-light")
            back()
            awaitChrome("!document.querySelector('.zen-overview')", 8_000)
            SystemClock.sleep(800)
        }
    }

    // --- reading the chrome and the core ---------------------------------------------------------

    /** The bubble and the card it points at, as the chrome draws them (CSS px; `up` false with none). */
    private fun bubble(): JSONObject = runCatching { JSONObject(chromeValue(BUBBLE_JS)) }.getOrElse { JSONObject().put("up", false) }

    /**
     * Two loose cards side by side in the grid's view – the same row, neither the bubble's card
     * nor the New Tab card nor a group – the one further from the page's card first as the source,
     * its neighbour the target; null with none.
     */
    private fun neighbours(): Pair<String, String>? {
        val cells = runCatching { JSONArray(chromeValue(CELLS_JS)) }.getOrElse { JSONArray() }
        val rows = (0 until cells.length()).map { cells.getJSONObject(it) }
            .filter { it.optBoolean("loose") && it.optString("id") != pageTabId }
            .groupBy { it.optDouble("top").roundToInt() }
        val row = rows.values.firstOrNull { it.size >= 2 } ?: return null
        val sorted = row.sortedBy { it.optDouble("left") }
        return sorted[0].optString("id") to sorted[1].optString("id")
    }

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        chromeValue("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    private fun near(a: Double, b: Double, tolerance: Double = 1.5): Boolean = abs(a - b) <= tolerance

    /** A box's figure for a finding line: whole pixels, or a dash where the probe read nothing (no NaN to round). */
    private fun JSONObject?.px(key: String): String {
        val v = this?.optDouble(key) ?: Double.NaN
        return if (v.isNaN()) "–" else v.roundToInt().toString()
    }

    /** The drag-to-group record (`settings.iph.tabGroupsDragAndDrop`). */
    private fun hintRecord(state: JSONObject = coreState()): JSONObject =
        state.optJSONObject("settings")?.optJSONObject("iph")?.optJSONObject("tabGroupsDragAndDrop") ?: JSONObject()

    private fun groupCount(state: JSONObject = coreState()): Int = state.optJSONObject("folders")?.length() ?: 0

    private fun folderOf(tabId: String, state: JSONObject = coreState()): String? {
        val tab = state.getJSONObject("tabs").optJSONObject(tabId) ?: return null
        return if (tab.isNull("folderId")) null else tab.optString("folderId").takeIf { it.isNotEmpty() }
    }

    /** The group's tabs in the space's track order. */
    private fun groupOrder(folderId: String, state: JSONObject = coreState()): List<String> {
        val space = state.getJSONArray("spaces").let { spaces ->
            (0 until spaces.length()).map { spaces.getJSONObject(it) }.first { it.optString("id") == state.optString("activeSpaceId") }
        }
        val ids = space.getJSONArray("tabIds")
        return (0 until ids.length()).map { ids.getString(it) }.filter { folderOf(it, state) == folderId }
    }

    private fun awaitCore(timeoutMs: Long, test: (JSONObject) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (runCatching { test(coreState()) }.getOrDefault(false)) return true
            SystemClock.sleep(200)
        }
        return false
    }

    private fun cardIds(): List<String> = runCatching {
        val raw = JSONArray(chromeValue("JSON.stringify([].map.call(document.querySelectorAll('.zen-mstack-card'),function(c){return c.getAttribute('data-cell')}))"))
        (0 until raw.length()).map { raw.getString(it) }
    }.getOrElse { emptyList() }

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(state: JSONObject = coreState()): Int = state.getJSONObject("tabs").length()

    private fun describeActive(state: JSONObject = coreState()): String =
        activeCoreTab(state).let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount(state)} tabs" }

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** The pose in view on the dark scheme for the design record, the light scheme – the seed's – put back after. */
    private fun darkStill(name: String) {
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        val dark = awaitChrome("document.documentElement.dataset.theme==='dark'", 8_000)
        SystemClock.sleep(1_500)
        if (!dark) finding("  the chrome did not take the dark scheme in time (data-theme '${chromeValue("document.documentElement.dataset.theme||''")}')")
        still(name)
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        awaitChrome("(document.documentElement.dataset.theme||'light')==='light'", 8_000)
        SystemClock.sleep(800)
    }

    // --- the tip module's memory -----------------------------------------------------------------

    private fun tipMemory(): JSONObject = coreState().optJSONObject("newTabEducationalTips") ?: JSONObject()

    private fun setTipMemory(memory: JSONObject) {
        coreInvoke("newtab.setEducationalTipMemory", JSONObject().put("memory", memory).toString())
    }

    /** Eight days on from the theme tip's tap and the default browser tip's third impression: tab groups is the next tip owed. */
    private fun tipMemorySeed(): JSONObject {
        val at = System.currentTimeMillis() - 8 * DAY_MS
        val cards = JSONObject()
            .put("ntp-theme", JSONObject().put("impressions", 1).put("shownAt", at).put("interacted", true))
            .put("default-browser", JSONObject().put("impressions", DEFAULT_BROWSER_TIP_CAP).put("shownAt", at).put("interacted", false))
        return JSONObject().put("cards", cards).put("shownAt", at).put("browsingDataClearedAt", JSONObject.NULL)
    }

    // --- stills, steps, findings -----------------------------------------------------------------

    private fun still(name: String) {
        shotIndex++
        shot("%02d-%s".format(shotIndex, name))
    }

    /** Run one step of the sequence; a failure inside it is a finding and a failure of the run. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures += "$name: ${e.message}"
        }
    }

    /** A claim of the sequence, on record either way; a failed one fails the run. */
    private fun expect(claim: String, held: Boolean, id: String) {
        finding("  $claim ${if (held) "PASS" else "FAIL"}")
        if (!held) failures += "$id: $claim"
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the sites -------------------------------------------------------------------------------

    private fun pageHtml(site: Site): String =
        "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>${site.title}</title>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}" +
            "header{background:${site.hex};color:#fff;padding:56px 24px 40px}h1{margin:0;font-size:32px}" +
            "p{padding:24px;font-size:19px;line-height:1.5;color:#3c3c43}</style></head>" +
            "<body><header><h1>${site.caption}</h1></header>" +
            "<p>${site.title.substringAfter(" - ")}. One of the twelve loopback pages the overview's drag-to-group hint demo opens.</p>" +
            "</body></html>"

    companion object {
        private const val PORT = 18192
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        private const val DAY_MS = 86_400_000L
        private const val DEFAULT_BROWSER_TIP_CAP = 3
        /** The finger's pause where nothing is pending before its one step onto the target (the overview motion driver's). */
        private const val EDGE_PAUSE = 400L
        /** How long the finger rests on the target for the ring to take hold and be drawn. */
        private const val REST = 1_400L
        /** Chrome's words for the tab-groups tip (`educationalTips.ts`; the design lead's fold on #695). */
        private const val TIP_TITLE = "Tidy up with tab groups"
        private const val TIP_DESCRIPTION = "Create tab groups that save and update across your devices when sync is on"
        private const val TIP_BUTTON = "Try it now"
        /** The bubble's element id (`HINT_BUBBLE_ID`, lib/iph.ts) and its sentence (`TAB_GROUPS_DRAG_HINT_TEXT`). */
        private const val BUBBLE_ID = "zen-hint-bubble"
        private const val HINT_TEXT = "Touch and hold a tab, then drag it onto another to group them"
        /** §9.20's margin inside the frame (`MESSAGE_INSET`, messages/stack.ts), CSS px. */
        private const val MESSAGE_INSET = 8.0
        private const val TIP_ACTION_JS = "document.querySelector('.zen-mstack-card[data-cell=\"tips\"] .zen-mstack-action')"
        /** The tip card's face: which tip, its words, its one button. */
        private const val TIP_FACE_JS = "(function(){var c=document.querySelector('.zen-mstack-card[data-cell=\"tips\"]');if(!c)return JSON.stringify({});" +
            "var f=c.querySelector('.zen-mstack-tip'),ti=c.querySelector('.zen-mstack-safety-title'),su=c.querySelector('.zen-mstack-safety-summary');" +
            "var bs=c.querySelectorAll('.zen-mstack-action'),b=bs[0];" +
            "return JSON.stringify({card:f?f.getAttribute('data-card'):'',title:ti?ti.textContent.trim():'',description:su?su.textContent.trim():'',buttons:bs.length," +
            "button:b?b.textContent.trim():'',buttonLabel:b?b.getAttribute('aria-label'):'',primary:!!(b&&b.hasAttribute('data-primary'))})})()"
        /**
         * The bubble as drawn – its words, kind, anchor, side, box, fill and ink against the tokens
         * painted on a probe, its font, the anchor cell's box, the cell's halo (the ring's
         * animation) and the card's description – in CSS px.
         */
        private const val BUBBLE_JS = "(function(){var b=document.getElementById('zen-hint-bubble');if(!b)return JSON.stringify({up:false});" +
            "var r=b.getBoundingClientRect(),cs=getComputedStyle(b);var id=b.getAttribute('data-anchor')||'';var l=b.parentElement.getBoundingClientRect();" +
            "var cell=id?document.querySelector('.zen-overview-grid [data-cell=\"'+id+'\"]'):null;var c=cell?cell.getBoundingClientRect():null;" +
            "var halo=cell?getComputedStyle(cell,'::before').animationName:'';var btn=cell?cell.querySelector('[aria-describedby]'):null;" +
            "var p=document.createElement('div');p.style.background='var(--v2-accent)';p.style.color='var(--v2-on-accent)';document.body.appendChild(p);" +
            "var ps=getComputedStyle(p),accent=ps.backgroundColor,onAccent=ps.color;p.remove();" +
            "return JSON.stringify({up:true,text:b.textContent,at:b.getAttribute('data-at')||'',edge:b.getAttribute('data-edge')||'',anchor:id," +
            "side:b.getAttribute('data-side')||'',role:b.getAttribute('role')||'',leaving:b.hasAttribute('data-leaving'),left:r.left,top:r.top,right:r.right,bottom:r.bottom," +
            "width:r.width,height:r.height,fill:cs.backgroundColor,ink:cs.color,border:cs.borderTopWidth,font:cs.fontSize+'/'+cs.fontWeight+'/'+cs.lineHeight," +
            "accent:accent,onAccent:onAccent,cell:c?{left:c.left,top:c.top,right:c.right,bottom:c.bottom}:null,halo:halo,haloed:cell?cell.hasAttribute('data-iph-anchor'):false," +
            "describedBy:btn?btn.getAttribute('aria-describedby'):'',vw:innerWidth,layer:{left:l.left,top:l.top,right:l.right,bottom:l.bottom}})})()"
        /** The grid's cells in view – id, box, whether a loose tab card (a tab id, not a group's or the New Tab card's) – in CSS px. */
        private const val CELLS_JS = "(function(){var g=document.querySelector('.zen-overview-grid');if(!g)return '[]';var gr=g.getBoundingClientRect();" +
            "return JSON.stringify([].map.call(g.querySelectorAll('[data-cell]'),function(e){var r=e.getBoundingClientRect();var id=e.getAttribute('data-cell')||'';" +
            "return {id:id,left:r.left,top:r.top,right:r.right,bottom:r.bottom,loose:!!e.getAttribute('data-tab-id')&&!e.closest('[data-cell^=\"group:\"]')&&r.top>=gr.top&&r.bottom<=gr.bottom}}))})()"
    }
}
