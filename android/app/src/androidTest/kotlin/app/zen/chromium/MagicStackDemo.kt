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

/**
 * The new tab page's cards on a device (NTP-16, W6-4; Chrome's Magic Stack, "Cards" to the
 * user), every act a finger's:
 *
 *  1. The stack under a seeded profile: a recently closed tab, a completed download whose file
 *     is on the device, two bookmarks and one site the permissions sweep took a grant from –
 *     four cards in the stack's fixed order (Continue where you left off, Downloads, Bookmarks,
 *     Safety check), and the tip card (NTP-20, W6-E15; Chrome's educational tip module, "Zenium
 *     tips") as a fifth: one tip at a time at the stack's end, the theme tip on a fresh
 *     profile's memory. The cards are page surfaces named for TalkBack, the section named
 *     "Cards", the strip a carousel with a page indicator under it – a dot per card, none of
 *     them a control, and a status line reading the page – each card's ⋮ the shared 44 icon
 *     button named for its module; one action a card and only one its rows do not already do
 *     (See all on Downloads and Bookmarks, Review on Safety check, the tip's one button, none on
 *     Continue), the Continue card's detail the host then the time; at the bottom dock the stack
 *     stands above the shortcut tiles, each card the strip's width less the 24 the next one
 *     peeks by.
 *  2. Paging by a real swipe on the strip (a measured scene, `magic-stack-swipe`): the strip
 *     snaps to the second card and the indicator reads "Page 2 of N" with the second dot
 *     current; a swipe back returns it to the first card.
 *  3. The Safety check card (NTP-19, W6-E9; Chrome's Safety Hub module in the Magic Stack): the
 *     seed's one revoked record gives Chrome's low-priority type alone (Safe Browsing on and no
 *     password checkup leave the two higher types nothing), the card fourth in the stack, swiped
 *     to a card at a time; its face is the page's own tile with the check in the success ink,
 *     the title "Removed permissions for 1 site" with no summary (Chrome's revoked type has
 *     none), one filled Review named "Review Safety check"; the impression is on the card's
 *     memory before the finger lands. Review opens Settings on the Safety check group in a new
 *     tab (`zen://settings/privacy?group=safety-check`, the group the landing) and does not end
 *     the run – Chrome's Review is a look, not a fix (`SafetyHubMagicStackMediator.java`) – the
 *     new tab page made active again in front of the Settings tab (left open: closed, it would
 *     head the recently closed list the Continue card reads, and step 9 restores the seeded
 *     tab), the card still in the stack – and the tip card gone from it: the page re-mounts, and
 *     the tip module rests three days after an impression – the strip swiped home for the steps
 *     after.
 *  4. The tip card (NTP-20, W6-E15; Chrome's educational tip module in the Magic Stack): the
 *     memory emptied again (the driver's seed, through the command the page writes with), a
 *     fresh page shows the theme tip last in the stack, swiped to a card at a time; its face is
 *     the Safety check card's form – the page's tile with a 24 glyph, Chrome's title over
 *     Chrome's description, one filled button named for the tip – and the impression is on the
 *     device's memory before the finger lands. Try it now opens the page's customise sheet (the
 *     feature itself) and retires the card on the memory while the card stands, as Chrome's
 *     `OnInteract` leaves it. Then, the memory's stamps moved eight days back by the driver
 *     (Chrome's cadence would take the days) and the card shown retired, the next fresh page
 *     shows the next tip in Chrome's order – the default browser where the host says Zenium is
 *     not the default (the emulator's answer; the driver reads it and predicts what it implies),
 *     tab groups over the seed's twelve tabs and no group, Delete browsing data with nothing
 *     deleted here in 30 days – each shot on the light scheme and the dark; the default browser
 *     tip retired at its cap of three impressions, the others as tapped. The pages after the
 *     first stand on the last card already: the chrome mounts one stack for whichever blank tab
 *     is active, so the strip keeps its offset from one page to the next (and the module counts
 *     the new tab's page as an impression of its own). A page within three days of a tip shows
 *     none: the page the steps after continue on, the strip swiped home for them.
 *  5. A card's ⋮ opens the shared local menu titled by the module, Hide This and Customise its
 *     rows; Hide This (a measured scene, `magic-stack-hide`) writes the device's hidden set,
 *     fades the card out over 120 ms and glides the cards after it into the gap on the FLIP
 *     spring – a probe on the strip records the fade's start and end, the card's removal and the
 *     siblings' transform frames while the finger's act runs.
 *  6. Customise from the ⋮ opens the "Cards" sheet of switch rows, the hidden card's switch off;
 *     a finger on it re-enables the card, which arrives in view behind the sheet: the strip
 *     pages to it on the spring (§9.29's arrival) and the first dot is current.
 *  7. Every switch off: the stack is gone from the page altogether (the page keeps its field and
 *     tiles); the sheet closed, the empty state.
 *  8. The way back with no ⋮ left: the page's gear sheet seats a Cards row first, above Layout
 *     with a hairline after it and in view at the sheet's rest height (§9.13); a finger on it
 *     swaps the sheets (one sheet over the page, §9.24) and the stack's sheet comes up; a switch
 *     on brings one card back, alone at the strip's full width and without dots; another brings
 *     the dots back, the strip paged to the card brought back ahead of the one in view.
 *  9. The Continue card's row restores the closed tab (`session.restoreClosed`; the row is the
 *     card's whole act, there is no Reopen button): the tab comes back on its loopback page. The
 *     strip stands on the Continue card step 8 brought back (the arrival paged to it; Chrome
 *     alone would have kept the snapped Bookmarks card through the layout change and left
 *     Continue a page to the left) – a claim, and a swipe back the recovery if it does not.
 *
 * The sites are loopback pages served from this process ([DemoServer]); the seeded state names
 * them at this driver's port. Every claim is a line in `magic-stack-findings.txt` next to the
 * recording and a failed one fails the run; the recording goes on to the end either way. The tree
 * on this image trails the screen by seconds after a transition, so a finger that waits on it
 * only waits so long and then lands on the DOM's box for the same control (the harness's
 * `touchControl`); a control whose name another on screen shares (a switch row and the card it
 * names, a menu row) is aimed at through the DOM alone.
 */
@RunWith(AndroidJUnit4::class)
class MagicStackDemo : DemoHarness("magic-stack-demo-state.json", "android-ntp-magic-stack", "magic-stack-demo") {
    override val tag = "MagicStackDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var shotIndex = 0
    private lateinit var demoTabId: String
    /** Whether the host says the browser is not the default: the default browser tip's condition. */
    private var notDefault = false
    /**
     * The tip expected on the page in view (NTP-20): the machine's pick over the memory the
     * driver last read or seeded ([predictTip]), or null while the module rests – the count of
     * cards a page draws follows from it ([expectedCards]).
     */
    private var tipUp: String? = null

    /** A loopback page: its path, the page's title and a heading colour. */
    private class Site(val path: String, val title: String, val hex: String) {
        val caption get() = title.substringBefore(" - ")
    }

    private val sites = listOf(
        Site("/", "Orchard - Fresh fruit, delivered", "#2E7D32"),
        Site("/tides", "Tides - Coastal weather", "#0277BD"),
        Site("/atlas", "Atlas - Maps for walkers", "#EF6C00"),
        Site("/ledger", "Ledger - Personal finance", "#5E35B1")
    )

    private val tides get() = sites[1]

    private fun url(site: Site) = "http://127.0.0.1:$PORT${site.path}"

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

    // --- seed ------------------------------------------------------------------------------------

    /** The seeded tab, the closed tab and the bookmarks point at this driver's server; the stamps become times. */
    override fun patchState(json: String): String = stamp(json.replace("127.0.0.1:18131", "127.0.0.1:$PORT"))

    /**
     * The completed download: a real file under the app's files (the core asks the host whether a
     * completed row's file is still there when the list loads – `download.exists`, a `FileSink`
     * for an absolute path – and only a row whose file is qualifies for the card), and the
     * downloads list naming it, three hours old. And the permissions store with one site the
     * unused-permissions sweep took a grant from two days ago (PS-41's `revokedUnused` record,
     * the file the core reads at boot in any case): the Safety check card's one trigger here –
     * Chrome's revoked-permissions type, the low priority, alone.
     */
    override fun seedMore(zen: File) {
        val dir = File(app.filesDir, DOWNLOAD_DIR).apply { mkdirs() }
        val file = File(dir, DOWNLOAD_NAME)
        file.writeBytes(pdfBytes())
        val item = JSONObject()
            .put("id", "dl_field_guide")
            .put("url", "http://127.0.0.1:$PORT/$DOWNLOAD_NAME")
            .put("filename", DOWNLOAD_NAME)
            .put("savePath", file.absolutePath)
            .put("totalBytes", file.length())
            .put("receivedBytes", file.length())
            .put("state", "completed")
            .put("startedAt", System.currentTimeMillis() - 3 * 3_600_000L)
            .put("mimeType", "application/pdf")
        File(zen, "downloads.json").writeText(JSONObject().put("version", 1).put("items", JSONArray().put(item)).toString())
        val now = System.currentTimeMillis()
        val revoked = JSONObject()
            .put("origin", REVOKED_ORIGIN)
            .put("permissions", JSONArray().put("geolocation").put("notifications"))
            .put("revokedAt", now - 2 * 86_400_000L)
            .put("expiresAt", now + 28 * 86_400_000L)
        File(zen, "permissions.json").writeText(
            JSONObject().put("version", 1).put("decisions", JSONObject()).put("revokedUnused", JSONArray().put(revoked)).toString()
        )
    }

    /** `"{{now-3h}}"` / `"{{now-2d}}"` (quotes included) become the epoch millisecond that long before now. */
    private fun stamp(text: String): String {
        val now = System.currentTimeMillis()
        return STAMP.replace(text) { m ->
            val amount = m.groupValues[1].toLongOrNull() ?: 0L
            val unit = if (m.groupValues[2] == "d") 86_400_000L else 3_600_000L
            (now - amount * unit).toString()
        }
    }

    /**
     * A one-page PDF, padded to about 1.2 MB with a comment stream so the card's size reads as a
     * document's would (the padding lies after `%%EOF`, where a reader ignores it).
     */
    private fun pdfBytes(): ByteArray {
        val head = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
            "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
        val pad = ByteArray(1_228_800 - head.length) { '%'.code.toByte() }
        return head.toByteArray() + pad
    }

    // --- warm-up ---------------------------------------------------------------------------------

    /**
     * Off camera: read what the host says of the default browser (the default browser tip's
     * condition), pay for the menu and the first new tab page's layout, and calibrate the DOM's
     * boxes against the tree. The off-camera page takes the tip module's first impression (the
     * stack's mount writes it), so the memory is emptied again after it – a seed, on record –
     * for the first page on camera to show the theme tip as a fresh profile's would.
     */
    override fun warmUp() {
        findings = File(out, "magic-stack-findings.txt")
        findings.writeText("Zenium Android Magic Stack checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        demoTabId = activeCoreTab()?.optString("id").orEmpty()
        val state = coreState()
        val defaultBrowser = state.optJSONObject("defaultBrowser") ?: JSONObject()
        notDefault = defaultBrowser.has("isDefault") && !defaultBrowser.isNull("isDefault") && !defaultBrowser.optBoolean("isDefault", true)
        finding(
            "start: ${describeActive()}; defaultBrowser $defaultBrowser (the default browser tip ${if (notDefault) "expected" else "not expected"} in its turn); " +
                "recentlyClosed ${state.optJSONArray("recentlyClosed")?.length()}; downloads ${summariseDownloads(state)}; " +
                "bookmarks ${state.optJSONArray("bookmarks")?.length()}; revoked ${state.optJSONArray("revokedUnusedPermissions")}; " +
                "safeBrowsing ${state.optJSONObject("settings")?.optJSONObject("privacy")?.opt("safeBrowsingEnabled")}; " +
                "safety card memory ${state.optJSONObject("newTabSafetyHubCard")}; tip memory ${state.optJSONObject("newTabEducationalTips")}; " +
                "tabs ${tabCount()}, groups ${groupCount()}, background ${background(state)}; hidden ${hiddenModules()}"
        )

        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_000)
        // The first new tab page pays for its layout (and the stack's): open and close one off camera.
        if (tapLabel(Finger(), NEW_TAB_LABEL)) {
            SystemClock.sleep(2_500)
            val fresh = activeCoreTab()
            if (fresh != null && fresh.optString("url") == BLANK_URL) {
                val stack = awaitChrome("!!$STACK_JS", 8_000)
                finding("warm-up: the stack ${if (stack) "painted" else "did NOT paint"} on the first page; cards ${cardIds()}")
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(fresh.optString("id"))}}")
                SystemClock.sleep(1_500)
            }
        }
        // The off-camera page's stack took the tip module's first impression: the memory back to
        // a fresh profile's, so the first page on camera shows the theme tip (NTP-20).
        val taken = tipMemory()
        setTipMemory(emptyTipMemory())
        finding("warm-up: the off-camera page took the tip module's first impression ($taken); the memory emptied again for the first page on camera (${tipMemory()})")
        ensureActive(demoTabId)
        val close = closeUrlField()
        if (!close.ok) finding("warm-up: ${close.describe()}")
        calibrateDomBoxes()
        finding("warm-up done: ${describeActive()}")
    }

    // --- the sequence ----------------------------------------------------------------------------

    override fun demo() {
        still("page")
        theStackOnThePage()
        pageBySwipe()
        theSafetyCheckCard()
        theTipCard()
        hideACard()
        customiseBringsItBack()
        theEmptyState()
        theWayBack()
        reopenFromContinue()
        finding("\nend: ${describeActive()}; ${failures.size} claim(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    /** The stack's cards on a fresh page: the four the seed gives, and the tip card while the module has a tip to show ([tipUp]). */
    private fun expectedCards(): List<String> = if (tipUp != null) MODULES else MODULES.filter { it != "tips" }

    // --- 1. the stack on the page ----------------------------------------------------------------

    private fun theStackOnThePage() {
        step("1. The stack on the page: one card per module with content, in the stack's order, named for TalkBack, the strip a carousel with its dots, above the tiles at the bottom dock") {
            val before = tabCount()
            tipUp = predictTip(tipMemory())
            finding("  the tip predicted for a fresh profile's memory: ${tipUp ?: "none"}")
            if (!tapLabel(Finger(), NEW_TAB_LABEL)) error("no '$NEW_TAB_LABEL' button on the bar")
            SystemClock.sleep(2_000)
            val expected = expectedCards()
            val up = awaitChrome("document.querySelectorAll('.zen-mstack-card').length===${expected.size}", 10_000)
            SystemClock.sleep(1_000)
            val geometry = geometry()
            val ids = cardIds()
            finding("  ${describeActive()} (tabs were $before); stack ${if (up) "up" else "NOT at the expected count"}; cards $ids; $geometry")
            expect("the plus opens a new tab page (tabs ${tabCount()})", tabCount() == before + 1 && activeUrl() == BLANK_URL, "ntp-open")
            expect("the stack draws ${expected.size} cards in the stack's order, the tip card last: $ids", ids == expected && tipUp == "ntp-theme", "stack-cards")
            val labels = chromeValue(CARD_LABELS_JS)
            finding("  card names: $labels")
            expect(
                "the cards are named for TalkBack, the module first then what it holds – the tip card the module's name, the tip's title and its description",
                labels.contains("Continue where you left off: ${tides.title}") &&
                    labels.contains("Downloads: $DOWNLOAD_NAME") &&
                    labels.contains("Bookmarks: ${sites[2].title}, ${sites[3].title}") &&
                    labels.contains(SAFETY_CARD_LABEL) &&
                    labels.contains(tipLabel("ntp-theme")),
                "stack-card-names"
            )
            expect("every card is a page surface (data-surface page)", chromeValue("String(${ALL_PAGE_SURFACES_JS})") == "true", "stack-card-surface")
            expect(
                "the strip is a list with the carousel role description, the section named 'Cards'",
                chromeValue("(($STRIP_JS)||{getAttribute:function(){return ''}}).getAttribute('role')") == "list" &&
                    chromeValue("(($STRIP_JS)||{getAttribute:function(){return ''}}).getAttribute('aria-roledescription')") == "carousel" &&
                    chromeValue("(($STACK_JS)||{getAttribute:function(){return ''}}).getAttribute('aria-label')") == "Cards",
                "stack-carousel-roles"
            )
            val dots = geometry.optInt("dots")
            expect(
                "the indicator: a dot per card (${dots} of ${expected.size}), the first current, a status line reading 'Page 1 of ${expected.size}' (role '${geometry.optString("role")}', status '${geometry.optString("status")}')",
                dots == expected.size && geometry.optInt("selected") == 0 && geometry.optString("role") == "status" && geometry.optString("status") == "Page 1 of ${expected.size}",
                "stack-dots"
            )
            expect(
                "the dots are indicators, not controls: no button, tab or focusable thing among them (${geometry.optInt("controls")}), every dot hidden from the reader, each a ${geometry.optInt("dotSize")} px disc",
                geometry.optInt("controls") == 0 && geometry.optBoolean("dotsHidden") && geometry.optInt("dotSize") in 5..7,
                "stack-dots-indicators"
            )
            val actions = chromeValue(ACTIONS_JS)
            val actionsExpected = JSONArray().also { list ->
                for (id in expected) list.put(JSONArray().put(id).put(JSONArray(actionsFor(id, tipUp))))
            }.toString()
            finding("  the cards' actions: $actions")
            expect("one action a card and only one its rows do not already do – none on Continue, See all on Downloads and Bookmarks, Review on Safety check, the tip's one button (Try it now on the theme tip)", actions == actionsExpected, "stack-actions")
            val detail = chromeValue(CONTINUE_DETAIL_JS)
            expect("the Continue card's detail reads the host then the time ('$detail'; the seed closed the tab an hour ago)", detail == "127.0.0.1 · 1 h ago", "stack-continue-detail")
            val mores = chromeValue(MORE_LABELS_JS)
            finding("  the ⋮ buttons: $mores")
            expect("each ⋮ is the shared 44 icon button named for its module", mores == JSONArray(expected.map { "More options for ${moduleTitle(it)}" }).toString() && chromeValue("String(${ALL_MORE_ICON_BUTTONS_JS})") == "true", "stack-more-buttons")
            // The tree: the first card's ⋮ by name (the WebView's tree carries buttons reliably,
            // but only those in view – the second card's ⋮ lies beyond the strip's clip, where the
            // first run looked for it; the cards' own names are read from the DOM above and noted
            // from the tree here).
            val firstMore = "More options for ${moduleTitle(expected[0])}"
            val treeMore = awaitFresh(8_000, "the first card's ⋮") { it == firstMore } != null
            val treeCard = findNode { it.startsWith("Continue where you left off") } != null
            finding("  tree: the first card's ⋮ '$firstMore' ${if (treeMore) "named" else "NOT found"}; a node starting 'Continue where you left off' ${if (treeCard) "present" else "absent"}")
            expect("TalkBack has the ⋮ by its module's name", treeMore, "stack-more-tree")
            // Geometry at the bottom dock (the phone's default): the stack above the tiles, the
            // card the strip's width less the 24 the next card peeks by.
            val dock = chromeValue("(document.querySelector('.zen-ntp')||{dataset:{}}).dataset.dock||''")
            val stack = domBox(STACK_JS)
            val grid = domBox(GRID_JS)
            expect("at the bottom dock (data-dock '$dock') the stack stands above the tiles (stack bottom ${stack?.bottom} <= grid top ${grid?.top})", dock == "bottom" && stack != null && grid != null && stack.bottom <= grid.top, "stack-above-tiles")
            val cardWidth = geometry.optInt("cardWidth")
            val stripInner = geometry.optInt("stripInner")
            expect("a card is the strip's width less the 24 the next one peeks by (card $cardWidth, strip $stripInner)", cardWidth > 0 && abs(stripInner - 24 - cardWidth) <= 2, "stack-card-peek")
            still("stack-first-card")
        }
    }

    // --- 2. paging by a swipe ---------------------------------------------------------------------

    private fun pageBySwipe() {
        step("2. Paging: a real swipe on the strip snaps to the second card and the indicator reads page 2; a swipe back returns to the first card") {
            val expected = expectedCards()
            val pitch = geometry().optInt("cardWidth") + 8
            val swipe = planSwipe(forward = true)
            measureFrames("magic-stack-swipe", JankBudget.Kind.GESTURE, trace = true) {
                swipe.run()
                SystemClock.sleep(900)
            }
            val paged = awaitChrome(dotCurrentJs(1), 4_000)
            SystemClock.sleep(400)
            val after = geometry()
            finding("  the strip's scrollLeft over the swipe (ms, px): ${chromeValue(SWIPE_PROBE_READ_JS)}")
            finding("  after the swipe: $after")
            expect("the strip snapped to the second card (scrollLeft ${after.optInt("scrollLeft")} within 12 of the pitch $pitch)", abs(after.optInt("scrollLeft") - pitch) <= 12, "stack-swipe-snap")
            expect("the indicator reads 'Page 2 of ${expected.size}' with the second dot current (status '${after.optString("status")}', current ${after.optInt("selected")})", paged && after.optInt("selected") == 1 && after.optString("status") == "Page 2 of ${expected.size}", "stack-swipe-status")
            still("stack-second-card")
            // Back the way it came: the dots take no tap, so a swipe to the right pages back.
            swipeStrip(forward = false)
            SystemClock.sleep(900)
            val back = awaitChrome(dotCurrentJs(0), 4_000)
            SystemClock.sleep(400)
            val home = geometry()
            finding("  the strip's scrollLeft over the swipe back (ms, px): ${chromeValue(SWIPE_PROBE_READ_JS)}")
            finding("  after the swipe back: $home")
            expect("a swipe back returns the strip to the first card (scrollLeft ${home.optInt("scrollLeft")}, status '${home.optString("status")}')", back && home.optInt("selected") == 0 && home.optInt("scrollLeft") <= 4, "stack-swipe-back")
            SystemClock.sleep(600)
        }
    }

    /**
     * A real swipe on the strip, a card's worth: to the left (`forward`) for the next card, to
     * the right for the one before. The finger starts on a card's body – nine tenths of the way
     * across the strip for a swipe left, a quarter of the way for a swipe right (clear of the
     * screen's edge, where the system's own gesture lives) – on the strip's middle line, off the
     * ⋮ and the action. It settles in first, as the pill gestures do: a nudge past the touch slop
     * and a hold, so the strip has the finger before the swipe – the compositor asks the main
     * thread which scroller a touch is on, and in the first run the moves of that first frame
     * went with the answer (the strip stopped 58 CSS px short of a 207 px swipe, under half a
     * pitch, and snapped back). Then most of the strip's width in 240 ms and off: a fling, which
     * the cards' `scroll-snap-stop: always` holds to the next card, and a travel that lands there
     * by nearness alone should the fling not register. A probe samples the strip's scrollLeft
     * every animation frame to record the trajectory ([SWIPE_PROBE_READ_JS] after).
     */
    private fun swipeStrip(forward: Boolean) = planSwipe(forward).run()

    /** A swipe planned and its probe armed (the chrome asked nothing more once the finger is down): [run] is the finger alone. */
    private inner class Swipe(private val x: Float, private val y: Float, private val nudge: Float, private val travel: Float) {
        fun run() {
            Finger().apply {
                down(x, y)
                moveBy(nudge, 0f, 60)
                hold(SWIPE_SETTLE_MS)
                moveBy(travel, 0f, 240)
                up()
            }
        }
    }

    private fun planSwipe(forward: Boolean): Swipe {
        val strip = domBox(STRIP_JS) ?: error("no strip on the page")
        val sign = if (forward) -1f else 1f
        val startX = if (forward) strip.left + strip.width() * 9 / 10 else strip.left + strip.width() / 4
        val start = Rect(startX, strip.top + strip.height() / 2, startX + 2, strip.top + strip.height() / 2 + 2)
        val from = touchPoint(start) ?: error("the strip lies outside the touchable window ($strip)")
        val nudge = sign * SWIPE_NUDGE_DP * density
        val travel = sign * strip.width() * (if (forward) 0.85f else 0.7f) - nudge
        noteLine("  swipe ${if (forward) "left" else "right"} from ${from.x.toInt()},${from.y.toInt()}: a nudge of ${nudge.toInt()} px and a ${SWIPE_SETTLE_MS} ms hold, then ${travel.toInt()} px over 240 ms; the probe ${chromeValue(SWIPE_PROBE_ARM_JS)}")
        return Swipe(from.x, from.y, nudge, travel)
    }

    /**
     * The strip swiped forward a card at a time from where it stands to the card `id` of
     * `expected` (the strip's `scroll-snap-stop: always` holds a fling to the next card), each
     * swipe begun once the strip is at rest from the last; a swipe that does not take (the snap
     * flake `planSwipe`'s KDoc records: the strip follows the finger, then snaps back) is a
     * finding and is swiped again once, and the strip scrolled to the card by the DOM is the
     * last recovery, on record. The strip's geometry where it stood.
     */
    private fun swipeToCard(id: String, expected: List<String>): JSONObject {
        val index = expected.indexOf(id)
        if (index < 0) error("the stack's expected order has no $id card")
        var at = geometry().optInt("selected").coerceAtLeast(0)
        while (at < index) {
            var took = false
            for (attempt in 1..2) {
                awaitStripAtRest()
                swipeStrip(forward = true)
                SystemClock.sleep(900)
                took = awaitChrome(dotCurrentJs(at + 1), 4_000)
                if (took) break
                finding("  the swipe to page ${at + 2} did not take${if (attempt == 1) " – swiped again" else " twice"}: ${geometry()}")
            }
            val now = geometry().optInt("selected")
            if (now <= at) break
            at = now
        }
        SystemClock.sleep(400)
        var stood = geometry()
        if (stood.optInt("selected") != index) {
            chromeValue(scrollToCardJs(id))
            SystemClock.sleep(1_000)
            stood = geometry()
            finding("  the swipes stopped short of the $id card: the strip scrolled to it by the DOM, now $stood")
        }
        return stood
    }

    /** The strip's offset read until two reads 150 ms apart agree (a snap in flight let finish), two seconds at most. */
    private fun awaitStripAtRest() {
        var last = geometry().optInt("scrollLeft")
        val deadline = SystemClock.uptimeMillis() + 2_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(150)
            val now = geometry().optInt("scrollLeft")
            if (now == last) return
            last = now
        }
    }

    // --- 3. the Safety check card ---------------------------------------------------------------

    /**
     * NTP-19's card (W6-E9): swiped to a card at a time (the strip's `scroll-snap-stop: always`
     * holds a fling to the next card; the strip scrolled to the card by the DOM is the recovery
     * should a swipe stop short), its face read from the DOM against Chrome's and the gate's
     * numbers – the tile the page's own (a `.zen-ntp-tile`'s radius, 56 with a 24 glyph, on the
     * card surface's `--v2-fill` – a page surface's fill, where the shortcuts on the window read
     * the window family's; the image's WebView 113 knows neither `corner-shape` nor `text-wrap:
     * balance`, so the squircle and the balanced title are the device's, noted here from
     * `CSS.supports`), the memory read from the core before and after the finger. Review opens
     * the Settings tab; Settings is the chrome document's own page (`SettingsPage.tsx`, as the
     * new tab page is), so its landing is read there. The new tab page is then made active
     * again (`tab.activate`) with the Settings tab left open behind it – closed, it would head
     * the recently closed list the Continue card reads, and step 9 restores the seeded tab – and
     * the strip swiped home for the tip step and the Hide This step after it, which wants the
     * Continue card in view.
     */
    private fun theSafetyCheckCard() {
        step("3. The Safety check card: the seeded revoked permission gives Chrome's low-priority type alone, fourth in the stack – the page's tile with the check, 'Removed permissions for 1 site', no summary, one filled Review named 'Review Safety check'; Review opens Settings on the Safety check group in a new tab and does not end the run") {
            val ntpTabId = activeCoreTab()?.optString("id").orEmpty()
            val expected = expectedCards()
            val index = expected.indexOf("safety-hub")
            val stood = swipeToCard("safety-hub", expected)
            expect("the strip stands on the Safety check card, page ${index + 1} of ${expected.size} (selected ${stood.optInt("selected")}, status '${stood.optString("status")}')", stood.optInt("selected") == index && stood.optString("status") == "Page ${index + 1} of ${expected.size}", "safety-page")
            val face = runCatching { JSONObject(chromeValue(SAFETY_FACE_JS)) }.getOrElse { JSONObject() }
            finding("  the card's face: $face")
            finding("  the WebView's CSS: ${chromeValue(CSS_SUPPORT_JS)}")
            expect("the card is the revoked-permissions type – the seed's one record; Safe Browsing on and no password checkup leave the two higher types nothing – titled 'Removed permissions for 1 site' with no summary, as Chrome's ('${face.optString("title")}', summary ${face.opt("summary")})", face.optString("type") == "revoked-permissions" && face.optString("title") == "Removed permissions for 1 site" && face.isNull("summary"), "safety-type")
            expect("the card is named for TalkBack '$SAFETY_CARD_LABEL' ('${face.optString("label")}')", face.optString("label") == SAFETY_CARD_LABEL, "safety-name")
            val tile = face.optJSONObject("tile")
            val shortcut = tile?.optJSONObject("shortcut")
            expect(
                "the tile is the page's own: 56 with a 24 glyph at the shortcuts' radius, on the card surface's --v2-fill and no wash (tile ${tile?.optInt("w")} × ${tile?.optInt("h")}, radius ${tile?.optString("radius")}, fill ${tile?.optString("background")} against the surface's ${face.optString("fill")}, glyph ${tile?.optInt("glyph")}; a shortcut tile radius ${shortcut?.optString("radius")} on the window's ${shortcut?.optString("background")})",
                tile != null && shortcut != null && tile.optInt("w") == 56 && tile.optInt("h") == 56 && tile.optInt("glyph") == 24 &&
                    tile.optString("radius") == "8px" && tile.optString("radius") == shortcut.optString("radius") && tile.optString("background") == face.optString("fill"),
                "safety-tile"
            )
            expect("the title block: 17/600 on 22, the one line of the type's title (${face.optString("titleFont")})", face.optString("titleFont") == "17px/600/22px", "safety-title-scale")
            expect("one filled button, 'Review', named 'Review Safety check' (${face.optInt("buttons")} button(s): '${face.optString("button")}' / '${face.optString("buttonLabel")}', primary ${face.optBoolean("primary")})", face.optInt("buttons") == 1 && face.optString("button") == "Review" && face.optString("buttonLabel") == "Review Safety check" && face.optBoolean("primary"), "safety-button")
            val before = safetyMemory()
            finding("  the memory before the finger: $before")
            expect("the impression is on the card's memory: the run open since the stack's mount, an impression counted, no run ended (activeSince ${before?.opt("activeSince")}, impressions ${before?.optInt("impressions")}, runs ${before?.optInt("runs")})", before != null && !before.isNull("activeSince") && before.optInt("impressions") >= 1 && before.optInt("runs") == 0, "safety-memory")
            still("safety-card")

            val tabsBefore = tabCount()
            val opened = touchDomExpecting("the Safety check card's Review button", SAFETY_ACTION_JS, "a Settings tab on the Safety check group is the active tab", 10_000) {
                activeUrl().startsWith(SAFETY_SETTINGS_URL) && tabCount() == tabsBefore + 1
            }
            val settingsTab = activeCoreTab()?.takeIf { it.optString("url").startsWith(SAFETY_SETTINGS_URL) }?.optString("id").orEmpty()
            finding("  ${describeActive()} (tabs were $tabsBefore)")
            expect("Review opens Settings on the Safety check group in a new tab in front ($SAFETY_SETTINGS_URL)", opened && settingsTab.isNotEmpty(), "safety-review-opens")
            val landed = settingsTab.isNotEmpty() && awaitChrome(SAFETY_LANDED_JS, 10_000)
            finding("  the settings page: ${if (settingsTab.isEmpty()) "no tab" else chromeValue(SAFETY_LANDING_JS)}")
            expect("the page lands on the Safety check group – the group marked as the landing, its top in the viewport's upper part, its heading 'Safety check'", landed, "safety-landing")
            SystemClock.sleep(800)
            still("safety-review-settings")
            val after = safetyMemory()
            finding("  the memory after Review: $after")
            expect("Review does not end the run – Chrome's Review is a look, not a fix; the two asks' buttons dismiss, this one does not (activeSince ${after?.opt("activeSince")}, runs ${after?.optInt("runs")})", after != null && !after.isNull("activeSince") && after.optInt("runs") == 0, "safety-review-keeps-run")

            // The Settings tab stays open behind the page: `tab.close` would seat it at the head of
            // the recently closed list, which the Continue card reads and step 9 restores from.
            // The page re-mounts (the chrome keeps no new tab page for a tab out of view,
            // `ContentArea.tsx`), and the tip module's impression on it rests the module three
            // days (Chrome's `kEducationalTipShownCount` over `KDaysToShowEphemeralCardOnce`): the
            // stack comes back without the tip card (NTP-20).
            if (ntpTabId.isNotEmpty()) ensureActive(ntpTabId)
            val memory = tipMemory()
            tipUp = predictTip(memory)
            val expectedBack = expectedCards()
            val back = awaitChrome("document.querySelectorAll('.zen-mstack-card').length===${expectedBack.size}", 8_000)
            SystemClock.sleep(600)
            val ids = cardIds()
            finding("  the tip memory at the re-mount: $memory; the tip predicted: ${tipUp ?: "none"}")
            expect("the new tab page is active again in front of the Settings tab with its ${expectedBack.size} cards, the Safety check card still among them and the tip card gone – the module rests three days after an impression ($ids; ${describeActive()})", back && activeUrl() == BLANK_URL && ids == expectedBack && tipUp == null && tabCount() == tabsBefore + 1, "safety-back")
            val home = swipeHome(expectedBack.size)
            expect("the strip stands on the first card again for the steps after (selected ${home.optInt("selected")}, scrollLeft ${home.optInt("scrollLeft")})", home.optInt("selected") == 0 && home.optInt("scrollLeft") <= 4, "safety-home")
            SystemClock.sleep(400)
        }
    }

    /**
     * The strip swiped back a card at a time to the first card, at most `cards` swipes, each begun
     * once the strip is at rest; the strip scrolled home by the DOM is the recovery, on record.
     * The strip's geometry where it stood.
     */
    private fun swipeHome(cards: Int): JSONObject {
        var home = geometry()
        var swipes = 0
        while (home.optInt("selected") > 0 && swipes < cards) {
            val target = home.optInt("selected") - 1
            awaitStripAtRest()
            swipeStrip(forward = false)
            swipes++
            SystemClock.sleep(900)
            awaitChrome(dotCurrentJs(target), 4_000)
            home = geometry()
        }
        if (home.optInt("selected") != 0 || home.optInt("scrollLeft") > 4) {
            chromeValue(SCROLL_HOME_JS)
            SystemClock.sleep(1_000)
            home = geometry()
            finding("  the swipes back stopped short of the first card: the strip scrolled home by the DOM, now $home")
        }
        finding("  home after $swipes swipe(s) back: $home")
        return home
    }

    // --- 4. the tip card ------------------------------------------------------------------------

    /**
     * NTP-20's card (W6-E15): Chrome's educational tip module in the Magic Stack, one tip at a
     * time at the stack's end (`EphemeralHomeModuleRank::kLast`), the first eligible in the
     * registry's order – the theme, the default browser, tab groups, Delete browsing data
     * (`home_modules_card_registry_android.cc:36-64`) – any tip once in three days, each once in
     * seven, ten impressions a card (three for the default browser), a tapped card never again
     * (`constants.h:119-130`, `default_browser_promo.cc:20`, `:151-183`). The memory is the
     * device's (`NewTabDeviceState.educationalTips`, read through `UIState.newTabEducationalTips`
     * and written through `newtab.setEducationalTipMemory` – the command the page writes with,
     * and the one the driver seeds through). Every page here is opened by a finger on the bar's
     * New tab and swiped to its last card from where the strip stands – the chrome mounts one
     * stack for whichever blank tab is active, so the strip keeps its offset from one page to the
     * next: the first page takes the swipes, the pages after stand on the last card already, and
     * the module counts the new tab's page as an impression of its own (Chrome builds a stack a
     * page); the days between Chrome's tips are the driver's:
     * between pages it moves the memory's stamps eight days back and retires the tip shown –
     * the theme by its own tap here, the default browser at its cap of three impressions, the
     * others as tapped – so the next page shows the next tip in Chrome's order. The one button's
     * act is the theme tip's Try it now, which opens the page's customise sheet
     * (`ChromeTabbedActivity.java:3519-3531` opens Chrome's) and retires the card on the memory
     * while the card stands until the next page, as Chrome's `OnInteract` leaves it. Each face
     * is shot on the light scheme and the dark (the design record's pair), the light scheme –
     * the seed's – put back after each.
     */
    private fun theTipCard() {
        step("4. The tip card (NTP-20): the memory emptied, a fresh page shows the theme tip last in the stack – Chrome's title over Chrome's description, one filled button, the impression on the memory; Try it now opens the customise sheet and retires the card; eight days on, the next page shows the next tip in Chrome's order (the default browser where the host says Zenium is not the default, tab groups, Delete browsing data), light and dark; a page within three days of a tip shows none") {
            // The tips this profile qualifies for, in Chrome's order: the default browser's only where
            // the host says Zenium is not the default.
            val order = TIP_ORDER.filter { it != "default-browser" || notDefault }
            finding("  the tips this profile qualifies for: $order (the host's answer on the default browser: ${if (notDefault) "not the default" else "the default, or not yet known"})")
            val shown = ArrayList<String>()
            var seed: JSONObject? = emptyTipMemory()
            var what = "the memory emptied again – a fresh profile's"
            while (shown.size < order.size) {
                val tip = openTipPage(seed, what) ?: break
                val expected = expectedCards()
                val stood = swipeToCard("tips", expected)
                expect("the strip stands on the tip card, page ${expected.size} of ${expected.size} (selected ${stood.optInt("selected")}, status '${stood.optString("status")}')", stood.optInt("selected") == expected.size - 1 && stood.optString("status") == "Page ${expected.size} of ${expected.size}", "tip-$tip-page")
                tipFace(tip, shown.size + 1)
                if (tip == "ntp-theme") tryItNow(tip)
                shown += tip
                if (shown.size == order.size) break
                // Eight days on, the tip shown retired: the next page's tip is the next in the order.
                seed = retired(rested(tipMemory(), 8), tip)
                what = "eight days on (the memory's stamps moved back by the driver), the $tip tip retired ${if (tip == "default-browser") "at its cap of three impressions" else "by its tap"}"
            }
            finding("  the tips shown: $shown")
            expect("the tips came one to a page in Chrome's order, every tip the profile qualifies for once: $shown", shown == order, "tip-order")
            // The memory as the last page left it – a tip shown minutes ago: the next page shows none.
            val none = openTipPage(null, "a page within three days of a tip")
            expect("a page within three days of a tip draws no tip card (predicted ${none ?: "none"}; cards ${cardIds()})", none == null && !cardIds().contains("tips"), "tip-rests")
            // The strip keeps its offset from one blank tab's page to the next (the one mounted
            // stack): swiped home, so the Hide This step finds the Continue card in view.
            val home = swipeHome(expectedCards().size)
            expect("the strip stands on the first card again for the steps after (selected ${home.optInt("selected")}, scrollLeft ${home.optInt("scrollLeft")})", home.optInt("selected") == 0 && home.optInt("scrollLeft") <= 4, "tip-home")
            SystemClock.sleep(400)
        }
    }

    /**
     * A fresh page under the tip module's memory as `seed`ed (null: as the last page left it): the
     * tip predicted from the memory and the page's signals ([predictTip]) is the one expected on
     * it ([tipUp]), and the page – opened by a finger on the bar's New tab – is expected to draw
     * the stack's cards with the tip card last, or without it. The tip predicted, or null.
     */
    private fun openTipPage(seed: JSONObject?, what: String): String? {
        if (seed != null) setTipMemory(seed)
        val memory = tipMemory()
        tipUp = predictTip(memory)
        finding("  $what: memory $memory; tabs ${tabCount()}, groups ${groupCount()}, background ${background()}; the tip predicted: ${tipUp ?: "none"}")
        val before = tabCount()
        if (!tapLabel(Finger(), NEW_TAB_LABEL)) error("no '$NEW_TAB_LABEL' button on the bar")
        SystemClock.sleep(2_000)
        val expected = expectedCards()
        val up = awaitChrome("document.querySelectorAll('.zen-mstack-card').length===${expected.size}", 10_000)
        SystemClock.sleep(600)
        val ids = cardIds()
        finding("  ${describeActive()} (tabs were $before); cards $ids")
        expect(
            "the page draws ${expected.size} cards${if (tipUp != null) ", the tip card last" else " and no tip card"}: $ids",
            up && ids == expected && activeUrl() == BLANK_URL && tabCount() == before + 1,
            "tip-page-${tipUp ?: "none"}"
        )
        return tipUp
    }

    /** The tip card's face read against Chrome's words and the gate's numbers, its impression on the memory, and its two stills. */
    private fun tipFace(tip: String, ordinal: Int) {
        val face = runCatching { JSONObject(chromeValue(TIP_FACE_JS)) }.getOrElse { JSONObject() }
        finding("  the tip card's face: $face")
        val title = TIP_TITLES.getValue(tip)
        val description = TIP_DESCRIPTIONS.getValue(tip)
        val button = TIP_BUTTONS.getValue(tip)
        expect("the card is the $tip tip: Chrome's title '$title' over Chrome's description ('${face.optString("title")}' / '${face.optString("description")}')", face.optString("card") == tip && face.optString("title") == title && face.optString("description") == description, "tip-$tip-face")
        expect("the card is named for TalkBack '${tipLabel(tip)}' ('${face.optString("label")}')", face.optString("label") == tipLabel(tip), "tip-$tip-name")
        val tile = face.optJSONObject("tile")
        expect(
            "the tile is the page's own, as the Safety check card's: 56 with a 24 glyph on the card surface's --v2-fill (tile ${tile?.optInt("w")} × ${tile?.optInt("h")}, radius ${tile?.optString("radius")}, fill ${tile?.optString("background")} against the surface's ${face.optString("fill")}, glyph ${tile?.optInt("glyph")})",
            tile != null && tile.optInt("w") == 56 && tile.optInt("h") == 56 && tile.optInt("glyph") == 24 && tile.optString("radius") == "8px" && tile.optString("background") == face.optString("fill"),
            "tip-$tip-tile"
        )
        expect(
            "the title block: 17/600 on 22 (${face.optString("titleFont")}); the description in full and never clamped – the card grows with the sentence, the button under it (${face.optInt("descriptionLines")} line(s) at ${face.optString("descriptionFont")}, line clamp ${face.optString("descriptionClamp")}, drawn whole ${face.optBoolean("descriptionFull")}, the button's top ${face.optInt("buttonTop")} at or under the sentence's bottom ${face.optInt("descriptionBottom")}, the card ${face.optInt("cardHeight")} tall; Chrome's layout clamps at two)",
            face.optString("titleFont") == "17px/600/22px" && face.optInt("descriptionLines") >= 1 && face.optString("descriptionClamp") == "none" && face.optBoolean("descriptionFull") && face.optInt("buttonTop") >= face.optInt("descriptionBottom"),
            "tip-$tip-text"
        )
        expect("one filled button '$button' named '$button: $title' (${face.optInt("buttons")} button(s): '${face.optString("button")}' / '${face.optString("buttonLabel")}', primary ${face.optBoolean("primary")})", face.optInt("buttons") == 1 && face.optString("button") == button && face.optString("buttonLabel") == "$button: $title" && face.optBoolean("primary"), "tip-$tip-button")
        val memory = tipMemory()
        val card = memory.optJSONObject("cards")?.optJSONObject(tip)
        finding("  the memory with the card up: $memory")
        expect("the impression is on the memory before the finger lands: the $tip card's impressions ${card?.optInt("impressions")}, shown now, the module's shownAt set", card != null && card.optInt("impressions") >= 1 && !card.isNull("shownAt") && !memory.isNull("shownAt"), "tip-$tip-memory")
        still("tip-$ordinal-$tip-light")
        darkStill("tip-$ordinal-$tip-dark")
    }

    /** The theme tip's one button: the page's customise sheet opens, the card is retired on the memory and stands until the next page. */
    private fun tryItNow(tip: String) {
        val title = TIP_TITLES.getValue(tip)
        val button = TIP_BUTTONS.getValue(tip)
        val opened = touchControlExpecting("$button: $title", TIP_ACTION_JS, "the page's customise sheet '$GEAR_TITLE' is up", 8_000) { sheetPresented(GEAR_TITLE) }
        expect("$button opens the page's customise sheet '$GEAR_TITLE' – the feature itself, as Chrome's button opens its customisation sheet (sheets ${sheetsPresented()})", opened, "tip-cta-opens")
        awaitSheetAtRest(6_000)
        still("tip-1-$tip-try-it-now")
        val memory = tipMemory()
        val card = memory.optJSONObject("cards")?.optJSONObject(tip)
        finding("  the memory after the tap: $memory; cards ${cardIds()}")
        expect("the tap retires the card on the memory (interacted ${card?.optBoolean("interacted")}) while the card stands until the next page, as Chrome's OnInteract leaves it (cards ${cardIds()})", card != null && card.optBoolean("interacted") && cardIds().contains("tips"), "tip-cta-retires")
        back()
        expect("the system back closes the sheet", awaitSheetGone(GEAR_TITLE, 6_000), "tip-cta-sheet-closed")
        SystemClock.sleep(600)
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

    /** The tip module's memory (`newTabDevice.educationalTips`, read through `UIState.newTabEducationalTips`). */
    private fun tipMemory(): JSONObject = coreState().optJSONObject("newTabEducationalTips") ?: emptyTipMemory()

    private fun setTipMemory(memory: JSONObject) {
        coreInvoke("newtab.setEducationalTipMemory", JSONObject().put("memory", memory).toString())
    }

    private fun emptyTipMemory(): JSONObject =
        JSONObject().put("cards", JSONObject()).put("shownAt", JSONObject.NULL).put("browsingDataClearedAt", JSONObject.NULL)

    /** The memory as it would stand `days` after its last impression: every shownAt moved that far back (the driver's stand-in for the days passing). */
    private fun rested(memory: JSONObject, days: Int): JSONObject {
        val copy = JSONObject(memory.toString())
        val at = System.currentTimeMillis() - days * DAY_MS
        if (!copy.isNull("shownAt")) copy.put("shownAt", at)
        val cards = copy.optJSONObject("cards") ?: JSONObject().also { copy.put("cards", it) }
        for (key in cards.keys()) {
            val card = cards.getJSONObject(key)
            if (!card.isNull("shownAt")) card.put("shownAt", at)
        }
        return copy
    }

    /** The memory with the `tip` retired: the default browser tip at its cap of three impressions, any other as tapped. */
    private fun retired(memory: JSONObject, tip: String): JSONObject {
        val cards = memory.optJSONObject("cards") ?: JSONObject().also { memory.put("cards", it) }
        val card = cards.optJSONObject(tip) ?: JSONObject().put("impressions", 1).put("shownAt", System.currentTimeMillis() - 8 * DAY_MS).put("interacted", false).also { cards.put(tip, it) }
        if (tip == "default-browser") card.put("impressions", DEFAULT_BROWSER_TIP_CAP) else card.put("interacted", true)
        return memory
    }

    /**
     * The tip the machine picks at the next mount (`pickEducationalTipCard`): none while the
     * module rests (a tip within three days); else the first card in Chrome's order that is
     * wanted – the theme while the background is the default, the default browser while the host
     * says Zenium is not the default and no other surface is asking, tab groups while there is no
     * group and more than ten tabs, Delete browsing data while none was deleted here in 30 days –
     * and rested: not tapped, under its cap (ten; three for the default browser), not shown in
     * seven days.
     */
    private fun predictTip(memory: JSONObject, state: JSONObject = coreState()): String? {
        val now = System.currentTimeMillis()
        val shownAt = if (memory.isNull("shownAt")) null else memory.optLong("shownAt")
        if (shownAt != null && now - shownAt < 3 * DAY_MS) return null
        val cleared = if (memory.isNull("browsingDataClearedAt")) null else memory.optLong("browsingDataClearedAt")
        val cards = memory.optJSONObject("cards") ?: JSONObject()
        val prompt = state.optJSONObject("defaultBrowser")?.opt("prompt")
        val tabs = state.getJSONObject("tabs").length()
        val groups = state.optJSONObject("folders")?.length() ?: 0
        for (id in TIP_ORDER) {
            val wanted = when (id) {
                "ntp-theme" -> background(state) == "space"
                "default-browser" -> notDefault && (prompt == null || prompt == JSONObject.NULL)
                "tab-groups" -> groups == 0 && tabs > TAB_GROUPS_TIP_TABS
                else -> cleared == null || now - cleared >= 30 * DAY_MS
            }
            if (!wanted) continue
            val card = cards.optJSONObject(id)
            if (card != null) {
                if (card.optBoolean("interacted")) continue
                if (card.optInt("impressions") >= (if (id == "default-browser") DEFAULT_BROWSER_TIP_CAP else TIP_CAP)) continue
                if (!card.isNull("shownAt") && now - card.optLong("shownAt") < 7 * DAY_MS) continue
            }
            return id
        }
        return null
    }

    private fun groupCount(state: JSONObject = coreState()): Int = state.optJSONObject("folders")?.length() ?: 0

    /** The page's background kind (`settings.newTab.background`; `space` is the default, the theme tip's condition). */
    private fun background(state: JSONObject = coreState()): String =
        state.optJSONObject("settings")?.optJSONObject("newTab")?.optString("background", "space") ?: "space"

    // --- 5. Hide This -----------------------------------------------------------------------------

    private fun hideACard() {
        step("5. A card's ⋮ opens the module's menu (Hide This, Customise); Hide This writes the hidden set, fades the card over 120 ms and glides the rest into the gap") {
            val id = "continue"
            val title = moduleTitle(id)
            if (!touchControl("More options for $title", moreJs(id))) error("no ⋮ on the $title card")
            val sheet = awaitSheet(title, 8_000)
            val rested = sheet && awaitSheetAtRest(6_000)
            val rows = chromeValue(MENU_ROWS_JS)
            finding("  the menu: sheets ${sheetsPresented()}, rows $rows, rested ${verdict(rested)}")
            expect("the ⋮ opens the shared local menu titled '$title'", sheet, "menu-title")
            expect("its rows are Hide This and Customise", rows == JSONArray(listOf("Hide This", "Customise")).toString(), "menu-rows")
            still("card-menu")

            val row = domBox(menuItemJs("Hide This")) ?: error("the menu has no 'Hide This' row in the DOM")
            val at = touchPoint(row) ?: error("the 'Hide This' row lies outside the touchable window ($row)")
            val cardsBefore = cardIds()
            val armed = chromeValue(PROBE_ARM_JS)
            noteLine("  probe $armed; touch at ${at.x.toInt()},${at.y.toInt()} on 'Hide This' at the DOM's box $row")
            measureFrames("magic-stack-hide", JankBudget.Kind.SPRING, trace = true) {
                Finger().tap(at.x, at.y)
                SystemClock.sleep(1_400)
            }
            val probe = runCatching { JSONObject(chromeValue(PROBE_READ_JS)) }.getOrElse { JSONObject() }
            val hidden = hiddenModules()
            val cardsAfter = cardIds()
            finding("  probe: $probe")
            finding("  hidden set $hidden; cards $cardsBefore -> $cardsAfter; sheets ${sheetsPresented()}")
            expect("Hide This writes the device's hidden set (continue in $hidden)", hidden.contains("\"continue\""), "hide-writes")
            expect("the card leaves on its fade (data-leaving set at ${probe.opt("leavingAt")} ms, animationend at ${probe.opt("animationEndAt")} ms, the card out of the strip at ${probe.opt("removedAt")} ms)", !probe.isNull("leavingAt") && !probe.isNull("removedAt") && (!probe.isNull("animationEndAt") || probe.optInt("removedAt") - probe.optInt("leavingAt") in 100..400), "hide-fade")
            val transforms = probe.optJSONObject("transforms") ?: JSONObject()
            val glided = transforms.keys().asSequence().toList()
            expect("the cards after it glide into the gap on the FLIP spring (transform frames on $glided: $transforms)", cardsAfter.isNotEmpty() && glided.containsAll(cardsAfter.take(1)) && transforms.optInt(cardsAfter.first()) >= 2, "hide-gap-close")
            expect("the stack is the remaining ${cardsBefore.size - 1} cards", cardsAfter == cardsBefore.drop(1), "hide-cards")
            expect("the menu has left", awaitSheetGone(title, 4_000), "hide-menu-gone")
            SystemClock.sleep(400)
            still("card-hidden")
        }
    }

    // --- 6. Customise -----------------------------------------------------------------------------

    private fun customiseBringsItBack() {
        step("6. Customise from the ⋮ opens the stack's sheet of switch rows, the hidden card's off; a finger on it brings the card back behind the sheet, the strip paged to it") {
            val first = cardIds().firstOrNull() ?: error("no card left on the page")
            val title = moduleTitle(first)
            if (!touchControl("More options for $title", moreJs(first))) error("no ⋮ on the $title card")
            if (!awaitSheet(title, 8_000)) error("the $title menu did not open")
            awaitSheetAtRest(6_000)
            val swapped = touchDomExpecting("the menu's Customise row", menuItemJs("Customise"), "the stack's sheet '$SHEET_TITLE' is up and the menu gone", 8_000) {
                sheetPresented(SHEET_TITLE) && !sheetPresented(title)
            }
            expect("Customise swaps the menu for the stack's sheet '$SHEET_TITLE'", swapped, "customise-opens")
            awaitSheetAtRest(6_000)
            val heading = chromeValue("((document.querySelector('.zen-sheet .zen-v2-heading')||{}).textContent||'').trim()")
            val stray = chromeValue("String(document.body.textContent.indexOf('Magic Stack')>=0)")
            expect("the sheet's one section is 'Show' ('$heading'), and Chrome's name for the feature is nowhere on screen (stray 'Magic Stack': $stray)", heading == "Show" && stray == "false", "customise-name")
            val switches = switchStates()
            finding("  the sheet's switches: $switches; sheets ${sheetsPresented()}")
            val expected = JSONObject().also { for (id in MODULES) it.put(moduleTitle(id), id != "continue") }
            expect("one switch per module the host has (the five, the tip module one switch for all its tips), the hidden card's off: $switches", sameStates(switches, expected), "customise-switches")
            val note = chromeValue("((document.querySelector('.zen-sheet .zen-v2-description')||{}).textContent||'').trim()")
            expect("the sheet says a card appears only when it has something to show ('$note')", note == "A card appears only when it has something to show.", "customise-note")
            still("customise-sheet")
            val on = touchDomExpecting("the '${moduleTitle("continue")}' switch", switchJs("continue"), "the hidden set drops the id and the card is back", 6_000, reveal = true) {
                !hiddenModules().contains("\"continue\"") && cardIds().firstOrNull() == "continue"
            }
            expect("the switch on re-enables the card at once, back in its seat behind the sheet (cards ${cardIds()}, hidden ${hiddenModules()})", on, "customise-reenable")
            // The arrival (§9.29): Chrome alone keeps the snapped Downloads card through the layout
            // change, a pitch to the right; the strip pages to the card brought back on the spring,
            // so the card the sheet re-enabled is the card in view – the first dot current, the
            // offset at its snap position.
            val arrived = awaitChrome(ARRIVED_AT_FIRST_JS, 4_000)
            val stood = geometry()
            finding("  after the switch: $stood")
            expect("the strip pages to the card brought back: in view behind the sheet, the first dot current and the offset at the card's snap position (selected ${stood.optInt("selected")}, scrollLeft ${stood.optInt("scrollLeft")}, status '${stood.optString("status")}')", arrived && stood.optInt("selected") == 0 && stood.optInt("scrollLeft") <= 4, "customise-arrival")
            SystemClock.sleep(600)
            still("customise-reenabled")
        }
    }

    // --- 7. the empty state -----------------------------------------------------------------------

    private fun theEmptyState() {
        step("7. Every switch off: the stack is gone from the page, the page keeps its field and tiles") {
            if (!sheetPresented(SHEET_TITLE)) error("the '$SHEET_TITLE' sheet is not up")
            for (id in MODULES) {
                val title = moduleTitle(id)
                val off = touchDomExpecting("the '$title' switch", switchJs(id), "the hidden set carries $id", 6_000, reveal = true) { hiddenModules().contains("\"$id\"") }
                if (!off) finding("  the '$title' switch did not take")
                SystemClock.sleep(500)
            }
            val gone = awaitChrome("!$STACK_JS", 6_000)
            val hidden = hiddenModules()
            finding("  hidden set $hidden; stack ${if (gone) "gone" else "STILL on the page"}; field ${domBox(FIELD_JS)}, grid ${domBox(GRID_JS)}")
            expect("with every module hidden ($hidden) the stack is not drawn at all", gone && MODULES.all { hidden.contains("\"$it\"") }, "empty-stack-gone")
            expect("the page keeps its field and its tiles", domBox(FIELD_JS) != null && domBox(GRID_JS) != null, "empty-page-intact")
            still("customise-all-off")
            back()
            val closed = awaitSheetGone(SHEET_TITLE, 6_000)
            expect("the system back closes the sheet", closed, "empty-sheet-closed")
            SystemClock.sleep(1_000)
            still("empty")
        }
    }

    // --- 8. the way back through the gear ---------------------------------------------------------

    private fun theWayBack() {
        step("8. With no ⋮ left, the page's gear sheet seats a Cards row first, above Layout and in view at rest; it swaps the sheets, a switch brings one card back alone at full width, another brings the dots back and the strip pages to it") {
            if (!touchControl(GEAR_LABEL, GEAR_JS)) error("no gear on the page")
            val gear = awaitSheet(GEAR_TITLE, 8_000)
            awaitSheetAtRest(6_000)
            val row = chromeValue("((${GEAR_ROW_JS})||{}).textContent||''")
            finding("  the gear sheet ${verdict(gear)}; its Cards row: '$row'")
            expect("the gear opens the page's sheet '$GEAR_TITLE' with a 'Cards' row", gear && row.startsWith("Cards") && row.contains("Choose which cards show under the shortcuts") && !row.contains("Magic Stack"), "gear-row")
            // The seat (§9.13 seats a control panel's action rows first): the row is the sheet's
            // first row, a hairline after it and the Layout section – the first heading – after
            // that, so at the sheet's rest height the row is in view and the fold cuts Layout's
            // grid. The still is that rest height; the row's act is the next still.
            val seat = runCatching { JSONObject(chromeValue(GEAR_SEAT_JS)) }.getOrElse { JSONObject() }
            val inView = chromeValue(visibleInSheetJs(GEAR_ROW_JS)) == "true"
            finding("  the gear sheet's seat: $seat; the Cards row in view at rest: $inView")
            expect("the Cards row is the gear sheet's first row, a hairline after it, Layout the first heading (first '${seat.optString("first")}', then '${seat.optString("second")}', heading '${seat.optString("heading")}')", seat.optString("first") == "magic-stack" && seat.optString("second").contains("zen-sheet-sep") && seat.optString("heading") == "Layout", "gear-row-seat")
            expect("the Cards row is in view at the sheet's rest height, above the fold", inView, "gear-row-in-view")
            still("gear-sheet")
            val swapped = touchDomExpecting("the gear sheet's Cards row", GEAR_ROW_JS, "the gear sheet has left and the stack's is up", 8_000, reveal = true) {
                sheetPresented(SHEET_TITLE) && !sheetPresented(GEAR_TITLE)
            }
            expect("the row swaps the sheets: the gear's leaves first, the stack's comes up (sheets ${sheetsPresented()})", swapped, "gear-swap")
            awaitSheetAtRest(6_000)
            val states = switchStates()
            expect("every switch is off on the stack's sheet: $states", states.length() == MODULES.size && states.keys().asSequence().all { !states.optBoolean(it) }, "gear-switches-off")
            still("cards-sheet-from-gear")
            val lone = touchDomExpecting("the 'Bookmarks' switch", switchJs("bookmarks"), "the Bookmarks card is back alone", 6_000, reveal = true) {
                cardIds() == listOf("bookmarks")
            }
            SystemClock.sleep(700)
            val geometry = geometry()
            finding("  one card: $geometry")
            expect("one card back, alone: the strip's full width (card ${geometry.optInt("cardWidth")}, strip ${geometry.optInt("stripInner")}) and no dots (${geometry.optInt("dots")})", lone && geometry.optInt("dots") == 0 && abs(geometry.optInt("stripInner") - geometry.optInt("cardWidth")) <= 2, "lone-card")
            still("lone-card")
            val two = touchDomExpecting("the '${moduleTitle("continue")}' switch", switchJs("continue"), "two cards with their dots", 6_000, reveal = true) {
                cardIds() == listOf("continue", "bookmarks") && geometry().optInt("dots") == 2
            }
            expect("a second card brings the dots back (cards ${cardIds()})", two, "two-cards")
            // Continue came back ahead of the Bookmarks card in view: Chrome alone would keep
            // Bookmarks snapped through the layout change and leave Continue a page to the left;
            // the arrival pages the strip to the card brought back (§9.29).
            val arrived = awaitChrome(ARRIVED_AT_FIRST_JS, 4_000)
            val stood = geometry()
            finding("  after the second switch: $stood")
            expect("the strip pages to the card brought back ahead of the one in view: the first dot current, the offset at its snap position (selected ${stood.optInt("selected")}, scrollLeft ${stood.optInt("scrollLeft")}, status '${stood.optString("status")}')", arrived && stood.optInt("selected") == 0 && stood.optInt("scrollLeft") <= 4, "two-cards-arrival")
            back()
            val closed = awaitSheetGone(SHEET_TITLE, 6_000)
            expect("the system back closes the sheet", closed, "gear-sheet-closed")
            SystemClock.sleep(1_000)
            still("two-cards")
        }
    }

    // --- 9. the Continue card's row --------------------------------------------------------------

    private fun reopenFromContinue() {
        step("9. The Continue card's row restores the closed tab on its page (the row is the card's whole act; there is no Reopen button)") {
            // Step 8 brought Bookmarks back first and Continue after it, ahead of it in the order.
            // Chrome alone keeps the snapped card through the layout change and would leave the
            // Continue card a page to the left; the arrival paged the strip to it (§9.29), and it
            // stands there with the sheet gone. The dots take no tap; were the card a page to the
            // left after all, a swipe back is the recovery that brings it into view for the row.
            val stood = geometry()
            expect("the strip stands on the Continue card the switch brought back, the sheet gone (selected ${stood.optInt("selected")}, scrollLeft ${stood.optInt("scrollLeft")})", stood.optInt("selected") == 0 && stood.optInt("scrollLeft") <= 4, "arrival-stands")
            if (stood.optInt("selected") != 0) {
                swipeStrip(forward = false)
                SystemClock.sleep(900)
                val home = awaitChrome(dotCurrentJs(0), 4_000)
                finding("  the Continue card stood a page to the left ($stood): swiped back ${verdict(home)}, now ${geometry()}")
            }
            val before = tabCount()
            val reopened = touchDomExpecting("the Continue card's row", CONTINUE_ROW_JS, "the closed tab is back as the active tab", 10_000) {
                activeUrl() == url(tides) && tabCount() == before + 1
            }
            finding("  ${describeActive()} (tabs were $before); recentlyClosed ${coreState().optJSONArray("recentlyClosed")?.length()}")
            expect("the row restores the closed tab (${url(tides)}) as the active tab", reopened, "reopen")
            awaitLoaded(url(tides), 8_000)
            SystemClock.sleep(1_200)
            still("reopened")
        }
    }

    // --- the stack, read --------------------------------------------------------------------------

    private fun cardIds(): List<String> = runCatching {
        val list = JSONArray(chromeValue(CARD_IDS_JS))
        (0 until list.length()).map { list.getString(it) }
    }.getOrElse { emptyList() }

    /** The strip's geometry as JSON: card count, the first card's width, the strip's inner width, scrollLeft, and the indicator's dots, current one, role, status and controls ([GEOMETRY_JS]). */
    private fun geometry(): JSONObject = runCatching { JSONObject(chromeValue(GEOMETRY_JS)) }.getOrElse { JSONObject() }

    /** The Customise sheet's switches: label -> checked. */
    private fun switchStates(): JSONObject = runCatching { JSONObject(chromeValue(SWITCHES_JS)) }.getOrElse { JSONObject() }

    private fun sameStates(a: JSONObject, b: JSONObject): Boolean =
        a.length() == b.length() && a.keys().asSequence().all { b.has(it) && a.optBoolean(it) == b.optBoolean(it) }

    private fun hiddenModules(): String = coreState().optJSONArray("newTabHiddenModules")?.toString() ?: "[]"

    /** The Safety check card's memory for the revoked type (`newTabDevice.safetyHubCard`, read through `UIState.newTabSafetyHubCard`), or null before a record exists. */
    private fun safetyMemory(): JSONObject? = coreState().optJSONObject("newTabSafetyHubCard")?.optJSONObject("revoked-permissions")

    private fun moduleTitle(id: String): String = when (id) {
        "continue" -> "Continue where you left off"
        "downloads" -> "Downloads"
        "bookmarks" -> "Bookmarks"
        "safety-hub" -> "Safety check"
        "tips" -> TIPS_TITLE
        else -> id
    }

    private fun summariseDownloads(state: JSONObject): String {
        val list = state.optJSONArray("downloads") ?: return "none"
        return (0 until list.length()).joinToString(", ") { i ->
            val d = list.getJSONObject(i)
            "${d.optString("filename")} ${d.optString("state")}${if (d.optBoolean("fileMissing")) " (file missing)" else ""}"
        }
    }

    // --- the core --------------------------------------------------------------------------------

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    private fun ensureActive(tabId: String) {
        if (activeCoreTab()?.optString("id") == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        SystemClock.sleep(1_500)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab?.optString("url") == url && !tab.optBoolean("loading", true)) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
        return false
    }

    // --- the chrome ------------------------------------------------------------------------------

    /**
     * A real touch on the control the DOM gives for `domJs`, without the tree – for a control
     * whose accessible name another on screen shares (a switch row and the card it names, a menu
     * row and the card's ⋮). The aim is a [noteLine]; false, nothing injected, when the DOM has
     * no such element inside the touchable window.
     */
    private fun touchDom(what: String, domJs: String): Boolean {
        val box = domBox(domJs) ?: run {
            noteLine("  $what is not in the DOM")
            return false
        }
        val point = touchPoint(box) ?: run {
            noteLine("  the DOM's box for $what ($box) lies outside the touchable window $touchable")
            return false
        }
        noteLine("  touch at ${point.x.toInt()},${point.y.toInt()} on $what at the DOM's box $box")
        Finger().tap(point.x, point.y)
        return true
    }

    /**
     * A sheet's row brought into its body's view before a finger lands on it: a row under the
     * sheet's fold is reached the way a thumb reaches it – the sheet expanded by a drag on its
     * grabber, then its body scrolled by a drag – until the row's box lies inside the body and the
     * touchable window (four tries). The box then, or null.
     */
    private fun revealSheetRow(what: String, domJs: String): Rect? {
        repeat(4) { attempt ->
            val box = domBox(domJs)
            if (box != null && touchPoint(box) != null && chromeValue("String(${visibleInSheetJs(domJs)})") == "true") return box
            if (attempt == 0) {
                val handle = domBox(SHEET_HANDLE_JS) ?: findByLabel(SHEET_HANDLE_LABEL) ?: return null.also { noteLine("  no grabber to expand the sheet for $what") }
                noteLine("  $what is under the sheet's fold ($box): the sheet expanded by a drag on its grabber")
                Finger().apply {
                    down(handle.exactCenterX(), handle.exactCenterY())
                    moveBy(0f, -0.35f * height, 220)
                    up()
                }
            } else {
                val scroll = domBox(SHEET_SCROLL_JS) ?: return null.also { noteLine("  no sheet body to scroll for $what") }
                val at = touchPoint(scroll) ?: return null
                noteLine("  $what is still under the fold ($box): the sheet's body scrolled by a drag")
                Finger().apply {
                    down(at.x, at.y + scroll.height() * 0.25f)
                    moveBy(0f, -scroll.height() * 0.5f, 280)
                    up()
                }
            }
            SystemClock.sleep(1_200)
        }
        return null
    }

    /** [touchDom], then up to `timeoutMs` for `took` to hold; a touch that went in and did not take is a [touchFault]. */
    private fun touchDomExpecting(what: String, domJs: String, effect: String, timeoutMs: Long, reveal: Boolean = false, took: () -> Boolean): Boolean {
        if (reveal && revealSheetRow(what, domJs) == null) noteLine("  $what could not be brought into the sheet's view")
        if (!touchDom(what, domJs)) return false
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) {
                Log.i(tag, "the touch on $what took: $effect")
                return true
            }
            SystemClock.sleep(150)
        }
        touchFault("a touch on $what did not take: not $effect within $timeoutMs ms")
        return false
    }

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
        return chromeValue("String(!!($code))") == "true"
    }

    /**
     * The sheet's spring has landed: the chassis holds `--zen-recede` at 1 once a sheet rests
     * (§11.1), and a finger landing on a moving sheet catches it instead of tapping.
     */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = awaitChrome(
            "document.querySelectorAll('.zen-sheet').length>=1&&" +
                "Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99",
            timeoutMs
        )
        SystemClock.sleep(800)
        return rested
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
            recover()
        }
    }

    /** A claim of the sequence, on record either way; a failed one fails the run. */
    private fun expect(claim: String, held: Boolean, id: String) {
        finding("  $claim ${verdict(held)}")
        if (!held) failures += "$id: $claim"
    }

    /** After a step threw: whatever is up sent away, the keyboard down, the page a new tab page with every module shown. */
    private fun recover() {
        if (imeShown()) {
            back()
            awaitIme(shown = false, timeoutMs = 4_000)
        }
        repeat(3) {
            if (!chromeSurfaceUp()) return@repeat
            back()
            SystemClock.sleep(1_000)
        }
        for (id in MODULES) coreInvoke("newtab.setModuleHidden", "{\"id\":${JSONObject.quote(id)},\"hidden\":false}")
        if (activeUrl() != BLANK_URL) {
            tapLabel(Finger(), NEW_TAB_LABEL)
            SystemClock.sleep(2_500)
        }
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

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
            "<p>${site.title.substringAfter(" - ")}. One of the loopback pages the Cards demo's closed tab and bookmarks point at.</p>" +
            "</body></html>"

    companion object {
        private const val PORT = 18178
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        private const val GEAR_LABEL = "Customise the new tab page"
        private const val SHEET_TITLE = "Cards"
        private const val GEAR_TITLE = "New tab page"
        /** The modules in the stack's fixed order (`magicStackPlan.ts`), the tip module last (Chrome's ephemeral rank); the sheet lists all five. */
        private val MODULES = listOf("continue", "downloads", "bookmarks", "safety-hub", "tips")
        /** The tip module's name, on its card's title row and the sheet's row (`EDUCATIONAL_TIP_MODULE_NAME`; Chrome's "Chrome tips" with the product's name). */
        private const val TIPS_TITLE = "Zenium tips"
        /** The tips in Chrome's registry order (`educationalTips.ts`, `home_modules_card_registry_android.cc:36-64`, less the two account-bound promos). */
        private val TIP_ORDER = listOf("ntp-theme", "default-browser", "tab-groups", "quick-delete")
        /**
         * Chrome's words for the four tips (`educationalTips.ts`; `browser_ui_strings.grd:1210-1260`),
         * with the product's name and its British spelling, and the design lead's folds on #695: the
         * tab-groups sentence says when the groups sync, its button "Try it now" (the overview it opens
         * shows no how), the default-browser button §9.29's "Set as default".
         */
        private val TIP_TITLES = mapOf(
            "ntp-theme" to "Customise your homepage",
            "default-browser" to "Use Zenium by default",
            "tab-groups" to "Tidy up with tab groups",
            "quick-delete" to "Manage your browsing data"
        )
        private val TIP_DESCRIPTIONS = mapOf(
            "ntp-theme" to "Make Zenium your own with custom colours and images for your homepage",
            "default-browser" to "You can use Zenium any time you tap links in messages, documents and other apps",
            "tab-groups" to "Create tab groups that save and update across your devices when sync is on",
            "quick-delete" to "You can delete some or all of your history, cookies, site data and more"
        )
        private val TIP_BUTTONS = mapOf(
            "ntp-theme" to "Try it now",
            "default-browser" to "Set as default",
            "tab-groups" to "Try it now",
            "quick-delete" to "Show me how"
        )
        /** The tip card's TalkBack name: the module, the tip's title, its description (`MagicStack.tsx`, `cardLabel`). */
        private fun tipLabel(tip: String) = "$TIPS_TITLE: ${TIP_TITLES.getValue(tip)}. ${TIP_DESCRIPTIONS.getValue(tip)}"
        private const val DAY_MS = 86_400_000L
        /** A tip card's cap of impressions, and the default browser tip's (`constants.h:128-130`, `default_browser_promo.cc:20`). */
        private const val TIP_CAP = 10
        private const val DEFAULT_BROWSER_TIP_CAP = 3
        /** The tab groups tip wants more open tabs than this (`tab_group_promo.cc:20`). */
        private const val TAB_GROUPS_TIP_TABS = 10
        private const val DOWNLOAD_DIR = "magic-stack-demo-files"
        private const val DOWNLOAD_NAME = "field-guide.pdf"
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)([hd]))?\\}\\}\"")
        /** The one site the seeded permissions store says the sweep took grants from: the Safety check card's trigger. */
        private const val REVOKED_ORIGIN = "https://forum.example"
        /** The card's TalkBack name: the module, then Chrome's title for the revoked type at one site (`safetyHubCard.ts`). */
        private const val SAFETY_CARD_LABEL = "Safety check: Removed permissions for 1 site"
        /** Where Review lands: Settings' Privacy section asked for its Safety check group (`page.open` with `query.group`). */
        private const val SAFETY_SETTINGS_URL = "zen://settings/privacy?group=safety-check"

        private const val SHEET_HANDLE_LABEL = "Resize sheet"
        private const val SHEET_HANDLE_JS = "document.querySelector('.zen-sheet [aria-label=\"$SHEET_HANDLE_LABEL\"]')"
        private const val SHEET_SCROLL_JS = "document.querySelector('.zen-sheet .zen-sheet-scroll')"

        /** Whether the element `domJs` gives lies wholly inside its sheet's scroll body and the window. */
        private fun visibleInSheetJs(domJs: String) =
            "(function(){var e=$domJs;if(!e)return false;var r=e.getBoundingClientRect();var s=e.closest('.zen-sheet-scroll');" +
                "var b=s?s.getBoundingClientRect():{top:0,bottom:window.innerHeight};return r.height>0&&r.top>=b.top-1&&r.bottom<=b.bottom+1&&r.bottom<=window.innerHeight})()"

        private const val STACK_JS = "document.querySelector('.zen-ntp .zen-mstack')"
        private const val STRIP_JS = "document.querySelector('.zen-ntp .zen-mstack-strip')"
        private const val FIELD_JS = "document.querySelector('.zen-ntp .zen-ntp-field')"
        private const val GRID_JS = "document.querySelector('.zen-ntp [aria-label=\"Most visited\"]')"
        private const val GEAR_JS = "document.querySelector('.zen-ntp [aria-label=\"$GEAR_LABEL\"]')"
        private const val CARD_IDS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-card'),function(e){return e.dataset.cell}))"
        private const val CARD_LABELS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-card'),function(e){return e.getAttribute('aria-label')}))"
        private const val MORE_LABELS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-more'),function(e){return e.getAttribute('aria-label')}))"
        private const val ALL_PAGE_SURFACES_JS = "Array.prototype.every.call(document.querySelectorAll('.zen-mstack-card'),function(e){return e.dataset.surface==='page'})"
        private const val ALL_MORE_ICON_BUTTONS_JS = "Array.prototype.every.call(document.querySelectorAll('.zen-mstack-more'),function(e){return e.classList.contains('zen-v2-icon-button')})"
        private const val MENU_ROWS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return e.textContent.trim()}))"
        /** The open sheet's switch rows, label -> checked (`RowView`: the row is the `role="switch"` button, its label a `.zen-settings-label`). */
        private const val SWITCHES_JS = "(function(){var o={};var s=document.querySelectorAll('.zen-sheet [role=\"switch\"]');for(var i=0;i<s.length;i++){var l=s[i].querySelector('.zen-settings-label');o[l?l.textContent.trim():s[i].textContent.trim()]=s[i].getAttribute('aria-checked')==='true'}return JSON.stringify(o)})()"
        /** The gear sheet's Magic Stack action row (`CustomizeSheet`, `data-row="magic-stack"`; the `role="dialog"` is the `.zen-sheet` element's own). */
        private const val GEAR_ROW_JS = "document.querySelector('.zen-sheet [data-row=\"magic-stack\"]')"
        /**
         * The gear sheet's seat (§9.13): its body's first child by `data-row` (the Cards row), its
         * second's classes (the hairline) and the first heading's text (Layout).
         */
        private const val GEAR_SEAT_JS = "(function(){var b=document.querySelector('.zen-sheet .zen-ntp-customize');if(!b)return JSON.stringify({});var c=b.children;var h=b.querySelector('.zen-v2-heading');" +
            "return JSON.stringify({first:c[0]?(c[0].getAttribute('data-row')||c[0].className):'',second:c[1]?c[1].className:'',heading:h?h.textContent.trim():''})})()"
        /**
         * The arrival's rest (§9.29): the strip's snapping back on – the pager takes it off for the
         * motion and restores it a frame after the rest – with the offset at the first card's snap
         * position and the first dot current.
         */
        private const val ARRIVED_AT_FIRST_JS = "(function(){var s=document.querySelector('.zen-ntp .zen-mstack-strip');if(!s)return false;var d=document.querySelectorAll('.zen-ntp .zen-mstack-dot')[0];" +
            "return s.style.getPropertyValue('scroll-snap-type')===''&&Math.abs(s.scrollLeft)<=4&&!!d&&d.hasAttribute('data-current')})()"
        /** The swipe's settling-in: a nudge past the 8 dp touch slop, then the hold that lets the strip latch the finger. */
        private const val SWIPE_NUDGE_DP = 12f
        private const val SWIPE_SETTLE_MS = 240L
        /**
         * The swipe's probe: the strip's scrollLeft sampled on every animation frame for 2.5 s
         * from the arming, kept on the window for [SWIPE_PROBE_READ_JS] – the peak, the last and
         * the path itself (ms since arming, px), so a strip that snaps back leaves its trajectory.
         */
        private const val SWIPE_PROBE_ARM_JS = "(function(){var s=document.querySelector('.zen-ntp .zen-mstack-strip');if(!s)return 'no strip';" +
            "var p={t0:performance.now(),path:[],peak:0};window.__mstackSwipe=p;" +
            "function f(){var l=s.scrollLeft;var t=Math.round(performance.now()-p.t0);var last=p.path[p.path.length-1];if(!last||last[1]!==Math.round(l))p.path.push([t,Math.round(l)]);" +
            "if(l>p.peak)p.peak=l;if(performance.now()-p.t0<2500)requestAnimationFrame(f)}requestAnimationFrame(f);return 'armed'})()"
        private const val SWIPE_PROBE_READ_JS = "(function(){var p=window.__mstackSwipe;if(!p)return 'no probe';var s=document.querySelector('.zen-ntp .zen-mstack-strip');" +
            "return JSON.stringify({peak:Math.round(p.peak),now:s?s.scrollLeft:null,path:p.path})})()"
        /**
         * The strip's geometry and its indicator: the card count, the first card's width, the
         * strip's inner width and scrollLeft; the dots' count, the current one (`data-current`),
         * the indicator's role and its status text, how many controls stand among the dots (none:
         * they are indicators), whether every dot is hidden from the reader, and a dot's width.
         */
        private const val GEOMETRY_JS = "(function(){var s=document.querySelector('.zen-ntp .zen-mstack-strip');if(!s)return JSON.stringify({cards:0});" +
            "var c=s.firstElementChild;var cs=getComputedStyle(s);var inner=s.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);" +
            "var box=document.querySelector('.zen-ntp .zen-mstack-dots');var dots=box?box.querySelectorAll('.zen-mstack-dot'):[];var sel=-1;var hidden=dots.length>0;" +
            "for(var i=0;i<dots.length;i++){if(dots[i].hasAttribute('data-current'))sel=i;if(dots[i].getAttribute('aria-hidden')!=='true')hidden=false}" +
            "return JSON.stringify({cards:s.children.length,cardWidth:c?c.offsetWidth:0,stripInner:Math.round(inner),scrollLeft:Math.round(s.scrollLeft)," +
            "dots:dots.length,selected:sel,role:box?(box.getAttribute('role')||''):'',status:box?(box.textContent||'').trim():''," +
            "controls:box?box.querySelectorAll('button,[role=\"tab\"],[role=\"tablist\"],[tabindex]').length:0,dotsHidden:hidden,dotSize:dots.length?dots[0].offsetWidth:0})})()"
        /** Every card's id with the labels of its action buttons: `[[id, [label, ...]], ...]` in the strip's order. */
        private const val ACTIONS_JS = "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-mstack-card'),function(e){" +
            "return [e.dataset.cell,Array.prototype.map.call(e.querySelectorAll('.zen-mstack-action'),function(b){return b.textContent.trim()})]}))"
        /** The Continue card's row detail: the host, then the time. */
        private const val CONTINUE_DETAIL_JS = "((document.querySelector('.zen-mstack-card[data-cell=\"continue\"] .zen-mstack-row-detail')||{}).textContent||'').trim()"
        /** The Continue card's row – the card's whole act (`session.restoreClosed`). */
        private const val CONTINUE_ROW_JS = "document.querySelector('.zen-mstack-card[data-cell=\"continue\"] .zen-mstack-row')"

        private fun moreJs(id: String) = "document.querySelector('.zen-mstack-card[data-cell=\"$id\"] .zen-mstack-more')"

        /** Whether the `i`th dot is the current one (`data-current`; the dots are indicators and carry no `aria-selected`). */
        private fun dotCurrentJs(i: Int) =
            "(document.querySelectorAll('.zen-ntp .zen-mstack-dot')[$i]||{hasAttribute:function(){return false}}).hasAttribute('data-current')"

        /** The one action a card carries, by module: only what its rows do not already do (§9.29); the Safety check card's is the revoked type's Review, the tip card's the tip's button. */
        private fun actionsFor(id: String, tip: String?): List<String> = when (id) {
            "downloads", "bookmarks" -> listOf("See all")
            "safety-hub" -> listOf("Review")
            "tips" -> listOfNotNull(tip?.let { TIP_BUTTONS.getValue(it) })
            else -> emptyList()
        }

        /**
         * The Safety check card's face (`MagicStack.tsx`, `SafetyHubCard`): the type, the card's
         * name, the title and summary texts, the tile's box, radius, corner shape, fill, ink and
         * glyph width, the card surface's own `--v2-fill` resolved through a probe element (the
         * gate on #642: the tile is the page's tile on the surface's fill – a page surface's
         * `--v2-fill`; the shortcuts on the window read the window family's fill), a shortcut
         * tile's radius, corner shape and fill beside it, the title's font as size/weight/line,
         * the summary's, the action buttons' count and the first one's text, name and primary
         * mark.
         */
        private const val SAFETY_FACE_JS = "(function(){var c=document.querySelector('.zen-mstack-card[data-cell=\"safety-hub\"]');if(!c)return JSON.stringify({});" +
            "var f=c.querySelector('.zen-mstack-safety'),t=c.querySelector('.zen-mstack-safety-tile'),g=t?t.querySelector('svg'):null;" +
            "var ti=c.querySelector('.zen-mstack-safety-title'),su=c.querySelector('.zen-mstack-safety-summary'),b=c.querySelector('.zen-mstack-action');" +
            "var sh=document.querySelector('.zen-ntp .zen-ntp-tile');var cs=function(e){return e?getComputedStyle(e):null};var ts=cs(t),ss=cs(sh),tis=cs(ti),sus=cs(su);" +
            "var pr=document.createElement('span');pr.style.background='var(--v2-fill)';c.appendChild(pr);var fill=getComputedStyle(pr).backgroundColor;c.removeChild(pr);" +
            "return JSON.stringify({type:f?f.dataset.type:null,label:c.getAttribute('aria-label'),title:ti?ti.textContent.trim():null,summary:su?su.textContent.trim():null,fill:fill," +
            "tile:t?{w:t.offsetWidth,h:t.offsetHeight,radius:ts.borderRadius,corner:ts.cornerShape||'',background:ts.backgroundColor,ink:ts.color,glyph:g?Math.round(g.getBoundingClientRect().width):0," +
            "shortcut:sh?{radius:ss.borderRadius,corner:ss.cornerShape||'',background:ss.backgroundColor}:null}:null," +
            "titleFont:tis?tis.fontSize+'/'+tis.fontWeight+'/'+tis.lineHeight:null,titleWrap:tis?(tis.textWrap||tis.textWrapStyle||''):null,summaryFont:sus?sus.fontSize+'/'+sus.lineHeight:null," +
            "buttons:c.querySelectorAll('.zen-mstack-action').length,button:b?b.textContent.trim():null,buttonLabel:b?b.getAttribute('aria-label'):null,primary:!!(b&&b.hasAttribute('data-primary'))})})()"
        /** What of the card's CSS this WebView knows: the squircle corner and the balanced title are the device's, not the image's 113. */
        private const val CSS_SUPPORT_JS = "JSON.stringify({cornerShape:CSS.supports('corner-shape','squircle'),textWrapBalance:CSS.supports('text-wrap','balance'),colorMix:CSS.supports('color','color-mix(in srgb,red 12%,transparent)')})"
        /** The Safety check card's one button. */
        private const val SAFETY_ACTION_JS = "document.querySelector('.zen-mstack-card[data-cell=\"safety-hub\"] .zen-mstack-action')"
        /** The recovery for a swipe that stopped short: the strip scrolled to the card's snap position. */
        private fun scrollToCardJs(id: String) =
            "(function(){var s=document.querySelector('.zen-ntp .zen-mstack-strip'),c=document.querySelector('.zen-mstack-card[data-cell=\"$id\"]');if(!s||!c)return 'no card';s.scrollTo({left:c.offsetLeft-s.offsetLeft});return 'scrolled'})()"
        /**
         * The tip card's face (`MagicStack.tsx`, `TipContent` on the Safety check card's form): the
         * tip up (`data-card`), the card's name, the title and description texts, the tile's box,
         * radius, fill and glyph width, the card surface's own `--v2-fill` through a probe element,
         * the title's font as size/weight/line, the description's as size/line with the lines it
         * takes (its box over its line height) and whether it is drawn in full – no line clamp on
         * it and no overflow past its box (the design lead's fold on #695: the card grows with the
         * sentence, where Chrome's layout clamps at two lines) – the button's top against the
         * description's bottom (the card grown, the button below the sentence, not over it), and
         * the action buttons' count and the first one's text, name and primary mark.
         */
        private const val TIP_FACE_JS = "(function(){var c=document.querySelector('.zen-mstack-card[data-cell=\"tips\"]');if(!c)return JSON.stringify({});" +
            "var f=c.querySelector('.zen-mstack-tip'),t=c.querySelector('.zen-mstack-safety-tile'),g=t?t.querySelector('svg'):null;" +
            "var ti=c.querySelector('.zen-mstack-safety-title'),su=c.querySelector('.zen-mstack-safety-summary'),b=c.querySelector('.zen-mstack-action');" +
            "var cs=function(e){return e?getComputedStyle(e):null};var ts=cs(t),tis=cs(ti),sus=cs(su);" +
            "var pr=document.createElement('span');pr.style.background='var(--v2-fill)';c.appendChild(pr);var fill=getComputedStyle(pr).backgroundColor;c.removeChild(pr);" +
            "var sb=su?su.getBoundingClientRect():null;var lines=sb&&sus?Math.round(sb.height/parseFloat(sus.lineHeight)):0;" +
            "var clamp=sus?(sus.getPropertyValue('-webkit-line-clamp')||'none'):null;var full=!!(su&&su.scrollHeight<=su.clientHeight+1&&su.scrollWidth<=su.clientWidth+1);" +
            "var bb=b?b.getBoundingClientRect():null;" +
            "return JSON.stringify({card:f?f.dataset.card:null,label:c.getAttribute('aria-label'),title:ti?ti.textContent.trim():null,description:su?su.textContent.trim():null,fill:fill," +
            "tile:t?{w:t.offsetWidth,h:t.offsetHeight,radius:ts.borderRadius,background:ts.backgroundColor,ink:ts.color,glyph:g?Math.round(g.getBoundingClientRect().width):0}:null," +
            "titleFont:tis?tis.fontSize+'/'+tis.fontWeight+'/'+tis.lineHeight:null,descriptionFont:sus?sus.fontSize+'/'+sus.lineHeight:null,descriptionLines:lines,descriptionClamp:clamp,descriptionFull:full," +
            "descriptionBottom:sb?Math.round(sb.bottom):null,buttonTop:bb?Math.round(bb.top):null,cardHeight:Math.round(c.getBoundingClientRect().height)," +
            "buttons:c.querySelectorAll('.zen-mstack-action').length,button:b?b.textContent.trim():null,buttonLabel:b?b.getAttribute('aria-label'):null,primary:!!(b&&b.hasAttribute('data-primary'))})})()"
        /** The tip card's one button. */
        private const val TIP_ACTION_JS = "document.querySelector('.zen-mstack-card[data-cell=\"tips\"] .zen-mstack-action')"
        /** The recovery for the swipes home: the strip scrolled to its start. */
        private const val SCROLL_HOME_JS = "(function(){var s=document.querySelector('.zen-ntp .zen-mstack-strip');if(!s)return 'no strip';s.scrollTo({left:0});return 'scrolled'})()"
        /** On the Settings page (the chrome document's, with the Settings tab active): the Safety check group is the landing (`SettingsPage.tsx` marks the group `?group=` lands `data-landing`), its top in the viewport's upper part. */
        private const val SAFETY_LANDED_JS = "(function(){var g=document.querySelector('.zen-settings-group[data-group=\"safety-check\"]');if(!g||!g.hasAttribute('data-landing'))return false;" +
            "var r=g.getBoundingClientRect();return r.height>0&&r.top>=-1&&r.top<window.innerHeight*0.5})()"
        /** On the Settings page: the landing's account – the page's mark, the group's box and heading, the viewport. */
        private const val SAFETY_LANDING_JS = "(function(){var p=document.querySelector('.zen-settings-page'),g=document.querySelector('.zen-settings-group[data-group=\"safety-check\"]');" +
            "var h=g?g.querySelector('.zen-v2-heading,h2,h3'):null;var r=g?g.getBoundingClientRect():null;" +
            "return JSON.stringify({page:!!p,pageLanding:!!(p&&p.hasAttribute('data-landing')),group:!!g,groupLanding:!!(g&&g.hasAttribute('data-landing')),heading:h?h.textContent.trim():null," +
            "box:r?[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]:null,viewport:window.innerWidth+'x'+window.innerHeight,url:location.href})})()"

        /** The open menu sheet's row reading `label` (`MenuSheet`: a `.zen-sheet-item` whose text is the label). */
        private fun menuItemJs(label: String) =
            "Array.prototype.find.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(e){return e.textContent.trim()===${JSONObject.quote(label)}})"

        /** The stack's sheet's switch row for the module `id` (`RowView` marks the row `data-row` with the row's id). */
        private fun switchJs(id: String) = "document.querySelector('.zen-sheet [role=\"switch\"][data-row=\"$id\"]')"

        /**
         * A probe on the strip for the hide: when the card was marked leaving, when its fade
         * ended (`animationend`), when it left the strip, and how many transform frames each
         * remaining card was given by the FLIP tracker (its inline `transform`, a frame at a time).
         * Armed before the finger's act, read after it (nothing of it runs in the measured block
         * but the observer's own callbacks).
         */
        private const val PROBE_ARM_JS = "(function(){var s=document.querySelector('.zen-mstack-strip');if(!s)return 'no strip';var t0=performance.now();" +
            "var p=window.__mstackProbe={leavingAt:null,animationEndAt:null,removedAt:null,transforms:{},firstTransformAt:null,lastTransformAt:null,cardsAtStart:s.children.length};" +
            "s.addEventListener('animationend',function(e){if(e.target&&e.target.classList&&e.target.classList.contains('zen-mstack-card')&&p.animationEndAt===null)p.animationEndAt=Math.round(performance.now()-t0)},true);" +
            "var mo=new MutationObserver(function(list){var now=Math.round(performance.now()-t0);for(var i=0;i<list.length;i++){var m=list[i];" +
            "if(m.type==='attributes'&&m.attributeName==='data-leaving'&&m.target.hasAttribute('data-leaving')&&p.leavingAt===null)p.leavingAt=now;" +
            "if(m.type==='attributes'&&m.attributeName==='style'&&m.target.classList&&m.target.classList.contains('zen-mstack-card')){var tf=m.target.style.transform;if(tf){var id=m.target.dataset.cell;p.transforms[id]=(p.transforms[id]||0)+1;if(p.firstTransformAt===null)p.firstTransformAt=now;p.lastTransformAt=now}}" +
            "if(m.type==='childList'&&m.removedNodes.length&&p.removedAt===null)p.removedAt=now}});" +
            "mo.observe(s,{attributes:true,attributeFilter:['data-leaving','style'],childList:true,subtree:true});" +
            "p.stop=function(){mo.disconnect();var c={};for(var k in p){if(k!=='stop')c[k]=p[k]}return JSON.stringify(c)};return 'armed'})()"
        private const val PROBE_READ_JS = "window.__mstackProbe?window.__mstackProbe.stop():'{}'"
    }
}
