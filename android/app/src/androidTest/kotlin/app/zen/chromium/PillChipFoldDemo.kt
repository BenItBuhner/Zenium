package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.util.Base64
import android.util.Log
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * Records the phone pill at rest and its chips' fold (OMN-02; design language v2 §9.29 as
 * amended on Bennett's ruling) on the GitHub repository page he photographed, with real
 * touches. Driven by the `android-pill-chip-fold-demo` workflow. See [DemoHarness].
 *
 *  1. At rest on github.com the pill carries the favicon, the host and the lock, nothing else:
 *     no shield, no count, no translate chip; the blocked count and the translate offer are
 *     spoken at the pill's address stop instead. Stills of the resting pill in light and dark,
 *     the bar docked at the top and at the bottom (`rest-github-{light,dark}-{top,bottom}`).
 *  2. The host's room: the host box measured in CSS px on Bennett's five-button bar and on the
 *     default bar, at the system font size (1.0) and at 130 percent (the chrome's text follows
 *     it, #237: `ChromeTextScale` on the chrome WebView's `textZoom`, the text alone growing):
 *     the box and the host text's own width, and whether the text is cut.
 *  3. The site-information sheet's rows for the folded chips: the shield with the count as its
 *     value, the translate offer with its pair; a finger on the translate row raises the
 *     translate bar, a finger on the shield row leads to Settings › Privacy and Security.
 *  4. The glyph slot: a video playing on example.com raises the Now playing chip in the lock's
 *     slot (the lock gives way); the swap is the §11.4 cross-fade (the chrome's `animate` calls
 *     on record: 120 ms, opacity, in place); a finger on the chip opens the media sheet; a
 *     reload ends the session and the lock returns on the same fade.
 *  5. What TalkBack hears: the address stop's label carries the folded chips' states; the
 *     pill's stops (field, site icon, lock) and the sheet's rows as the tree names them, written
 *     next to the recording.
 *
 * Measurements and outcomes go to `android-chip-fold-results.json`; the claims that did not hold
 * fail the instrumentation at the end, after the stills are flushed.
 */
@RunWith(AndroidJUnit4::class)
class PillChipFoldDemo : DemoHarness("pill-chip-fold-demo-state.json", "android-chip-fold", "pill-chip-fold-demo") {
    override val tag = "PillChipFoldDemo"
    private lateinit var notes: File
    private val results = JSONObject()
    private val failures = ArrayList<String>()
    private val host: Host get() = (activity as MainActivity).host

    @Test
    fun record() {
        runDemo()
        if (failures.isNotEmpty()) throw AssertionError("claims that did not hold:\n" + failures.joinToString("\n"))
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    // --- warm-up ---------------------------------------------------------------------------------

    override fun warmUp() {
        notes = File(out, "android-chip-fold-notes.txt")
        notes.writeText("Zenium Android pill chip fold demo (v2 §9.29, OMN-02)\n\n")
        results.put("density", density.toDouble())
        results.put("window", JSONObject().put("width", width).put("height", height))
        note("window ${width}x$height density $density (${(width / density).roundToInt()} dp wide)")

        // GitHub's repository page is heavy on the emulator: let it land before anything is read.
        val landed = awaitTab(GITHUB_TAB, 90_000) { tab -> !tab.optBoolean("loading") && tab.optString("url").startsWith("https://github.com/") }
        note("github.com: ${if (landed) "landed" else "still loading after 90 s"}; ${describeTab(GITHUB_TAB)}")

        // The blocking engine: the bundled snapshot installs after boot; the count on the page
        // only means something once every enabled list has its filters (the blocking UI demo's wait).
        val deadline = SystemClock.uptimeMillis() + 150_000
        var status = blockingStatus()
        var lastReport = 0L
        while (SystemClock.uptimeMillis() < deadline && !(status.optBoolean("ready") && enabledListsHaveFilters(status))) {
            if (SystemClock.uptimeMillis() - lastReport > 10_000) {
                lastReport = SystemClock.uptimeMillis()
                note("waiting for the filter lists: ${describeLists(status)}")
            }
            SystemClock.sleep(1_000)
            status = blockingStatus()
        }
        note("blocking ready=${status.optBoolean("ready")} enabled=${status.optBoolean("enabled")} level=${level()}; ${describeLists(status)}")
        // The page once more with the lists in force, so the count is the page's own.
        coreInvoke("tab.reload", """{"tabId":"$GITHUB_TAB","skipCache":true}""")
        SystemClock.sleep(2_000)
        awaitTab(GITHUB_TAB, 90_000) { tab -> !tab.optBoolean("loading") }
        SystemClock.sleep(3_000)
        note("github.com after the reload: ${describeTab(GITHUB_TAB)}")

        // The translate offer for the sheet's row and the address stop: an explicit offer (the
        // page is English, as the UI is, so the pair is retargeted to German for a pair the row
        // can show), then the bar put away – the offer stands, the pill carries no chip for it.
        val offered = runCatching {
            coreInvoke("translate.offer", """{"tabId":"$GITHUB_TAB"}""")
            coreInvoke("translate.retarget", """{"tabId":"$GITHUB_TAB","target":"de"}""")
            coreInvoke("translate.dismiss", """{"tabId":"$GITHUB_TAB"}""")
            true
        }.getOrElse { e ->
            note("translate.offer did not take: ${e.message}")
            false
        }
        SystemClock.sleep(800)
        note("translate: offered=$offered state=${translateState(GITHUB_TAB)}")

        // Off camera: the Settings chunk (the shield row leads there), and example.com's page (the
        // video plays there), so neither is paid for on the recording.
        val warm = coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        val painted = awaitChrome("document.querySelector('[data-row=\"tracking-enabled\"]')", 15_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(600)
        coreInvoke("tab.activate", """{"tabId":"$EXAMPLE_TAB"}""")
        awaitTab(EXAMPLE_TAB, 30_000) { tab -> !tab.optBoolean("loading") }
        SystemClock.sleep(1_500)
        coreInvoke("tab.activate", """{"tabId":"$GITHUB_TAB"}""")
        SystemClock.sleep(2_000)
        note("warm-up: the Settings chunk ${if (painted) "painted" else "did NOT paint"}; example.com ${describeTab(EXAMPLE_TAB)}")

        installFadeHook()
        val close = closeUrlField()
        if (!close.ok) note("warm-up: ${close.describe()}")
        ensureForeground()
        SystemClock.sleep(1_500)
        Log.i(tag, "warm-up done")
    }

    // --- the sequence ----------------------------------------------------------------------------

    override fun demo() {
        try {
            restStep()
            hostRoomStep()
            stillsStep()
            sheetStep()
            glyphSlotStep()
            talkBackStep()
        } finally {
            File(out, "android-chip-fold-results.json").writeText(results.toString(2) + "\n")
            File(out, "android-chip-fold-verdict.txt").writeText(
                if (failures.isEmpty()) "OK\n" else failures.joinToString("\n", postfix = "\n")
            )
        }
        note("\ndone")
    }

    /** 1. The pill at rest on github.com: favicon, host, lock; the count and the offer at the address stop. */
    private fun restStep() {
        note("\n1. the pill at rest on github.com (bar ${barPosition()}, $THEME)")
        ensureForeground()
        val pill = readPill()
        val chips = pill.optJSONArray("chips").toStringList()
        val buttons = pill.optJSONArray("buttons").toStringList()
        note("  chips drawn after the address: $chips")
        note("  buttons in the pill: $buttons")
        note("  address stop (tree): ${addressSpoken() ?: "(not in the accessibility tree)"}")
        note("  address label (chrome): ${pill.optString("address")}")
        note("  ${describeTab(GITHUB_TAB)}")
        claim("the pill draws the lock and nothing else after the address", chips == listOf("lock"), "drew $chips")
        claim("no translate chip in the pill", !pill.optBoolean("translateChip"), "a [data-translate] stands in the pill")
        claim("no shield or count in the pill", buttons.none { it.startsWith("Requests blocked") || it.contains("blocked") }, "buttons $buttons")
        claim(
            "the pill's buttons are the address, the site icon and the lock",
            buttons.size == 3 && buttons[0].startsWith("Address,") && SITE_ICON_LABEL in buttons && LOCK_LABEL in buttons,
            "buttons $buttons"
        )
        val spoken = addressSpoken().orEmpty()
        val blocked = tab(GITHUB_TAB)?.optInt("blockedCount") ?: 0
        if (blocked > 0) claim("the address stop speaks the blocked count", spoken.contains("blocked"), "reads '$spoken' with $blocked blocked")
        else note("  (nothing blocked on the page yet; the address stop has no count to speak)")
        if (translateState(GITHUB_TAB)?.optString("status") == "offered") {
            claim("the address stop speaks the translate offer", spoken.contains("Translation offered"), "reads '$spoken'")
        }
        results.put("rest", pill)
        results.put("restAddressSpoken", spoken)
        results.put("restBlockedCount", blocked)
        SystemClock.sleep(1_000)
        shot("rest-github-$THEME-${barPosition()}")
        beat()
    }

    /**
     * 2. The host's room (v2 §9.29: "412 − the bar's buttons − favicon − one chip leaves it about
     * 200 px, and no chip may take that below 150"): the host box in CSS px on Bennett's
     * five-button bar and on the default bar, at the system font size and at 130 percent (the
     * chrome's text following it, #237).
     */
    private fun hostRoomStep() {
        note("\n2. the host's room")
        val room = JSONObject()
        fun measure(name: String, describe: String) {
            SystemClock.sleep(900)
            val pill = readPill()
            val entry = JSONObject()
                .put("hostBox", pill.optDouble("hostBox"))
                .put("textWidth", pill.optDouble("textWidth"))
                .put("truncated", pill.optBoolean("truncated"))
                .put("pillWidth", pill.optDouble("pillWidth"))
                .put("fontSize", pill.optString("fontSize"))
                .put("textZoom", chromeTextZoom())
                .put("textZoomHeard", textZoomHeard())
                .put("fontScale", fontScaleHeard())
                .put("bar", pill.optJSONArray("bar"))
            room.put(name, entry)
            note("  $describe: host box ${fmt(entry.getDouble("hostBox"))} px, text ${fmt(entry.getDouble("textWidth"))} px (${pill.optString("hostText")}), " +
                "${if (entry.getBoolean("truncated")) "CUT" else "not cut"}, pill ${fmt(entry.getDouble("pillWidth"))} px, font ${entry.getString("fontSize")}, textZoom ${entry.getInt("textZoom")} (heard ${entry.getDouble("textZoomHeard")}), fontScale ${entry.getDouble("fontScale")}")
        }
        // (a) The system font size 1.0.
        measure("bennett-1.0", "Bennett's five-button bar, font scale 1.0")
        setPhoneBar(DEFAULT_BAR)
        measure("default-1.0", "the default bar, font scale 1.0")
        setPhoneBar(BENNETT_BAR)

        // (b) The system font size at 130 percent: the chrome's text follows it on its own
        //     (#237: `MainActivity.onConfigurationChanged` puts `ChromeTextScale`'s percent on
        //     the chrome WebView's `textZoom` and says so in `environment.textZoom`; the text
        //     alone grows, the boxes and glyphs hold), so the host box is read as it is.
        shell("settings put system font_scale 1.3")
        val followed = poll(15_000) { chromeTextZoom() >= 125 && textZoomHeard() > 1.2 }
        note("  system font size 130 percent: textZoom ${chromeTextZoom()} on the chrome, the chrome heard textZoom ${textZoomHeard()} fontScale ${fontScaleHeard()}${if (followed) "" else " (not within 15 s)"}")
        claim("the chrome's text follows the system font size (#237)", followed, "textZoom ${chromeTextZoom()}, heard ${textZoomHeard()}")
        measure("bennett-1.3", "Bennett's bar, system font scale 1.3")
        shot("fontscale-130-$THEME-${barPosition()}")
        setPhoneBar(DEFAULT_BAR)
        measure("default-1.3", "the default bar, system font scale 1.3")
        setPhoneBar(BENNETT_BAR)
        shell("settings put system font_scale 1.0")
        poll(15_000) { chromeTextZoom() == 100 && textZoomHeard() < 1.05 }
        SystemClock.sleep(1_000)
        results.put("hostRoom", room)

        // The claims: the rule's 150 on the default bar at either size; the text never cut.
        for (name in listOf("default-1.0", "default-1.3")) {
            val entry = room.getJSONObject(name)
            claim("host box >= 150 px on the default bar ($name)", entry.getDouble("hostBox") >= 150, "${fmt(entry.getDouble("hostBox"))} px")
        }
        for (name in listOf("bennett-1.0", "default-1.0", "bennett-1.3", "default-1.3")) {
            val entry = room.getJSONObject(name)
            claim("the host text is not cut ($name)", !entry.getBoolean("truncated"), "text ${fmt(entry.getDouble("textWidth"))} px in a ${fmt(entry.getDouble("hostBox"))} px box")
        }
        beat()
    }

    /** `environment.textZoom` as the chrome heard it (1 when the host said nothing). */
    private fun textZoomHeard(): Double = coreState().optJSONObject("pageEnvironment")?.optDouble("textZoom", 1.0) ?: 1.0

    private fun fontScaleHeard(): Double = coreState().optJSONObject("pageEnvironment")?.optDouble("fontScale", 1.0) ?: 1.0

    /** 3. The resting pill in the other scheme and at the other dock: the four stills for Bennett. */
    private fun stillsStep() {
        note("\n3. the resting pill: both schemes, both docks")
        val other = if (THEME == "dark") "light" else "dark"
        setScheme(other)
        shot("rest-github-$other-top")
        note("  still: $other, top")
        setBarPosition("bottom")
        shot("rest-github-$other-bottom")
        note("  still: $other, bottom")
        setScheme(THEME)
        shot("rest-github-$THEME-bottom")
        note("  still: $THEME, bottom")
        val bottom = readPill()
        results.put("restBottom", bottom)
        claim("the pill at the bottom dock draws the lock alone too", bottom.optJSONArray("chips").toStringList() == listOf("lock"), "drew ${bottom.optJSONArray("chips")}")
        setBarPosition("top")
        beat()
    }

    /**
     * 4. The site-information sheet: the shield's row with the count, the translate row with its
     * pair, both under a finger – the translate row raises the bar, the shield row leads to
     * Settings › Privacy and Security.
     */
    private fun sheetStep() {
        note("\n4. the site-information sheet's rows")
        ensureForeground()
        if (!openSiteInfo()) {
            claim("the site icon opens the site-information sheet", false, "no sheet came up")
            return
        }
        val rows = sheetRows()
        note("  rows for the folded chips (chrome): $rows")
        note("  rows as the tree names them: ${rows.map { treeLabel(it) ?: "(not in the tree)" }}")
        results.put("sheetRows", JSONArray(rows))
        val blocked = tab(GITHUB_TAB)?.optInt("blockedCount") ?: 0
        val shield = rows.firstOrNull { it.startsWith("Requests blocked") }
        claim("the shield row is in the sheet", shield != null, "rows $rows")
        if (shield != null && blocked > 0) {
            claim("the shield row carries the count", shield == "Requests blocked, $blocked" || shield.endsWith(", $blocked") || shield.contains("$blocked"), "row '$shield' for $blocked blocked")
        }
        val translate = rows.firstOrNull { it.startsWith("Translate this page") }
        if (translateState(GITHUB_TAB) != null) {
            claim("the translate row is in the sheet with its pair", translate != null && translate.contains(","), "rows $rows")
        }
        SystemClock.sleep(1_200)
        shot("sheet-rows")
        beat()

        // The translate row: the sheet leaves and the translate bar comes up for the offer.
        if (translate != null) {
            val took = touchTapLabelExpecting(translate, "the translate bar is up (the offer no longer dismissed)", timeoutMs = 8_000) {
                translateState(GITHUB_TAB)?.let { !it.optBoolean("dismissed") } == true
            }
            results.put("translateRowRaisesBar", took)
            if (took) {
                awaitSurface(up = false, timeoutMs = 6_000)
                SystemClock.sleep(1_500)
                note("  translate row: bar up, state ${translateState(GITHUB_TAB)}")
                shot("translate-row-bar")
                beat()
                coreInvoke("translate.dismiss", """{"tabId":"$GITHUB_TAB"}""")
                SystemClock.sleep(1_000)
            } else {
                closeSheets()
            }
        } else {
            note("  (no translate row to touch)")
            closeSheets()
        }

        // The shield row: the sheet leaves and the Settings tab stands at Privacy and Security.
        if (shield != null && openSiteInfo()) {
            val took = touchTapLabelExpecting(shield, "the Settings tab is at Privacy and Security", timeoutMs = 10_000, prefix = true) {
                activeCoreTab()?.optString("url") == "$SETTINGS_URL/privacy"
            }
            results.put("shieldRowOpensPrivacy", took)
            if (took) {
                awaitSurface(up = true, timeoutMs = 6_000)
                SystemClock.sleep(1_500)
                note("  shield row: ${activeCoreTab()?.optString("url")}")
                // The per-site OFF switch (PS-03 / PS-33) lives in the surface the row opens: the
                // Settings tab remembers the page it came from and lists "Block on github.com"
                // under Sites without blocking, the count's meaning in its description.
                val switchRow = awaitChrome("document.querySelector('[data-row=\"tracking-site-current\"]')", 8_000)
                val switchText = chromeValue("(function(){var r=document.querySelector('[data-row=\"tracking-site-current\"]');return r?r.textContent:''})()")
                claim("the opened Settings page carries the per-site switch for github.com", switchRow && switchText.contains("github.com"), "row ${if (switchRow) "'$switchText'" else "absent"}")
                results.put("perSiteSwitchRow", switchText)
                note("  per-site switch row: ${if (switchRow) "'$switchText'" else "absent"}")
                shot("shield-row-privacy")
                beat()
                activeCoreTab()?.optString("id")?.takeIf { it != GITHUB_TAB && it != EXAMPLE_TAB }?.let {
                    coreInvoke("tab.close", """{"tabId":"$it"}""")
                }
                SystemClock.sleep(800)
            } else {
                closeSheets()
            }
        }
        coreInvoke("tab.activate", """{"tabId":"$GITHUB_TAB"}""")
        SystemClock.sleep(1_500)
        // The media row: listed only while a newer state holds the slot. The phone has one state
        // chip today (the save-password key is the desktop's), so the row is the unit tests'; the
        // chip's own tap below runs the same action.
        note("  (the media row is listed only behind a newer state; one state chip on the phone: covered by the unit tests, the chip's tap below runs the same action)")
    }

    /**
     * 5. The glyph slot: a playing video on example.com raises the Now playing chip where the lock
     * stood, on the §11.4 cross-fade; a finger on the chip opens the media sheet; a reload ends
     * the session and the lock returns on the same fade.
     */
    private fun glyphSlotStep() {
        note("\n5. the glyph slot: the lock gives way to a playing video and returns")
        coreInvoke("tab.activate", """{"tabId":"$EXAMPLE_TAB"}""")
        awaitTab(EXAMPLE_TAB, 20_000) { tab -> !tab.optBoolean("loading") }
        SystemClock.sleep(2_000)
        val before = readPill()
        note("  example.com at rest: chips ${before.optJSONArray("chips")}, address '${before.optString("address")}'")
        claim("example.com's pill draws the lock", before.optJSONArray("chips").toStringList() == listOf("lock"), "drew ${before.optJSONArray("chips")}")

        // A video (the media demo's clip, an audio track in it) and a big button that plays it: a
        // finger is a user gesture, which `mediaPlaybackRequiresUserGesture` asks for.
        val clip = Base64.encodeToString(readAssetBytes("media-demo-clip.webm"), Base64.NO_WRAP)
        val injected = pageJs(EXAMPLE_TAB, INJECT_VIDEO_JS.replace("__CLIP__", clip))
        note("  video injected into example.com: $injected")
        clearFades()
        val played = tapPageButton(EXAMPLE_TAB, "zen-demo-play", "the media session reports the video playing", 20_000) {
            mediaState(EXAMPLE_TAB)?.optBoolean("playing") == true
        }
        results.put("videoPlays", played)
        val swapped = poll(10_000) { readPill().optJSONArray("chips").toStringList() == listOf("media") }
        val during = readPill()
        note("  while playing: chips ${during.optJSONArray("chips")}, buttons ${during.optJSONArray("buttons")}, address '${during.optString("address")}'")
        claim("the Now playing chip takes the lock's slot (the lock gives way)", swapped, "drew ${during.optJSONArray("chips")}")
        claim("the lock is not in the tree while the state is live", awaitNode(3_000) { it == LOCK_LABEL } == null, "the tree still lists '$LOCK_LABEL'")
        val chipNode = awaitNode(8_000) { it == CHIP_PLAYING }
        claim("the Now playing chip is in the tree", chipNode != null, "no node reads '$CHIP_PLAYING'")
        SystemClock.sleep(600)
        val fadesIn = fades()
        results.put("fadesLockToMedia", fadesIn)
        note("  the chrome's animate calls on the swap: $fadesIn")
        checkFade(fadesIn, leaving = "lucide-lock", arriving = "media", what = "lock -> Now playing")
        SystemClock.sleep(800)
        shot("media-takes-slot")
        beat()

        // A finger on the chip: the media sheet (the host's word on a surface up).
        if (chipNode != null) {
            val took = touchTapLabelExpecting(CHIP_PLAYING, "the media sheet is up", timeoutMs = 10_000) { chromeSurfaceUp() }
            results.put("mediaChipOpensSheet", took)
            if (took) {
                SystemClock.sleep(1_500)
                note("  media sheet: title '${findNode { it == "Zenium demo clip" }?.let { "shown" } ?: "not in the tree"}'")
                shot("media-sheet")
                beat()
                back()
                awaitSurface(up = false, timeoutMs = 8_000)
                SystemClock.sleep(800)
            }
        }

        // The session ends with the page: the lock returns on the same fade.
        clearFades()
        coreInvoke("tab.reload", """{"tabId":"$EXAMPLE_TAB"}""")
        val returned = poll(15_000) { readPill().optJSONArray("chips").toStringList() == listOf("lock") }
        val after = readPill()
        note("  after the reload: chips ${after.optJSONArray("chips")}, address '${after.optString("address")}', media state ${mediaState(EXAMPLE_TAB)}")
        claim("the lock returns when the state ends", returned, "drew ${after.optJSONArray("chips")}")
        SystemClock.sleep(600)
        val fadesOut = fades()
        results.put("fadesMediaToLock", fadesOut)
        note("  the chrome's animate calls on the return: $fadesOut")
        checkFade(fadesOut, leaving = "lucide-audio-lines", arriving = "lock", what = "Now playing -> lock")
        SystemClock.sleep(800)
        shot("lock-returns")
        beat()
        coreInvoke("tab.activate", """{"tabId":"$GITHUB_TAB"}""")
        SystemClock.sleep(1_500)
    }

    /** 6. What TalkBack hears: the address stop with the folded states, the pill's stops, the sheet's rows. */
    private fun talkBackStep() {
        note("\n6. TalkBack: the address stop speaks the folded states")
        ensureForeground()
        // The pill is no stop of its own (#237 took the group's name off it): its subtree is the
        // first ancestor of the address button that also holds the site icon.
        val group = pillNode()
        val stops = group?.let { speakable(it).map { n -> label(n) } } ?: emptyList()
        val address = addressSpoken()
        note("  address stop: ${address ?: "(not in the tree)"}")
        note("  the pill's stops in TalkBack's order: $stops")
        claim("the pill has three stops: the address, the site icon, the lock", stops.size == 3 && stops[0].startsWith("Address,") && SITE_ICON_LABEL in stops && LOCK_LABEL in stops, "stops $stops")
        val blocked = tab(GITHUB_TAB)?.optInt("blockedCount") ?: 0
        // #237's connection state first, then the sheet chips' states in the pill's order.
        val expected = buildList {
            add(LOCK_LABEL)
            if (blocked > 0) add("$blocked request${if (blocked == 1) "" else "s"} blocked")
            if (translateState(GITHUB_TAB)?.optString("status") == "offered") add("Translation offered")
        }
        for (part in expected) claim("the address stop speaks '$part'", address?.contains(part) == true, "reads '$address'")
        claim(
            "the address stop's order: the host, the connection, then the sheet chips' states",
            address != null && expected.map { address.indexOf(it) }.let { at -> at.all { it >= 0 } && at == at.sorted() },
            "reads '$address'"
        )
        results.put("talkBack", JSONObject().put("address", address).put("stops", JSONArray(stops)).put("expectedStates", JSONArray(expected)))
        File(out, "android-chip-fold-a11y.txt").writeText(
            buildString {
                appendLine("# The phone pill as the accessibility tree names it (github.com, v2 §9.29)")
                appendLine("address stop: $address")
                appendLine("stops in order: $stops")
                appendLine("sheet rows: ${results.optJSONArray("sheetRows")}")
                appendLine()
                group?.let { visit(it, 0, this) }
            }
        )
        shot("talkback-address")
        beat()
    }

    // --- the pill and the sheet, through the chrome's document ------------------------------------

    /**
     * The pill as the chrome's document has it: the chips drawn after the address (`data-chip`
     * ids in the run), the buttons' labels, the address's label, the host box and the host
     * text's own width in CSS px, whether the text is cut, and the bar's buttons.
     */
    private fun readPill(): JSONObject {
        val raw = chromeJs(READ_PILL_JS)
        val text = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String) ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
    }

    /** The sheet's rows for the folded chips, by their accessible names ("Requests blocked, 5"). */
    private fun sheetRows(): List<String> {
        val raw = chromeJs(
            "JSON.stringify(Array.from(document.querySelectorAll('[data-testid=\"siteinfo-pill-chips\"] button'))" +
                ".map(function(b){return b.getAttribute('aria-label')||b.textContent.trim()}))"
        )
        val text = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String) ?: return emptyList()
        return runCatching { JSONArray(text) }.getOrNull().toStringList()
    }

    /**
     * A finger on the pill's site icon, then the sheet up: the host's word on a surface and the
     * rows' group in the chrome's document. False when no sheet came within the time.
     */
    private fun openSiteInfo(): Boolean {
        val icon = awaitNode(8_000) { it == SITE_ICON_LABEL }
        if (icon == null) {
            note("  (site icon not in the accessibility tree)")
            return false
        }
        if (!touchTap(icon)) return false
        val up = poll(10_000) { chromeSurfaceUp() && awaitChrome("document.querySelector('[data-testid=\"siteinfo-pill-chips\"]')", 500) }
        if (!up) touchFault("a finger on '$SITE_ICON_LABEL' did not bring the site-information sheet up")
        SystemClock.sleep(1_500)
        return up
    }

    /** Back while the chrome reports a surface, so nothing of a step's is left over the page. */
    private fun closeSheets() {
        var count = 0
        while (chromeSurfaceUp() && count < 4) {
            back()
            count++
            SystemClock.sleep(900)
        }
    }

    /** The address stop as TalkBack reads it: the host, then the states of the chips the sheet carries. */
    private fun addressSpoken(): String? =
        findNode { it.startsWith("Address,") }?.let { it.contentDescription ?: it.text }?.toString()

    /**
     * The pill's node in the tree: the nearest ancestor of the address button whose subtree also
     * holds the site icon (the pill carries no role or name of its own since #237, so it is
     * found by what it contains; the bar's own buttons are its siblings, not inside it).
     */
    private fun pillNode(): AccessibilityNodeInfo? {
        var node = findNode { it.startsWith("Address,") } ?: return null
        while (true) {
            if (subtreeHas(node) { it == SITE_ICON_LABEL }) return node
            node = node.parent ?: return null
        }
    }

    private fun subtreeHas(root: AccessibilityNodeInfo, matches: (String) -> Boolean): Boolean {
        if (matches(label(root))) return true
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            if (subtreeHas(child, matches)) return true
        }
        return false
    }

    /** The accessible name the tree gives a sheet row named `label` in the chrome, or null. */
    private fun treeLabel(label: String): String? = findNode { it == label }?.let { label(it) }

    // --- the cross-fade on record ----------------------------------------------------------------

    /**
     * Put the chrome's `Element.prototype.animate` calls inside the pill on record: the chip run
     * cross-fades a set change through it (`ChipRun`, 120 ms on opacity, the ghost copy of the
     * chip that leaves fading out, the chip that arrives fading in). Each call: the duration and
     * easing asked for, the opacity's from and to, whether the target is a ghost copy, the chip
     * it belongs to (`data-chip` on the live run) and the glyph inside it (`lucide-lock`,
     * `lucide-audio-lines`), since the ghost's copies are inert spans without a label.
     */
    private fun installFadeHook() {
        chromeJs(FADE_HOOK_JS)
    }

    private fun clearFades() {
        chromeJs("window.__demoFades=[]")
    }

    private fun fades(): JSONArray {
        val raw = chromeJs("JSON.stringify(window.__demoFades||[])")
        val text = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String) ?: return JSONArray()
        return runCatching { JSONArray(text) }.getOrElse { JSONArray() }
    }

    /** The swap's fades: one out on the leaving chip's ghost copy, one in on the arriving chip, both 120 ms on opacity. */
    private fun checkFade(fades: JSONArray, leaving: String, arriving: String, what: String) {
        val entries = (0 until fades.length()).map { fades.getJSONObject(it) }
        val out = entries.firstOrNull { it.optBoolean("ghost") && it.optString("icon").contains(leaving) && it.optDouble("to") == 0.0 }
        val inn = entries.firstOrNull { !it.optBoolean("ghost") && it.optString("chip") == arriving && it.optDouble("from") == 0.0 }
        claim("$what: the leaving chip's ghost copy fades out", out != null, "no fade to 0 on a ghost $leaving among $fades")
        claim("$what: the arriving chip fades in", inn != null, "no fade from 0 on the $arriving chip among $fades")
        for (fade in listOfNotNull(out, inn)) {
            claim("$what: the fade runs ${FADE_MS} ms (v2 §11.4)", fade.optDouble("duration") == FADE_MS.toDouble(), "duration ${fade.opt("duration")}")
            claim("$what: the fade is on opacity alone", fade.optBoolean("opacityOnly"), "keyframes ${fade.opt("props")}")
        }
    }

    // --- the settings the steps switch -----------------------------------------------------------

    private fun setScheme(scheme: String) {
        coreInvoke("settings.update", """{"colorScheme":"$scheme"}""")
        // The theme blends over 240 ms (v2 §11.6); the emulator's software GPU takes its time.
        SystemClock.sleep(2_500)
    }

    private fun setBarPosition(position: String) {
        coreInvoke("settings.update", """{"phoneBarPosition":"$position"}""")
        SystemClock.sleep(2_500)
    }

    private fun barPosition(): String = coreState().getJSONObject("settings").optString("phoneBarPosition", "bottom")

    private fun setPhoneBar(layout: String) {
        coreInvoke("settings.update", """{"phoneBar":$layout}""")
        SystemClock.sleep(1_200)
    }

    /** `WebSettings.textZoom` on the chrome: what #237's `ChromeTextScale` set from the system font size. */
    private fun chromeTextZoom(): Int {
        var zoom = 0
        instrumentation.runOnMainSync { zoom = host.chrome.settings.textZoom }
        return zoom
    }

    // --- the page --------------------------------------------------------------------------------

    /** Evaluate in a tab's page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(tabId: String, code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the page's element `id` is on screen (its CSS box scaled to the view, offset by the view), or null. */
    private fun pageElementRect(tabId: String, id: String): Rect? {
        val raw = pageJs(tabId, "(function(){var e=document.getElementById(${JSONObject.quote(id)});if(!e)return null;var r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()")
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        var origin: IntArray? = null
        var scale = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            origin = IntArray(2).also { view.getLocationOnScreen(it) }
            @Suppress("DEPRECATION")
            scale = view.scale
        }
        val at = origin ?: return null
        if (scale <= 0f) scale = density
        return Rect(
            (at[0] + json.getDouble("x") * scale).toInt(),
            (at[1] + json.getDouble("y") * scale).toInt(),
            (at[0] + (json.getDouble("x") + json.getDouble("w")) * scale).toInt(),
            (at[1] + (json.getDouble("y") + json.getDouble("h")) * scale).toInt()
        )
    }

    /** A real finger on the page's element `id`, then up to `timeoutMs` for `took` (the step's claim, named by `effect`). */
    private fun tapPageButton(tabId: String, id: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        val rect = pageElementRect(tabId, id) ?: run {
            note("  the page has no element '$id' to touch")
            return false
        }
        val point = touchPoint(rect) ?: run {
            note("  '$id' at $rect has no part inside the touchable window")
            return false
        }
        Finger().tap(point.x, point.y)
        if (poll(timeoutMs, took)) {
            note("  finger on the page's '$id' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on the page's '$id' did not take: not $effect within $timeoutMs ms")
        return false
    }

    // --- the core ----------------------------------------------------------------------------------

    private fun tab(tabId: String): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(tabId)

    private fun describeTab(tabId: String): String {
        val t = tab(tabId) ?: return "$tabId gone"
        return "url=${t.optString("url")} title=\"${t.optString("title")}\" loading=${t.optBoolean("loading")} blockedCount=${t.optInt("blockedCount")}"
    }

    private fun awaitTab(tabId: String, timeoutMs: Long, accept: (JSONObject) -> Boolean): Boolean =
        poll(timeoutMs) { tab(tabId)?.let(accept) == true }

    private fun blockingStatus(): JSONObject = coreState().optJSONObject("blocking") ?: JSONObject()

    private fun level(): String = coreState().getJSONObject("settings").optJSONObject("blocking")?.optString("level").orEmpty()

    private fun translateState(tabId: String): JSONObject? =
        coreState().optJSONObject("translate")?.optJSONObject("tabs")?.optJSONObject(tabId)

    /** The core's media entry for the tab (`UIState.media`), or null. */
    private fun mediaState(tabId: String): JSONObject? {
        val media = coreState().optJSONArray("media") ?: return null
        for (i in 0 until media.length()) {
            val entry = media.getJSONObject(i)
            if (entry.optString("tabId") == tabId) return entry
        }
        return null
    }

    private fun enabledListsHaveFilters(status: JSONObject): Boolean {
        val lists = status.optJSONArray("lists") ?: return false
        var enabled = 0
        for (i in 0 until lists.length()) {
            val l = lists.getJSONObject(i)
            if (!l.optBoolean("enabled")) continue
            enabled++
            if (l.optInt("filterCount") == 0) return false
        }
        return enabled > 0
    }

    private fun describeLists(status: JSONObject): String {
        val lists = status.optJSONArray("lists") ?: return "no lists"
        return (0 until lists.length()).joinToString(", ") {
            val l = lists.getJSONObject(it)
            "${l.optString("id")}(${if (l.optBoolean("enabled")) "on" else "off"}, ${l.optInt("filterCount")} filters)"
        }
    }

    // --- the chrome's bridge -----------------------------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    // --- the tree ------------------------------------------------------------------------------------

    private fun label(node: AccessibilityNodeInfo): String =
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() } ?: node.text?.toString().orEmpty()

    /** The nodes TalkBack stops at inside `root`, in its linear order: the clickable ones with a label. */
    private fun speakable(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val found = ArrayList<AccessibilityNodeInfo>()
        fun visit(node: AccessibilityNodeInfo) {
            if (node !== root && node.isClickable && label(node).isNotBlank()) {
                found += node
                return
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
        }
        visit(root)
        return found
    }

    private fun visit(node: AccessibilityNodeInfo, depth: Int, into: StringBuilder) {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        into.appendLine("  ".repeat(depth) + "${node.className} label=\"${node.contentDescription}\" text=\"${node.text}\" clickable=${node.isClickable} bounds=${bounds.toShortString()}")
        for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1, into) }
    }

    // --- bookkeeping ---------------------------------------------------------------------------------

    private fun claim(what: String, held: Boolean, detail: String) {
        if (held) {
            note("  OK: $what")
        } else {
            note("  FAIL: $what ($detail)")
            failures += "$what ($detail)"
        }
    }

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    private fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        FileInputStream(fd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { fd.close() }
    }.getOrElse { "shell failed: $it" }

    private fun readAssetBytes(name: String): ByteArray =
        instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun JSONArray?.toStringList(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { optString(it) }

    private fun fmt(value: Double): String = "%.1f".format(value)

    private companion object {
        const val GITHUB_TAB = "tab_github"
        const val EXAMPLE_TAB = "tab_example"
        const val SITE_ICON_LABEL = "Site information"
        const val LOCK_LABEL = "Connection is secure"
        const val CHIP_PLAYING = "Now playing"
        const val SETTINGS_URL = "zen://settings"
        /** `CHIP_FOLD_FADE_MS` (components/phone/pillChips.tsx). */
        const val FADE_MS = 120
        /** Bennett's bar in his photograph, and the seed's. */
        const val BENNETT_BAR = """{"left":["back","reload","forward"],"right":["new-tab","menu"]}"""
        /** `DEFAULT_PHONE_BAR` (shared/phoneBar.ts). */
        const val DEFAULT_BAR = """{"left":["back"],"right":["new-tab","tabs","menu"]}"""
        val THEME: String = InstrumentationRegistry.getArguments().getString("theme").let { if (it == "dark") "dark" else "light" }

        /** The pill as the chrome's document has it (see [readPill]); the widths in CSS px. */
        val READ_PILL_JS = """
            (function () {
              var pill = document.querySelector('.zen-phone-pill:not(.zen-pill-ghost)');
              var host = pill && pill.querySelector('[data-testid="pill-host"]');
              var address = pill && pill.querySelector('[data-testid="pill-address"]');
              var run = pill && pill.querySelector('[data-testid="pill-chips"]');
              var box = host ? host.getBoundingClientRect() : null;
              var textWidth = 0;
              if (host) { var range = document.createRange(); range.selectNodeContents(host); textWidth = range.getBoundingClientRect().width; }
              var bar = Array.from(document.querySelectorAll('.zen-phone-bar-row > button')).map(function (b) { return b.getAttribute('aria-label'); });
              return JSON.stringify({
                pillWidth: pill ? Math.round(pill.getBoundingClientRect().width * 10) / 10 : null,
                hostBox: box ? Math.round(box.width * 10) / 10 : null,
                hostText: host ? host.textContent : null,
                textWidth: Math.round(textWidth * 10) / 10,
                truncated: host ? host.scrollWidth > host.clientWidth + 0.5 : null,
                fontSize: host ? getComputedStyle(host).fontSize : null,
                chips: run ? Array.from(run.querySelectorAll(':scope > [data-chip]')).map(function (c) { return c.dataset.chip; }) : [],
                buttons: pill ? Array.from(pill.querySelectorAll('button')).map(function (b) { return b.getAttribute('aria-label'); }) : [],
                translateChip: !!(pill && pill.querySelector('[data-translate]')),
                address: address ? address.getAttribute('aria-label') : null,
                bar: bar,
                dpr: window.devicePixelRatio
              });
            })()
        """.trimIndent()

        /** The chrome's `animate` calls inside the pill on record (see [installFadeHook]). */
        val FADE_HOOK_JS = """
            (function () {
              if (window.__demoFadeHook) return 'hooked already';
              window.__demoFades = [];
              var native = Element.prototype.animate;
              window.__demoFadeHook = native;
              Element.prototype.animate = function (keyframes, options) {
                try {
                  var el = this;
                  if (el.closest && el.closest('.zen-phone-pill')) {
                    var frames = Array.isArray(keyframes) ? keyframes : (keyframes ? [keyframes] : []);
                    var props = {};
                    frames.forEach(function (f) { Object.keys(f || {}).forEach(function (k) { if (k !== 'offset' && k !== 'easing' && k !== 'composite') props[k] = true; }); });
                    var svg = el.querySelector ? (el.querySelector('svg') || (el.tagName === 'svg' ? el : null)) : null;
                    var wrap = el.closest('[data-chip]');
                    var icon = svg ? (svg.getAttribute('class') || '').split(/\s+/).filter(function (c) { return c.indexOf('lucide-') === 0; }).join(' ') : '';
                    window.__demoFades.push({
                      t: Math.round(performance.now()),
                      duration: options && typeof options === 'object' ? options.duration : options,
                      easing: options && typeof options === 'object' ? options.easing : null,
                      from: frames.length ? frames[0].opacity : null,
                      to: frames.length ? frames[frames.length - 1].opacity : null,
                      props: Object.keys(props),
                      opacityOnly: Object.keys(props).length === 1 && props.opacity === true,
                      ghost: !!el.closest('.zen-pill-run-ghost'),
                      chip: wrap ? wrap.dataset.chip : null,
                      icon: icon,
                      label: el.getAttribute('aria-label')
                    });
                  }
                } catch (e) {}
                return native.apply(this, arguments);
              };
              return 'hooked';
            })()
        """.trimIndent()

        /**
         * A looping video (the media demo's WebM clip as a data URL: example.com is https, so a
         * loopback http source would be mixed content) with Media Session metadata, and a big
         * button at the top of the page that plays it under a finger.
         */
        val INJECT_VIDEO_JS = """
            (function () {
              if (document.getElementById('zen-demo-play')) return 'already there';
              var video = document.createElement('video');
              video.id = 'zen-demo-video';
              video.src = 'data:video/webm;base64,__CLIP__';
              video.loop = true;
              video.setAttribute('playsinline', '');
              video.preload = 'auto';
              video.style.cssText = 'display:block;width:100%;background:#000;aspect-ratio:16/9;margin:0 0 12px';
              var button = document.createElement('button');
              button.id = 'zen-demo-play';
              button.textContent = 'Play video';
              button.style.cssText = 'display:block;width:100%;height:96px;font:600 22px system-ui,sans-serif;background:#1d4ed8;color:#fff;border:0;border-radius:12px;margin:0 0 12px';
              button.addEventListener('click', function () {
                try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'Zenium demo clip', artist: 'Zenium' }); } catch (e) {}
                video.play().then(function () { button.textContent = 'Playing'; }, function (e) { button.textContent = 'play failed: ' + e.name; });
              });
              var slot = document.createElement('div');
              slot.style.cssText = 'padding:16px';
              slot.appendChild(button);
              slot.appendChild(video);
              document.body.insertBefore(slot, document.body.firstChild);
              window.scrollTo(0, 0);
              return 'injected';
            })()
        """.trimIndent()
    }
}
