package app.zen.chromium

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * The omnibox polish of wave 4 (W4-6) under a REAL finger, for the `android-omnibox-polish-demo`
 * workflow – the five matrix rows, each with its claim read off the chrome, the core or the
 * system's own windows, never off the still alone:
 *
 *  1. MOT-07: the pill's tap on a page grows it into the omnibox's field on one spring
 *     (`lib/omniboxFocus.ts`). Measured first, with the keyboard disabled, through [traceFrames]:
 *     `omnibox-focus-open` (the tap, the flight, the landing) and `omnibox-focus-close` (a back,
 *     the flight home), the renderer main thread's layouts and paints per frame read out of the
 *     chrome WebView's trace – the rule is transform and opacity alone, nothing laid out per
 *     frame. Then sampled per animation frame with the keyboard up (`--zen-omnibox-focus` on the
 *     surfaces that carry it – the omnibox's layer and the phone bar, #307 – and the root's
 *     `data-omnibox-focus` phase), for the record of the value's run.
 *  2. OMN-18: a typed query's rows under §9.27 group headings (15/600), Chrome for Android's
 *     order from the field outward – Pages, Searches, Open tabs – each group's rows of its own
 *     kinds; one more letter keeps the headings that stay as the same elements (§11.4: the
 *     boundary changes cross-fade in place, nothing is remounted or slides).
 *  3. OMN-17: a hold on a history row opens the §9.23 prompt sheet ("Remove suggestion from
 *     history?", the row's text as its description, Cancel | Remove in the footer); a REAL touch
 *     on Remove forgets the entry (the core's `history.delete`, read back through
 *     `history.search`) and the row leaves; a hold answered with Cancel keeps its row.
 *  4. NTP-09: the default engine's favicon at the field's start when the engine is not the
 *     vendor's default – in the omnibox's field, in the new tab page's resting field, in the
 *     field the page's tap morphs into – 20 CSS px, loaded; the vendor's default shows the tile
 *     and the magnifier as before.
 *  5. OMN-23: a link on the clipboard, a hold on the empty field: the system's floating toolbar
 *     carries "Paste and go" beside its Paste (sentence case, the system's); a REAL touch on it
 *     loads the link. Text on the clipboard: "Paste and search", and the touch searches it.
 *
 * Two sites of the driver's own on the loopback ([DemoServer]): 127.0.0.1 is the seeded default
 * engine's (its suggest endpoint answers the query rows, a page for the paste), 127.0.0.2 the
 * roast site the seeded history and the second tab are on. The engine's mark is a data URL in
 * the seeded registry ([FAVICON_URL]): the chrome is an https document, so an `http:` image of
 * the loopback site would be mixed content the WebView blocks (as a real engine's `http:` mark
 * would be; the shipped engines' are https), and a data URL is a favicon the registry keeps.
 * Findings in `android-omnibox-polish-findings.txt` next to the frames; the run FAILS when a
 * claim does not hold. See [DemoHarness] for the plumbing and its rule on real touches versus
 * accessibility clicks; the frame instrument is the harness's ([measureFrames]).
 */
@RunWith(AndroidJUnit4::class)
class OmniboxPolishDemo : DemoHarness("omnibox-polish-demo-state.json", "android-omnibox-polish", "omnibox-polish-demo") {
    override val tag = "OmniboxPolishDemo"
    private lateinit var brew: DemoServer
    private lateinit var roast: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var imeIds: List<String> = emptyList()

    @Test
    fun record() {
        brew = DemoServer(PORT, brewRoutes()).also { it.start() }
        roast = DemoServer(PORT, roastRoutes(), address = ROAST_HOST).also { it.start() }
        try {
            runDemo()
        } finally {
            if (imeIds.isNotEmpty()) enableIme()
            if (THEME == "dark") shell("cmd uimode night no")
            brew.close()
            roast.close()
        }
        if (failures.isNotEmpty()) error("the omnibox polish did not hold up under a finger: ${failures.joinToString("; ")}")
    }

    /** The theme, and the seeded engine's mark (the state carries `{{favicon}}` where the data URL goes). */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")
            .replace("{{favicon}}", FAVICON_URL)

    /** The history the query's Pages rows come from: three roast pages and one that never matches. */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val history = STAMP.replace(readAsset("omnibox-polish-demo-history.json")) { m ->
            val hours = m.groupValues[1].toLongOrNull() ?: 0L
            (now - hours * 3_600_000L).toString()
        }
        File(zen, "history.json").writeText(history)
    }

    /**
     * The system's colour scheme before the app starts, so the app is born in it: switched once
     * the app is up and measured (the dark act of run 2), the change relaunches the activity and
     * recreates the launcher under it, and the window's height flickered a nav bar's 24 dp while
     * the pill's first tap was aimed off the tree – the tap landed on the home button, the home
     * screen came to the front and no act after it saw the page.
     */
    override fun beforeLaunch() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    override fun warmUp() {
        findings = File(out, "android-omnibox-polish-findings.txt")
        findings.writeText(
            "Zenium Android omnibox polish check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, $THEME)\n" +
                "sites: ${brew.selfCheck()}; ${roast.selfCheck()}\n\n"
        )
        val loaded = awaitChrome("true", 1_000) && awaitPage(BREW_ORIGIN + "/", 20_000)
        finding("warm-up: the seeded page ${if (loaded) "is up" else "did NOT report complete"}")
        // The first open pays for the editor's layout and the suggestions' first fetch: off camera.
        tapPill()
        val field = awaitField(8_000)
        SystemClock.sleep(1_000)
        closeField()
        settle(6_000)
        finding("warm-up: the editor opened once off camera (field ${if (field) "seen" else "NOT seen"})")
        // The new tab page is a chunk of its own that loads on its first open: pay for it too.
        val ntp = openNewTabPage()
        finding("warm-up: the new tab page ${if (ntp) "opened" else "did NOT open"} once off camera")
        SystemClock.sleep(800)
        closeNewTabPages()
        finding("warm-up: the demo page ${if (showBrewPage()) "is" else "is NOT"} the active tab")
        finding("sampler: ${jsString(SAMPLER)}")
    }

    override fun demo() {
        // 1. MOT-07: the frame cost, traced, the keyboard out of the way.
        step("MOT-07 the pill's tap into the field: frame cost (traceFrames, the keyboard disabled)") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            disableIme()
            try {
                focusCost()
            } finally {
                enableIme()
            }
        }

        // 2. MOT-07: the same motion sampled per frame, the keyboard up, for the record and the still.
        step("MOT-07 the pill's tap, sampled per animation frame (the keyboard up)") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            focusSampled()
        }

        // 3. OMN-18: the query's rows under headings.
        step("OMN-18 a typed query's rows under group headings") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 6_000)
            SystemClock.sleep(600)
            instrumentation.sendStringSync(QUERY)
            // The three groups up for the whole query, no row on its way out: the card at rest.
            val grouped = awaitChrome(
                "document.querySelectorAll('$HEADINGS:not([data-leaving])').length>=3&&(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(QUERY)}&&!document.querySelector('$ROWS[data-leaving]')",
                15_000
            )
            // The emulator's software GPU trails the DOM by a second or two: the still after it has caught up.
            SystemClock.sleep(2_500)
            shot("02-grouped-typed")
            val card = JSONObject(chromeValue(CARD_JS).ifEmpty { "{}" })
            val edge = card.optString("edge")
            val headings = card.optJSONArray("headings") ?: JSONArray()
            val labels = (0 until headings.length()).map { headings.getJSONObject(it).getString("label") }
            val kinds = (0 until headings.length()).map { i ->
                val h = headings.getJSONObject(i)
                val list = h.getJSONArray("kinds")
                (0 until list.length()).map { list.getString(it) }
            }
            val type = (0 until headings.length()).all { i ->
                val h = headings.getJSONObject(i)
                h.optString("fontSize") == "15px" && h.optString("fontWeight") == "600"
            }
            finding("  typed '$QUERY'; the card docked $edge; headings from the field outward: ${labels.joinToString(" | ")}")
            for (i in labels.indices) finding("    ${labels[i]}: ${kinds[i].joinToString(", ")} (${headings.getJSONObject(i).optString("fontSize")}/${headings.getJSONObject(i).optString("fontWeight")})")
            finding("  rows of no section at the field's end (the default match): ${card.optString("loose").ifEmpty { "none" }}")
            val unheaded = card.optString("unheaded")
            if (unheaded.isNotEmpty()) finding("  rows sectioned under NO heading: $unheaded")
            val order = labels == EXPECTED_GROUPS
            val own = unheaded.isEmpty() && labels.indices.all { i -> kinds[i].isNotEmpty() && kinds[i].all { it in GROUP_KINDS.getValue(labels[i]) } }
            val topLoose = card.optString("loose") == "search"
            finding("  Chrome's order Pages, Searches, Open tabs $order; every group's rows of its kinds $own; the verbatim search alone at the field's end $topLoose; headings 15/600 $type ${verdict(grouped && order && own && topLoose && type)}")
            if (!grouped || !order || !own || !topLoose || !type) failures += "the typed query's rows were not grouped as Chrome's (headings ${labels.joinToString()}; loose '${card.optString("loose")}')"
            // §11.4: one more letter. The Pages and Searches headings stay – as the same elements,
            // so the change cross-fades in place – and Open tabs goes with the tab that stops matching.
            chromeJs("document.querySelectorAll('$HEADINGS').forEach(function(h){h.__demoMark=1})")
            instrumentation.sendStringSync(MORE)
            val narrowed = awaitChrome("document.querySelectorAll('$HEADINGS:not([data-leaving])').length===2", 10_000)
            SystemClock.sleep(2_000)
            shot("02b-grouped-narrowed")
            val kept = JSONObject(chromeValue(KEPT_JS).ifEmpty { "{}" })
            val stayed = kept.optJSONArray("kept")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            val fresh = kept.optJSONArray("fresh")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            val inPlace = narrowed && stayed.sorted() == listOf("Pages", "Searches") && fresh.isEmpty()
            finding("  typed '$MORE' ('$QUERY$MORE'): headings kept as their elements ${stayed.joinToString()}; remounted ${fresh.ifEmpty { listOf("none") }.joinToString()}; two groups left $narrowed ${verdict(inPlace)}")
            if (!inPlace) failures += "a keystroke did not keep the staying headings in place (kept ${stayed.joinToString()}, fresh ${fresh.joinToString()})"
            // Back to the query for the hold: the three groups again.
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DEL)
            awaitChrome("document.querySelectorAll('$HEADINGS:not([data-leaving])').length>=3&&(document.querySelector('$FIELD')||{}).value===${JSONObject.quote(QUERY)}", 10_000)
            SystemClock.sleep(800)
        }

        // 4. OMN-17: the hold, the prompt, Remove; then a hold answered with Cancel.
        step("OMN-17 a hold on a history row asks on the prompt sheet; Remove forgets it") {
            settle(8_000)
            if (!fieldUp() || fieldValue() != QUERY) {
                // The grouping step is the way to the state, not the claim: the rows again.
                if (!fieldUp()) {
                    showBrewPage()
                    if (!openField()) error("the pill's tap opened no field")
                    awaitIme(shown = true, timeoutMs = 6_000)
                } else if (fieldValue().isNotEmpty()) {
                    touchTapLabel(CLEAR_LABEL, timeoutMs = 4_000)
                }
                SystemClock.sleep(600)
                instrumentation.sendStringSync(QUERY)
                awaitChrome("document.querySelectorAll('$ROWS[data-kind=history]').length>=1&&!document.querySelector('$ROWS[data-leaving]')", 12_000)
                SystemClock.sleep(1_000)
            }
            val row = historyRow() ?: error("no history row for '$QUERY' on the card")
            val title = row.getString("title")
            val url = HISTORY_URLS[title] ?: error("the row '$title' is not one of the seeded pages")
            val point = touchPoint(row.rect()) ?: error("no part of the row ${row.rect()} is inside the touchable window $touchable")
            finding("  the first history row from the field: '$title' (${row.optString("host")}); finger held at ${point.x},${point.y}")
            Finger().apply {
                press(point.x, point.y)
                up()
            }
            val asked = awaitNode(8_000) { it == PROMPT_TITLE } != null
            val rested = asked && awaitSheetAtRest(6_000)
            SystemClock.sleep(600)
            shot("03-remove-confirm")
            val prompt = JSONObject(chromeValue(PROMPT_JS).ifEmpty { "{}" })
            val description = prompt.optString("description")
            val buttons = prompt.optJSONArray("buttons")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            val expectedDescription = "$title — ${row.optString("host")}"
            val composed = prompt.optBoolean("block") && description == expectedDescription && buttons == listOf("Cancel", "Remove") && prompt.optBoolean("danger")
            finding(
                "  prompt '$PROMPT_TITLE' on screen $asked, at rest $rested; title block ${prompt.optBoolean("block")}; description '$description' " +
                    "(the row's text ${description == expectedDescription}); footer ${buttons.joinToString(" | ")}; Remove in the danger ink ${prompt.optBoolean("danger")} ${verdict(asked && composed)}"
            )
            if (!asked) error("the hold opened no prompt sheet")
            if (!composed) failures += "the prompt sheet is not composed as §9.23 (description '$description', footer ${buttons.joinToString(" | ")})"
            // THE touch: Remove.
            val touched = touchTapLabel(REMOVE_LABEL, timeoutMs = 6_000)
            val sheetGone = awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 8_000)
            val rowGone = awaitChrome("!Array.from(document.querySelectorAll('$ROWS $ROW_TITLE')).some(function(e){return e.textContent.trim()===${JSONObject.quote(title)}})", 8_000)
            SystemClock.sleep(1_200)
            shot("04-removed")
            val forgotten = !historyHas(url)
            val left = historyRow()?.optString("title") ?: "none"
            finding("  Remove ${if (touched) "touched" else "NOT touched"}; sheet gone $sheetGone; the row gone $rowGone; '$url' forgotten by the core $forgotten; first history row now '$left' ${verdict(touched && sheetGone && rowGone && forgotten)}")
            if (!touched || !rowGone || !forgotten) failures += "the hold's Remove did not forget '$title' (touched $touched, row gone $rowGone, forgotten $forgotten)"
            // A hold answered with Cancel keeps its row and its entry.
            val next = historyRow()
            if (next == null) {
                finding("  no second history row for the Cancel path")
            } else {
                val keepTitle = next.getString("title")
                val keepUrl = HISTORY_URLS[keepTitle]
                val p = touchPoint(next.rect())
                if (p == null) {
                    finding("  the second row ${next.rect()} is outside the touchable window: the Cancel path skipped")
                } else {
                    Finger().apply {
                        press(p.x, p.y)
                        up()
                    }
                    val askedAgain = awaitNode(8_000) { it == PROMPT_TITLE } != null && awaitSheetAtRest(6_000)
                    val cancelled = askedAgain && touchTapLabel(CANCEL_LABEL, timeoutMs = 6_000)
                    val closed = awaitChrome("document.querySelectorAll('.zen-sheet').length===0", 8_000)
                    SystemClock.sleep(1_000)
                    val stays = chromeValue("String(Array.from(document.querySelectorAll('$ROWS $ROW_TITLE')).some(function(e){return e.textContent.trim()===${JSONObject.quote(keepTitle)}}))") == "true"
                    val kept = keepUrl == null || historyHas(keepUrl)
                    finding("  a hold on '$keepTitle', Cancel touched $cancelled; sheet gone $closed; the row stays $stays; the entry kept $kept ${verdict(cancelled && stays && kept)}")
                    if (!cancelled || !stays || !kept) failures += "the hold's Cancel did not keep '$keepTitle'"
                }
            }
        }

        // 5. NTP-09: the engine's favicon in the fields.
        step("NTP-09 the default engine's favicon at the field's start") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            if (!openField()) error("the pill's tap opened no field")
            awaitIme(shown = true, timeoutMs = 6_000)
            if (fieldValue().isNotEmpty()) touchTapLabel(CLEAR_LABEL, timeoutMs = 4_000)
            val loaded = awaitChrome(faviconLoadedJs(".zen-omnibox-field"), 10_000)
            SystemClock.sleep(1_500)
            shot("05-field-engine-favicon")
            val field = glyph(".zen-omnibox-field")
            finding("  the omnibox field's glyph: $field ${verdict(loaded && field.favicon20(FAVICON_URL))}")
            if (!loaded || !field.favicon20(FAVICON_URL)) failures += "the omnibox field does not show the engine's favicon at 20 px ($field)"
            closeField()
            settle(8_000)
            // The new tab page's resting field carries the same mark; its tap morphs into the omnibox's field, which carries it too.
            if (!openNewTabPage()) error("the new tab page did not open (the field ${if (fieldUp()) "is" else "is not"} up)")
            val ntpLoaded = awaitChrome(faviconLoadedJs(NTP_FIELD), 10_000)
            SystemClock.sleep(1_500)
            shot("06-ntp-resting-field-favicon")
            val resting = glyph(NTP_FIELD)
            finding("  the new tab page's resting field: $resting ${verdict(ntpLoaded && resting.favicon20(FAVICON_URL))}")
            if (!ntpLoaded || !resting.favicon20(FAVICON_URL)) failures += "the new tab page's field does not show the engine's favicon at 20 px ($resting)"
            val p = ntpFieldPoint() ?: error("the new tab page's field was not found")
            Finger().tap(p.x, p.y)
            // The morph (§11.8) flies the double into the field's slot and lands: the omnibox's field, with the mark, once it has.
            val landed = awaitMorphPhase("open", 12_000)
            val opened = awaitChrome(faviconLoadedJs(".zen-omnibox-field"), 8_000)
            awaitIme(shown = true, timeoutMs = 6_000)
            SystemClock.sleep(1_500)
            shot("07-ntp-field-open-favicon")
            val morphed = glyph(".zen-omnibox-field")
            finding("  the field's tap morphed into the omnibox (morph landed $landed, the field's favicon up $opened); its glyph: $morphed ${verdict(opened && morphed.favicon20(FAVICON_URL))}")
            if (!opened || !morphed.favicon20(FAVICON_URL)) failures += "the morphed field does not carry the engine's favicon ($morphed)"
            closeField()
            awaitMorphPhase("rest", 10_000)
            settle(8_000)
            // The vendor's default: no favicon, the fields' own glyphs as before.
            coreInvoke("settings.update", "{\"searchEngineId\":${JSONObject.quote(VENDOR_ENGINE_ID)}}")
            SystemClock.sleep(1_200)
            val restingDefault = glyph(NTP_FIELD)
            val q = ntpFieldPoint() ?: p
            Finger().tap(q.x, q.y)
            awaitMorphPhase("open", 12_000)
            awaitChrome("!!document.querySelector('.zen-omnibox-field [data-testid=engine-field-glyph]')", 8_000)
            SystemClock.sleep(1_500)
            shot("08-vendor-default-glyphs")
            val fieldDefault = glyph(".zen-omnibox-field")
            val plain = !restingDefault.favicon && !fieldDefault.favicon && fieldDefault.text == "G"
            finding("  the vendor's default picked: the resting field $restingDefault; the omnibox field $fieldDefault ${verdict(plain)}")
            if (!plain) failures += "the vendor's default engine drew a favicon or lost its tile ($fieldDefault)"
            closeField()
            awaitMorphPhase("rest", 10_000)
            settle(8_000)
            coreInvoke("settings.update", "{\"searchEngineId\":${JSONObject.quote(ENGINE_ID)}}")
            SystemClock.sleep(600)
            closeNewTabPages()
        }

        // 6. OMN-23: a link on the clipboard, Paste and go from the field's own toolbar.
        step("OMN-23 Paste and go from the field's floating toolbar") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            val copiedAt = setClipboard(PASTED_URL)
            val overlayGone = awaitClipboardOverlayGone(copiedAt)
            finding("  clipboard set to '$PASTED_URL' (${clipDescription()}); overlay gone before the pill $overlayGone")
            val items = holdField("09-paste-action-mode") { it.any { i -> i.label == PASTE_AND_GO } }
            val go = items?.firstOrNull { it.label == PASTE_AND_GO }
            finding("  the field's toolbar: ${items.describe()} (${clipDescription()}) ${verdict(go != null)}")
            if (go == null) error("the field's toolbar offered no '$PASTE_AND_GO'")
            val point = touchTapPoint(go.node)
            val loaded = point != null && awaitPageUrl(PASTED_URL, 15_000)
            val closed = awaitChrome("!document.querySelector('$FIELD')", 6_000)
            SystemClock.sleep(2_000)
            shot("10-pasted-and-gone")
            finding("  '$PASTE_AND_GO' touched at ${point?.let { "${it.x.toInt()},${it.y.toInt()}" } ?: "NOWHERE"}; tab URL '${activeCoreTab()?.optString("url")}'; field closed $closed ${verdict(loaded)}")
            if (!loaded) failures += "'$PASTE_AND_GO' did not load the clipboard's link (tab '${activeCoreTab()?.optString("url")}')"
        }

        // 7. OMN-23: text on the clipboard, Paste and search.
        step("OMN-23 Paste and search for text on the clipboard") {
            if (!showBrewPage()) error("the demo page is not the active tab")
            val copiedAt = setClipboard(PASTED_TEXT)
            val overlayGone = awaitClipboardOverlayGone(copiedAt)
            finding("  clipboard set to '$PASTED_TEXT' (${clipDescription()}); overlay gone before the pill $overlayGone")
            val items = holdField("11-paste-search-action-mode") { it.any { i -> i.label == PASTE_AND_SEARCH } }
            val search = items?.firstOrNull { it.label == PASTE_AND_SEARCH }
            val fallback = items?.firstOrNull { it.label == PASTE_AND_GO }
            val classified = clipDescription()
            finding("  the field's toolbar: ${items.describe()} ($classified) ${verdict(search != null)}")
            val item = search ?: fallback ?: error("the field's toolbar offered neither '$PASTE_AND_SEARCH' nor '$PASTE_AND_GO'")
            if (search == null) {
                // Android 11 and below, or a clip the classifier has not reached: the item goes where
                // typed text would, which searches text all the same; the findings say which was shown.
                finding("  no '$PASTE_AND_SEARCH' (the system did not classify the clip: $classified); '$PASTE_AND_GO' touched instead")
                if (classified.contains("classification complete")) failures += "text on the clipboard was offered '$PASTE_AND_GO', not '$PASTE_AND_SEARCH'"
            }
            val point = touchTapPoint(item.node)
            val searched = point != null && awaitPageUrlPrefix(BREW_ORIGIN + "/search?q=", 15_000)
            SystemClock.sleep(2_500)
            shot("12-pasted-and-searched")
            val url = activeCoreTab()?.optString("url").orEmpty()
            val terms = url.contains("roast") && url.contains("profiles")
            finding("  '${item.label}' touched; tab URL '$url' (the clipboard's words searched ${searched && terms}) ${verdict(searched && terms)}")
            if (!searched || !terms) failures += "the paste did not search the clipboard's text (tab '$url')"
        }

        finding("\nend: ${failures.size} failure(s)")
    }

    // --- MOT-07 ----------------------------------------------------------------------------------

    /**
     * The focus motion's frame cost for the perf table: two `spring` scenes through [traceFrames],
     * the harness's one instrument – `omnibox-focus-open`, a real finger on the pill, the flight,
     * the landing; `omnibox-focus-close`, a back from open, the flight home – each with the chrome
     * WebView's trace around it and nothing read from the chrome inside the window (the finger and
     * the wait alone: a read is renderer work the trace would count as the chrome's). The window
     * is [FOCUS_WINDOW_MS] from the touch, sized as the field morph's cost scenes are for this
     * emulator's software GPU, its tail idle: the per-frame columns dilute a little toward idle,
     * never up. The machine is read after the window: the field must have landed inside it. The
     * keyboard is disabled for both, so the frames are the motion's and not the keyboard's inset
     * animation's, and the back reaches the chrome rather than the keyboard. HWUI's frame times
     * are the emulator's and reported, never judged; the trace's layouts per main-thread frame
     * carry the claim: transform and opacity alone, nothing laid out per frame.
     */
    private fun focusCost() {
        val p = pillPoint()
        awaitShots()
        SystemClock.sleep(1_000)
        val opening = traceFrames(FOCUS_OPEN, JankBudget.Kind.SPRING) {
            Finger().tap(p.x, p.y)
            SystemClock.sleep(FOCUS_WINDOW_MS)
        }
        val landed = focusState()
        finding("  $FOCUS_OPEN: ${costLines(opening)}")
        finding("  machine after the window: $landed; root data-omnibox-focus '${focusLook()}'; bar open ${urlbarOpen()}")
        val openOk = landed.optString("phase") == "open"
        check("$FOCUS_OPEN: the field had landed in the omnibox when the ${FOCUS_WINDOW_MS} ms window closed", openOk, "phase '${landed.optString("phase")}'")
        traceClaim(opening)
        if (!openOk) {
            closeField()
            awaitFocusPhase("rest", 6_000)
            return
        }
        SystemClock.sleep(800)
        val closing = traceFrames(FOCUS_CLOSE, JankBudget.Kind.SPRING) {
            back()
            SystemClock.sleep(FOCUS_WINDOW_MS)
        }
        val home = focusState()
        finding("  $FOCUS_CLOSE: ${costLines(closing)}")
        finding("  machine after the window: $home; root data-omnibox-focus '${focusLook()}'; bar open ${urlbarOpen()}")
        val closeOk = home.optString("phase") == "rest" && !urlbarOpen()
        check("$FOCUS_CLOSE: the field was home in the pill when the window closed", closeOk, "phase '${home.optString("phase")}', bar open ${urlbarOpen()}")
        traceClaim(closing)
        if (!closeOk) {
            closeField()
            awaitFocusPhase("rest", 6_000)
        }
    }

    /**
     * The rule's measure out of a traced scene: layouts per main-thread frame, paints per frame,
     * main-thread ms per frame, long tasks. The motion itself lays nothing out per frame; the
     * omnibox's mount, its rows arriving and the field's focus lay out a handful of times in the
     * window, so the claim is a ceiling of [LAYOUTS_PER_FRAME_MAX] over the window rather than
     * zero. Reported with a verdict; the emulator's numbers are indicative, the run does not fail
     * on them (the perf program's table reads them).
     */
    private fun traceClaim(scene: FrameStats.Scene) {
        val t = scene.trace
        if (t == null || !t.found || t.frames == 0) {
            finding("  ${scene.name}: no renderer main-thread reading (${scene.traceMissing ?: "no frames in the window"}): the layout rule not measured")
            return
        }
        val layouts = t.layoutCount.toDouble() / t.frames
        val paints = t.paintCount.toDouble() / t.frames
        val recalcs = t.styleRecalcCount.toDouble() / t.frames
        finding(
            "  ${scene.name}: ${t.frames} main-thread frames in ${"%.0f".format(t.windowMs)} ms; layouts ${t.layoutCount} (${"%.2f".format(layouts)}/frame), " +
                "paints ${t.paintCount} (${"%.2f".format(paints)}/frame), style recalcs ${t.styleRecalcCount} (${"%.2f".format(recalcs)}/frame); " +
                "main thread per frame mean ${"%.1f".format(t.frameMs?.meanMs ?: 0.0)} ms, p95 ${"%.1f".format(t.frameMs?.p95Ms ?: 0.0)} ms, max ${"%.1f".format(t.frameMs?.maxMs ?: 0.0)} ms; " +
                "long tasks ${t.longTasks} (longest ${"%.1f".format(t.longestTaskMs)} ms); script ${"%.0f".format(t.scriptMs)} ms of ${"%.0f".format(t.busyMs)} busy"
        )
        finding("  ${scene.name}: transform and opacity alone – layouts per frame ${"%.2f".format(layouts)} under $LAYOUTS_PER_FRAME_MAX ${verdict(layouts <= LAYOUTS_PER_FRAME_MAX)} (reported, not asserted)")
    }

    /**
     * The motion sampled once per animation frame with the keyboard up, as a user sees it:
     * `--zen-omnibox-focus` (0 the pill's pose, 1 the omnibox's) on the surface that carries it
     * (the omnibox's layer, else the phone bar: #307 took it off the root) and the root's
     * `data-omnibox-focus` (`opening`, `open`, `closing`, absent at rest) per frame, from the tap to the landing and
     * from the back to home. The claims: the value sets out from the pill's pose and lands at 1
     * with the look `open`; the back runs it back to the pill and the root's mark goes; one run
     * each way, the value never turning round (a decrease inside a run is counted and said).
     */
    private fun focusSampled() {
        val p = pillPoint()
        jsString(SAMPLER)
        jsString("window.__focusSampler.start()")
        Finger().tap(p.x, p.y)
        val landed = awaitFocusPhase("open", 10_000)
        awaitIme(shown = true, timeoutMs = 6_000)
        SystemClock.sleep(1_200)
        shot("01-focus-open")
        val opening = FocusRun.parse(jsString("window.__focusSampler.stop()"))
        finding("  tap -> open: landed $landed; ${opening.describe()}")
        val openOk = landed && opening.startsLow() && opening.endsAt(1.0, "open")
        check("the tap runs the field from the pill's pose (${"%.2f".format(opening.first ?: -1.0)}) to the omnibox's (1) and the look to open", openOk, opening.describe())
        finding("  the value never turned round on the way: ${opening.reversals} reversal(s) ${verdict(opening.reversals == 0)} (a spring may overshoot by design; said, not asserted)")
        // Home again: the keyboard's back first (the harness closes by the chrome's state), then the field's.
        jsString("window.__focusSampler.start()")
        closeField()
        val home = awaitFocusPhase("rest", 10_000)
        SystemClock.sleep(800)
        val closing = FocusRun.parse(jsString("window.__focusSampler.stop()"))
        finding("  back -> rest: home $home; ${closing.describe()}")
        val closeOk = home && closing.sawLook("closing") && closing.endsCleared()
        check("the back runs the field home and the root's mark goes", closeOk, closing.describe())
    }

    /** One sampled run of the motion, parsed from the sampler's rows. */
    private class FocusRun(val rows: List<Triple<Int, Double?, String>>) {
        val first: Double? get() = rows.firstOrNull { it.third == "opening" || it.third == "closing" }?.second ?: rows.firstOrNull()?.second
        val last: Double? get() = rows.lastOrNull { it.second != null }?.second
        val looks: List<String> get() = rows.map { it.third }.fold(ArrayList()) { acc, l -> if (acc.lastOrNull() != l) acc.add(l); acc }
        val reversals: Int
            get() {
                var n = 0
                var prev: Double? = null
                val run = rows.filter { it.third == "opening" || it.third == "closing" }
                val opening = run.firstOrNull()?.third == "opening"
                for (r in run) {
                    val v = r.second ?: continue
                    if (prev != null && (if (opening) v < prev!! - 0.001 else v > prev!! + 0.001)) n++
                    prev = v
                }
                return n
            }
        /** Frames the look was `opening` or `closing`, and how long they spanned. */
        val flightFrames: Int get() = rows.count { it.third == "opening" || it.third == "closing" }
        val flightMs: Int
            get() {
                val run = rows.filter { it.third == "opening" || it.third == "closing" }
                return if (run.size < 2) 0 else run.last().first - run.first().first
            }
        fun startsLow(): Boolean = (first ?: 1.0) <= 0.25
        fun endsAt(value: Double, look: String): Boolean = rows.lastOrNull()?.let { it.third == look && it.second != null && Math.abs(it.second!! - value) < 0.001 } ?: false
        fun sawLook(look: String): Boolean = rows.any { it.third == look }
        fun endsCleared(): Boolean = rows.lastOrNull()?.let { it.third.isEmpty() && it.second == null } ?: false
        fun describe(): String =
            "${rows.size} frames sampled, the flight $flightFrames frames over $flightMs ms; value ${first?.let { "%.3f".format(it) } ?: "-"} -> ${last?.let { "%.3f".format(it) } ?: "-"}; " +
                "looks ${looks.joinToString(" > ") { it.ifEmpty { "(rest)" } }}"

        companion object {
            fun parse(json: String): FocusRun {
                val rows = ArrayList<Triple<Int, Double?, String>>()
                val array = runCatching { JSONArray(json) }.getOrNull() ?: return FocusRun(rows)
                for (i in 0 until array.length()) {
                    val r = array.optJSONArray(i) ?: continue
                    rows += Triple(r.optInt(0), r.optString(1).toDoubleOrNull(), r.optString(2))
                }
                return FocusRun(rows)
            }
        }
    }

    /** The focus machine as the chrome's store has it (`{phase, look}`), `{}` when unreadable. */
    private fun focusState(): JSONObject = storeState("omnibox-focus")

    /** The new tab page field's morph machine (`lib/fakeboxMorph.ts`: `phase` rest, opening, open or closing), `{}` when unreadable. */
    private fun morphState(): JSONObject = storeState("fakebox-morph")

    private fun storeState(name: String): JSONObject =
        runCatching { JSONObject(chromeValue("JSON.stringify(((window.__zenStores||{})[${JSONObject.quote(name)}]||{get:function(){return {}}}).get())")) }.getOrElse { JSONObject() }

    private fun focusLook(): String = chromeValue("document.documentElement.getAttribute('data-omnibox-focus')||''")

    private fun awaitFocusPhase(phase: String, timeoutMs: Long): Boolean = awaitPhase(::focusState, phase, timeoutMs)

    private fun awaitMorphPhase(phase: String, timeoutMs: Long): Boolean = awaitPhase(::morphState, phase, timeoutMs)

    private fun awaitPhase(state: () -> JSONObject, phase: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (state().optString("phase") == phase) return true
            SystemClock.sleep(100)
        }
        return state().optString("phase") == phase
    }

    /** A measured scene's summary line and its trace line (the table's first two), for the findings. */
    private fun costLines(scene: FrameStats.Scene): String = scene.table().lines().take(2).joinToString(" | ") { it.trim() }

    // --- OMN-17 ----------------------------------------------------------------------------------

    /** The first history row from the field: its title, host and option box (CSS px); null when the card has none. */
    private fun historyRow(): JSONObject? {
        val text = chromeValue(HISTORY_ROW_JS)
        return runCatching { JSONObject(text) }.getOrNull()?.takeIf { it.has("title") }
    }

    /** A row's box as the DOM lays it out, in screen px (the chrome fills the window from its top-left corner). */
    private fun JSONObject.rect(): Rect = Rect(
        Math.round(getDouble("x") * density).toInt(),
        Math.round(getDouble("y") * density).toInt(),
        Math.round((getDouble("x") + getDouble("w")) * density).toInt(),
        Math.round((getDouble("y") + getDouble("h")) * density).toInt()
    )

    /** Whether the core still remembers `url` (`history.search` on the address's own words). */
    private fun historyHas(url: String): Boolean {
        val entries = runCatching { JSONArray(coreInvoke("history.search", "{\"query\":${JSONObject.quote(url.substringAfter("//").substringBefore("/"))},\"limit\":50}")) }.getOrNull() ?: return false
        for (i in 0 until entries.length()) if (entries.optJSONObject(i)?.optString("url") == url) return true
        return false
    }

    /** The prompt's spring has landed (`--zen-recede` at 1 once a sheet rests, §11.1). */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = awaitChrome(
            "document.querySelectorAll('.zen-sheet').length>=1&&Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99",
            timeoutMs
        )
        SystemClock.sleep(600)
        return rested
    }

    // --- NTP-09 ----------------------------------------------------------------------------------

    /**
     * A field's leading glyph as the DOM has it: a favicon image shown (its address, its box) or
     * the slot's own mark (its text; the address of an image that is there but not shown, for
     * the record), or nothing when the field itself is not up.
     */
    private class Glyph(val present: Boolean, val favicon: Boolean, val src: String, val loaded: Boolean, val w: Double, val h: Double, val text: String) {
        fun favicon20(url: String): Boolean = favicon && src == url && loaded && Math.abs(w - 20.0) < 0.6 && Math.abs(h - 20.0) < 0.6
        override fun toString(): String = when {
            !present -> "NO FIELD on the page"
            favicon -> "favicon '${src.take(48)}${if (src.length > 48) "…" else ""}' loaded $loaded at ${"%.1f".format(w)}x${"%.1f".format(h)} CSS px"
            else -> "no favicon shown, the slot's mark '${text.ifEmpty { "(icon)" }}'" + (if (src.isNotEmpty()) " (an image '${src.take(48)}…' present, loaded $loaded)" else "")
        }
    }

    private fun glyph(scope: String): Glyph {
        val o = runCatching { JSONObject(chromeValue(glyphJs(scope))) }.getOrElse { JSONObject() }
        return Glyph(o.optBoolean("present"), o.optBoolean("favicon"), o.optString("src"), o.optBoolean("loaded"), o.optDouble("w", 0.0), o.optDouble("h", 0.0), o.optString("text"))
    }

    private fun glyphJs(scope: String): String =
        "(function(){var s=document.querySelector(${JSONObject.quote(scope)});if(!s)return JSON.stringify({present:false});" +
            "var i=s.querySelector('$FAVICON');var g=s.querySelector('[data-testid=engine-field-glyph]');" +
            "var loaded=!!(i&&i.complete&&i.naturalWidth>0);" +
            "if(loaded&&getComputedStyle(i).visibility!=='hidden'){var r=i.getBoundingClientRect();" +
            "return JSON.stringify({present:true,favicon:true,src:i.getAttribute('src'),loaded:true,w:r.width,h:r.height})}" +
            "return JSON.stringify({present:true,favicon:false,src:i?i.getAttribute('src'):'',loaded:loaded,w:0,h:0,text:g?g.textContent.trim():''})})()"

    /** The favicon image inside `scope` has loaded and is shown (the fallback given up for it). */
    private fun faviconLoadedJs(scope: String): String =
        "(function(){var i=document.querySelector(${JSONObject.quote("$scope $FAVICON")});" +
            "return !!i&&i.complete&&i.naturalWidth>0&&getComputedStyle(i).visibility!=='hidden'})()"

    /** The middle of the new tab page's resting field, in screen px; null when the page shows none. */
    private fun ntpFieldPoint(): PointF? {
        val text = chromeValue(
            "(function(){var f=document.querySelector('$NTP_FIELD');if(!f)return '';var r=f.getBoundingClientRect();" +
                "return [r.left+r.width/2,r.top+r.height/2].map(function(v){return Math.round(v*$density)}).join(',')})()"
        )
        val px = text.split(',').map { it.toFloatOrNull() ?: return null }
        if (px.size != 2) return null
        val p = PointF(px[0], px[1])
        if (!touchable.contains(p.x.toInt(), p.y.toInt())) {
            Log.w(tag, "the new tab page's field middle $p is outside the touchable window $touchable")
            return null
        }
        return p
    }

    /**
     * A new tab page as the active tab, its resting field up: `tab.create` at the space page's
     * address. (`tab.new` is not the way on this host: with no new tab page capability in the
     * WebView's chrome it opens the omnibox in its new-tab mode over the current page instead.)
     * A field the page's arrival opened is closed again, so the page rests. False when the
     * page's field is not there in time.
     */
    private fun openNewTabPage(): Boolean {
        val id = coreInvoke("tab.create", "{\"url\":${JSONObject.quote(BLANK_URL)},\"active\":true}").trim('"')
        Log.i(tag, "new tab page: $id")
        val up = awaitChrome("!!document.querySelector('$NTP_FIELD')", 12_000)
        SystemClock.sleep(600)
        if (urlbarOpen() || fieldUp()) {
            closeField()
            settle(8_000)
        }
        return up && awaitChrome("!!document.querySelector('$NTP_FIELD')&&!document.querySelector('$FIELD')", 6_000)
    }

    /** Every new tab page tab closed through the core, so the seeded page is the active tab again. */
    private fun closeNewTabPages() {
        val tabs = coreState().getJSONObject("tabs")
        for (key in tabs.keys()) {
            val tab = tabs.optJSONObject(key) ?: continue
            if (tab.optString("url").startsWith("zen://")) coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(tab.getString("id"))}}")
        }
        SystemClock.sleep(1_200)
        ensureForeground()
    }

    // --- OMN-23 ----------------------------------------------------------------------------------

    private class ToolbarItem(val label: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    private fun List<ToolbarItem>?.describe(): String = this?.joinToString(" | ") { it.label } ?: "MISSING"

    /**
     * The field's floating toolbar, left to right: the clickable nodes with a content description
     * in the window that holds the system's Paste (the toolbar is a popup window of its own; each
     * item a button described by its title). Null while no such toolbar is up.
     */
    private fun toolbarItems(): List<ToolbarItem>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val items = ArrayList<ToolbarItem>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isClickable && node.isVisibleToUser) {
                    items += ToolbarItem(label, Rect().also { node.getBoundsInScreen(it) }, node)
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (items.any { it.label == PASTE }) return items.sortedBy { it.bounds.left }
        }
        return null
    }

    /**
     * Poll for the field's toolbar until `ready` is content with its items (Zenium's joins the
     * system's a moment after the mode starts: the chrome is asked which field it is), for up to
     * `timeoutMs`; then whatever toolbar is up, or null when none came.
     */
    private fun awaitToolbar(timeoutMs: Long, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: List<ToolbarItem>? = null
        while (SystemClock.uptimeMillis() < deadline) {
            toolbarItems()?.let { items ->
                last = items
                if (ready(items)) return items
            }
            SystemClock.sleep(250)
        }
        return last
    }

    /**
     * The pill, then a REAL long press on the empty field: the WebView starts its insertion action
     * mode (the system's Paste, and Zenium's item after it once the chrome has said the field is
     * the omnibox's). The still `shotName` is taken with the toolbar up; the items once `ready`.
     */
    private fun holdField(shotName: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        ensureForeground()
        settle(8_000)
        tapPill()
        // Another app's window (the clipboard overlay's chips) may have taken the touch: back out, the pill again.
        if (awaitSystemWindow(1_500)) {
            finding("  another app's window (${ui.rootInActiveWindow?.packageName}) came up on the pill's touch; backing out, the pill again")
            ensureForeground()
            SystemClock.sleep(800)
            tapPill()
        }
        if (!awaitField(8_000)) {
            finding("  the pill's tap opened no field in 8 s; the pill again")
            openField()
        }
        awaitIme(shown = true, timeoutMs = 6_000)
        SystemClock.sleep(800)
        if (fieldValue().isNotEmpty()) {
            touchTapLabel(CLEAR_LABEL, timeoutMs = 4_000)
            SystemClock.sleep(600)
        }
        val field = fieldRect() ?: error("the field is not on screen")
        val point = touchPoint(field) ?: error("no part of the field $field is inside the touchable window $touchable")
        finding("  the pill opened the field (empty ${fieldValue().isEmpty()}); finger held on it at ${point.x},${point.y}")
        Finger().apply {
            press(point.x, point.y)
            up()
        }
        val items = awaitToolbar(12_000, ready)
        SystemClock.sleep(800)
        shot(shotName)
        return items
    }

    /** The field's box as the DOM lays it out, in screen px; null when no field is up. */
    private fun fieldRect(): Rect? {
        val text = chromeValue(
            "(function(){var f=document.querySelector('$FIELD');if(!f)return '';var r=f.getBoundingClientRect();" +
                "return [r.left,r.top,r.right,r.bottom].map(function(v){return Math.round(v*$density)}).join(',')})()"
        )
        val px = text.split(',').map { it.toIntOrNull() ?: return null }
        if (px.size != 4) return null
        return Rect(px[0], px[1], px[2], px[3])
    }

    /** `text` on the clipboard, as an app in the foreground may put it; when it was put there. */
    private fun setClipboard(text: String): Long {
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(ClipData.newPlainText("omnibox polish demo", text))
        }
        return SystemClock.uptimeMillis()
    }

    /** The clip's description as the field toolbar reads it: mime types, the system's classification and its URL confidence. */
    private fun clipDescription(): String {
        var text = "no clip"
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val d = runCatching { manager.primaryClipDescription }.getOrNull() ?: return@runOnMainSync
            val mimes = (0 until d.mimeTypeCount).map { d.getMimeType(it) }
            text = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val status = when (d.classificationStatus) {
                    ClipDescription.CLASSIFICATION_COMPLETE -> "classification complete, url confidence ${"%.2f".format(d.getConfidenceScore(android.view.textclassifier.TextClassifier.TYPE_URL))}"
                    ClipDescription.CLASSIFICATION_NOT_PERFORMED -> "classification not performed"
                    else -> "classification not complete"
                }
                "${mimes.joinToString()}; $status"
            } else {
                "${mimes.joinToString()}; no classification before Android 12"
            }
        }
        return text
    }

    // --- the pill, the field, the page -----------------------------------------------------------

    /**
     * A finger on the bar's address pill: where the tree says it is, else where the bar has it
     * (the harness's [pillPoint]: never a pill the tree puts in a system bar).
     */
    private fun tapPill() {
        val p = pillPoint()
        Finger().tap(p.x, p.y)
    }

    /**
     * The pill's tap, the field awaited: a settled chrome first (a tap while the focus motion
     * is still flying home is the machine's to ignore), then the tap, and one more tap when the
     * first opened nothing in time, said in the findings. True once the field is in the DOM.
     */
    private fun openField(): Boolean {
        settle(8_000)
        tapPill()
        if (awaitField(8_000)) return true
        finding("  the pill's tap opened no field in 8 s (machine ${focusState()}, bar open ${urlbarOpen()}); the pill again")
        settle(6_000)
        tapPill()
        return awaitField(8_000)
    }

    private fun awaitField(timeoutMs: Long): Boolean = awaitChrome("!!document.querySelector('$FIELD')", timeoutMs)

    private fun fieldUp(): Boolean = chromeValue("String(!!document.querySelector('$FIELD'))") == "true"

    /**
     * The chrome at rest between scenes: the focus motion's machine and the field morph's home
     * or landed (`rest` or `open`, not flying – the store says the field is open through the
     * whole closing flight, so a reading of `urlbarOpen()` mid-flight is a stale yes), the
     * store's word on the field agreeing with the DOM's, and no sheet up. False when it does
     * not settle in time (said by the caller's next reading rather than here).
     */
    private fun settle(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(150)
        }
        val ok = settled()
        if (!ok) Log.w(tag, "the chrome did not settle in $timeoutMs ms: focus ${focusState()}, morph ${morphState()}, bar open ${urlbarOpen()}, field up ${fieldUp()}")
        return ok
    }

    private fun settled(): Boolean {
        for (machine in listOf(focusState(), morphState())) {
            val phase = machine.optString("phase", "rest")
            if (phase != "rest" && phase != "open" && phase.isNotEmpty()) return false
        }
        val storeOpen = "((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).open===true)"
        return chromeValue("String(($storeOpen===!!document.querySelector('$FIELD'))&&document.querySelectorAll('.zen-sheet').length===0)") == "true"
    }

    /**
     * The shared close of the field (DemoHarness.closeUrlField, by the chrome's state): a field
     * left open, or a page a back reached, fails the run by name rather than the scene after it.
     */
    private fun closeField() {
        val close = closeUrlField()
        if (!close.ok) {
            finding("  the field's close: ${close.describe()} ${verdict(false)}")
            failures += "the field's close: ${close.describe()}"
        }
    }

    private fun fieldValue(): String = chromeValue("(document.querySelector('$FIELD')||{}).value||''")

    /**
     * The seeded demo page (`tab_brew` at the default engine's site) as the active tab, loaded:
     * activated through the core when another tab is up, its document re-navigated there when the
     * tab has moved on (the paste scenes navigate it). False when it is not there in time.
     */
    private fun showBrewPage(): Boolean {
        val url = BREW_ORIGIN + "/"
        // Settled first: a close read mid-flight would press a back the field is already taking.
        settle(8_000)
        closeField()
        settle(8_000)
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

    /** The tab's WebView that is on screen (the test shares the app's process and its views). */
    private fun pageWebView(): TabWebView? {
        var found: TabWebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: android.view.View) {
                if (found != null) return
                if (view is TabWebView && view.isShown) {
                    found = view
                    return
                }
                if (view is android.view.ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return found
    }

    /** The string a script evaluates to in the page, or null when it did not answer in time. */
    private fun evalJs(web: TabWebView, script: String): String? {
        val latch = java.util.concurrent.CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            web.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, java.util.concurrent.TimeUnit.SECONDS)
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    // --- the keyboard, the device ----------------------------------------------------------------

    /**
     * The keyboard out of the way for the traced scenes: its inset animation would be frames of
     * its own in the window, and a system back goes to an open keyboard before the chrome.
     * `ime disable` for every input method on the device; `ime enable` puts them back.
     */
    private fun disableIme() {
        imeIds = shell("ime list -s").lines().map { it.trim() }.filter { it.isNotEmpty() }
        for (id in imeIds) shell("ime disable $id")
        SystemClock.sleep(800)
        finding("  keyboard disabled for the traced scenes: ${imeIds.joinToString()}")
    }

    private fun enableIme() {
        for (id in imeIds) shell("ime enable $id")
        imeIds = emptyList()
        SystemClock.sleep(800)
        finding("  keyboard enabled again")
    }

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    // --- the chrome ------------------------------------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun jsString(code: String): String {
        val raw = chromeJs(code)
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw
    }

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
            // Whatever the step left up (the editor, a sheet, a toolbar) goes before the next one:
            // one back per reading, each given its flight (the field's close is a spring the store
            // reports as open until it lands), and the chrome settled before the next scene reads it.
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

    /** One claim: PASS or FAIL in the findings; a FAIL is a failure of the run. */
    private fun check(claim: String, ok: Boolean, detail: String) {
        finding("  $claim: $detail ${verdict(ok)}")
        if (!ok) failures += claim
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the two sites ---------------------------------------------------------------------------

    /** The seeded default engine's site: the page the demo starts on, the engine's endpoints, the page a paste goes to (its mark is [FAVICON_URL], a data URL). */
    private fun brewRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html("Brew notes", "<p>Notes on brewing coffee at home: ratios, grind sizes and water temperatures.</p>"),
        "/guide.html" to html("Brewing guide", "<p>Start with 15 g of coffee to 250 g of water.</p>"),
        "/pasted.html" to html("Pasted and gone", "<p>This page's address was on the clipboard; Paste and go loaded it.</p>"),
        "/search" to results("Brew notes"),
        "/suggest" to suggestions("roast levels explained", "roast coffee at home", "roast profile chart")
    )

    /** The roast site: the second tab's page and the seeded history's pages. */
    private fun roastRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to html("Roast index", "<p>An index of roasters and their beans.</p>"),
        "/roasters.html" to html("Roasters near you", "<p>Roasters within cycling distance.</p>"),
        "/profiles.html" to html("Roast profiles for home roasting", "<p>Light, medium and dark, by time and temperature.</p>"),
        "/drum.html" to html("Drum roasting basics", "<p>Charge temperature, first crack, development time.</p>")
    )

    private fun html(title: String, body: String): Pair<String, ByteArray> =
        "text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$title</title>" +
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
        private const val PORT = 18136
        private const val ROAST_HOST = "127.0.0.2"
        private const val BREW_ORIGIN = "http://127.0.0.1:$PORT"
        private const val ROAST_ORIGIN = "http://$ROAST_HOST:$PORT"
        /** The seeded tab on the demo page (omnibox-polish-demo-state.json). */
        private const val BREW_TAB_ID = "tab_brew"
        /** The new tab page's address (the space page the resting field is on). */
        private const val BLANK_URL = "zen://blank"
        /** The seeded default engine (the state's `searchEngines[0]`) and the vendor's default. */
        private const val ENGINE_ID = "custom:brew-notes"
        private const val VENDOR_ENGINE_ID = "google"
        /** The engine's mark: a 16 px "B" tile, sized so the image has an intrinsic width whatever the WebView's SVG rules. */
        private const val FAVICON_SVG =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\" viewBox=\"0 0 16 16\"><rect width=\"16\" height=\"16\" rx=\"4\" fill=\"#3b5bdb\"/>" +
                "<text x=\"8\" y=\"11.5\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"10\" font-weight=\"700\" fill=\"#fff\">B</text></svg>"
        /** The mark as the registry keeps it (`sanitizeFavicon` takes a data URL): what the seeded engine's `favicon` is, and what the fields' image must show. */
        private val FAVICON_URL: String =
            "data:image/svg+xml;base64," + android.util.Base64.encodeToString(FAVICON_SVG.toByteArray(), android.util.Base64.NO_WRAP)
        /** The query: three history pages, the engine's rows and the second tab match it; one letter more leaves the tab out. */
        private const val QUERY = "roast"
        private const val MORE = "e"
        /** What the paste scenes put on the clipboard. */
        private const val PASTED_URL = "$BREW_ORIGIN/pasted.html"
        private const val PASTED_TEXT = "roast profiles"
        /** The seeded history (omnibox-polish-demo-history.json), by title. */
        private val HISTORY_URLS = mapOf(
            "Roasters near you" to "$ROAST_ORIGIN/roasters.html",
            "Roast profiles for home roasting" to "$ROAST_ORIGIN/profiles.html",
            "Drum roasting basics" to "$ROAST_ORIGIN/drum.html",
            "Brewing guide" to "$BREW_ORIGIN/guide.html"
        )
        /** Chrome for Android's order from the field outward (`CARD_SECTIONS` in core/suggestions.ts), and each group's kinds. */
        private val EXPECTED_GROUPS = listOf("Pages", "Searches", "Open tabs")
        private val GROUP_KINDS = mapOf(
            "Pages" to setOf("url", "history", "bookmark", "entity"),
            "Searches" to setOf("search"),
            "Open tabs" to setOf("tab")
        )
        /** The prompt sheet (RemoveSuggestionSheet.tsx) and its footer. */
        private const val PROMPT_TITLE = "Remove suggestion from history?"
        private const val REMOVE_LABEL = "Remove"
        private const val CANCEL_LABEL = "Cancel"
        /** The field's clear button, there once something is typed. */
        private const val CLEAR_LABEL = "Clear"
        /** The system's Paste and Zenium's two items (strings.xml), in the system's sentence case. */
        private const val PASTE = "Paste"
        private const val PASTE_AND_GO = "Paste and go"
        private const val PASTE_AND_SEARCH = "Paste and search"
        /** The measured scenes' names (stable across runs: the perf table keys on them). */
        private const val FOCUS_OPEN = "omnibox-focus-open"
        private const val FOCUS_CLOSE = "omnibox-focus-close"
        /**
         * The measured window of a cost scene from the touch: the flight and its landing with
         * nothing read from the chrome meanwhile, sized as the field morph's on this emulator's
         * software GPU (its flights landed 2 to 5.4 s after the tap), the tail idle.
         */
        private const val FOCUS_WINDOW_MS = 6_000L
        /**
         * Layouts per main-thread frame the traced window may show and still read as transform
         * and opacity alone: the harness's spring budget's ceiling ([JankBudget.SPRING_BUDGET]).
         * The motion writes one root value per frame; the omnibox's mount, its rows' arrival and
         * the field's focus lay out a handful of times in the window, and Blink books a layout
         * entry of a quarter millisecond for a transform change's visual overflow on each frame
         * (run 1's trace: 13 layouts in 18 frames, the flight's each ~0.25 ms against ~20 ms of
         * style recalculation), which is bookkeeping, not a relayout of the chrome.
         */
        private val LAYOUTS_PER_FRAME_MAX = JankBudget.SPRING_BUDGET.layoutsPerFrame
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)h)?\\}\\}\"")
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /** The chrome's DOM: the field, the card's rows and headings, the favicon image, the new tab page's field. */
        private const val FIELD = "[data-testid=\"urlbar-input\"]"
        private const val ROWS = ".zen-omnibox-sheet [role=\"listbox\"] > li"
        private const val HEADINGS = ".zen-omnibox-sheet [data-testid=\"urlbar-group-heading\"]"
        private const val ROW_TITLE = "[data-testid=\"urlbar-row-title\"]"
        private const val ROW_SUBTITLE = "[data-testid=\"urlbar-row-subtitle\"]"
        private const val FAVICON = "[data-testid=\"engine-field-favicon\"]"
        private const val NTP_FIELD = ".zen-ntp-field"

        /**
         * The card as it stands, from the field outward: the dock, the headings in the DOM's
         * order (which reads from the field outward on either dock: a bottom-docked card lists
         * its rows in reverse, the first nearest the field, each heading after its group's rows;
         * a top-docked one top to bottom, each heading before its rows) – each with its type and
         * the kinds of the rows sectioned under it (the rows' `data-section`, the heading's
         * `data-group`) – and the rows of no section, which stand at the field's end with the
         * default match. Leaving headings and rows (ghosts) are left out.
         */
        private val CARD_JS = """
            (function () {
              var list = document.querySelector('.zen-omnibox-sheet [role="listbox"]');
              if (!list) return '{}';
              var bottom = list.getAttribute('data-edge') === 'bottom';
              var items = Array.prototype.slice.call(list.children).filter(function (el) { return !el.hasAttribute('data-leaving'); });
              var headings = items.filter(function (el) { return el.getAttribute('data-testid') === 'urlbar-group-heading'; });
              var rows = items.filter(function (el) { return el.getAttribute('data-testid') !== 'urlbar-group-heading'; });
              function kind(r) { return r.getAttribute('data-kind') || '?'; }
              return JSON.stringify({
                edge: bottom ? 'bottom' : 'top',
                headings: headings.map(function (h) {
                  var cs = getComputedStyle(h), group = h.getAttribute('data-group');
                  return { label: h.textContent.trim(), group: group, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
                    kinds: rows.filter(function (r) { return r.getAttribute('data-section') === group; }).map(kind) };
                }),
                loose: rows.filter(function (r) { return !r.hasAttribute('data-section'); }).map(kind).join(', '),
                unheaded: rows.filter(function (r) {
                  var s = r.getAttribute('data-section');
                  return s && !headings.some(function (h) { return h.getAttribute('data-group') === s; });
                }).map(function (r) { return kind(r) + ' in ' + r.getAttribute('data-section'); }).join(', ')
              });
            })()
        """.trimIndent()

        /** The headings on the card after a keystroke: those marked before it (kept as their elements) and those without the mark (remounted). */
        private val KEPT_JS = """
            (function () {
              var kept = [], fresh = [];
              document.querySelectorAll('.zen-omnibox-sheet [data-testid="urlbar-group-heading"]:not([data-leaving])').forEach(function (h) {
                (h.__demoMark ? kept : fresh).push(h.textContent.trim());
              });
              return JSON.stringify({ kept: kept, fresh: fresh });
            })()
        """.trimIndent()

        /** The first history row in the DOM that is not on its way out (nearest the field on a bottom-docked card): its title, its host and its option's box in CSS px. */
        private val HISTORY_ROW_JS = """
            (function () {
              var row = document.querySelector('.zen-omnibox-sheet [role="listbox"] > li[data-kind="history"]:not([data-leaving])');
              if (!row) return '{}';
              var option = row.querySelector('[role="option"]') || row;
              var r = option.getBoundingClientRect();
              var title = row.querySelector('$ROW_TITLE');
              var host = row.querySelector('$ROW_SUBTITLE');
              return JSON.stringify({ title: title ? title.textContent.trim() : '', host: host ? host.textContent.trim() : '',
                x: r.left, y: r.top, w: r.width, h: r.height });
            })()
        """.trimIndent()

        /** The prompt sheet's composition (§9.23): the title block, its description, the footer's buttons and the danger mark on Remove. */
        private val PROMPT_JS = """
            (function () {
              var sheet = document.querySelector('.zen-sheet');
              if (!sheet) return '{}';
              var block = sheet.querySelector('.zen-sheet-title-block');
              var desc = sheet.querySelector('.zen-sheet-title-block > p');
              var buttons = Array.prototype.map.call(sheet.querySelectorAll('.zen-sheet-footer button'), function (b) { return b.textContent.trim(); });
              var remove = Array.prototype.find.call(sheet.querySelectorAll('.zen-sheet-footer button'), function (b) { return b.textContent.trim() === 'Remove'; });
              var heading = Array.prototype.find.call(sheet.querySelectorAll('h1, h2, h3, [role="heading"]'), function (h) { return /Remove suggestion from history\?/.test(h.textContent); });
              var description = desc ? desc.textContent.trim() : '';
              if (!description && heading) {
                var next = heading.nextElementSibling;
                while (next && !description) { description = next.textContent.trim(); next = next.nextElementSibling; }
              }
              return JSON.stringify({ block: !!(block || heading), description: description, buttons: buttons,
                danger: !!(remove && remove.hasAttribute('data-danger')) });
            })()
        """.trimIndent()

        /**
         * The chrome-side sampler: one row per animation frame while it runs – ms since start,
         * `--zen-omnibox-focus` as written on the surfaces that carry it (#307 `aef46ffd`,
         * lib/omniboxFocus.ts: the omnibox's layer `.zen-omnibox-layer` and the phone bar
         * `.zen-phone-bar`, the value on their inline style per frame; the root carries none, and
         * '' once the motion has cleared it) and the root's `data-omnibox-focus` phase ('' at
         * rest). Reads of inline styles and an attribute: no style recalc forced.
         */
        private val SAMPLER = """
            (function () {
              if (window.__focusSampler) return 'kept';
              var s = { rows: [], on: false, t0: 0 };
              s.value = function () {
                var layer = document.querySelector('.zen-omnibox-layer');
                var bar = document.querySelector('.zen-phone-bar');
                return (layer && layer.style.getPropertyValue('--zen-omnibox-focus').trim()) ||
                  (bar && bar.style.getPropertyValue('--zen-omnibox-focus').trim()) || '';
              };
              s.tick = function () {
                if (!s.on) return;
                var root = document.documentElement;
                s.rows.push([Math.round(performance.now() - s.t0), s.value(), root.getAttribute('data-omnibox-focus') || '']);
                requestAnimationFrame(s.tick);
              };
              s.start = function () { s.rows = []; s.on = true; s.t0 = performance.now(); requestAnimationFrame(s.tick); return 'started'; };
              s.stop = function () { s.on = false; return JSON.stringify(s.rows); };
              window.__focusSampler = s;
              return 'installed';
            })()
        """.trimIndent()
    }
}
