package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Primitives pass 5 on a device (wave 5, W5-3): the six seeds of the pass read off the phone, each
 * as claims on the chrome's DOM, the core's state and the host, in the seeded Work space of
 * [GroupsDemoBase] (Research [Alpha, Beta] in blue; Home active; Gamma and Delta loose):
 *
 *  - seed 43 – the new tab page's RESTING FIELD leads with the engine's favicon at 20 in the
 *    field's 20 slot (`EngineFieldGlyph`; the magnifier is the slot's fallback until the favicon
 *    has loaded, so the slot is never blank);
 *  - seed 44 – the SIX-GLYPH ICON ROW settled: the menu's row reads forward, home, star,
 *    download, info, reload on the default bar, every button named and 44; an action the bar
 *    carries is not repeated in the row (§9.13) – Forward and Reload put on the bar leave the
 *    row at home, star, download, info;
 *  - seeds 45 and 46 – ONE GROUP GLYPH everywhere on `groupColorVars`' pair (§9.37, #375; the
 *    lead's #360 verdict: the 10 dot, a 2 ring for a saved group, in the 16 box): the strip's
 *    chip, the Tabs pane's group card and the Groups pane's rows carry the same glyph, blue for
 *    Research and green for a second group closed to a saved one; the card's COUNT reads as the
 *    aside (§9.36, §10.3): 13 tabular, deemphasized, no fill – as do the pane's headings' counts;
 *  - seed 48 – the frame host's PHONE DIALOGS as §9.16 SHEETS: Bookmark All Tabs comes up as a
 *    sheet on the chassis (the 48 header, the count's sentence as body copy, the Name field and
 *    the Folder menulist, Cancel and Save at 16 + the inset; the focus on the dialog, no
 *    keyboard); the menulist's popup a sheet of radio rows over it, the chosen row focused;
 *  - seed 47 – the OPAQUE VEIL from the lock's arming until the first masked frame (`LockVeil`,
 *    `Host`; #250's lock, the `09-locked` finding of #346): with the lock on and a private page
 *    in view, Home arms the lock and raises the veil; on the return the veil's view stands over
 *    the chrome from the window's first frame back – attached, visible, above the chrome, opaque
 *    and in the window's tone (the root's colour) – until the host lowers it for the masked frame
 *    (the host's own log line), within `LockVeil.DEADLINE_MS`, its view out of `root` with it
 *    (the first run's veil stuck: the state down, the view left over the chrome); the lock's
 *    cover stands under it and the lock holds; the switch off releases it all. Sampled every
 *    8 ms from the departure ([VeilWatch]), as `PrivateLockDemo` samples the page view's hide.
 *
 * The private tabs need `WebViewFeature.MULTI_PROFILE`, so the driver runs on the AOSP image
 * with the Chromium snapshot WebView (the `webview` shard; `android-primitives-5-demo.yml`) and
 * sets a device PIN for the run (`locksettings set-pin`, cleared at the end): the lock arms only
 * with a screen lock to pass later. The recording shows the private surface
 * (`PrivateBrowsing.captureForRecording`). No gesture or spring of its own is measured, so no
 * `measureFrames`. Findings in `android-primitives-5-findings.txt`, stills
 * `android-primitives-5-NN-<state>.png`.
 */
@RunWith(AndroidJUnit4::class)
class Primitives5Demo : GroupsDemoBase("android-primitives-5", "primitives-5-demo") {
    override val tag = "Primitives5Demo"
    override val findingsFile = "android-primitives-5-findings.txt"
    override val title = "Zenium Android primitives pass 5: seeds 43-48 on a device"

    private val host: Host get() = (activity as MainActivity).host
    private var pinSet = false

    @Test
    fun record() {
        try {
            recordDemo(PAGES_5)
        } finally {
            PrivateBrowsing.captureForRecording = false
            if (pinSet) shellCommand("locksettings clear --old $PIN")
        }
    }

    /** The bar stays put (no hide on scroll): the icon row's reading against the bar is of a bar in view. */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val settings = state.optJSONObject("settings") ?: JSONObject().also { state.put("settings", it) }
        settings.put("hideToolbarOnScroll", false)
        return state.toString()
    }

    /** The recording must show the private surface; the PIN is the screen lock the lock needs. */
    override fun beforeLaunch() {
        PrivateBrowsing.captureForRecording = true
        Log.i(tag, "set-pin: ${shellCommand("locksettings set-pin $PIN").trim()}")
        pinSet = true
        shellCommand("wm dismiss-keyguard")
    }

    // --- warm-up -----------------------------------------------------------------------------------

    /**
     * The first-open costs out of the scenes: the overview and the menu once each, and the
     * private profile built once (its first tab is the slow one), then Home active again.
     */
    override fun warmUp() {
        head()
        finding(
            "engine: multi-profile ${WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)}, " +
                "screen lock ${onMain { host.reauth.available() }}, capture for recording ${PrivateBrowsing.captureForRecording}"
        )
        awaitLoaded(HOME, "$ORIGIN/")
        openOverview()
        closeOverview()
        if (tapMenuButton() && waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            closeMenu()
        }
        coreInvoke("tab.newPrivate", "{}")
        awaitPrivateActive()
        SystemClock.sleep(1_500)
        coreInvoke("tab.closePrivate")
        awaitNoPrivateTabs()
        activateTab(HOME)
        settle()
        ensureForeground()
        finding("warm-up done: ${describeSpace()}")
    }

    override fun demo() {
        ensureForeground()
        scene("Seed 43: the new tab page's resting field leads with the engine's favicon at 20") { seed43() }
        scene("Seed 44: the six-glyph icon row settled; an action the bar carries is not repeated") { seed44() }
        scene("Seeds 45 and 46: one group glyph everywhere; the count an aside") { seeds45and46() }
        scene("Seed 48: the frame host's phone dialog as a section 9.16 sheet") { seed48() }
        scene("Seed 47: the opaque veil from the lock's arming until the first masked frame") { seed47() }
        still("end")
        tail()
    }

    /** A scene's failure is one FAIL and the next scene's start, not the end of the run. */
    private fun scene(title: String, block: () -> Unit) {
        section(title)
        try {
            block()
        } catch (e: Throwable) {
            check("$title: the scene ran through", false, "${e.javaClass.simpleName}: ${e.message}")
            recover()
        }
    }

    /** Back out of whatever a broken scene left up: a sheet, the overview, a chrome surface. */
    private fun recover() {
        ensureForeground()
        for (attempt in 0 until 3) {
            if (!inDom(SHEET) && !overviewOpen() && !chromeSurfaceUp()) break
            back()
            SystemClock.sleep(1_200)
        }
    }

    // --- seed 43: the resting field's glyph ----------------------------------------------------------

    private fun seed43() {
        val before = trackOrder().map { it.first }.toSet()
        val opened = openNewTabPage(before)
        val ntpTab = activeTabId()?.takeIf { it !in before }
        check("the bar's New tab opens a new tab as the active one", opened && ntpTab != null, "active ${activeTabId()}")
        check("the new tab page's resting field is up", awaitDom(NTP_FIELD, 8_000), "field ${inDom(NTP_FIELD)}")
        // The favicon's arrival is the network's: waited for, recorded, never claimed.
        val loaded = awaitJs("(function(){var i=document.querySelector('$NTP_FAVICON');return !!i&&i.complete&&i.naturalWidth>0})()", true, 6_000)
        val g = jsObject(NTP_GLYPH_JS)
        finding("  glyph $g")
        check(
            "the field leads with the 20 slot: the first of the field's children, 20 by 20, nothing of the field to its left",
            g.optBoolean("present") && g.optBoolean("first") && g.optBoolean("leading") && near(g.optDouble("w"), 20.0, 0.75) && near(g.optDouble("h"), 20.0, 0.75),
            "present ${g.optBoolean("present")}, first ${g.optBoolean("first")}, leading ${g.optBoolean("leading")}, ${g.optDouble("w")}x${g.optDouble("h")}"
        )
        check(
            "the slot carries the engine's favicon at 20 (an https address, the 20 image, rounded 3)",
            g.optString("src").startsWith("https://") && near(g.optDouble("iw"), 20.0, 0.75) && near(g.optDouble("ih"), 20.0, 0.75) && g.optString("radius") == "3px",
            "src '${g.optString("src")}', image ${g.optDouble("iw")}x${g.optDouble("ih")}, radius '${g.optString("radius")}'"
        )
        check(
            "the slot is never blank: the favicon once it has loaded, the magnifier until then",
            g.optBoolean("shown") != g.optBoolean("magnifier"),
            "favicon shown ${g.optBoolean("shown")}, magnifier ${g.optBoolean("magnifier")}"
        )
        check("the placeholder reads 'Search or enter address' after the glyph", g.optString("placeholder") == "Search or enter address", "placeholder '${g.optString("placeholder")}'")
        finding("  favicon ${if (g.optBoolean("shown")) "shown" else "not shown"}; loaded $loaded, arrived ${g.optBoolean("arrived")} (the network's: a finding)")
        SystemClock.sleep(600)
        still("43-ntp-resting-field")
        if (ntpTab != null) {
            coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(ntpTab)},\"force\":true}")
            awaitCore { !tabExists(ntpTab, it) }
        }
        activateTab(HOME)
        SystemClock.sleep(600)
    }

    /**
     * The phone's new tab page is the chrome's own over a blank tab (`lib/newtab.ts`
     * `openNewTabPage`; the core's `tab.new` is the desktop's served page, or its bar in new-tab
     * mode, and opens no tab here – `capabilities.newTabPage` is off on Android): the bar's New
     * tab button is the way in (the MOT-03 grow), the core's blank tab the fallback when the
     * touch did not take. Whether a tab not in `before` became the active one.
     */
    private fun openNewTabPage(before: Set<String>): Boolean {
        val opened = { awaitCore(6_000) { state -> activeTabId(state)?.let { it !in before } == true } }
        if (touchTapLabel("New tab") && opened()) return true
        finding("  (the bar's New tab did not open one; asking the core for the blank tab)")
        coreInvoke("tab.create", "{\"url\":\"zen://blank\",\"active\":true}")
        return opened()
    }

    // --- seed 44: the icon row ---------------------------------------------------------------------

    private fun seed44() {
        closeUrlField()
        finding("  phoneBar setting ${phoneBar() ?: "unset (the default: back | new-tab, tabs, menu)"}; bar buttons ${barLabels()}")
        val row = openIconRow()
        val glyphs = row.map { it.optString("glyph") }
        check("on the default bar the row reads forward, home, star, download, info, reload – six glyphs in the spec's order", glyphs == DEFAULT_ROW, "row $glyphs")
        check("every glyph carries an accessible name", row.isNotEmpty() && row.all { it.optString("label").isNotEmpty() }, "labels ${row.map { it.optString("label") }}")
        check(
            "every button is the phone's 44 target",
            row.isNotEmpty() && row.all { near(it.optDouble("w"), 44.0, 1.5) && near(it.optDouble("h"), 44.0, 1.5) },
            "sizes ${row.map { "${it.optDouble("w", 0.0).roundToInt()}x${it.optDouble("h", 0.0).roundToInt()}" }}"
        )
        finding("  disabled in the row: ${row.filter { it.optBoolean("disabled") }.map { it.optString("glyph") }} (forward with no history behind is expected)")
        SystemClock.sleep(600)
        still("44-menu-row-default-bar")
        closeMenu()

        coreInvoke("settings.update", "{\"phoneBar\":{\"left\":[\"back\",\"forward\"],\"right\":[\"reload\",\"tabs\",\"menu\"]}}")
        val moved = awaitUntil(8_000) { barLabels().let { "Forward" in it && ("Reload" in it || "Stop" in it) } }
        check("Forward and Reload put on the bar show there", moved, "bar ${barLabels()}")
        SystemClock.sleep(800)
        val row2 = openIconRow()
        val glyphs2 = row2.map { it.optString("glyph") }
        check("an action the bar carries is not repeated in the row: forward and reload gone, home, star, download, info stand", glyphs2 == BAR_ROW, "row $glyphs2")
        SystemClock.sleep(600)
        still("44-menu-row-bar-carries-forward-reload")
        closeMenu()

        coreInvoke("settings.update", "{\"phoneBar\":{\"left\":[\"back\"],\"right\":[\"new-tab\",\"tabs\",\"menu\"]}}")
        val restored = awaitUntil(8_000) { barLabels().let { "Forward" !in it && "New tab" in it } }
        check("the default bar comes back", restored, "bar ${barLabels()}")
        SystemClock.sleep(600)
    }

    private fun openIconRow(): List<JSONObject> {
        for (attempt in 1..3) {
            if (!inDom("$ICON_ROW button[data-glyph]")) {
                tapMenuButton()
                if (!awaitDom("$ICON_ROW button[data-glyph]", 8_000)) {
                    finding("  (the menu's icon row did not come up, attempt $attempt)")
                    closeMenu()
                    continue
                }
            }
            SystemClock.sleep(1_200)
            val arr = jsArray(ICON_ROW_JS)
            return (0 until arr.length()).map { arr.getJSONObject(it) }
        }
        return emptyList()
    }

    private fun closeMenu() {
        if (!inDom(SHEET) && !chromeSurfaceUp()) return
        back()
        if (!awaitDomGone(SHEET, SHEET_WAIT)) finding("  (the menu is still up)")
        awaitSurface(false, 4_000)
        SystemClock.sleep(600)
    }

    private fun barLabels(): List<String> =
        jsArray("Array.prototype.map.call(document.querySelectorAll('$BAR_BUTTONS'),function(b){return b.getAttribute('aria-label')||''})").strings()

    private fun phoneBar(): String? = coreState().optJSONObject("settings")?.optJSONObject("phoneBar")?.toString()

    // --- seeds 45 and 46: the glyph and the count -----------------------------------------------------

    private fun seeds45and46() {
        closeUrlField()
        val trip = createTrip()

        activateTab(ALPHA)
        awaitLoaded(ALPHA, ALPHA_URL, 10_000)
        check("the group strip's chip is up over Alpha (the active tab in Research)", awaitDom(STRIP_GLYPH, 8_000), "chip ${inDom(STRIP_GLYPH)}")
        val chip = glyph(STRIP_GLYPH)
        check("the strip's chip carries the one glyph: the 10 dot in the 16 box, filled with Research's blue (the ${chromeScheme()} set)", glyphIsDot(chip, blueRgb()), describeGlyph(chip))
        SystemClock.sleep(600)
        still("45-strip-chip")

        openOverview()
        pickPane("tabs")
        check("Research's card is on the Tabs pane", awaitDom(CARD_HEADER, SHEET_WAIT), "header ${domRect(CARD_HEADER)}")
        val card = glyph("$CARD_HEADER .zen-group-row-glyph")
        check("the card's header carries the same dot in the same blue", glyphIsDot(card, blueRgb()), describeGlyph(card))
        val count = jsObject("$COUNT_JS(${JSONObject.quote("$CARD_HEADER .zen-group-row-count")})")
        finding("  count $count")
        check(
            "the card's count reads as the aside: '2' at 13 tabular, no fill of its own",
            count.optString("text") == "2" && near(count.optDouble("size"), 13.0, 0.5) && count.optString("numeric").contains("tabular-nums") && count.optString("bg") == "rgba(0, 0, 0, 0)",
            "text '${count.optString("text")}', size ${count.optString("size")}, numeric '${count.optString("numeric")}', fill '${count.optString("bg")}'"
        )
        check(
            "the count is deemphasized beside the name: a translucent ink where the name's is solid",
            count.optDouble("alpha", 1.0) < 1.0 && count.optDouble("alpha", 1.0) < count.optDouble("nameAlpha", 1.0),
            "count ${count.optString("color")}, name ${count.optString("nameColor")}"
        )
        SystemClock.sleep(600)
        still("45-46-group-card")

        pickPane("groups")
        check(
            "the Groups pane lists Research under Open and ${TRIP_NAME} under Saved",
            awaitDom("$OPEN_SECTION .zen-phone-row", SHEET_WAIT) && awaitDom("$SAVED_SECTION .zen-phone-row", SHEET_WAIT) &&
                textsOf("$OPEN_SECTION .zen-list-title") == listOf("Research") && textsOf("$SAVED_SECTION .zen-list-title") == listOf(TRIP_NAME),
            "open ${textsOf("$OPEN_SECTION .zen-list-title")}, saved ${textsOf("$SAVED_SECTION .zen-list-title")}"
        )
        val open = glyph("$OPEN_SECTION .zen-group-row-glyph")
        check("the open group's row carries the filled dot in blue", glyphIsDot(open, blueRgb()), describeGlyph(open))
        val saved = glyph("$SAVED_SECTION .zen-group-row-glyph")
        check("the saved group's row carries the same 10 glyph as a 2 ring in its green, the fill clear (trip $trip)", glyphIsRing(saved, greenRgb()), describeGlyph(saved))
        check("each heading's count is the aside: one open, one saved", textsOf(GROUPS_ASIDE) == listOf("1", "1"), "asides ${textsOf(GROUPS_ASIDE)}")
        SystemClock.sleep(600)
        still("45-groups-pane-open-saved")
        closeOverview()
        activateTab(HOME)
        SystemClock.sleep(600)
    }

    /** A second group, green, with Gamma and Delta, closed to a saved one; its id, or null when the core refused. */
    private fun createTrip(): String? {
        val raw = coreInvoke("folder.create", "{\"spaceId\":\"$SPACE\",\"name\":${JSONObject.quote(TRIP_NAME)},\"icon\":\"📁\",\"color\":\"green\",\"rename\":false}")
        val id = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()?.takeIf { it.isNotEmpty() }
        check("a second group, $TRIP_NAME in green, is created", id != null, "folder.create -> $raw")
        if (id == null) return null
        for (tab in listOf(GAMMA, DELTA)) coreInvoke("tab.moveToFolder", "{\"tabId\":\"$tab\",\"folderId\":${JSONObject.quote(id)}}")
        check("Gamma and Delta move into it", awaitCore { folderOf(GAMMA, it) == id && folderOf(DELTA, it) == id }, "gamma ${folderOf(GAMMA)}, delta ${folderOf(DELTA)}")
        coreInvoke("folder.close", "{\"folderId\":${JSONObject.quote(id)}}")
        check(
            "Close Group keeps its two pages as a saved group",
            awaitCore { savedCount(id, it) == 2 && !tabExists(GAMMA, it) && !tabExists(DELTA, it) },
            "saved ${savedCount(id)}, gamma ${tabExists(GAMMA)}, delta ${tabExists(DELTA)}"
        )
        awaitToastGone()
        return id
    }

    private fun savedCount(folderId: String, state: JSONObject = coreState()): Int =
        state.getJSONObject("folders").optJSONObject(folderId)?.optJSONArray("savedTabs")?.length() ?: 0

    private fun glyph(selector: String): JSONObject = jsObject("$GLYPH_JS(${JSONObject.quote(selector)})")

    /** The one glyph in an open group's pose: the 16 box, the 10 dot filled with the group's colour, no own icon. */
    private fun glyphIsDot(g: JSONObject, colour: String): Boolean =
        g.optBoolean("present") && near(g.optDouble("w"), 16.0, 0.5) && near(g.optDouble("h"), 16.0, 0.5) &&
            g.optBoolean("dot") && g.optString("icon").isEmpty() && !g.optBoolean("saved") &&
            near(g.optDouble("dw"), 10.0, 0.5) && near(g.optDouble("dh"), 10.0, 0.5) && g.optString("bg") == colour

    /** The same glyph in a saved group's pose: the 10 box as a 2 ring in the group's colour, the fill clear. */
    private fun glyphIsRing(g: JSONObject, colour: String): Boolean =
        g.optBoolean("present") && near(g.optDouble("w"), 16.0, 0.5) && near(g.optDouble("h"), 16.0, 0.5) &&
            g.optBoolean("dot") && g.optString("icon").isEmpty() && g.optBoolean("saved") &&
            near(g.optDouble("dw"), 10.0, 0.5) && near(g.optDouble("dh"), 10.0, 0.5) &&
            g.optString("bg") == "rgba(0, 0, 0, 0)" && g.optString("shadow").let { it.contains(colour) && it.contains("2px") && it.contains("inset") }

    private fun describeGlyph(g: JSONObject): String =
        if (!g.optBoolean("present")) "no glyph"
        else "box ${g.optDouble("w")}x${g.optDouble("h")}, dot ${g.optBoolean("dot")}, icon '${g.optString("icon")}', dot box ${g.optDouble("dw")}x${g.optDouble("dh")}, " +
            "fill '${g.optString("bg")}', shadow '${g.optString("shadow")}', radius '${g.optString("radius")}', saved ${g.optBoolean("saved")}, rgb ${g.optString("rgb")}"

    // --- seed 48: the dialog as a sheet ---------------------------------------------------------------

    private fun seed48() {
        closeUrlField()
        val pages = trackOrder().count { (id, _) -> !tabUrl(id).orEmpty().startsWith("zen://") }
        if (!openMenuItem("Bookmarks", "Bookmark All Tabs…")) {
            finding("  (the menu path did not take; asking the core for the dialog)")
            closeMenu()
            coreInvoke("bookmark.allTabs")
        }
        check("Bookmark All Tabs brings the form up as a sheet", awaitDom("$SHEET .zen-sheet-title", 8_000) && awaitDom(FORM, 4_000), "title '${textOf("$SHEET .zen-sheet-title")}', form ${inDom(FORM)}")
        awaitSheetSettled(FORM, 8_000)
        val p = sheetProbe(FORM)
        finding("  ${sheetText(p)}")
        check(
            "the sheet is the dialog and holds the focus: no field, no keyboard (section 9.22)",
            p.optString("role") == "dialog" && p.optString("tabindex") == "-1" && p.optBoolean("focusOnContainer") && !imeShown(),
            "role '${p.optString("role")}', tabindex '${p.optString("tabindex")}', focus on the container ${p.optBoolean("focusOnContainer")}, keyboard ${imeShown()}"
        )
        check("the 48 header names it 'Bookmark all tabs'", p.optDouble("headerHeight") >= 47.5 && p.optString("title") == "Bookmark all tabs", "header ${p.optDouble("headerHeight")}, title '${p.optString("title")}'")
        check(
            "the count's sentence is body copy under the header: '${copyFor(pages)}' at 15/400",
            p.optString("copy") == copyFor(pages) && near(p.optDouble("copySize"), 15.0, 0.5) && p.optString("copyWeight") == "400",
            "copy '${p.optString("copy")}' at ${p.optDouble("copySize")}/${p.optString("copyWeight")}"
        )
        check(
            "the form holds the Name field and the Folder menulist, its popup a dialog",
            p.optBoolean("nameField") && p.optString("menulistPopup") == "dialog" && p.optString("menulistText").isNotEmpty(),
            "name field ${p.optBoolean("nameField")}, menulist '${p.optString("menulistText")}' haspopup '${p.optString("menulistPopup")}'"
        )
        val footer = p.optJSONArray("footer")?.let { arr -> (0 until arr.length()).map { arr.getString(it) } } ?: emptyList()
        check("the footer is Cancel then Save, Save the one primary", footer == listOf("Cancel", "Save") && p.optInt("primaries") == 1 && p.optString("primary") == "Save", "footer $footer, primaries ${p.optInt("primaries")} ('${p.optString("primary")}')")
        val wantGap = 16.0 + p.optDouble("insetBottom")
        check("the footer's buttons stand 16 + the inset over the sheet's bottom edge", near(p.optDouble("gapFooter"), wantGap, 1.0), "gap ${p.optDouble("gapFooter")}, wanted $wantGap (inset ${p.optDouble("insetBottom")})")
        check("the sheet is edge to edge on the phone", near(p.optDouble("width"), p.optDouble("layerWidth"), 1.0), "sheet ${p.optDouble("width")} of the layer's ${p.optDouble("layerWidth")}")
        SystemClock.sleep(600)
        still("48-bookmark-all-tabs-sheet")

        val picked = touchUntil("the Folder menulist", { domRect("$FORM .zen-v2-menulist") }, { inDom(PICKER) }, waitMs = SHEET_WAIT)
        check("the menulist's touch brings the folder picker: a sheet of radio rows over the form's", picked && awaitDom("$PICKER [role=\"radio\"]", SHEET_WAIT), "picker ${inDom(PICKER)}")
        awaitSheetSettled(PICKER, 8_000)
        val q = sheetProbe(PICKER)
        finding("  ${sheetText(q)}")
        check("two sheets stand: the form's under the picker's", jsNumber("document.querySelectorAll('$SHEET').length") >= 2.0, "sheets ${jsNumber("document.querySelectorAll('$SHEET').length")}")
        check(
            "the picker is headed Folder, a list body, the chosen folder checked – the menulist's",
            q.optString("title") == "Folder" && q.optString("body") == "list" && q.optString("checked").isNotEmpty() && q.optString("checked") == p.optString("menulistText"),
            "title '${q.optString("title")}', body '${q.optString("body")}', checked '${q.optString("checked")}' vs menulist '${p.optString("menulistText")}'"
        )
        check("the checked row holds the focus", q.optString("focusText").isNotEmpty() && q.optString("focusText") == q.optString("checked"), "focus on '${q.optString("focusText")}'")
        val wantRowGap = 16.0 + q.optDouble("insetBottom")
        check("the last row stands 16 + the inset over the picker's bottom edge", near(q.optDouble("gapLastRow"), wantRowGap, 1.0), "gap ${q.optDouble("gapLastRow")}, wanted $wantRowGap")
        SystemClock.sleep(600)
        still("48-folder-picker-sheet")

        back()
        check("back leaves the picker; the form's sheet stays", awaitDomGone(PICKER, SHEET_WAIT) && inDom(FORM), "picker ${inDom(PICKER)}, form ${inDom(FORM)}")
        SystemClock.sleep(500)
        back()
        check("back again leaves the form; nothing was saved", awaitDomGone(SHEET, SHEET_WAIT), "sheet ${inDom(SHEET)}")
        awaitSurface(false, 4_000)
        SystemClock.sleep(600)
    }

    private fun copyFor(count: Int): String = if (count == 1) "1 page goes into a new folder" else "$count pages go into a new folder"

    /** The sheet around the element `inner` selects, measured; empty when there is none. */
    private fun sheetProbe(inner: String): JSONObject = jsObject("$SHEET_JS(${JSONObject.quote(inner)})")

    private fun sheetText(p: JSONObject): String =
        "the sheet ${p.optInt("height")} tall and ${p.optDouble("width")} wide (layer ${p.optDouble("layerWidth")}), its bottom at ${p.optInt("bottom")}, " +
            "insets top ${p.optDouble("insetTop")} bottom ${p.optDouble("insetBottom")}, header ${p.optDouble("headerHeight")}, body '${p.optString("body")}', ${p.optInt("rows")} rows"

    /** The sheet at rest: its top the same over two reads 300 ms apart; then a beat for the spring's tail. */
    private fun awaitSheetSettled(inner: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = Int.MIN_VALUE
        while (SystemClock.uptimeMillis() < deadline) {
            val top = sheetProbe(inner).optInt("top", Int.MIN_VALUE)
            if (top != Int.MIN_VALUE && top == last) {
                SystemClock.sleep(600)
                return true
            }
            last = top
            SystemClock.sleep(300)
        }
        return false
    }

    // --- seed 47: the veil --------------------------------------------------------------------------

    private fun seed47() {
        closeUrlField()
        coreInvoke("private.setLockOnLeave", "{\"enabled\":true}")
        check("the lock's switch goes on (the host mirrors the core's choice)", awaitUntil(6_000) { host.privateLock.enabled }, "enabled ${host.privateLock.enabled}")
        coreInvoke("tab.newPrivate", "{\"url\":${JSONObject.quote(SECRET_URL)}}")
        check("a private tab opens on the secret page", awaitPrivateActive(), "active ${activeTabId()}")
        activeTabId()?.let { awaitLoaded(it, SECRET_URL, 15_000) }
        check("the host has a private surface in view", awaitUntil(6_000) { onMain { host.privateSurface } }, "privateSurface ${onMain { host.privateSurface }}")
        settle()
        still("47-private-page-before-leaving")

        shellCommand("logcat -c")
        val watch = VeilWatch().also { it.start() }
        pressHome()
        check("Home puts Zenium behind the launcher", awaitFront(ours = false), "front ${frontPackage()}")
        val locked = awaitLocked(4_000)
        val raisedAway = host.lockVeil.raised
        check("the lock arms as the window stops, and the veil goes up with it (a private surface was in view)", locked && raisedAway, "locked $locked, veil raised $raisedAway")
        SystemClock.sleep(1_500)
        returnToApp()
        check("Zenium is back in front", awaitFront(ours = true), "front ${frontPackage()}")
        SystemClock.sleep(450)
        finding("  the screen over the chrome on the return: ${sampleScreen()} (the OS may show its task snapshot for the first frames: a finding, not a claim)")
        still("47-veil-on-return")
        val fell = awaitUntil(9_000) { !host.lockVeil.raised }
        SystemClock.sleep(400)
        val r = watch.finish()
        val log = veilLog()
        val why = log.lastOrNull { "lowered: " in it }?.substringAfter("lowered: ")?.trim()
        finding("  veil watch: ${r.describe()}")
        finding("  host log: $log")
        check("the veil stood from the window's first frame back", r.sawStop && r.raisedAtStart && r.raisedOnScreen > 0, "stop seen ${r.sawStop}, raised at the start ${r.raisedAtStart}, raised samples on screen ${r.raisedOnScreen}")
        check("no gap: whenever it was raised with the window on screen, its view was attached, visible and above the chrome", r.gaps == 0, "gaps ${r.gaps} (of ${r.raisedOnScreen}), not topmost ${r.notTopmost}")
        val veil = r.veilColour
        val root = r.rootColour
        check("the veil is opaque and in the window's tone (the root's colour, alpha 255)", veil != null && veil == root && Color.alpha(veil) == 255, "veil ${hex(veil)}, root ${hex(root)}")
        check("it fell for the masked frame, not the deadline – the host's own word", fell && why == "masked frame", "fell $fell, host log '${why ?: "none"}', lowered ${r.loweredAtMs} ms after the first frame back")
        check("it fell within LockVeil.DEADLINE_MS of the window's start", r.loweredAtMs in 1L..LockVeil.DEADLINE_MS, "lowered at ${r.loweredAtMs} ms, the deadline ${LockVeil.DEADLINE_MS}")
        // The first run's veil stuck here: the state lowered, the view left in root over the chrome.
        check(
            "the veil's view leaves root as the veil falls: nothing of it stays over the chrome",
            r.detachedAtMs >= 0 && r.detachedAtMs - r.loweredAtMs <= 200 && onMain { host.lockVeilView?.parent == null },
            "view detached ${if (r.detachedAtMs < 0) "never" else "${r.detachedAtMs} ms after the first frame back"} (lowered at ${r.loweredAtMs}), ${r.stale} stale samples, parent now ${onMain { host.lockVeilView?.parent?.javaClass?.simpleName ?: "none" }}"
        )
        check("the lock's cover stands under it and the lock holds", awaitCover(8_000) && host.privateLock.locked, "cover ${coverUp()}, locked ${host.privateLock.locked}")
        ensureForeground()
        SystemClock.sleep(800)
        finding("  the screen over the chrome with the cover up: ${sampleScreen()} (the veil's one colour gone: the cover's words and button in the grid)")
        still("47-cover-after-the-veil")

        // Nothing is locked with the switch off: the release, no veil for it.
        coreInvoke("private.setLockOnLeave", "{\"enabled\":false}")
        val released = awaitUntil(8_000) { !host.privateLock.locked }
        val coverGone = awaitDomGone(COVER, 8_000)
        check(
            "the switch off releases the lock; the cover leaves; no veil stands, no view of it in root",
            released && coverGone && !host.lockVeil.raised && onMain { host.lockVeilView?.parent == null },
            "locked ${host.privateLock.locked}, cover ${inDom(COVER)}, veil ${host.lockVeil.raised}, view attached ${onMain { host.lockVeilView?.parent != null }}"
        )
        SystemClock.sleep(600)
        coreInvoke("tab.closePrivate")
        check("the private tabs close", awaitNoPrivateTabs(), "private ${privateTabIds()}")
        settle()
        ensureForeground()
    }

    /** What the veil watch saw, once stopped. */
    private class VeilReport {
        var samples = 0
        var sawStop = false
        var raisedAtStart = false
        var raisedOnScreen = 0
        var gaps = 0
        var notTopmost = 0
        var loweredAtMs = -1L
        /** The first sample after the lowering with the view out of root; -1 while it stays. */
        var detachedAtMs = -1L
        /** Samples after the lowering with the view still in root, on screen. */
        var stale = 0
        var veilColour: Int? = null
        var rootColour: Int? = null
        val runs = ArrayList<String>()

        fun describe(): String =
            "$samples samples; stop seen $sawStop; raised at the window's start $raisedAtStart; $raisedOnScreen raised samples on screen, $gaps gaps, $notTopmost not topmost; " +
                "lowered ${if (loweredAtMs < 0) "never" else "$loweredAtMs ms after the first frame back"}, its view out of root ${if (detachedAtMs < 0) "never" else "at $detachedAtMs ms"} ($stale stale samples); " +
                "veil ${hex(veilColour)}, root ${hex(rootColour)}; timeline ${runs.take(14)}"

        private fun hex(colour: Int?): String = colour?.let { "#%08x".format(it) } ?: "none"
    }

    /**
     * The veil sampled every 8 ms from the departure: the activity's lifecycle state (on screen
     * at STARTED), the veil's flag, and its view – attached to the root, VISIBLE, above the chrome
     * and topmost – with the veil's and the root's colours at the first raised sample on screen
     * after the stop. Counted from the first on-screen sample after a stop: the window's return.
     */
    private inner class VeilWatch : Thread("veil-watch") {
        @Volatile private var stopped = false
        private val report = VeilReport()

        override fun run() {
            val t0 = SystemClock.uptimeMillis()
            var lastKey = ""
            var runStart = 0L
            var firstBackAt = -1L
            var wasRaisedOnScreen = false
            while (!stopped) {
                val now = SystemClock.uptimeMillis() - t0
                val h = runCatching { (activity as? MainActivity)?.host }.getOrNull()
                val state = runCatching { (activity as? FragmentActivity)?.lifecycle?.currentState }.getOrNull()
                val onScreen = state != null && state.isAtLeast(Lifecycle.State.STARTED)
                val raised = h?.lockVeil?.raised == true
                var attached = false
                var visible = false
                var aboveChrome = false
                var topmost = false
                var veilColour: Int? = null
                var rootColour: Int? = null
                runCatching {
                    val v = h?.lockVeilView
                    val parent = v?.parent as? ViewGroup
                    if (v != null && parent != null) {
                        attached = true
                        visible = v.visibility == View.VISIBLE
                        val index = parent.indexOfChild(v)
                        topmost = index == parent.childCount - 1
                        val chrome = h?.chrome
                        aboveChrome = chrome != null && chrome.parent === parent && index > parent.indexOfChild(chrome)
                        veilColour = (v.background as? ColorDrawable)?.color
                        rootColour = (parent.background as? ColorDrawable)?.color
                    }
                }
                report.samples++
                if (!onScreen) report.sawStop = true
                if (report.sawStop && onScreen) {
                    if (firstBackAt < 0) {
                        firstBackAt = now
                        report.raisedAtStart = raised
                    }
                    if (raised) {
                        report.raisedOnScreen++
                        if (!(attached && visible && aboveChrome)) report.gaps++
                        if (!topmost) report.notTopmost++
                        if (report.veilColour == null && veilColour != null) {
                            report.veilColour = veilColour
                            report.rootColour = rootColour
                        }
                        wasRaisedOnScreen = true
                    } else if (wasRaisedOnScreen) {
                        if (report.loweredAtMs < 0) report.loweredAtMs = now - firstBackAt
                        if (attached) report.stale++
                        else if (report.detachedAtMs < 0) report.detachedAtMs = now - firstBackAt
                    }
                }
                val key = "${if (onScreen) "on" else "off"}/${if (raised) "veil" else "clear"}/${if (attached) (if (visible) "visible" else "hidden") else "detached"}"
                if (key != lastKey) {
                    if (lastKey.isNotEmpty()) report.runs += "$lastKey $runStart-$now ms"
                    lastKey = key
                    runStart = now
                }
                SystemClock.sleep(8)
            }
            report.runs += "$lastKey $runStart-${SystemClock.uptimeMillis() - t0} ms"
        }

        fun finish(): VeilReport {
            stopped = true
            join(3_000)
            return report
        }
    }

    private fun hex(colour: Int?): String = colour?.let { "#%08x".format(it) } ?: "none"

    /** The host's own words on the veil since the scene's `logcat -c` (`Host.raiseVeil` / `lowerVeil`), the tag and time stripped. */
    private fun veilLog(): List<String> =
        shellCommand("logcat -d -s ZenHost:*").lines()
            .filter { "private lock veil" in it }
            .map { it.substringAfter("private lock veil").trim().trimStart(':').trim() }

    /**
     * What the screen shows over the chrome's box: the dominant colour of a 12 by 12 grid of
     * samples and its share, and how many distinct colours (quantized) the grid holds – one
     * colour is a veil (or the OS's snapshot of a plain page); many is a page or the chrome.
     */
    private fun sampleScreen(): String {
        return runCatching {
            val box = onMain {
                val at = IntArray(2)
                host.chrome.getLocationOnScreen(at)
                Rect(at[0], at[1], at[0] + host.chrome.width, at[1] + host.chrome.height)
            }
            val shot = ui.takeScreenshot() ?: error("no screenshot")
            val bitmap = if (shot.config == Bitmap.Config.HARDWARE) shot.copy(Bitmap.Config.ARGB_8888, false) else shot
            val counts = HashMap<Int, Int>()
            val n = 12
            for (i in 0 until n) for (j in 0 until n) {
                val x = (box.left + (box.width() * (i + 0.5f) / n).roundToInt()).coerceIn(0, bitmap.width - 1)
                val y = (box.top + (box.height() * (j + 0.5f) / n).roundToInt()).coerceIn(0, bitmap.height - 1)
                val c = bitmap.getPixel(x, y) and 0xfff0f0f0.toInt()
                counts[c] = (counts[c] ?: 0) + 1
            }
            if (bitmap !== shot) bitmap.recycle()
            shot.recycle()
            val top = counts.entries.maxByOrNull { it.value } ?: error("no samples")
            "dominant ${hex(top.key)} in ${(top.value * 100) / (n * n)} % of ${n * n} samples, ${counts.size} distinct colours, box $box"
        }.getOrElse { "not sampled: ${it.javaClass.simpleName}: ${it.message}" }
    }

    // --- the lock, Home and back (as PrivateLockDemo) -------------------------------------------------

    private fun pressHome() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    /**
     * Zenium back in front through the shell (`am start` from the shell is no background start
     * the system may refuse); the in-process start is the fallback when the shell's answer is not ok.
     */
    private fun returnToApp() {
        val started = shellCommand("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        if (!started.contains("Status: ok")) {
            finding("  am start: ${started.trim().lines().joinToString(" | ")}; starting from the process instead")
            app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun frontPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun awaitFront(ours: Boolean, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val front = frontPackage()
            if (front != null && (front == app.packageName) == ours) return true
            SystemClock.sleep(200)
        }
        return (frontPackage() == app.packageName) == ours
    }

    /** The lock armed, waited for: the activity's stop follows the launcher's first frame a little later. */
    private fun awaitLocked(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (host.privateLock.locked) return true
            SystemClock.sleep(50)
        }
        return host.privateLock.locked
    }

    /** A lock cover at rest is in the chrome's DOM, not one on its way out. */
    private fun coverUp(): Boolean =
        jsString("(function(){var e=document.querySelector('$COVER');return e&&!e.hasAttribute('data-leaving')?'up':''})()") == "up"

    private fun awaitCover(timeoutMs: Long): Boolean = awaitUntil(timeoutMs) { coverUp() }

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun awaitPrivateActive(timeoutMs: Long = 10_000): Boolean = awaitUntil(timeoutMs) { privateActive() }

    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence()
            .filter { tabs.optJSONObject(it)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }
            .sorted()
            .toList()
    }

    private fun awaitNoPrivateTabs(timeoutMs: Long = 8_000): Boolean = awaitUntil(timeoutMs) { privateTabIds().isEmpty() }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    // --- the overview (as TabGroupsDemo) ------------------------------------------------------------

    private fun activateTab(tabId: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        if (!awaitCore { activeTabId(it) == tabId }) finding("  ($tabId did not become the active tab)")
    }

    /** Open the overview with a touch on the bar's Tabs button; a touch read as a hold is dismissed and tried again. */
    private fun openOverview() {
        if (overviewOpen()) return
        for (attempt in 0 until OPEN_ATTEMPTS) {
            val close = closeUrlField()
            if (!close.ok) finding("  (attempt ${attempt + 1}: ${close.describe()})")
            val tabs = findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?: screen(domRect("[aria-label^=\"Tabs (\"]"))
            if (tabs != null) {
                Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            } else {
                val f = Finger()
                f.down(pillCenterX, pillY)
                f.settleIn(0f, -NUDGE)
                f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
                f.up()
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (!overviewOpen() && SystemClock.uptimeMillis() < deadline) {
                if (heldInstead()) {
                    finding("  (the tap on Tabs was read as a hold, attempt ${attempt + 1}: dismissed, trying again)")
                    back()
                    val gone = SystemClock.uptimeMillis() + 4_000
                    while (heldInstead() && SystemClock.uptimeMillis() < gone) SystemClock.sleep(200)
                    SystemClock.sleep(1_000)
                    break
                }
                SystemClock.sleep(200)
            }
            if (overviewOpen()) {
                SystemClock.sleep(2_000)
                calibrate("[aria-label=\"Spaces\"]", "Spaces")
                return
            }
        }
        error("the overview never opened")
    }

    private fun closeOverview() {
        for (attempt in 0 until 3) {
            if (!overviewOpen() && !inDom(OVERVIEW)) break
            back()
            if (awaitUntil(6_000) { !overviewOpen() }) break
        }
        SystemClock.sleep(1_200)
    }

    private fun heldInstead(): Boolean = inDom(".zen-quick-menu, .zen-sheet")

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('$OVERVIEW');return e?e.style.transform:''})()") == "scale(1)"

    private fun selectedPane(): String = attrOf("[data-testid^=\"overview-pane-\"][aria-selected=\"true\"]", "data-pane")

    private fun paneIs(pane: String): Boolean = selectedPane() == pane

    /** A touch on the segment's `pane` button until the pane is the one picked. */
    private fun pickPane(pane: String) {
        if (paneIs(pane)) return
        val picked = touchUntil("the $pane segment", { domRect("[data-testid=\"overview-pane-$pane\"]") }, { paneIs(pane) }, waitMs = SHEET_WAIT)
        if (!picked) error("the $pane pane never came up")
        SystemClock.sleep(600)
    }

    // --- reads -----------------------------------------------------------------------------------

    /** A JS expression's object result; empty when it never answered or was no object. */
    private fun jsObject(code: String): JSONObject {
        val raw = chromeJs("JSON.stringify($code)")
        if (raw.isEmpty() || raw == "null") return JSONObject()
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrDefault(JSONObject())
    }

    private fun near(a: Double, b: Double, tolerance: Double): Boolean = a.isFinite() && abs(a - b) <= tolerance

    private companion object {
        /** Set with `locksettings set-pin` before the app starts; cleared at the end. */
        private const val PIN = "1234"
        private const val OPEN_ATTEMPTS = 4
        private const val TRIP_NAME = "Trip planning"
        private const val SECRET_URL = "$ORIGIN/secret.html"

        private const val SHEET = ".zen-sheet"
        private const val FORM = ".zen-sheet .zen-phone-form"
        private const val PICKER = ".zen-sheet [role=\"radiogroup\"][aria-label=\"Folder\"]"
        private const val ICON_ROW = ".zen-menu-icon-row"
        private const val BAR_BUTTONS = ".zen-phone-bar-row .zen-toolbar-button"
        private const val NTP_FIELD = ".zen-ntp-field"
        private const val NTP_FAVICON = ".zen-ntp-field [data-testid=\"engine-field-favicon\"]"
        private const val OVERVIEW = ".zen-overview"
        private const val GROUPS_PANE = "[data-testid=\"overview-groups\"]"
        private const val OPEN_SECTION = "[data-testid=\"overview-groups-open\"]"
        private const val SAVED_SECTION = "[data-testid=\"overview-groups-saved\"]"
        private const val GROUPS_ASIDE = "$GROUPS_PANE .zen-overview-groups-aside"
        private const val CARD_HEADER = ".zen-overview-grid [data-cell=\"group:$FOLDER\"] > .zen-group-header"
        private const val STRIP_GLYPH = ".zen-group-strip .zen-group-chip-show .zen-group-row-glyph"
        private const val COVER = "[data-testid=\"private-lock-cover\"]"

        /** The row's glyphs on the default bar (menus.ts `phoneIconRow`), and with Forward and Reload on the bar. */
        private val DEFAULT_ROW = listOf("forward", "home", "star", "download", "info", "reload")
        private val BAR_ROW = listOf("home", "star", "download", "info")

        /** The secret page (PrivateLockDemo's): large, readable text – what the veil and the cover hide. */
        private val PAGES_5: Map<String, Pair<String, ByteArray>> = mapOf(
            "/secret.html" to ("text/html; charset=utf-8" to (
                "<!doctype html><html><head><meta charset=utf-8>" +
                    "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Secret notes</title>" +
                    "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff7e6}main{padding:36px 24px}" +
                    "h1{font-size:34px;margin:0 0 20px;color:#7a3e00}p{font-size:24px;line-height:1.45;margin:0 0 18px}" +
                    ".tag{display:inline-block;padding:8px 14px;border-radius:12px;background:#ffd9a3;font-size:20px}</style></head>" +
                    "<body><main><h1>Secret notes</h1><p class=tag>Only a private tab reads this</p>" +
                    "<p>Dentist on Thursday at 9. Gift for June: the blue kettle. Passport renewal by the 14th.</p>" +
                    "<p>The veil and the lock cover must hide every word of this page until the screen lock is passed.</p></main></body></html>"
                ).toByteArray())
        )

        /** The new tab field's leading slot: its box, its place among the field's children, the favicon and the fallback in it. */
        private val NTP_GLYPH_JS = """
            (function(){
              var main=document.querySelector('.zen-ntp-field .zen-ntp-field-main');
              var slot=main?main.querySelector('[data-testid="engine-field-glyph"]'):null;
              if(!slot)return {present:false};
              var r=slot.getBoundingClientRect();
              var img=slot.querySelector('[data-testid="engine-field-favicon"]');
              var ir=img?img.getBoundingClientRect():null;
              var leading=true;
              for(var i=0;i<main.children.length;i++){var k=main.children[i];if(k===slot)continue;
                var kr=k.getBoundingClientRect();if(kr.width>0&&kr.left<r.right-0.5)leading=false;}
              var last=main.lastElementChild;
              return {present:true,w:r.width,h:r.height,left:r.left,first:main.firstElementChild===slot,leading:leading,
                src:img?(img.getAttribute('src')||''):'',shown:!!img&&!img.classList.contains('invisible'),
                arrived:!!img&&img.hasAttribute('data-arrived'),iw:ir?ir.width:0,ih:ir?ir.height:0,
                radius:img?getComputedStyle(img).borderRadius:'',magnifier:!!slot.querySelector('svg'),
                placeholder:last&&last!==slot?last.textContent.trim():''};
            })()
        """.trimIndent()

        /** The menu's icon row: every button's glyph, name, state and box. */
        private val ICON_ROW_JS = """
            Array.prototype.map.call(document.querySelectorAll('.zen-menu-icon-row button[data-glyph]'),function(b){
              var r=b.getBoundingClientRect();
              return {glyph:b.getAttribute('data-glyph'),label:b.getAttribute('aria-label')||'',
                disabled:b.disabled||b.getAttribute('aria-disabled')==='true',w:r.width,h:r.height}})
        """.trimIndent()

        /** A group glyph (`GroupGlyph`, `.zen-group-row-glyph`): its box, the dot's box and paint, the saved pose, the pair's channels. */
        private val GLYPH_JS = """
            (function(sel){
              var g=document.querySelector(sel);if(!g)return {present:false};
              var r=g.getBoundingClientRect();var d=g.querySelector('.zen-group-row-dot');var i=g.querySelector('.zen-group-row-icon');
              var dr=d?d.getBoundingClientRect():null;var cs=d?getComputedStyle(d):null;
              var rgb=getComputedStyle(g).getPropertyValue('--zen-group-rgb').trim();
              return {present:true,w:r.width,h:r.height,saved:g.hasAttribute('data-saved'),dot:!!d,icon:i?(i.getAttribute('data-icon')||''):'',
                dw:dr?dr.width:0,dh:dr?dr.height:0,bg:cs?cs.backgroundColor:'',shadow:cs?cs.boxShadow:'',radius:cs?cs.borderRadius:'',
                rgb:rgb?'rgb('+rgb.split(/\s+/).join(', ')+')':''};
            })
        """.trimIndent()

        /** A count (`.zen-group-row-count`): its text and type, its ink beside the name's, its fill. */
        private val COUNT_JS = """
            (function(sel){
              var c=document.querySelector(sel);if(!c)return {present:false};
              var cs=getComputedStyle(c);var head=c.closest('.zen-group-header');
              var name=head?head.querySelector('span.font-medium'):null;var ns=name?getComputedStyle(name):null;
              var alpha=function(col){var m=/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)/.exec(col);return m?parseFloat(m[1]):(/^rgb\(/.test(col)?1:-1)};
              return {present:true,text:c.textContent.trim(),size:parseFloat(cs.fontSize),numeric:cs.fontVariantNumeric,weight:cs.fontWeight,
                color:cs.color,alpha:alpha(cs.color),bg:cs.backgroundColor,nameColor:ns?ns.color:'',nameAlpha:ns?alpha(ns.color):-1};
            })
        """.trimIndent()

        /**
         * A sheet measured around the element `inner` selects: its box against the layer's, the
         * host's insets (the root's `--zen-inset-*`), the chassis header and title, the form's copy,
         * field, menulist and footer, the gap from its footer's primary (or its last row) to its
         * bottom edge, the checked radio row and where the focus is.
         */
        private val SHEET_JS = """
            (function(inner){
              var el=document.querySelector(inner);var sheet=el?el.closest('.zen-sheet'):null;if(!sheet)return null;
              var r=sheet.getBoundingClientRect();var layer=sheet.parentElement;var lr=layer?layer.getBoundingClientRect():null;
              var rs=document.documentElement.style;var ins=function(n){return parseFloat(rs.getPropertyValue('--zen-inset-'+n))||0};
              var header=sheet.querySelector('.zen-sheet-header');var title=sheet.querySelector('.zen-sheet-title');
              var copy=sheet.querySelector('.zen-phone-form-copy');var menulist=sheet.querySelector('.zen-v2-menulist');
              var footer=Array.prototype.map.call(sheet.querySelectorAll('.zen-sheet-footer button'),function(b){return b.textContent.trim()});
              var primaries=sheet.querySelectorAll('.zen-sheet-footer [data-primary]');
              var footerBtn=sheet.querySelector('.zen-sheet-footer [data-primary]')||sheet.querySelector('.zen-sheet-footer button');
              var rows=sheet.querySelectorAll('.zen-phone-row, [role="radio"]');var lastRow=rows.length?rows[rows.length-1]:null;
              var checked=sheet.querySelector('[role="radio"][aria-checked="true"]');var active=document.activeElement;
              var hund=function(v){return Math.round(v*100)/100};
              return {height:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom),width:hund(r.width),layerWidth:lr?hund(lr.width):0,
                insetTop:ins('top'),insetBottom:ins('bottom'),role:sheet.getAttribute('role')||'',tabindex:sheet.getAttribute('tabindex')||'',
                body:sheet.getAttribute('data-body')||'',headerHeight:header?hund(header.getBoundingClientRect().height):0,
                title:title?title.textContent.trim():'',copy:copy?copy.textContent.trim():'',
                copySize:copy?parseFloat(getComputedStyle(copy).fontSize):0,copyWeight:copy?getComputedStyle(copy).fontWeight:'',
                nameField:!!sheet.querySelector('.zen-phone-field input'),
                menulistText:menulist?menulist.textContent.trim():'',menulistPopup:menulist?(menulist.getAttribute('aria-haspopup')||''):'',
                footer:footer,primaries:primaries.length,primary:primaries.length?primaries[0].textContent.trim():'',
                gapFooter:footerBtn?hund(r.bottom-footerBtn.getBoundingClientRect().bottom):-1,
                rows:rows.length,gapLastRow:lastRow?hund(r.bottom-lastRow.getBoundingClientRect().bottom):-1,
                checked:checked?checked.textContent.trim():'',focusOnContainer:active===sheet,
                focusText:active&&active!==sheet&&sheet.contains(active)?active.textContent.trim():''};
            })
        """.trimIndent()
    }
}
