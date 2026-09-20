package app.zen.chromium

import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.util.Log
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
 * The `android-reader-ui-demo` workflow: the reader document's controls on the phone after the
 * document lost its toolbar (§10.1; CT-13, EDGE-13, EDGE-11), on the read-aloud demo's article
 * ([DemoServer], `read-aloud-demo-page.html`) and profile. Writes `reader-ui-findings.txt` next
 * to the stills (a `PASS` or `FAIL` per check; the run fails at its end when any did, or when a
 * touch did not take):
 *
 *  1. Reader View from the app menu (a real touch): the `zen://reader` document comes up with the
 *     title, the byline and the reading time, and with no toolbar in it (the four segmented
 *     groups are off the document; the Text preferences sheet is their one home). The pill at
 *     rest stays the favicon, the host and the one site-information glyph: no reader chip.
 *  2. The app menu's Text Preferences… (the phone's way in): the §9.13 sheet with the read-aloud
 *     row first, the four picker rows, then the extras – Text spacing, Line focus, Lines in
 *     focus, Syllables. The sheet opens at its peek, where the last rows sit below the fold; a
 *     finger pulls it to its expanded detent by its handle first (as the app menu is pulled).
 *     Real touches: Line focus on (the document's `data-line-focus` reads 3 and the page
 *     script's masks are in the document), Syllables on (`data-syllables`, the marks in the
 *     text), Lines in focus from 3 to 5 lines through its menulist's picker sheet (§9.13: the
 *     pick closes the sheet by itself), Text spacing to Wider (`data-spacing`) the same way.
 *  3. A phone read of the reader article: a real touch on the sheet's Listen to this article
 *     starts a session with `source: reader` (the sheet leaves; the player docks under the
 *     document); the engine speaks the reader document's sentences with the sentence highlight
 *     painted into the reader document itself, the line focus band following the sentence read;
 *     Pause under a finger; Close under a finger ends the session.
 *  4. Everything again in dark, for the design record: the reader document (its theme following
 *     the colour scheme), the sheet with the extras, the player.
 *
 * Frame stats ([FrameStats]; Bennett's rule of 2026-09-20, the Android program's PERF-3 scene
 * names as #259's driver uses them): the app menu opened under a finger and dismissed with a
 * back first, as the baseline (`menu-sheet-open` / `menu-sheet-close`), then the PR's own
 * scenes – the Text preferences sheet's open under the finger on the menu's row, its pull to the
 * expanded detent, and its dismiss on a back (`reader-prefs-sheet-open` / `-expand` / `-close`);
 * the Lines in focus and Text spacing pickers' open from the menulist and the pick that closes
 * them (`lines-in-focus-picker-open` / `-pick`, `text-spacing-picker-open` / `-pick`); the
 * player docking on Listen to this article and leaving on Close (`read-aloud-player-dock` /
 * `-close`). The table goes to `services-reader-android-frames.txt` and into the findings, the
 * scenes to `reader-ui-frames.json.txt`, the raw dumps to `services-reader-android-framestats.txt`.
 *
 * Every control pressed inside a sheet or the player is a real injected finger with an
 * assertion (#198's rule); the URL field, when a step leaves it open, is closed with
 * [closeUrlField] and its outcome read. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ReaderUiDemo : DemoHarness("read-aloud-demo-state.json", MEDIA_PREFIX, "reader-ui-demo") {
    override val tag = "ReaderUiDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private lateinit var frames: FrameStats
    private var failures = 0
    private var shots = 0
    private val host get() = (activity as MainActivity).host
    private var engineless = false

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("read-aloud-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            ReadAloud.availabilityOverride = null
        }
        if (failures > 0) throw AssertionError("$failures reader UI check(s) failed; see reader-ui-findings.txt")
    }

    override fun beforeLaunch() {
        // Without a speech engine the sheet's Listen row would be gone with the capability; the
        // override keeps the sheet's shape on record, and the read step expects the error state.
        engineless = runCatching {
            app.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0).isEmpty()
        }.getOrDefault(true)
        if (engineless) ReadAloud.availabilityOverride = true
    }

    override fun warmUp() {
        findings = File(out, "reader-ui-findings.txt")
        findings.writeText("Zenium Android reader UI checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        frames = FrameStats(tag, app.packageName, out, MEDIA_PREFIX, ::shell)
        finding("demo server: ${server.selfCheck()}")
        val caps = coreState().getJSONObject("capabilities")
        finding("capabilities: readAloud=${caps.optBoolean("readAloud")}${if (engineless) " (OVERRIDDEN: no engine on this image)" else ""} phone=${caps.optBoolean("phone")}")
        awaitLoaded("$ORIGIN/")
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        finding("article: ${describeTab()}; readerable=$readerable")
        check("the reader core finds the article readerable (what enables Reader View)", readerable)
        val close = closeUrlField()
        finding("URL field at warm-up: ${close.describe()}")
        check("the URL field is closed (or was never open) before the recording", close.ok)
        // The app menu once, off camera: the baseline scene reads a warm menu, as the Android
        // program's does (#259's driver opens it in its warm-up the same way).
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
            awaitSurface(up = false, timeoutMs = 8_000)
        }
        SystemClock.sleep(1_200)
    }

    override fun demo() {
        try {
            snap("article")
            beat()
            baselineScenes()
            if (!readerView()) {
                finding("\nReader View never came up; nothing else can be recorded")
                return
            }
            preferencesSheet()
            readTheArticle()
            dark()
            finding("\nend: ${describeTab()}${if (failures == 0) "" else "; $failures FAIL"}")
        } finally {
            val table = frames.table(
                "The PR's scenes: the Text preferences sheet (a §9.13 control panel over the reader document) opened from the app menu's row, pulled to its expanded detent and dismissed with a back; its Lines in focus and Text spacing pickers (§9.24 sheets over it) opened from the menulist and closed by the pick; the read-aloud player docking on Listen to this article and leaving on Close."
            )
            File(out, "$MEDIA_PREFIX-frames.txt").writeText(table)
            // The shared pull step takes *.png / *.txt from the handshake dir: the JSON goes out as a .txt.
            File(out, "reader-ui-frames.json.txt").writeText(frames.json().toString(2))
            finding("\n$table")
        }
    }

    // --- 0. the baseline scene: the app menu ------------------------------------------------------

    /**
     * The app menu – the sheet main had before this PR – under a finger on the bar's Menu button,
     * settled, then dismissed with a back: the before the PR's scenes read against, as two
     * readings under the Android program's names ([FrameStats]).
     */
    private fun baselineScenes() {
        ensureForeground()
        val opened = frames.scene("menu-sheet-open") {
            tapMenuButton()
            poll(6_000) { chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) != null }
        }
        check("PERF-3 baseline: the app menu opened under a finger (menu-sheet-open)", opened)
        if (!opened) {
            back()
            awaitSurface(up = false, timeoutMs = 8_000)
            return
        }
        val closed = frames.scene("menu-sheet-close") {
            back()
            awaitSurface(up = false, timeoutMs = 8_000) && waitForGone(MENU_HANDLE_LABEL, 8_000)
        }
        check("PERF-3 baseline: the app menu went on a back (menu-sheet-close)", closed)
        SystemClock.sleep(600)
    }

    // --- 1. Reader View: the document without its toolbar ------------------------------------------

    private fun readerView(): Boolean {
        finding("\nCT-13 / §10.1 Reader View from the app menu: the document carries no toolbar")
        val opened = openMenuItem("Reader View")
        if (!opened) {
            check("the app menu lists Reader View for the article", false)
            back()
            return false
        }
        val entered = poll(15_000) { isReader() }
        finding("  real touch on Reader View: ${describeTab()}")
        if (!entered) {
            touchFault("a touch on Reader View did not open the reader document")
            return false
        }
        val mounted = poll(15_000) { readerProbe().optString("title").isNotEmpty() }
        val probe = readerProbe()
        finding("  the reader document: $probe")
        // The article's <title> is "The lighthouse keeper's almanac: a long night of tides, …" and its
        // <h1> only the part before the colon, so the reader core's Readability title heuristic
        // (no heading reads the whole title; the part after the last colon has three words or
        // more) titles the document with the part after the colon – the engine's behaviour, as
        // in Firefox's Reader View; either is the article's title here.
        val title = probe.optString("title")
        check("the reader document renders the title, the byline and the reading time", mounted && (title.startsWith("The lighthouse keeper") || title.startsWith("a long night of tides")) && probe.optBoolean("byline") && probe.optBoolean("readingTime"))
        check("the document carries no toolbar of its own (§10.1)", mounted && !probe.optBoolean("toolbar"))
        val pill = pillProbe()
        finding("  the pill at rest: $pill")
        check("the pill at rest is the favicon, the host and one site-information glyph: no reader chip", pill.optInt("chips") == 1 && pill.optInt("siteInfo") == 1 && pill.optInt("readerChip") == 0)
        SystemClock.sleep(1_000)
        snap("reader-document")
        beat()
        return true
    }

    // --- 2. the Text preferences sheet with the extras ---------------------------------------------

    private fun preferencesSheet() {
        finding("\nEDGE-13 / §9.13 the Text preferences sheet (the app menu's Text Preferences…)")
        if (!openSheet(scenes = true)) return
        val rows = sheetRows()
        finding("  rows: $rows")
        check("the sheet's rows: Listen to this article, then Text size, Font, Colour theme, Column width, then Text spacing, Line focus, Lines in focus, Syllables",
            rows.indexOf("Listen to this article") == 0 && listOf("Text size", "Font", "Colour theme", "Column width", "Text spacing", "Line focus", "Lines in focus", "Syllables").all { it in rows } && rows.indexOf("Text spacing") < rows.indexOf("Line focus") && rows.indexOf("Line focus") < rows.indexOf("Lines in focus") && rows.indexOf("Lines in focus") < rows.indexOf("Syllables"))
        val heights = menulistHeights()
        finding("  the picker menulists' heights (CSS px): $heights")
        check("the sheet's menulists are the phone's 40 px controls", heights.isNotEmpty() && heights.all { Math.abs(it - 40.0) <= 1.0 })
        val linesDisabled = switchRow("Lines in focus")?.isEnabled == false || rowNode("Lines in focus")?.let { !it.isEnabled } == true
        finding("  at rest: Line focus ${switchState("Line focus")}, Syllables ${switchState("Syllables")}; Lines in focus enabled=${!linesDisabled}")
        check("the extras rest off with Lines in focus disabled under Line focus", switchState("Line focus") == "false" && switchState("Syllables") == "false")
        snap("preferences-sheet")
        beat()

        // Line focus on: a real touch on the switch row.
        touchTapLabelExpecting("Line focus", "the reader document carries data-line-focus 3", timeoutMs = 6_000, prefix = true) { readerProbe().optString("lineFocus") == "3" }
        var probe = readerProbe()
        finding("  after Line focus: switch ${switchState("Line focus")}; document $probe")
        check("Line focus on: settings.reader.lineFocus 3, the document's data-line-focus 3 and the page script's masks in it", switchState("Line focus") == "true" && probe.optString("lineFocus") == "3" && probe.optInt("masks") >= 2)
        // Syllables on: the last row. The sheet was pulled to its expanded detent when it opened
        // (openSheet), where the nine rows fit the screen; when the tree still has the row below
        // the fold (the emulator's tree lags the pull), it is scrolled into view through the tree
        // first and the finger goes in after – the claim stays with the touch.
        val syllablesOn = { readerProbe().optString("syllables") == "true" }
        if (revealPrefix("Syllables")) touchTapLabelExpecting("Syllables", "the reader document carries data-syllables", timeoutMs = 6_000, prefix = true, took = syllablesOn)
        else finding("  no row on screen reads Syllables")
        probe = readerProbe()
        finding("  after Syllables: switch ${switchState("Syllables")}; document $probe")
        check("Syllables on: the document's data-syllables true and the page script's marks in the text", switchState("Syllables") == "true" && probe.optString("syllables") == "true" && probe.optInt("marks") > 0)
        // The switch's thumb and the row's pressed state settle after the probe reads the new
        // value (run 2's still caught the thumb mid-slide): a beat before the design record.
        SystemClock.sleep(800)
        snap("preferences-sheet-extras-on")
        beat()
        // Lines in focus: 3 -> 5 through its picker sheet. A §9.13 control-panel row's tap target
        // is its control – the 40 menulist reading the value ("3 lines") – not the row's label.
        // The picker's open and the pick that closes it (§9.13, #247) are a scene each.
        revealPrefix("Lines in focus")
        val picker = frames.scene("lines-in-focus-picker-open") {
            touchControlExpecting("Lines in focus", "the Lines in focus picker lists 1 / 3 / 5 lines", timeoutMs = 6_000) { rowNode("5 lines") != null && rowNode("1 line") != null }
        }
        if (picker) {
            SystemClock.sleep(800)
            snap("lines-in-focus-picker")
            frames.scene("lines-in-focus-picker-pick") {
                touchTapLabelExpecting("5 lines", "the document's data-line-focus reads 5 and the picker closed", timeoutMs = 6_000) { readerProbe().optString("lineFocus") == "5" && rowNode("1 line") == null }
            }
            probe = readerProbe()
            finding("  after 5 lines: document $probe; picker gone=${rowNode("1 line") == null}; the menulist reads ${menulistValue("Lines in focus")}")
            check("5 lines: the pick closes the picker on its own (§9.13) and the document's band is five lines", probe.optString("lineFocus") == "5" && rowNode("1 line") == null)
        } else {
            check("the Lines in focus menulist opens its picker", false)
        }
        // Text spacing: Normal -> Wider through its menulist (Column width has a "Wide" of its own;
        // "Wider" is spacing's alone).
        revealPrefix("Text spacing")
        val spacing = frames.scene("text-spacing-picker-open") {
            touchControlExpecting("Text spacing", "the Text spacing picker lists Wider", timeoutMs = 6_000) { rowNode("Wider") != null }
        }
        if (spacing) {
            frames.scene("text-spacing-picker-pick") {
                touchTapLabelExpecting("Wider", "the document's data-spacing reads wider", timeoutMs = 6_000) { readerProbe().optString("spacing") == "wider" }
            }
            probe = readerProbe()
            finding("  after Wider: document $probe")
            check("Text spacing Wider: the document's data-spacing wider (the stylesheet's letter, word and line spacing)", probe.optString("spacing") == "wider")
        } else {
            check("the Text spacing menulist opens its picker", false)
        }
        // The band re-placed at the wider line height (readerExtras.ts's relayout on the root's
        // typography change), before the still that records it.
        SystemClock.sleep(800)
        snap("preferences-sheet-wider-five-lines")
        beat()
        // The system back closes the sheet alone (the `reader-prefs-sheet-close` scene); the
        // document keeps its extras.
        val closed = backFromSheet(scene = true)
        probe = readerProbe()
        finding("  back: sheet gone=$closed; document $probe")
        check("back closes the sheet and the document keeps line focus 5, syllables, wider spacing", closed && probe.optString("lineFocus") == "5" && probe.optString("syllables") == "true" && probe.optString("spacing") == "wider")
        SystemClock.sleep(800)
        snap("reader-line-focus-syllables")
        beat()
    }

    // --- 3. a phone read of the reader article -----------------------------------------------------

    private fun readTheArticle() {
        finding("\nCT-13 / EDGE-11 Listen to this article from the sheet: the reader document read with the highlight in it")
        if (!openSheet()) return
        // The finger on Listen, the sheet leaving and the player docking under the document are
        // one scene (`read-aloud-player-dock`: the sheet's slide out and the docked panel's in).
        var sheetGone = false
        var panel = false
        frames.scene("read-aloud-player-dock") {
            touchTapLabelExpecting("Listen to this article", "a session starts from the reader document", timeoutMs = 10_000) { readAloud() != null }
            sheetGone = poll(6_000) { findNode { it == "Listen to this article" } == null }
            panel = poll(8_000) { panelUp() }
            sheetGone && panel
        }
        val session = readAloud()
        finding("  real touch on Listen to this article: session ${session?.let { "up: status=${it.optString("status")} source=${it.optString("source")} sentences=${it.optInt("sentenceCount")}" } ?: "MISSING"}")
        check("the session's source is the reader document (source: reader)", session?.optString("source") == "reader")
        finding("  the sheet left=$sheetGone; the player docked=$panel (${panelBounds()})")
        check("the sheet leaves and the player docks under the reader document", sheetGone && panel)
        if (engineless) {
            val error = poll(20_000) { status() == "error" }
            finding("  no engine on this image: status ${status()} (error=$error)")
            check("without an engine the player shows its error line", error)
            snap("player-reader-error")
        } else {
            val playing = poll(30_000) { status() == "playing" }
            val s = readAloud()
            finding("  status -> playing: $playing; session=$s")
            check("the engine speaks the reader document (playing; more than one sentence)", playing && (s?.optInt("sentenceCount") ?: 0) > 1)
            val painted = poll(8_000) { readerHighlight().optBoolean("sentence") }
            val hl = readerHighlight()
            finding("  the reader document's highlight (CSS Custom Highlight API, the core's page script): $hl")
            check("the sentence highlight is painted into the reader document itself", painted)
            val band = poll(8_000) { readerProbe().optInt("bandTop", -1) > 0 }
            finding("  the line focus band: ${readerProbe()}")
            check("the line focus band follows the sentence being read (the masks leave a window on it)", band)
            SystemClock.sleep(1_000)
            snap("player-reader-playing")
            beat()
            touchTapLabelExpecting("Pause", "the session reads paused", timeoutMs = 6_000) { status() == "paused" }
            finding("  after Pause: status=${status()} progress '${progressText()}'")
            check("a real touch on Pause pauses the reading", status() == "paused")
            SystemClock.sleep(600)
            snap("player-reader-paused")
            beat()
        }
        var gone = false
        frames.scene("read-aloud-player-close") {
            touchTapLabelExpecting("Close", "the session ends", timeoutMs = 6_000) { readAloud() == null }
            gone = poll(6_000) { !panelUp() }
            gone
        }
        finding("  after Close: session=${readAloud()}; panel gone=$gone")
        check("Close ends the session and the player leaves", readAloud() == null && gone)
        beat()
    }

    // --- 4. dark ---------------------------------------------------------------------------------

    private fun dark() {
        finding("\ndesign record: the reader document, the sheet and the player in dark")
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        val probe = readerProbe()
        finding("  the reader document in dark: $probe")
        check("the reader's Default theme follows the colour scheme (the document paints dark: ${probe.optString("bg")})", probe.optString("scheme") == "dark" && probe.optString("bg").startsWith("rgb(24, 24, 28)"))
        snap("reader-document-dark")
        beat()
        if (openSheet()) {
            SystemClock.sleep(800)
            snap("preferences-sheet-dark")
            beat()
            touchTapLabelExpecting("Listen to this article", "a session starts in dark", timeoutMs = 10_000) { readAloud() != null }
            val up = poll(8_000) { panelUp() }
            if (!engineless) poll(20_000) { status() == "playing" }
            finding("  dark: session=${readAloud()}; player up=$up")
            check("dark: Listen to this article docks the player", up)
            SystemClock.sleep(1_200)
            snap("player-reader-dark")
            beat()
            touchTapLabelExpecting("Close", "the session ends", timeoutMs = 6_000) { readAloud() == null }
            SystemClock.sleep(1_200)
        }
        shell("cmd uimode night no")
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        SystemClock.sleep(1_500)
    }

    // --- the sheet ---------------------------------------------------------------------------------

    /**
     * The app menu's Text Preferences… under a finger; true once the sheet lists its rows. The
     * menu's own open and pull are the harness's ([openMenuItem]'s steps, outside any scene);
     * the finger on the row and the sheet coming up is the `reader-prefs-sheet-open` scene, the
     * pull to the expanded detent `reader-prefs-sheet-expand` – once per run, on the first sheet
     * (`scenes`); the later opens, the dark record's among them, play without a reading.
     */
    private fun openSheet(scenes: Boolean = false): Boolean {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            finding("  the app menu never opened on the reader page")
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
        if (reveal(MENU_ITEM) == null) {
            finding("  the app menu did not list $MENU_ITEM on the reader page")
            check("the app menu carries $MENU_ITEM on the reader page (the phone's way in, its pill having no chip)", false)
            back()
            return false
        }
        val sheetUp = { rowNode("Text size") != null }
        val up = if (scenes) {
            frames.scene("reader-prefs-sheet-open") { touchTapLabel(MENU_ITEM) && poll(8_000, sheetUp) }
        } else {
            touchTapLabel(MENU_ITEM) && poll(8_000, sheetUp)
        }
        if (!up) touchFault("a touch on $MENU_ITEM opened no sheet")
        check("a real touch on $MENU_ITEM opens the sheet", up)
        SystemClock.sleep(1_000)
        // The sheet opens at its peek, where the extras' rows sit below the fold and out of a
        // finger's reach (the first run: no node for Syllables, Lines in focus clipped at the
        // screen's bottom edge): pulled to its expanded detent by its handle, the way the app
        // menu is (DemoHarness.openMenuItem), the nine rows fit the screen.
        if (up) {
            val pull = {
                val handle = findByLabel(SHEET_HANDLE_LABEL)
                if (handle == null) {
                    false
                } else {
                    val before = handle.top
                    Finger().apply {
                        down(handle.exactCenterX(), handle.exactCenterY())
                        moveBy(0f, -0.4f * height, 130)
                        up()
                    }
                    // Settled once the handle holds still above where it was.
                    poll(4_000) { findByLabel(SHEET_HANDLE_LABEL)?.let { it.top < before - 40 * density } == true }
                }
            }
            val pulled = if (scenes) frames.scene("reader-prefs-sheet-expand", pull) else pull()
            if (scenes) finding("  the sheet pulled to its expanded detent by its handle: $pulled")
            SystemClock.sleep(2_000)
        }
        return up
    }

    /**
     * The system back on the sheet, as the `reader-prefs-sheet-close` scene when `scene`; true
     * once the sheet's title is gone and the host reports no surface.
     */
    private fun backFromSheet(scene: Boolean): Boolean {
        val gone = {
            back()
            poll(6_000) { findNode { it == "Text preferences" } == null && !chromeSurfaceUp() }
        }
        return if (scene) frames.scene("reader-prefs-sheet-close", gone) else gone()
    }

    /**
     * Scroll the row whose text starts with `label` into view through the tree
     * (ACTION_SHOW_ON_SCREEN, as [reveal] does for an exact label; a switch row's text runs its
     * label and description together), so the finger that follows has bounds on screen to land
     * in. False when no node reads it.
     */
    private fun revealPrefix(label: String): Boolean {
        val node = findNode { it == label || it.startsWith(label) } ?: return false
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_200)
        return true
    }

    /**
     * A real touch on the control of the §9.13 row labelled `label` – the 40 menulist, a button
     * whose accessible name is the row's label (`V2Menulist`'s `aria-label`) – then up to
     * `timeoutMs` for `took`, as [touchTapLabelExpecting]. The row's label span reads the same
     * text and comes first in the tree (the first run's finger landed on it, and a label opens
     * nothing), so the finger goes to the clickable node reading the label; when the tree offers
     * none, to the menulist's rect as the chrome's DOM lays it out (OmniboxDemo's fallback).
     * False, with a [touchFault], when the touch went in and `took` never held; false and a
     * finding when there was nothing to touch.
     */
    private fun touchControlExpecting(label: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        val reads = { node: AccessibilityNodeInfo ->
            val text = (node.text ?: node.contentDescription)?.toString()
            text != null && (text == label || text.startsWith("$label ") || text.startsWith("$label,"))
        }
        val control = findNodeWhere { node -> node.isClickable && reads(node) }
        val point = if (control != null) {
            touchTapPoint(control)
        } else {
            menulistDomRect(label)?.let { rect ->
                touchPoint(rect)?.also { Finger().tap(it.x, it.y) }
            }
        }
        if (point == null) {
            finding("  nothing to touch for the $label control (tree node: ${control != null}; DOM rect: ${menulistDomRect(label)})")
            return false
        }
        Log.i(tag, "touch at ${point.x},${point.y} on the $label control (${if (control != null) "tree" else "DOM rect"})")
        if (poll(timeoutMs, took)) return true
        touchFault("a touch on the $label control did not take: not $effect within $timeoutMs ms")
        return false
    }

    /** The menulist in the row labelled `label`, as the chrome's DOM lays it out, in screen px; null when there is none. */
    private fun menulistDomRect(label: String): Rect? {
        val text = jsonString(chromeJs(
            "(function(){var rows=Array.from(document.querySelectorAll('[data-reader-prefs-rows] .zen-v2-row'));" +
                "var r=rows.find(function(e){var l=e.querySelector('.truncate');return l&&(l.textContent||'').trim()===${JSONObject.quote(label)}});" +
                "var m=r&&r.querySelector('.zen-v2-menulist');if(!m)return '';var b=m.getBoundingClientRect();" +
                "return [b.left,b.top,b.right,b.bottom].map(function(v){return Math.round(v*$density)}).join(',')})()"
        ))
        val px = text.split(',').map { it.toIntOrNull() ?: return null }
        if (px.size != 4) return null
        return Rect(px[0], px[1], px[2], px[3])
    }

    /** What the menulist in the row labelled `label` reads, from the chrome's document. */
    private fun menulistValue(label: String): String = jsonString(chromeJs(
        "(function(){var rows=Array.from(document.querySelectorAll('[data-reader-prefs-rows] .zen-v2-row'));" +
            "var r=rows.find(function(e){var l=e.querySelector('.truncate');return l&&(l.textContent||'').trim()===${JSONObject.quote(label)}});" +
            "var m=r&&r.querySelector('.zen-v2-menulist');return m?(m.textContent||'').trim():''})()"
    ))

    /** The sheet's row labels in order, from the chrome's own document. */
    private fun sheetRows(): List<String> {
        val raw = jsonString(chromeJs(
            "(function(){var r=document.querySelector('[data-reader-prefs-rows]');if(!r)return '[]';" +
                "return JSON.stringify(Array.from(r.querySelectorAll('.zen-v2-row')).map(function(e){var l=e.querySelector('.truncate');return l?(l.textContent||'').trim():''}).filter(Boolean))})()"
        ))
        return runCatching { val a = org.json.JSONArray(raw); (0 until a.length()).map { a.getString(it) }.distinct() }.getOrDefault(emptyList())
    }

    private fun menulistHeights(): List<Double> {
        val raw = jsonString(chromeJs(
            "(function(){var r=document.querySelector('[data-reader-prefs-rows]');if(!r)return '[]';" +
                "return JSON.stringify(Array.from(r.querySelectorAll('.zen-v2-menulist')).map(function(m){return m.getBoundingClientRect().height}))})()"
        ))
        return runCatching { val a = org.json.JSONArray(raw); (0 until a.length()).map { a.getDouble(it) } }.getOrDefault(emptyList())
    }

    /** The `aria-checked` of the switch row reading `label` (`"true"` / `"false"`), from the chrome's document. */
    private fun switchState(label: String): String = jsonString(chromeJs(
        "(function(){var rows=Array.from(document.querySelectorAll('[data-reader-prefs-rows] [role=switch]'));" +
            "var r=rows.find(function(e){return (e.textContent||'').indexOf(${JSONObject.quote(label)})===0});return r?String(r.getAttribute('aria-checked')):''})()"
    ))

    private fun switchRow(label: String): AccessibilityNodeInfo? = findNodeWhere { node ->
        node.isCheckable && ((node.text ?: node.contentDescription)?.toString()?.startsWith(label) == true)
    }

    /** The row (or control) reading `label`: the clickable node reading it alone or with a description after it. */
    private fun rowNode(label: String): AccessibilityNodeInfo? {
        val reads = { node: AccessibilityNodeInfo ->
            val text = (node.text ?: node.contentDescription)?.toString()
            text != null && (text == label || text.startsWith("$label ") || text.startsWith("$label\n"))
        }
        return findNodeWhere { node -> node.isClickable && reads(node) } ?: findNodeWhere(reads)
    }

    // --- the player ----------------------------------------------------------------------------------

    private fun readAloud(): JSONObject? = coreState().optJSONObject("readAloud")
    private fun status(): String = readAloud()?.optString("status").orEmpty()
    private fun panelUp(): Boolean = findNode { it == PANEL_LABEL } != null || findNode { it == "Previous sentence" } != null
    private fun panelBounds(): Rect? = findNode { it == PANEL_LABEL }?.let { Rect().also(it::getBoundsInScreen) }
    private fun progressText(): String =
        jsonString(chromeJs("(function(){var e=document.querySelector('.zen-read-aloud-progress');return e?e.textContent.trim():''})()"))

    // --- the pill ------------------------------------------------------------------------------------

    /** The phone pill's chips, from the chrome's document: how many, the site-information glyph, any reader chip. */
    private fun pillProbe(): JSONObject {
        val raw = jsonString(chromeJs(
            "(function(){var p=document.querySelector('.zen-phone-pill');if(!p)return '{}';" +
                "return JSON.stringify({chips:p.querySelectorAll('[data-pill-chip]').length,siteInfo:p.querySelectorAll('[data-site-info]').length," +
                "readerChip:p.querySelectorAll('[data-reader-prefs-chip]').length,text:(p.textContent||'').trim().slice(0,40)})})()"
        ))
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    // --- the reader document --------------------------------------------------------------------------

    private fun isReader(): Boolean = tab()?.optString("url")?.startsWith("zen://reader") == true

    /**
     * What the reader document shows, from inside it: the title, whether the byline and the
     * reading time are there, whether any toolbar is (there must be none), the extras' root
     * attributes and what the page script painted for them (the line focus masks, the syllable
     * marks, the band's top), the theme the document resolved to.
     */
    private fun readerProbe(): JSONObject {
        val raw = pageJs(
            "(function(){var d=document,r=d.documentElement;var meta=d.querySelector('header .meta');var top=d.querySelector('.zen-focus-mask[data-edge=\"top\"]');" +
                "return JSON.stringify({title:(d.querySelector('header h1')||{}).textContent||'',byline:!!(meta&&/Zenium read-aloud demo|127\\.0\\.0\\.1/.test(meta.textContent)),readingTime:!!(meta&&/min read/.test(meta.textContent))," +
                "toolbar:!!d.querySelector('nav.toolbar, .toolbar, [data-set], [data-size]'),lineFocus:r.getAttribute('data-line-focus')||'0',syllables:r.getAttribute('data-syllables')||'false'," +
                "spacing:r.getAttribute('data-spacing')||'normal',masks:d.querySelectorAll('.zen-focus-mask').length,marks:d.querySelectorAll('.zen-syl').length," +
                "bandTop:top?Math.round(top.getBoundingClientRect().height):-1,theme:r.getAttribute('data-theme')||''," +
                "bg:getComputedStyle(d.body).backgroundColor,scheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    private fun readerHighlight(): JSONObject {
        val raw = pageJs(
            "(function(){var h=window.CSS&&CSS.highlights;return JSON.stringify({api:!!h," +
                "sentence:!!(h&&h.has('zenium-read-sentence')),word:!!(h&&h.has('zenium-read-word'))})})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    /** Evaluate in the demo tab's page (the reader document once Reader View is on); the raw JSON-encoded result. */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    private fun tab(): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(TAB)

    private fun describeTab(): String {
        val tab = tab() ?: return "tab $TAB gone"
        return "url=${tab.optString("url").take(60)} title=\"${tab.optString("title").take(50)}…\" readerable=${tab.optBoolean("readerable")}"
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = tab()
            if (tab != null && tab.optString("url") == url && !tab.optBoolean("loading")) {
                SystemClock.sleep(800)
                return
            }
            SystemClock.sleep(400)
        }
        finding("  the article never finished loading: ${describeTab()}")
    }

    private fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "shell failed: $it" }

    // --- findings -------------------------------------------------------------------------------------

    private fun snap(name: String) = shot("%02d-%s".format(++shots, name))

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

    companion object {
        private const val PORT = 18148
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB = "tab_demo"
        /** The stills' and the frame files' prefix (the harness's `shotPrefix`). */
        private const val MEDIA_PREFIX = "services-reader-android"
        /** The app menu's row that opens the sheet (`core/menus.ts`; U+2026). */
        private const val MENU_ITEM = "Text Preferences…"
        /** The player's `role=region` label (`ReadAloudPanel`). */
        private const val PANEL_LABEL = "Read aloud"
        /** The Text preferences sheet's handle (`ReaderPreferencesSheet`'s `handleLabel`). */
        private const val SHEET_HANDLE_LABEL = "Resize text preferences"
    }
}
