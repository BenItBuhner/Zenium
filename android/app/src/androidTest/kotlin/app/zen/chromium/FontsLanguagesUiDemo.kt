package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The `android-fonts-languages-demo` workflow: the UI halves of the parity rows CT-23, CT-25,
 * CT-41 and CT-36 on the phone, on the shared Settings builder's rows and the reader's Text
 * preferences sheet, with the demo's own article open under them ([DemoServer],
 * `fonts-languages-demo-page.html`, a page that leaves its type to the browser). Writes
 * `fonts-languages-findings.txt` next to the stills (a `PASS` or `FAIL` per check; the run
 * fails at its end when any did, or when a touch did not take):
 *
 *  1. CT-23 Appearance: Settings > Look and Feel > Colour scheme under a real finger – the
 *     picker sheet's title block says "Websites follow this too." – and Dark picked with a
 *     finger: the row reads Dark, the chrome turns, and the SAME article document (its
 *     `performance.timeOrigin` unchanged) sees `prefers-color-scheme` flip, no reload.
 *  2. CT-25 Customise fonts, in dark: Font size dragged three stops along its §9.21 slider (the
 *     value beside the label following the thumb, the size applied when the finger lets go: the
 *     core's `settings.fonts.size` 20 and the open article's body text at 20 px), Minimum font
 *     size dragged to 12 (the article's 11 px small print lifted to 12), Standard font through
 *     its picker sheet (each face drawn in itself) to Cursive, the Reset row appearing once
 *     anything stands off the defaults, the preview row following – and the article reflowed
 *     when Settings closes, still the same document.
 *  3. CT-23 back to Light the same way, the article following again; Reset fonts under a finger
 *     puts the type back (16 px, no floor, the platform's face) on the open page.
 *  4. CT-41 Preferred languages: the list's §10.4 rows in order with their trailing ⋯ – German's
 *     menu (Move Up / Move Down / Remove, Move Down at .4 on the last row) under a finger, Move
 *     Up under a finger puts German first (`settings.languages`); Add language opens the §9.13
 *     picker sheet with its filter field, `basq` typed into it narrows the list to Basque, a
 *     finger on Basque adds it and closes the sheet; the phone copy says pages receive the
 *     system's languages.
 *  5. CT-36 Reader View's Text preferences: the sheet carries Translate into (a menulist reading
 *     German, the first preferred language after the move) and Translate under Listen; Translate
 *     under a finger turns the row busy with the progress as its second line (the model coming
 *     down, the blocks done), the article turns German in place, the row gives way to Show
 *     original whose second line names the source; Show original under a finger shows the
 *     English and again the German; the back closes the sheet on the translated document.
 *
 * The jank record ([traceFrames], `frames.jsonl`; Bennett's rule of 2026-09-20 and the Android
 * program's PERF-3 harness): the app menu opened under a finger and dismissed with a back first
 * (`menu-sheet-open` / `menu-sheet-close`, the table's point of reference), then this PR's
 * scenes – the colour scheme picker's open and the pick that closes it
 * (`colour-scheme-picker-open` / `-pick`), the two slider drags (`font-size-slider-drag`,
 * `minimum-font-size-slider-drag`, `gesture`: the finger down on the thumb, along the track and
 * up, the size applied on the release), the font picker's open and pick
 * (`font-family-picker-open` / `-pick`), the language row's ⋯ menu open and its Move Up
 * (`language-menu-open` / `-move-up`), Add language's picker open and the pick that closes it
 * (`add-language-picker-open` / `-pick`), the Text preferences sheet's open and its close on a
 * back (`reader-prefs-sheet-open` / `-close`), every sheet scene `open`. Each block is the
 * finger (or the back) and [MOTION_MS] for what it does, nothing else – the node found and the
 * point fixed BEFORE the block, the claim polled AFTER it ([scene]). Every scene carries the
 * chrome WebView's trace; the gate (`jankGate`, soft unless the workflow says hard) reports or
 * fails them; the findings list the scenes one line each. The core's startup sweeps are held
 * for the run (`holdBackgroundWork`), so no feed refresh lands in a measured scene.
 *
 * Composed on [PageControlsDemo] for its Settings plumbing (the app menu, a section over the
 * landing, a row scrolled into view, the chrome cleared and the Settings tab left) rather than
 * a copy of it; the profile is `fonts-languages-demo-state.json` (one tab, the article; the
 * languages English (United States) then German so the list has a row to move; the scheme from
 * the `theme` argument, light for the workflow's run so the flip goes to dark and back). Every
 * control pressed inside a sheet is a real injected finger with an assertion (#198's rule).
 */
@RunWith(AndroidJUnit4::class)
class FontsLanguagesUiDemo : PageControlsDemo("fonts-languages-demo-state.json", MEDIA_PREFIX, "fonts-languages-demo") {
    override val tag = "FontsLanguagesUiDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private val host get() = (activity as MainActivity).host

    @Test
    override fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("fonts-languages-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            super.record()
        } finally {
            server.close()
        }
        if (failures > 0) throw AssertionError("$failures fonts / languages UI check(s) failed; see $FINDINGS")
    }

    /** The scheme from the `theme` argument alone: this profile names no locked page. */
    override fun patchState(json: String): String = patchTheme(json)

    override fun warmUp() {
        findings = File(out, FINDINGS)
        findings.writeText("Zenium Android fonts / languages / appearance / reader translate UI checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, seeded $THEME)\n\n")
        finding("demo server: ${server.selfCheck()}")
        warmUpChrome()
        val caps = coreState().getJSONObject("capabilities")
        finding("capabilities: genericFontFamilies=${caps.optBoolean("genericFontFamilies")} pageLanguages=${caps.optBoolean("pageLanguages")} phone=${caps.optBoolean("phone")}")
        check(
            "the phone host reports genericFontFamilies false and pageLanguages false (the interface note's §2.4 and §3.4: the honest rows)",
            !caps.optBoolean("genericFontFamilies", true) && !caps.optBoolean("pageLanguages", true)
        )
        awaitPage(HOST, 30_000, "/")
        finding("article: ${describeTab()}; fonts ${fonts()}; languages ${languages()}")
        // The Settings tab once, off camera, at the Look and Feel section: its first paint and
        // the builder's compilation are paid for before any measured scene (the reference scene
        // reads a warm menu the same way, as the Android program's drivers do).
        coreInvoke("page.open", "{\"id\":\"settings\",\"section\":\"look\"}")
        if (waitFor(FONTS_HEADING, 12_000) == null) finding("  warm-up: the Customise fonts heading never showed in Look and Feel")
        SystemClock.sleep(800)
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        SystemClock.sleep(1_200)
    }

    override fun demo() {
        try {
            snap("article-$THEME")
            beat()
            referenceScenes()
            val document = articleValue("performance.timeOrigin")
            val other = if (THEME == "dark") "Light" else "Dark"
            val own = if (THEME == "dark") "Dark" else "Light"
            appearanceSection(own, other, document)
            fontsSection(document)
            appearanceBackSection(other, own, document)
            languagesSection()
            readerSection()
            finding("\nend: ${describeTab()}${if (failures == 0) "" else "; $failures FAIL"}")
        } finally {
            framesFinding()
        }
    }

    // --- the frame record ----------------------------------------------------------------------------

    /**
     * One scene through the harness's one helper ([traceFrames]): the block is `motion` – the
     * finger, or the back – and [MOTION_MS] for what it does, nothing else; what the motion is
     * expected to do, `took`, is polled AFTER the block for up to `timeoutMs` more (#198's rule,
     * kept out of the frames). Answers whether `took` held.
     */
    private fun scene(name: String, kind: JankBudget.Kind, timeoutMs: Long = 6_000, took: () -> Boolean, motion: () -> Unit): Boolean {
        traceFrames(name, kind) {
            motion()
            SystemClock.sleep(MOTION_MS)
        }
        return poll(timeoutMs, took)
    }

    private fun Finger.tap(at: PointF) = tap(at.x, at.y)

    /**
     * Where a finger lands on the node reading `label` (exactly, or with a description running on
     * after it when `prefix`, as a Settings row's text does), found now – before a scene's clock
     * starts – and settled ([steadyBounds]); null, with a finding, when nothing on screen reads
     * it or no part of it is inside the touchable window.
     */
    private fun fingerOn(label: String, prefix: Boolean = false, timeoutMs: Long = 8_000): PointF? =
        fingerWhere(label, timeoutMs) { it == label || (prefix && (it.startsWith("$label ") || it.startsWith("$label\n"))) }

    private fun fingerWhere(what: String, timeoutMs: Long = 8_000, matches: (String) -> Boolean): PointF? {
        val node = awaitNode(timeoutMs, matches) ?: run {
            finding("  nothing on screen reads '$what'")
            return null
        }
        val bounds = steadyBounds(node) ?: run {
            finding("  '$what' left the tree before the finger")
            return null
        }
        return touchPoint(bounds) ?: run {
            finding("  no part of '$what' ($bounds) is inside the touchable window")
            null
        }
    }

    /** The bar's Menu button, where [tapMenuButton] puts the finger. */
    private fun menuButtonPoint(): PointF =
        (findByLabel(MENU_LABEL) ?: waitFor(MENU_LABEL, 4_000))?.let { PointF(it.exactCenterX(), it.exactCenterY()) }
            ?: PointF(width - 30 * density, pillY)

    private fun framesFinding() {
        val scenes = frameScenes
        if (scenes.isEmpty()) {
            finding("\nframes: no scene was measured")
            return
        }
        finding("\nframes (DemoHarness.traceFrames, PERF-3's harness; gate ${jankGate.key}; startup sweeps held=$holdBackgroundWork; the emulator's software GPU makes every frame janky by construction: the trace columns, and the same scenes run to run on this one recipe, are the reading):")
        for (s in scenes) {
            val summary = s.summary
            val hwui = if (summary == null) {
                "not measured (no HWUI summary in the dump)"
            } else {
                "${summary.frames} frames, ${summary.janky} janky, p50 ${summary.p50Ms} p90 ${summary.p90Ms} p95 ${summary.p95Ms} p99 ${summary.p99Ms} ms, long stage ${s.analysis.dominant ?: "-"}"
            }
            val trace = s.trace?.let { "; ${it.describe()}" } ?: s.traceMissing?.let { "; trace: none read ($it)" } ?: ""
            finding("  ${s.name} (${s.kind.key}, ${s.durationMs} ms): $hwui$trace; ${s.verdict.describe()}")
        }
    }

    // --- 0. the reference scene: the app menu ---------------------------------------------------------

    private fun referenceScenes() {
        ensureChromeClear()
        val menu = menuButtonPoint()
        val opened = scene("menu-sheet-open", JankBudget.Kind.OPEN, took = { chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) != null }) {
            Finger().tap(menu)
        }
        check("PERF-3 reference: the app menu opened under a finger (menu-sheet-open)", opened)
        if (!opened) {
            touchFault("a touch on the Menu button opened no app menu (menu-sheet-open)")
            ensureChromeClear()
            return
        }
        val closed = scene("menu-sheet-close", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = { !chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) == null }) {
            back()
        }
        check("PERF-3 reference: the app menu went on a back (menu-sheet-close)", closed)
        SystemClock.sleep(600)
    }

    // --- 1. CT-23: the colour scheme, the page following ---------------------------------------------

    private fun appearanceSection(own: String, other: String, document: String?) {
        finding("\nCT-23 Appearance: Colour scheme $own -> $other with the article open (the picker's description, the page following without a reload)")
        val before = articleValue(SCHEME_JS)
        finding("  before: the article sees $before under the ${own.lowercase()} chrome; document $document")
        if (!openSettings(LOOK_SECTION)) {
            check("the app menu's Settings opens Look and Feel", false)
            return
        }
        val picked = colourScheme(own, other, measured = true)
        if (picked) {
            val flipped = poll(8_000) { articleValue(SCHEME_JS) == other.lowercase() }
            val same = articleValue("performance.timeOrigin") == document
            finding("  the article sees ${articleValue(SCHEME_JS)} under the ${other.lowercase()} chrome; same document: $same")
            check("the open article's prefers-color-scheme flips to ${other.lowercase()} with the chrome, the same document (no reload)", flipped && same)
            SystemClock.sleep(800)
            snap("look-and-feel-${other.lowercase()}")
        }
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        SystemClock.sleep(1_500)
        snap("article-${other.lowercase()}-same-document")
        beat()
    }

    /**
     * The Colour scheme row's picker: the row under a finger (its sheet lists the three options
     * under the §9.23 title block whose description is "Websites follow this too."), then `to`
     * under a finger – the pick closes the sheet with the row reading `to`. Both a scene when
     * `measured`. True once the row reads `to`.
     */
    private fun colourScheme(from: String, to: String, measured: Boolean): Boolean {
        if (revealRow(COLOR_SCHEME_ROW) == null) {
            check("Look and Feel lists the $COLOR_SCHEME_ROW row", false)
            return false
        }
        SystemClock.sleep(600)
        val row = fingerOn(COLOR_SCHEME_ROW, prefix = true) ?: run {
            check("the $COLOR_SCHEME_ROW row is on screen to touch", false)
            return false
        }
        val listed = { findNode { it == to } != null && findNode { it == "Follow system" } != null }
        val opened = if (measured) {
            scene("colour-scheme-picker-open", JankBudget.Kind.OPEN, took = listed) { Finger().tap(row) }
        } else {
            Finger().tap(row)
            poll(6_000, listed)
        }
        if (!opened) {
            touchFault("a touch on the $COLOR_SCHEME_ROW row opened no picker listing $to")
            ensureChromeClear()
            return false
        }
        SystemClock.sleep(800)
        val description = sheetDescription()
        finding("  the picker sheet's title block reads: \"$description\"")
        check("the Colour scheme picker's description is \"Websites follow this too.\" (CT-23)", description == "Websites follow this too.")
        if (measured) {
            snap("colour-scheme-picker")
            beat()
        }
        val option = fingerOn(to) ?: run {
            check("the picker lists $to to touch", false)
            back()
            return false
        }
        val reads = { rowReads(COLOR_SCHEME_ROW, to) && findNode { it == "Follow system" } == null }
        val took = if (measured) {
            scene("colour-scheme-picker-pick", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = reads) { Finger().tap(option) }
        } else {
            Finger().tap(option)
            poll(8_000, reads)
        }
        finding("  $COLOR_SCHEME_ROW: $from -> ${if (took) to else "still $from"} (the pick closed the sheet: ${findNode { it == "Follow system" } == null})")
        if (!took) touchFault("a touch on $to did not take: the $COLOR_SCHEME_ROW row does not read $to with the picker gone")
        check("a finger on $to closes the picker with the row reading $to (§9.13)", took)
        return took
    }

    // --- 2. CT-25: Customise fonts ----------------------------------------------------------------------

    private fun fontsSection(document: String?) {
        finding("\nCT-25 Customise fonts (Settings > Look and Feel): the sliders applied on release, the family picker, Reset, the article reflowing")
        val before = articleMetrics()
        finding("  the article before: $before")
        if (!openSettings(LOOK_SECTION)) {
            check("Look and Feel opens for the fonts group", false)
            return
        }
        if (revealRow(FONT_SIZE_ROW) == null) {
            check("Look and Feel carries the Customise fonts group with its Font size row", false)
            ensureChromeClear()
            return
        }
        SystemClock.sleep(800)
        val rows = groupRows("fonts")
        finding("  the group's rows: $rows")
        check(
            "the phone's group is Font size, Minimum font size, Standard font, the preview (and Reset once off the defaults): no serif / sans-serif / fixed rows (genericFontFamilies false)",
            rows.containsAll(listOf("fonts-size", "fonts-minimum-size", "fonts-standard-phone", "fonts-preview")) && rows.none { it in setOf("fonts-serif-phone", "fonts-sansSerif-phone", "fonts-fixed-phone", "fonts-reset") }
        )
        check("the sliders carry Chrome's end labels (Very small … Very large; Tiny … Huge)", sliderEnds("fonts-size") == "Very small|Very large" && sliderEnds("fonts-minimum-size") == "Tiny|Huge")
        finding("  at rest: Font size reads ${sliderValue("fonts-size")}, Minimum font size ${sliderValue("fonts-minimum-size")}, preview ${previewMetrics()}")
        snap("customise-fonts")
        beat()

        // Font size: three stops along the slider (16 -> 20 px). The value beside the label
        // follows the thumb; the size is applied when the finger lets go (§9.21, the brief's
        // rule: no page layout per frame), and the open article's body text follows.
        val sizeTook = dragSlider("fonts-size", FONT_SIZE_MAX_INDEX, FONT_SIZE_TARGET_INDEX, "font-size-slider-drag") {
            fonts().optInt("size") == 20
        }
        val sizeReads = sliderValue("fonts-size")
        val bodySize = poll(6_000) { articleValue(BODY_FONT_SIZE_JS) == "20px" }
        finding("  after the drag: settings.fonts.size=${fonts().optInt("size")}, the row reads $sizeReads, the article's body font-size ${articleValue(BODY_FONT_SIZE_JS)} (same document: ${articleValue("performance.timeOrigin") == document})")
        check("Font size dragged three stops applies 20 px on release: the core's setting, the row's value, the open article's body text", sizeTook && sizeReads == "20 px" && bodySize)
        if (!sizeTook) touchFault("the Font size slider drag did not take: settings.fonts.size is ${fonts().optInt("size")}, not 20")
        SystemClock.sleep(600)
        snap("customise-fonts-size-20")

        // Minimum font size: to 12 px. The article's 11 px small print is lifted to 12.
        revealRow(MINIMUM_FONT_SIZE_ROW)
        SystemClock.sleep(600)
        val minimumTook = dragSlider("fonts-minimum-size", MINIMUM_FONT_SIZE_MAX_INDEX, MINIMUM_FONT_SIZE_TARGET_INDEX, "minimum-font-size-slider-drag") {
            fonts().optInt("minimumSize") == 12
        }
        val smallLifted = poll(6_000) { articleValue(SMALL_FONT_SIZE_JS) == "12px" }
        finding("  after the drag: settings.fonts.minimumSize=${fonts().optInt("minimumSize")}, the row reads ${sliderValue("fonts-minimum-size")}, the article's 11 px small print at ${articleValue(SMALL_FONT_SIZE_JS)}")
        check("Minimum font size dragged to 12 px lifts the article's 11 px small print to 12 (WebSettings.minimumFontSize, in place)", minimumTook && sliderValue("fonts-minimum-size") == "12 px" && smallLifted)
        if (!minimumTook) touchFault("the Minimum font size slider drag did not take: settings.fonts.minimumSize is ${fonts().optInt("minimumSize")}, not 12")

        // Standard font: the action row opens the phone's picker sheet (each face drawn in
        // itself), Cursive under a finger sets the family and closes the sheet.
        revealRow(STANDARD_FONT_ROW)
        SystemClock.sleep(600)
        val familyRow = fingerOn(STANDARD_FONT_ROW, prefix = true)
        if (familyRow != null) {
            val listed = { findNode { it == "Cursive" } != null && findNode { it == "Serif monospace" } != null }
            val opened = scene("font-family-picker-open", JankBudget.Kind.OPEN, took = listed) { Finger().tap(familyRow) }
            check("a finger on Standard font opens the family picker sheet listing the fonts.xml aliases", opened)
            if (opened) {
                SystemClock.sleep(800)
                val faces = pickerFaces()
                finding("  the picker's rows and the face each is drawn in: $faces")
                check("each family row is drawn in its own face (RadioOption.font)", faces.count { it.second.contains("cursive") } >= 1 && faces.count { it.second.contains("monospace") } >= 1)
                snap("standard-font-picker")
                beat()
                val cursive = fingerOn("Cursive")
                if (cursive != null) {
                    val set = { fonts().optString("standard") == "cursive" && findNode { it == "Serif monospace" } == null }
                    val took = scene("font-family-picker-pick", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = set) { Finger().tap(cursive) }
                    val family = poll(6_000) { articleValue(BODY_FONT_FAMILY_JS) == "cursive" }
                    finding("  after Cursive: settings.fonts.standard=${fonts().optString("standard")}, the row reads ${rowText("fonts-standard-phone")}, the article's body font-family ${articleValue(BODY_FONT_FAMILY_JS)}")
                    check("a finger on Cursive sets the standard family and closes the picker (§9.13); the open article's text is set in it", took && family)
                    if (!took) touchFault("a touch on Cursive did not take: settings.fonts.standard is ${fonts().optString("standard")}")
                } else {
                    touchFault("the family picker listed no Cursive row to touch")
                    back()
                }
            } else {
                touchFault("a touch on Standard font opened no family picker")
            }
        } else {
            check("the Standard font row is on screen to touch", false)
        }

        // Off the defaults: the Reset row is listed; the preview follows the committed values.
        SystemClock.sleep(800)
        val reset = revealRow(RESET_ROW)
        val after = groupRows("fonts")
        finding("  the group now: $after; preview ${previewMetrics()}")
        check("the Reset fonts row appears once anything stands off the defaults", reset != null && "fonts-reset" in after)
        check("the preview row follows the committed values (20 px cursive standard, fixed at Chrome's 13/16 ratio)", previewMetrics().let { it.contains("standard=20px") && it.contains("cursive") && it.contains("fixed=16px") })
        snap("customise-fonts-changed")
        beat()

        // The article again: reflowed in the new type, the same document.
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        SystemClock.sleep(1_500)
        val now = articleMetrics()
        finding("  the article after: $now (same document: ${articleValue("performance.timeOrigin") == document})")
        check("the open article reflowed with the new type (taller, body 20 px, small print 12 px, cursive) without a reload", now.optInt("scrollHeight") > before.optInt("scrollHeight") && now.optString("body") == "20px" && now.optString("small") == "12px" && now.optString("family") == "cursive" && articleValue("performance.timeOrigin") == document)
        snap("article-fonts-changed-${articleValue(SCHEME_JS)}")
        beat()
    }

    /**
     * A finger along the slider of the row `rowId`: down on its thumb, along the track to the
     * stop `toIndex` of `maxIndex` (Radix reads the value off the pointer's place on the root's
     * width, rounded to the step), up – the row's value follows the thumb while the finger is
     * down and the setting is committed on the release. The `gesture` scene named `scene`; the
     * thumb and the root are placed from the chrome's own document (the tree's range node, when
     * it has one, is noted). `took` is the claim polled after the block.
     */
    private fun dragSlider(rowId: String, maxIndex: Int, toIndex: Int, scene: String, took: () -> Boolean): Boolean {
        val root = chromeRect("[data-row=\"$rowId\"] .zen-settings-slider")
        val thumb = chromeRect("[data-row=\"$rowId\"] [role=\"slider\"]")
        val rangeNode = findNodeWhere { it.rangeInfo != null && ((it.contentDescription ?: it.text)?.toString()?.let { t -> t == FONT_SIZE_ROW || t == MINIMUM_FONT_SIZE_ROW } == true) }
        finding("  slider $rowId: thumb $thumb on root $root; the tree's range node: ${rangeNode?.className ?: "none"}${rangeNode?.rangeInfo?.let { " at ${it.current} of ${it.max}" } ?: ""}")
        if (root == null || thumb == null || root.width() <= 0) {
            check("the $rowId slider is in the chrome's document to touch", false)
            return false
        }
        val x0 = thumb.exactCenterX()
        val y = thumb.exactCenterY()
        val target = root.left + root.width() * toIndex / maxIndex.toFloat()
        val point = touchPoint(Rect(x0.toInt() - 1, y.toInt() - 1, x0.toInt() + 1, y.toInt() + 1)) ?: run {
            check("the $rowId slider's thumb is inside the touchable window", false)
            return false
        }
        Log.i(tag, "slider $rowId: finger from ${point.x},${point.y} to ${target},${point.y} (stop $toIndex of $maxIndex)")
        val held = scene(scene, JankBudget.Kind.GESTURE, timeoutMs = 8_000, took = took) {
            Finger().apply {
                down(point.x, point.y)
                moveBy(target - point.x, 0f, 700)
                hold(200)
                up()
            }
        }
        return held
    }

    // --- 3. CT-23 back, and Reset fonts -----------------------------------------------------------------

    private fun appearanceBackSection(from: String, to: String, document: String?) {
        finding("\nCT-23 back: Colour scheme $from -> $to, the article following again; Reset fonts on the open page")
        if (!openSettings(LOOK_SECTION)) {
            check("Look and Feel opens again", false)
            return
        }
        if (colourScheme(from, to, measured = false)) {
            val flipped = poll(8_000) { articleValue(SCHEME_JS) == to.lowercase() }
            finding("  the article sees ${articleValue(SCHEME_JS)} under the ${to.lowercase()} chrome; same document: ${articleValue("performance.timeOrigin") == document}")
            check("the article follows back to ${to.lowercase()}, still the same document", flipped && articleValue("performance.timeOrigin") == document)
        }
        // Reset fonts: the action row under a finger; the open article back at 16 px, no floor,
        // the platform's face – in place.
        if (revealRow(RESET_ROW) != null) {
            SystemClock.sleep(600)
            val reset = touchTapLabelExpecting(RESET_ROW, "settings.fonts back at the defaults", timeoutMs = 6_000, prefix = true) {
                fonts().let { it.optInt("size") == 16 && it.optInt("minimumSize") == 0 && it.isNull("standard") }
            }
            val page = poll(6_000) { articleValue(BODY_FONT_SIZE_JS) == "16px" && articleValue(SMALL_FONT_SIZE_JS) == "11px" && articleValue(BODY_FONT_FAMILY_JS) != "cursive" }
            finding("  after Reset fonts: fonts ${fonts()}; the article's body ${articleValue(BODY_FONT_SIZE_JS)} ${articleValue(BODY_FONT_FAMILY_JS)}, small print ${articleValue(SMALL_FONT_SIZE_JS)}; the Reset row listed: ${"fonts-reset" in groupRows("fonts")}")
            check("Reset fonts puts the type back (16 px, no minimum, the platform's face) on the open article and the row leaves the group", reset && page && "fonts-reset" !in groupRows("fonts"))
            SystemClock.sleep(600)
            snap("customise-fonts-reset")
        } else {
            check("the Reset fonts row is there to press", false)
        }
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        SystemClock.sleep(1_200)
        snap("article-${to.lowercase()}-reset")
        beat()
    }

    // --- 4. CT-41: Preferred languages --------------------------------------------------------------------

    private fun languagesSection() {
        finding("\nCT-41 Preferred languages (Settings > Languages): the rows in order with their ⋯ menus, Move Up, Add language with its filter")
        if (!openSettings(LANGUAGES_SECTION)) {
            check("the app menu's Settings opens Languages", false)
            return
        }
        if (revealRow(ADD_LANGUAGE_ROW) == null) {
            check("Languages carries the Preferred languages group with its Add language row", false)
            ensureChromeClear()
            return
        }
        SystemClock.sleep(800)
        val rows = groupRows("preferred")
        val description = groupDescription("preferred")
        finding("  the group's rows: $rows; description: \"$description\"")
        check("the list's rows are English (United States) then German, one per language in the list's order, then Add language", rows == listOf("languages-preferred:en-US", "languages-preferred:de", "languages-add"))
        check("the phone copy says pages receive the system's languages, not this list (pageLanguages false)", description.contains("pages receive the system’s languages"))
        val menus = menuButtons()
        finding("  the rows' ⋯ buttons: $menus")
        check("each language row carries a trailing ⋯ named for it (Options for English (United States), Options for German)", menus == listOf("Options for English (United States)", "Options for German"))
        snap("languages")
        beat()

        // German's ⋯: the menu sheet titled German – Move Up, Move Down (at .4, the last row),
        // Remove – and Move Up under a finger puts German first.
        val dots = fingerOn("Options for German")
        if (dots != null) {
            val listed = { findNode { it == "Move Up" } != null && findNode { it == "Remove" } != null }
            val opened = scene("language-menu-open", JankBudget.Kind.OPEN, took = listed) { Finger().tap(dots) }
            check("a finger on German's ⋯ opens its menu sheet (Move Up / Move Down / Remove)", opened)
            if (opened) {
                SystemClock.sleep(800)
                val items = menuItems()
                finding("  the menu's items: $items")
                check("Move Down is disabled on the last row, Move Up and Remove enabled (§9.30: listed at .4, never dropped)", items.any { it.startsWith("Move Down") && it.endsWith("disabled") } && items.any { it.startsWith("Move Up") && it.endsWith("enabled") } && items.any { it.startsWith("Remove") && it.endsWith("enabled") })
                snap("language-menu")
                beat()
                val up = fingerOn("Move Up")
                if (up != null) {
                    val moved = { languages().let { it.size == 2 && it[0] == "de" } && findNode { it == "Move Up" } == null }
                    val took = scene("language-menu-move-up", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = moved) { Finger().tap(up) }
                    finding("  after Move Up: languages ${languages()}; rows ${groupRows("preferred")}")
                    check("Move Up puts German first (settings.languages de, en-US) and the rows follow the order", took && groupRows("preferred").take(2) == listOf("languages-preferred:de", "languages-preferred:en-US"))
                    if (!took) touchFault("a touch on Move Up did not take: languages are ${languages()}")
                } else {
                    touchFault("the menu sheet listed no Move Up to touch")
                    back()
                }
            } else {
                touchFault("a touch on German's ⋯ opened no menu sheet")
            }
        } else {
            check("German's ⋯ button is on screen to touch", false)
        }
        SystemClock.sleep(800)
        snap("languages-reordered")
        beat()

        // Add language: the picker sheet with its filter field; `basq` typed narrows the list to
        // Basque; Basque under a finger adds it and closes the sheet.
        revealRow(ADD_LANGUAGE_ROW)
        SystemClock.sleep(600)
        val add = fingerOn(ADD_LANGUAGE_ROW, prefix = true)
        if (add != null) {
            val listed = { findNode { it == FILTER_LABEL } != null && findNode { it.startsWith("Afrikaans") } != null }
            val opened = scene("add-language-picker-open", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = listed) { Finger().tap(add) }
            check("a finger on Add language opens the picker sheet with the filter field pinned over the list", opened)
            if (opened) {
                SystemClock.sleep(800)
                val all = pickerCount()
                finding("  the picker lists $all languages; the filter field reads \"${filterValue()}\"")
                snap("add-language-picker")
                beat()
                val field = fingerOn(FILTER_LABEL)
                if (field != null) {
                    Finger().tap(field)
                    val focused = poll(4_000) { chromeString("document.activeElement&&document.activeElement.getAttribute('aria-label')||''") == FILTER_LABEL }
                    val ime = awaitIme(shown = true, timeoutMs = 4_000)
                    finding("  the filter field under a finger: focused=$focused, keyboard up=$ime")
                    if (!focused) touchFault("a touch on the filter field did not focus it")
                    typeText("basq")
                    val narrowed = poll(6_000) { pickerCount() == 1 && findNode { it.startsWith("Basque") } != null }
                    finding("  typed basq: the field reads \"${filterValue()}\", the list has ${pickerCount()} row(s): ${pickerLabels()}")
                    check("the filter narrows the list as it is typed (basq → Basque alone)", narrowed && filterValue() == "basq")
                    SystemClock.sleep(600)
                    snap("add-language-filtered")
                    beat()
                    if (imeShown()) {
                        back()
                        awaitIme(shown = false, timeoutMs = 6_000)
                        SystemClock.sleep(800)
                        check("the back with the keyboard up puts the keyboard away and leaves the sheet standing", !imeShown() && findNode { it == FILTER_LABEL } != null)
                    }
                    val basque = fingerWhere("Basque") { it == "Basque" || it.startsWith("Basque ") || it.startsWith("Basque\n") }
                    if (basque != null) {
                        val added = { languages().contains("eu") && findNode { it == FILTER_LABEL } == null }
                        val took = scene("add-language-pick", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = added) { Finger().tap(basque) }
                        finding("  after Basque: languages ${languages()}; rows ${groupRows("preferred")}")
                        check("a finger on Basque adds it (settings.languages de, en-US, eu) and closes the picker (§9.13)", took && groupRows("preferred") == listOf("languages-preferred:de", "languages-preferred:en-US", "languages-preferred:eu", "languages-add"))
                        if (!took) touchFault("a touch on Basque did not take: languages are ${languages()}")
                    } else {
                        touchFault("the filtered picker listed no Basque row to touch")
                        back()
                    }
                } else {
                    check("the filter field is on screen to touch", false)
                    back()
                }
            } else {
                touchFault("a touch on Add language opened no picker sheet")
            }
        } else {
            check("the Add language row is on screen to touch", false)
        }
        SystemClock.sleep(800)
        snap("languages-added")
        beat()
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        SystemClock.sleep(1_000)
    }

    // --- 5. CT-36: Translate in Reader View's Text preferences -----------------------------------------

    private fun readerSection() {
        finding("\nCT-36 Reader View > Text preferences: Translate into + Translate / Show original")
        val opened = openMenuItem("Reader View")
        if (!opened) {
            check("the app menu lists Reader View for the article", false)
            ensureChromeClear()
            return
        }
        val entered = poll(15_000) { isReader() }
        finding("  real touch on Reader View: ${describeTab()}")
        if (!entered) {
            touchFault("a touch on Reader View did not open the reader document")
            return
        }
        val mounted = poll(15_000) { articleValue("(document.querySelector('header h1')||{}).textContent||''").orEmpty().isNotEmpty() }
        check("the reader document renders the article", mounted)
        val original = readerText()
        finding("  the reader document (lang ${articleValue("document.documentElement.lang")}): \"${original.take(90)}…\"")
        SystemClock.sleep(1_000)
        snap("reader-document")
        beat()

        // The Text preferences sheet from the app menu (the phone's way in), measured.
        if (!openPreferencesSheet()) return
        val rows = sheetRows()
        finding("  the sheet's rows: $rows")
        check(
            "Translate into and Translate stand in the group under Listen and before Text size (one place, CT-36)",
            rows.indexOf("Translate into") >= 0 && rows.indexOf("Translate") == rows.indexOf("Translate into") + 1 && rows.indexOf("Translate") < rows.indexOf("Text size") && (rows.indexOf("Listen to this article") < 0 || rows.indexOf("Listen to this article") < rows.indexOf("Translate into"))
        )
        val target = menulistValue("Translate into")
        finding("  Translate into reads: $target (languages ${languages()})")
        check("Translate into defaults to the first preferred language – German, after Move Up", target == "German")
        SystemClock.sleep(600)
        snap("reader-prefs-translate")
        beat()

        // Translate under a finger: the row turns busy with the progress; the article turns German.
        val translate = fingerOn("Translate")
        if (translate == null) {
            check("the Translate row is on screen to touch", false)
            backFromSheet(measured = false)
            return
        }
        val t0 = SystemClock.uptimeMillis()
        Finger().tap(translate)
        val started = poll(10_000) { readerStatus() in WORKING || readerStatus() == "translated" }
        finding("  real touch on Translate: status ${readerStatus()} after ${SystemClock.uptimeMillis() - t0} ms")
        if (!started) touchFault("a touch on Translate did not start the reader translation (status ${readerStatus()})")
        var busyShot = false
        var seen = ""
        val deadline = SystemClock.uptimeMillis() + 300_000
        while (SystemClock.uptimeMillis() < deadline) {
            val state = readerState()
            val status = state?.optString("status").orEmpty()
            val line = "$status ${state?.optJSONObject("download")?.let { "${it.optLong("received")}/${it.optLong("total")}" } ?: ""} ${state?.optJSONObject("progress")?.let { "${it.optInt("done")}/${it.optInt("total")}" } ?: ""}"
            if (line != seen) {
                seen = line
                Log.i(tag, "reader translation: $line; the row's second line: \"${rowDescription("Translate")}\"")
            }
            if (status in WORKING && !busyShot && (status == "downloading" || status == "translating")) {
                busyShot = true
                SystemClock.sleep(500)
                finding("  busy: the row reads \"${rowDescription("Translate")}\" (busy=${rowBusy("Translate")})")
                check("while the core works the Translate row is busy with the progress as its second line (§9.30)", rowBusy("Translate") && rowDescription("Translate").isNotEmpty())
                snap("reader-prefs-translating")
            }
            if (status == "translated" || status == "error") break
            SystemClock.sleep(400)
        }
        val end = readerState()
        val status = end?.optString("status").orEmpty()
        finding("  end: $end after ${SystemClock.uptimeMillis() - t0} ms")
        if (!busyShot) finding("  (the model was on the device and the translation too quick for a busy still)")
        check("the article translates (status translated; the en → de model through the existing translate path)", status == "translated")
        if (status != "translated") {
            finding("  the Translate row's second line: \"${rowDescription("Translate")}\"")
            snap("reader-prefs-translate-failed")
            backFromSheet(measured = true)
            return
        }
        val translated = poll(8_000) { readerText() != original && articleValue("document.documentElement.lang") == "de" }
        finding("  the reader document (lang ${articleValue("document.documentElement.lang")}): \"${readerText().take(90)}…\"")
        check("the article shows the German in place (the document's lang de, its text changed)", translated)
        val showOriginal = poll(6_000) { rowNode("Show original") != null }
        finding("  the rows now: ${sheetRows()}; Show original's second line: \"${rowDescription("Show original")}\"")
        check("once translated the action row gives way to Show original, its second line naming the source (Translated from English)", showOriginal && rowDescription("Show original") == "Translated from English" && "Translate" !in sheetRows())
        SystemClock.sleep(800)
        snap("reader-prefs-translated")
        beat()

        // Show original under a finger: the English again, the translation kept; and back.
        touchTapLabelExpecting("Show original", "the reader shows the article as written", timeoutMs = 8_000, prefix = true) {
            readerState()?.optBoolean("showOriginal") == true && readerText() == original
        }
        finding("  after Show original: showOriginal=${readerState()?.optBoolean("showOriginal")}, lang ${articleValue("document.documentElement.lang")}, text \"${readerText().take(60)}…\"")
        check("Show original on shows the English with the translation kept (translate.readerShowOriginal)", readerState()?.optBoolean("showOriginal") == true && readerText() == original)
        SystemClock.sleep(800)
        snap("reader-prefs-show-original")
        beat()
        touchTapLabelExpecting("Show original", "the reader shows the German again", timeoutMs = 8_000, prefix = true) {
            readerState()?.optBoolean("showOriginal") == false && readerText() != original
        }
        check("Show original off shows the German again", readerState()?.optBoolean("showOriginal") == false && readerText() != original)
        SystemClock.sleep(600)

        // The system back closes the sheet alone (measured); the translated document stays.
        val closed = backFromSheet(measured = true)
        finding("  back: sheet gone=$closed; the document's lang ${articleValue("document.documentElement.lang")}")
        check("back closes the sheet and the reader keeps the translation", closed && articleValue("document.documentElement.lang") == "de")
        SystemClock.sleep(800)
        snap("reader-translated")
        beat()
    }

    /**
     * The app menu's Text Preferences… under a finger (the menu's own open and pull outside any
     * scene); the finger on the row and the sheet coming up is the `reader-prefs-sheet-open`
     * scene. True once the sheet lists Translate into.
     */
    private fun openPreferencesSheet(): Boolean {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            check("the app menu opens on the reader page", false)
            return false
        }
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        if (reveal(PREFERENCES_ITEM) == null) {
            check("the app menu carries $PREFERENCES_ITEM on the reader page", false)
            back()
            return false
        }
        val item = fingerOn(PREFERENCES_ITEM) ?: run {
            check("$PREFERENCES_ITEM is on screen to touch", false)
            back()
            return false
        }
        val up = scene("reader-prefs-sheet-open", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = { rowNode("Translate into") != null && rowNode("Text size") != null }) { Finger().tap(item) }
        if (!up) touchFault("a touch on $PREFERENCES_ITEM opened no sheet listing Translate into")
        check("a real touch on $PREFERENCES_ITEM opens the Text preferences sheet", up)
        SystemClock.sleep(1_200)
        return up
    }

    /** The system back on the sheet, as the `reader-prefs-sheet-close` scene when `measured`. */
    private fun backFromSheet(measured: Boolean): Boolean {
        val gone = { findNode { it == "Text preferences" } == null && !chromeSurfaceUp() }
        if (measured) return scene("reader-prefs-sheet-close", JankBudget.Kind.OPEN, took = gone) { back() }
        back()
        return poll(6_000, gone)
    }

    // --- the chrome's document ---------------------------------------------------------------------------

    /** Where the first chrome element matching `selector` is on screen (device px), or null. */
    private fun chromeRect(selector: String): Rect? {
        val raw = chromeString(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" +
                "var r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()"
        )
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        return Rect(
            (origin[0] + json.getDouble("x") * density).toInt(),
            (origin[1] + json.getDouble("y") * density).toInt(),
            (origin[0] + (json.getDouble("x") + json.getDouble("w")) * density).toInt(),
            (origin[1] + (json.getDouble("y") + json.getDouble("h")) * density).toInt()
        )
    }

    /** The string a script evaluates to in the chrome ("" when it did not answer or was not a string). */
    private fun chromeString(code: String): String = jsonString(chromeJs(code))

    /** The row ids of the Settings group `groupId`, in order. */
    private fun groupRows(groupId: String): List<String> = jsonList(chromeString(
        "(function(){var g=document.querySelector('[data-group=\"$groupId\"]');if(!g)return '[]';" +
            "return JSON.stringify(Array.from(g.querySelectorAll('[data-row]')).map(function(e){return e.getAttribute('data-row')}))})()"
    ))

    /** The group's description under its heading. */
    private fun groupDescription(groupId: String): String = chromeString(
        "(function(){var g=document.querySelector('[data-group=\"$groupId\"]');if(!g)return '';" +
            "var d=g.querySelector('.zen-settings-group-description, .zen-settings-description');return d?(d.textContent||'').trim():''})()"
    )

    /** The row's whole text (label and description as the tree runs them). */
    private fun rowText(rowId: String): String = chromeString(
        "(function(){var r=document.querySelector('[data-row=\"$rowId\"]');return r?(r.textContent||'').trim().replace(/\\s+/g,' '):''})()"
    )

    /** What the slider row's value reads ("20 px"). */
    private fun sliderValue(rowId: String): String = chromeString(
        "(function(){var v=document.querySelector('[data-row=\"$rowId\"] .zen-settings-slider-value');return v?(v.textContent||'').trim():''})()"
    )

    /** The slider row's two end labels, `first|last`. */
    private fun sliderEnds(rowId: String): String = chromeString(
        "(function(){var e=document.querySelector('[data-row=\"$rowId\"] .zen-settings-slider-ends');if(!e)return '';" +
            "return Array.from(e.children).map(function(c){return (c.textContent||'').trim()}).join('|')})()"
    )

    /** The preview row's computed type: the standard paragraph's size and family, the fixed one's size. */
    private fun previewMetrics(): String = chromeString(
        "(function(){var p=document.querySelector('[data-row=\"fonts-preview\"]');if(!p)return 'none';" +
            "var s=p.querySelector('[data-face=\"standard\"]'),f=p.querySelector('[data-face=\"fixed\"]');" +
            "var cs=s&&getComputedStyle(s),cf=f&&getComputedStyle(f);" +
            "return 'standard='+(cs?cs.fontSize+' '+cs.fontFamily:'?')+' fixed='+(cf?cf.fontSize+' '+cf.fontFamily:'?')})()"
    )

    /** The family picker's rows and the face each is drawn in (the radio's computed font-family). */
    private fun pickerFaces(): List<Pair<String, String>> {
        val raw = chromeString(
            "(function(){var rs=Array.from(document.querySelectorAll('[role=\"radiogroup\"] [role=\"radio\"]'));" +
                "return JSON.stringify(rs.map(function(r){var l=r.querySelector('.zen-settings-label')||r;return [(l.textContent||'').trim(),getComputedStyle(l).fontFamily]}))})()"
        )
        return runCatching {
            val a = JSONArray(raw)
            (0 until a.length()).map { i -> a.getJSONArray(i).let { it.getString(0) to it.getString(1) } }
        }.getOrDefault(emptyList())
    }

    /** The ⋯ buttons' names in the Preferred languages group, in order. */
    private fun menuButtons(): List<String> = jsonList(chromeString(
        "(function(){var g=document.querySelector('[data-group=\"preferred\"]');if(!g)return '[]';" +
            "return JSON.stringify(Array.from(g.querySelectorAll('.zen-settings-row-menu, [aria-label^=\"Options for\"]')).map(function(b){return b.getAttribute('aria-label')||''}).filter(Boolean))})()"
    ))

    /** The open menu sheet's items with their state, `label enabled|disabled`. */
    private fun menuItems(): List<String> = jsonList(chromeString(
        "(function(){var d=document.querySelector('[role=\"dialog\"] [role=\"menu\"]')||document.querySelector('[role=\"dialog\"]');if(!d)return '[]';" +
            "return JSON.stringify(Array.from(d.querySelectorAll('[role=\"menuitem\"], button')).map(function(b){var t=(b.textContent||'').trim();if(!t)return '';" +
            "return t+' '+((b.disabled||b.getAttribute('aria-disabled')==='true')?'disabled':'enabled')}).filter(Boolean))})()"
    ))

    /** How many languages the Add language picker lists now. */
    private fun pickerCount(): Int = chromeString(
        "String(document.querySelectorAll('[role=\"group\"][aria-label=\"$ADD_LANGUAGE_ROW\"] button').length)"
    ).toIntOrNull() ?: -1

    /** The picker's labels (first line of each row), at most eight. */
    private fun pickerLabels(): List<String> = jsonList(chromeString(
        "(function(){var bs=Array.from(document.querySelectorAll('[role=\"group\"][aria-label=\"$ADD_LANGUAGE_ROW\"] button')).slice(0,8);" +
            "return JSON.stringify(bs.map(function(b){var l=b.querySelector('.zen-settings-label')||b;return (l.textContent||'').trim()}))})()"
    ))

    /** What the picker's filter field holds. */
    private fun filterValue(): String = chromeString(
        "(function(){var f=document.querySelector('.zen-settings-pick-filter input');return f?f.value:''})()"
    )

    /** The open sheet's title-block description (§9.23). */
    private fun sheetDescription(): String = chromeString(
        "(function(){var p=document.querySelector('.zen-sheet-title-block p');return p?(p.textContent||'').trim():''})()"
    )

    /** The Text preferences sheet's row labels in order. */
    private fun sheetRows(): List<String> = jsonList(chromeString(
        "(function(){var r=document.querySelector('[data-reader-prefs-rows]');if(!r)return '[]';" +
            "return JSON.stringify(Array.from(r.querySelectorAll('.zen-v2-row')).map(function(e){var l=e.querySelector('.truncate');return l?(l.textContent||'').trim():''}).filter(Boolean))})()"
    )).distinct()

    /** What the menulist in the Text preferences row labelled `label` reads. */
    private fun menulistValue(label: String): String = chromeString(
        "(function(){var rows=Array.from(document.querySelectorAll('[data-reader-prefs-rows] .zen-v2-row'));" +
            "var r=rows.find(function(e){var l=e.querySelector('.truncate');return l&&(l.textContent||'').trim()===${JSONObject.quote(label)}});" +
            "var m=r&&r.querySelector('.zen-v2-menulist');return m?(m.textContent||'').trim():''})()"
    )

    /** The second line of the Text preferences row labelled `label` ("" without one). */
    private fun rowDescription(label: String): String = chromeString(
        "(function(){var rows=Array.from(document.querySelectorAll('[data-reader-prefs-rows] .zen-v2-row'));" +
            "var r=rows.find(function(e){var l=e.querySelector('.truncate');return l&&(l.textContent||'').trim()===${JSONObject.quote(label)}});" +
            "if(!r)return '';var d=r.querySelector('.zen-v2-row-description, .zen-settings-description, [data-description]');" +
            "if(d)return (d.textContent||'').trim();var t=(r.textContent||'').trim();return t.indexOf(${JSONObject.quote(label)})===0?t.slice(${label.length}).trim():''})()"
    )

    /** Whether the Text preferences row labelled `label` is busy (§9.30: `aria-busy`, or its spinner). */
    private fun rowBusy(label: String): Boolean = chromeString(
        "(function(){var rows=Array.from(document.querySelectorAll('[data-reader-prefs-rows] .zen-v2-row'));" +
            "var r=rows.find(function(e){var l=e.querySelector('.truncate');return l&&(l.textContent||'').trim()===${JSONObject.quote(label)}});" +
            "if(!r)return 'false';return String(r.getAttribute('aria-busy')==='true'||r.hasAttribute('data-busy')||!!r.querySelector('.animate-spin, [data-spinner], .zen-v2-spinner'))})()"
    ) == "true"

    /** The row (or control) reading `label`: the clickable node reading it alone or with a description after it. */
    private fun rowNode(label: String): AccessibilityNodeInfo? {
        val reads = { node: AccessibilityNodeInfo ->
            val text = (node.text ?: node.contentDescription)?.toString()
            text != null && (text == label || text.startsWith("$label ") || text.startsWith("$label\n"))
        }
        return findNodeWhere { node -> node.isClickable && reads(node) } ?: findNodeWhere(reads)
    }

    // --- the article -------------------------------------------------------------------------------------

    /** The demo tab's view (the article, then the reader document once Reader View is on). */
    private fun articleView(): TabWebView? {
        var view: TabWebView? = null
        instrumentation.runOnMainSync { view = host.tabs.get(TAB) }
        return view
    }

    /** `String(expression)` in the demo tab, whether or not it is the tab on screen; null when it did not answer. */
    private fun articleValue(expression: String): String? = articleView()?.let { evalJs(it, "String($expression)") }

    /** The article's type as laid out: the body's size and family, the small print's size, the height. */
    private fun articleMetrics(): JSONObject {
        val raw = articleView()?.let { evalJs(it, ARTICLE_METRICS_JS) } ?: "{}"
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    /** The reader document's first paragraphs' text, whitespace folded. */
    private fun readerText(): String =
        articleValue("Array.from(document.querySelectorAll('article p, main p, .content p, p')).slice(0,3).map(function(p){return p.textContent}).join(' ').replace(/\\s+/g,' ').trim()").orEmpty()

    private fun isReader(): Boolean = tab()?.optString("url")?.startsWith("zen://reader") == true

    private fun tab(): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(TAB)

    private fun describeTab(): String {
        val tab = tab() ?: return "tab $TAB gone"
        return "url=${tab.optString("url").take(60)} title=\"${tab.optString("title").take(50)}\" readerable=${tab.optBoolean("readerable")}"
    }

    // --- the core's state ---------------------------------------------------------------------------------

    private fun fonts(): JSONObject = coreState().getJSONObject("settings").optJSONObject("fonts") ?: JSONObject()

    private fun languages(): List<String> {
        val a = coreState().getJSONObject("settings").optJSONArray("languages") ?: return emptyList()
        return (0 until a.length()).map { a.getString(it) }
    }

    private fun readerState(): JSONObject? = coreState().optJSONObject("translate")?.optJSONObject("reader")?.optJSONObject(TAB)

    private fun readerStatus(): String = readerState()?.optString("status").orEmpty()

    // --- keys ------------------------------------------------------------------------------------------------

    /** Type `text` as key events, each stamped as it is injected (PasswordsUiDemo's rule against stale events). */
    private fun typeText(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (ch in text) {
            val events = map.getEvents(charArrayOf(ch)) ?: continue
            for (event in events) {
                val now = SystemClock.uptimeMillis()
                if (!ui.injectInputEvent(KeyEvent.changeTimeRepeat(event, now, 0), true)) Log.w(tag, "a key was not injected")
                SystemClock.sleep(40)
            }
        }
    }

    // --- findings ------------------------------------------------------------------------------------------

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  ${if (ok) "PASS" else "FAIL"}: $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendText(line + "\n")
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: ""

    private fun jsonList(raw: String): List<String> =
        runCatching { val a = JSONArray(raw); (0 until a.length()).map { a.getString(it) } }.getOrDefault(emptyList())

    companion object {
        private const val PORT = 18152
        private const val HOST = "127.0.0.1"
        private const val TAB = "tab_article"
        /** The stills' and the frame files' prefix (the harness's `shotPrefix`). */
        private const val MEDIA_PREFIX = "services-fonts-languages-android"
        private const val FINDINGS = "fonts-languages-findings.txt"
        private const val LOOK_SECTION = "Look and Feel"
        private const val LANGUAGES_SECTION = "Languages"
        private const val FONTS_HEADING = "Customise fonts"
        private const val FONT_SIZE_ROW = "Font size"
        private const val MINIMUM_FONT_SIZE_ROW = "Minimum font size"
        private const val STANDARD_FONT_ROW = "Standard font"
        private const val RESET_ROW = "Reset fonts"
        private const val ADD_LANGUAGE_ROW = "Add language"
        private const val FILTER_LABEL = "Find a language"
        /** The app menu's row that opens the sheet (`core/menus.ts`; U+2026). */
        private const val PREFERENCES_ITEM = "Text Preferences…"
        /** `FONT_SIZE_STEPS` has 25 stops (index 7 is 16 px, index 10 is 20 px); `MINIMUM_FONT_SIZE_STEPS` 17 (index 7 is 12 px). */
        private const val FONT_SIZE_MAX_INDEX = 24
        private const val FONT_SIZE_TARGET_INDEX = 10
        private const val MINIMUM_FONT_SIZE_MAX_INDEX = 16
        private const val MINIMUM_FONT_SIZE_TARGET_INDEX = 7
        private val WORKING = setOf("detecting", "downloading", "translating")
        /** What a measured scene's block gives the motion after the finger (or the back). */
        private const val MOTION_MS = 3_000L

        private const val SCHEME_JS = "matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'"
        private const val BODY_FONT_SIZE_JS = "getComputedStyle(document.body).fontSize"
        private const val BODY_FONT_FAMILY_JS = "getComputedStyle(document.body).fontFamily"
        private const val SMALL_FONT_SIZE_JS = "getComputedStyle(document.getElementById('small-print')).fontSize"
        private const val ARTICLE_METRICS_JS = """
            (function () {
              var b = getComputedStyle(document.body), s = document.getElementById('small-print'), pre = document.querySelector('pre');
              return JSON.stringify({
                body: b.fontSize, family: b.fontFamily, small: s ? getComputedStyle(s).fontSize : '?', pre: pre ? getComputedStyle(pre).fontSize : '?',
                scrollHeight: document.documentElement.scrollHeight, scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
              });
            })()
        """
    }
}
