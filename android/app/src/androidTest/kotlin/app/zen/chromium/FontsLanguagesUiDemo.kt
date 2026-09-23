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
 *  2. CT-25 Customise fonts, in dark: Font size and Minimum font size are §10.4's ± rows on the
 *     phone (the value on the label's line, the 44 px Decrease / Increase buttons about the
 *     track, no end labels – the lead check on #350, ruling 1); three fingers on Font size's +
 *     step it to 20 (each press applied at once: the core's `settings.fonts.size` 20 and the
 *     open article's body text at 20 px), seven on Minimum font size's + to 12 (the article's
 *     11 px small print lifted to 12), Standard font through its picker sheet (each face drawn
 *     in itself, the sheet open expanded at the checked face) to Cursive, the Reset row
 *     appearing once anything stands off the defaults, the preview row following – and the
 *     article reflowed when Settings closes, still the same document.
 *  3. CT-23 back to Light the same way, the article following again; Reset fonts under a finger
 *     puts the type back (16 px, no floor, the platform's face) on the open page, no
 *     confirmation asked (ruling 8).
 *  4. CT-41 Preferred languages: the list's §10.4 item rows in order – a plain row, no ⋯ and no
 *     chevron, the whole row opening its item sheet (ruling 2) – German's sheet (titled German:
 *     Move Up / Move Down / Remove as action rows, Move Down at .4 on the last row, Remove in
 *     the plain ink) under a finger, Move Up under a finger puts German first
 *     (`settings.languages`) with the sheet standing, Move Up now at .4, and a back closing it;
 *     Add language opens the section's find-and-pick PAGE (`zen://settings/languages/add`, a
 *     drill-in with the filter field pinned over the list, ruling 3), `basq` typed into it
 *     narrows the list to Basque, a finger on Basque adds it and the page leaves; the phone
 *     copy says pages receive the system's languages.
 *  5. CT-36 Reader View's Text preferences: Translate is the head's one action row after Listen
 *     (both with their glyph, the setting rows with none: rulings 4 and 5), Text spacing whole
 *     above the peek's fold; Translate under a finger opens the target picker sheet – expanded,
 *     scrolled to the checked German (the first preferred language after the move), every
 *     language named in itself under the English from the shipped table (ruling 7) – and
 *     German under a finger translates on the pick: the row turns busy with the progress as its
 *     second line (the model coming down, the blocks done), the article turns German in place,
 *     the row gives way to the Show original switch whose second line names the target; Show
 *     original under a finger shows the English and again the German; the back closes the
 *     sheet on the translated document.
 *
 * The jank record ([traceFrames], `frames.jsonl`; Bennett's rule of 2026-09-20 and the Android
 * program's PERF-3 harness): the app menu opened under a finger and dismissed with a back first
 * (`menu-sheet-open` / `menu-sheet-close`, the table's point of reference), then this PR's
 * scenes – the colour scheme picker's open and the pick that closes it
 * (`colour-scheme-picker-open` / `-pick`), the two runs of step presses
 * (`font-size-step-presses`, `minimum-font-size-step-presses`, `gesture`: the fingers on the +
 * in turn, each stepping the row's own value, the sequence committed once when it is quiet –
 * the Android performance gate's ruling, [stepPresses]: at most three long tasks over the whole
 * sequence, exactly one `fonts.apply` in its trace, the value moved on every press; and before
 * them one press on Font size's +, `font-size-single-press`, reported alone – its long tasks
 * by CPU and by wall, its one `fonts.apply`, its one move – undone on the − outside any scene),
 * the font picker's open and pick
 * (`font-family-picker-open` / `-pick`), the language row's item sheet open and its Move Up
 * (`language-item-sheet-open` / `-move-up`), Add language's page open and the pick that leaves
 * it (`add-language-page-open` / `-pick`), the Text preferences sheet's open and its close on a
 * back (`reader-prefs-sheet-open` / `-close`), the reader's target picker open and the pick
 * that translates (`reader-translate-picker-open` / `-pick`), every sheet and page scene
 * `open`. Each block is the finger (or the back) and [MOTION_MS] for what it does, nothing
 * else – the node found and the point fixed BEFORE the block, the claim polled AFTER it
 * ([scene]). Every scene carries the
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
 *
 * The tree is read past UiAutomation's cache wherever a claim rests on it ([awaitRow],
 * [fingerWhere], [poll]: the cache dropped and a frame asked of the chrome each round, the
 * harness's remedy above [dropTreeCache]). Where the WebView's tree lags a section's drill-in
 * from the landing – it did for every Settings row in runs 35747286900 and 35754718133, fifteen
 * seconds on, while the screen and the chrome's document had them all, as in #305's run – the
 * chrome's own document places the finger ([awaitRow], [rowPoint], [controlPoint],
 * [optionPoint]) and the finding says so; a sheet's claims are the document's word ([sheetUp],
 * [sheetLists]) with the tree's noted beside it. A text field is found by its hint
 * ([findField]): the WebView keeps a field's name there, not in its text.
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

    /** The harness's notes (how long the tree took to list a control) go into the findings too. */
    override fun noteLine(line: String) {
        if (::findings.isInitialized) finding(line) else super.noteLine(line)
    }

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
     * A finger on the node reading `label` ([fingerOn]: read past the cache), then up to
     * `timeoutMs` for `took`, the step's claim named by `effect` – the harness's
     * [touchTapLabelExpecting] with the tree read fresh on both sides. A miss is a [touchFault]
     * either way; false when nothing on screen reads `label`.
     */
    private fun pressExpecting(label: String, effect: String, timeoutMs: Long = 6_000, prefix: Boolean = false, took: () -> Boolean): Boolean {
        val at = fingerOn(label, prefix) ?: run {
            touchFault("nothing on screen reads '$label' to touch (for: $effect)")
            return false
        }
        Finger().tap(at)
        if (poll(timeoutMs, took)) {
            Log.i(tag, "the touch on '$label' took: $effect")
            return true
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /**
     * Where a finger lands on the node reading `label` (exactly, or with a description or value
     * running on after it when `prefix`, as a Settings row's text does – a space, a line, or the
     * comma a value row's name puts before its value: "Colour scheme, Light"), found now – before
     * a scene's clock starts – past the cache ([awaitFresh]) and settled ([steadyBounds]); null,
     * with a finding, when nothing on screen reads it or no part of it is inside the touchable
     * window.
     */
    private fun fingerOn(label: String, prefix: Boolean = false, timeoutMs: Long = 8_000): PointF? =
        fingerWhere(label, timeoutMs) {
            it == label || (prefix && (it.startsWith("$label ") || it.startsWith("$label\n") || it.startsWith("$label,")))
        }

    private fun fingerWhere(what: String, timeoutMs: Long = 8_000, matches: (String) -> Boolean): PointF? {
        val node = awaitFresh(timeoutMs, "'$what'", matches) ?: run {
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

    /**
     * Where a finger lands on the text field named `label` ([findField]: the WebView keeps a
     * field's name in the EditText's hint), read past the cache for up to `timeoutMs`; when the
     * tree never lists it, the box the chrome's own document gives for `selector`. Null, with a
     * finding, when neither has it.
     */
    private fun fieldPoint(label: String, selector: String, timeoutMs: Long = 8_000): PointF? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            dropTreeCache()
            val node = findField(label)
            if (node != null) {
                val point = steadyBounds(node)?.let { touchPoint(it) }
                if (point != null) return point
            }
            nudgeFrame()
            SystemClock.sleep(250)
        }
        val box = chromeRect(selector) ?: run {
            finding("  no field named '$label' in the tree or the chrome's document")
            return null
        }
        finding("  the tree lists no field named '$label'; the finger goes to the chrome's box for it, $box")
        return touchPoint(box)
    }

    /**
     * The Settings row `rowId` (its label `label`) scrolled into view, and where it is on screen.
     * The tree first: read past UiAutomation's cache ([freshNodes], a frame asked of the chrome
     * between reads) for up to `timeoutMs`, then [revealRow]'s bounds. When the tree never lists
     * it, the chrome's own box for `[data-row=rowId]` once the document has scrolled the row to
     * the middle ([domRow]) – with a finding saying the document stood in. Null, with the rows
     * the document holds, when the document has no such row either.
     *
     * Why the document stands in: the WebView's accessibility tree trails a section's drill-in
     * from the landing (the landing turning inert as the pane mounts) and stays behind until a
     * later change – a sheet coming up – wakes it: runs 35747286900 and 35754718133 polled fifteen
     * seconds for Colour scheme while the screen and the document had every row, and #305's run
     * met the same (its finger went to the DOM's box too), while a section opened straight at
     * its URL (the warm-up's `page.open`, #305's deep-linked Privacy) is listed at once. Chromium
     * itself serialises the transition within a frame (the AX tree read over CDP in the preview
     * host has the region and its rows 100 ms after the tap, the inert landing's rows gone), so
     * the rows are there for assistive tech; the emulator's WebView is what lags.
     */
    private fun awaitRow(rowId: String, label: String, timeoutMs: Long = ROW_WAIT_MS): Rect? {
        val start = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - start < timeoutMs) {
            if (freshNodes { it.startsWith(label) }.isNotEmpty()) {
                val took = SystemClock.uptimeMillis() - start
                if (took > 1_000) finding("  (the tree listed the $label row after $took ms)")
                revealRow(label)?.let { return it }
                break
            }
            nudgeFrame()
            SystemClock.sleep(250)
        }
        val box = domRow(rowId)
        if (box == null) {
            finding("  (neither the tree nor the chrome's document has the $label row; the document's rows: ${domRows()})")
            return null
        }
        finding("  (the tree has not listed the $label row ${SystemClock.uptimeMillis() - start} ms after the drill-in; the chrome's document stands in: its box $box)")
        return box
    }

    /**
     * The chrome document's box for the Settings row `rowId`, scrolled to the middle of its pane
     * first (an instant scroll, so the box is at rest when read); null when the document has no
     * such row.
     */
    private fun domRow(rowId: String): Rect? {
        val scrolled = chromeString(
            "(function(){var r=document.querySelector('[data-row=\"$rowId\"]');if(!r)return 'none';" +
                "r.scrollIntoView({block:'center',behavior:'instant'});return 'ok'})()"
        )
        if (scrolled != "ok") return null
        SystemClock.sleep(400)
        return chromeRect("[data-row=\"$rowId\"]")?.takeUnless { it.isEmpty }
    }

    /**
     * Where a finger lands on the Settings row `rowId` reading `label`: [awaitRow]'s box – the
     * tree's when it lists the row, the document's otherwise – inside the touchable window. Null,
     * with a finding, when neither has the row or no part of it can be touched.
     */
    private fun rowPoint(rowId: String, label: String): PointF? {
        val box = awaitRow(rowId, label) ?: return null
        return touchPoint(box) ?: run {
            finding("  no part of the $label row ($box) is inside the touchable window")
            null
        }
    }

    /**
     * Where a finger lands on a control reading `label` inside the section or a sheet: the
     * tree's node ([fingerOn]'s match, `prefix` as there) when the tree lists it within
     * `timeoutMs`, else the chrome document's box for `element` (a script evaluating to the
     * element, [chromeRectOf]) – the same lag as [awaitRow]'s, met on a row's own control (a
     * language row's ⋯) or, should a sheet not wake the tree, its options. A finding says when
     * the document stood in; null when neither has the control.
     */
    private fun controlPoint(label: String, element: String, prefix: Boolean = false, timeoutMs: Long = CONTROL_WAIT_MS): PointF? {
        val node = awaitFresh(timeoutMs, "'$label'") {
            it == label || (prefix && (it.startsWith("$label ") || it.startsWith("$label\n") || it.startsWith("$label,")))
        }
        if (node != null) {
            val bounds = steadyBounds(node)
            val point = bounds?.let { touchPoint(it) }
            if (point != null) return point
            finding("  '$label' is in the tree but not to touch (${bounds ?: "gone"}); the document is asked")
        }
        val box = chromeRectOf(element)?.takeUnless { it.isEmpty } ?: run {
            finding("  nothing on screen reads '$label' (the tree within $timeoutMs ms, the document neither)")
            return null
        }
        finding("  (the tree has not listed '$label'; the chrome's document stands in: its box $box)")
        return touchPoint(box) ?: run {
            finding("  no part of '$label' ($box) is inside the touchable window")
            null
        }
    }

    /**
     * A sheet's option or item reading `text` – a picker's radio row, an item sheet's action
     * row, the Add language page's row – through [controlPoint], the document's element the
     * topmost surface's control whose label starts with `text` ([sheetControlJs]).
     */
    private fun optionPoint(text: String, prefix: Boolean = false): PointF? = controlPoint(text, sheetControlJs(text), prefix = prefix)

    /**
     * A script evaluating to the topmost surface's control (a radio row, a menu item, an option,
     * a button) whose label – its `.zen-settings-label`, the v2 row's `.zen-v2-label` or its
     * `.truncate` line, else its own text – is `text` or starts with it before a space or a
     * line; null without a surface or such a control. The surface is the LAST sheet in the
     * document (a picker stacked over the Text preferences sheet is the one the finger is for),
     * else the Add language page (no sheet: its list is the surface).
     */
    private fun sheetControlJs(text: String): String =
        "(function(){var q=${JSONObject.quote(text)};var root=$LAST_SURFACE_JS;if(!root)return null;" +
            "var cs=Array.from(root.querySelectorAll('[role=\"radio\"], [role=\"menuitem\"], [role=\"option\"], button'));" +
            "return cs.find(function(c){var l=c.querySelector('.zen-settings-label, .zen-v2-label, .truncate')||c;var t=(l.textContent||'').trim();" +
            "return t===q||t.indexOf(q+' ')===0||t.indexOf(q+'\\n')===0})||null})()"

    /** Whether a sheet (a picker, an item sheet, the Text preferences) stands in the chrome's document. */
    private fun sheetUp(): Boolean = chromeHas(".zen-sheet, [role=\"dialog\"]")

    /** The topmost sheet's title (the dialog's `aria-labelledby` text, `h2.zen-sheet-title`), "" without a sheet. */
    private fun sheetTitle(): String = chromeString(
        "(function(){var ds=document.querySelectorAll('[role=\"dialog\"]');var d=ds[ds.length-1];if(!d)return '';" +
            "var n=d.getAttribute('aria-label');if(n)return n;var id=d.getAttribute('aria-labelledby');var t=id&&document.getElementById(id);" +
            "t=t||d.querySelector('.zen-sheet-title');return t?(t.textContent||'').trim():''})()"
    )

    /** Whether the Add language page stands in the chrome's document (`AddLanguagePage.tsx`). */
    private fun addPageUp(): Boolean = chromeHas(ADD_PAGE_SELECTOR)

    /** Whether the reader's target picker stands: its radiogroup named Translate into (`V2MenulistSheet`). */
    private fun targetPickerUp(): Boolean = chromeHas("[role=\"radiogroup\"][aria-label=\"Translate into\"]")

    /** Whether the open sheet lists a control whose label starts with `text` (the document's word, past the tree's lag). */
    private fun sheetLists(text: String): Boolean = chromeJs("Boolean(${sheetControlJs(text)})").trim() == "true"

    /**
     * Whether the value row `rowId` reads `label` … `value` – the tree's word ([rowReads]) or, past
     * its lag, the document's: the row's accessible name (`aria-label`, "Colour scheme, Dark"
     * since #305) else its text.
     */
    private fun rowValueReads(rowId: String, label: String, value: String): Boolean {
        if (rowReads(label, value)) return true
        val name = chromeString(
            "(function(){var r=document.querySelector('[data-row=\"$rowId\"]');if(!r)return '';" +
                "return (r.getAttribute('aria-label')||r.textContent||'').replace(/\\s+/g,' ').trim()})()"
        )
        return name.startsWith(label) && name.endsWith(value)
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
            // The host dispatches the configuration change to every page, on screen or not; what
            // the article sees while Settings stands over it is noted, the claim is made once the
            // article is back in front (the page-controls demo's reading).
            val behind = poll(6_000) { articleValue(SCHEME_JS) == other.lowercase() }
            finding("  with Settings over it the article sees ${articleValue(SCHEME_JS)} (flipped behind Settings: $behind)")
            SystemClock.sleep(800)
            snap("look-and-feel-${other.lowercase()}")
        }
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        if (picked) {
            val flipped = poll(8_000) { articleValue(SCHEME_JS) == other.lowercase() }
            val same = articleValue("performance.timeOrigin") == document
            finding("  the article sees ${articleValue(SCHEME_JS)} under the ${other.lowercase()} chrome; same document: $same")
            check("the open article's prefers-color-scheme flips to ${other.lowercase()} with the chrome, the same document (no reload)", flipped && same)
        }
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
        val row = rowPoint(COLOR_SCHEME_ROW_ID, COLOR_SCHEME_ROW) ?: run {
            check("Look and Feel lists the $COLOR_SCHEME_ROW row to touch", false)
            return false
        }
        SystemClock.sleep(600)
        // The picker is up once the document's sheet lists the option and Follow system (the
        // tree is asked too, and noted when it lags: the sheet has woken it in every run so far).
        val listed = { sheetLists(to) && sheetLists("Follow system") }
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
        finding("  the tree's word on the picker: $to ${if (findNode { it == to } != null) "listed" else "not listed"}, Follow system ${if (findNode { it == "Follow system" } != null) "listed" else "not listed"}")
        val option = optionPoint(to) ?: run {
            check("the picker lists $to to touch", false)
            back()
            return false
        }
        val reads = { rowValueReads(COLOR_SCHEME_ROW_ID, COLOR_SCHEME_ROW, to) && !sheetUp() }
        val took = if (measured) {
            scene("colour-scheme-picker-pick", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = reads) { Finger().tap(option) }
        } else {
            Finger().tap(option)
            poll(8_000, reads)
        }
        finding("  $COLOR_SCHEME_ROW: $from -> ${if (took) to else "still $from"} (the pick closed the sheet: ${!sheetUp()}; the tree reads the row: ${rowReads(COLOR_SCHEME_ROW, to)})")
        if (!took) touchFault("a touch on $to did not take: the $COLOR_SCHEME_ROW row does not read $to with the picker gone")
        check("a finger on $to closes the picker with the row reading $to (§9.13)", took)
        return took
    }

    // --- 2. CT-25: Customise fonts ----------------------------------------------------------------------

    private fun fontsSection(document: String?) {
        finding("\nCT-25 Customise fonts (Settings > Look and Feel): the ± rows stepped under fingers, the family picker, Reset, the article reflowing")
        val before = articleMetrics()
        finding("  the article before: $before")
        if (!openSettings(LOOK_SECTION)) {
            check("Look and Feel opens for the fonts group", false)
            return
        }
        if (awaitRow(FONT_SIZE_ROW_ID, FONT_SIZE_ROW) == null) {
            check("Look and Feel carries the Customise fonts group with its Font size row", false)
            ensureChromeClear()
            return
        }
        SystemClock.sleep(800)
        val rows = groupRows("fonts")
        finding("  the group's rows: $rows")
        check(
            "the phone's group is Font size, Minimum font size, Standard font, the preview (and Reset once off the defaults): the phone's own level rows, no desktop menulist rows, no serif / sans-serif / fixed rows (genericFontFamilies false)",
            rows.containsAll(listOf(FONT_SIZE_ROW_ID, MINIMUM_FONT_SIZE_ROW_ID, STANDARD_FONT_ROW_ID, "fonts-preview")) && rows.none { it in setOf("fonts-size", "fonts-minimum-size", "fonts-serif-phone", "fonts-sansSerif-phone", "fonts-fixed-phone", "fonts-reset") }
        )
        val sizeForm = sliderForm(FONT_SIZE_ROW_ID)
        val minimumForm = sliderForm(MINIMUM_FONT_SIZE_ROW_ID)
        finding("  the level rows' form: Font size $sizeForm; Minimum font size $minimumForm")
        check(
            "each level row is §10.4's ± row (ruling 1): the value on the label's line, the 44 px Decrease / Increase buttons named for the row about the track, no end labels",
            stepRow(sizeForm, FONT_SIZE_ROW) && stepRow(minimumForm, MINIMUM_FONT_SIZE_ROW)
        )
        finding("  at rest: Font size reads ${sliderValue(FONT_SIZE_ROW_ID)}, Minimum font size ${sliderValue(MINIMUM_FONT_SIZE_ROW_ID)}, preview ${previewMetrics()}")
        snap("customise-fonts")
        beat()

        // One press on Font size's + (16 -> 17 px), REPORTED, no claim: the single-press case of
        // the ruling's condition (d) – the value moves on the press, exactly one `fonts.apply`
        // after the window – is accepted on the unit test (`fontsDraft.test.tsx`: none at 399 ms,
        // one at 400, still one at 1000), and the scene carries it here so a run that is asked has
        // it in the table. One finger on the − after it, outside any scene, puts the row back at
        // 16 px, where the three-press sequence and its claims begin.
        val singleTook = stepPresses(FONT_SIZE_ROW_ID, FONT_SIZE_ROW, 1, "font-size-single-press", claims = false) {
            fonts().optInt("size") == 17
        }
        val backAt16 = if (singleTook) stepBack(FONT_SIZE_ROW_ID, FONT_SIZE_ROW) { fonts().optInt("size") == 16 } else fonts().optInt("size") == 16
        finding("  the single press (took: $singleTook) undone on the −: settings.fonts.size=${fonts().optInt("size")}, the row reads ${sliderValue(FONT_SIZE_ROW_ID)} (back at 16: $backAt16)")
        SystemClock.sleep(600)

        // Font size: three presses on the row's + (16 -> 17 -> 18 -> 20 px). Each press steps
        // the row's own value and the preview; the sequence commits once when it is quiet (the
        // ruling's coalescing, `FONTS_COMMIT_QUIET_MS` – 400 ms – after the last step), and
        // the open article's body text follows the one commit.
        val sizeTook = stepPresses(FONT_SIZE_ROW_ID, FONT_SIZE_ROW, FONT_SIZE_PRESSES, "font-size-step-presses") {
            fonts().optInt("size") == 20
        }
        val sizeReads = sliderValue(FONT_SIZE_ROW_ID)
        // What the article behind Settings sees is noted here (the host hands every page its
        // WebSettings at once); the page's claim is made once it is back in front, below.
        val bodySize = poll(6_000) { articleValue(BODY_FONT_SIZE_JS) == "20px" }
        finding("  after the presses: settings.fonts.size=${fonts().optInt("size")}, the row reads $sizeReads, the article's body font-size behind Settings ${articleValue(BODY_FONT_SIZE_JS)} (at 20 px: $bodySize; same document: ${articleValue("performance.timeOrigin") == document})")
        check("three presses on Font size's + apply 20 px: the core's setting and the row's value", sizeTook && sizeReads == "20 px")
        if (!sizeTook) touchFault("the presses on Font size's + did not take: settings.fonts.size is ${fonts().optInt("size")}, not 20")
        SystemClock.sleep(600)
        snap("customise-fonts-size-20")

        // Minimum font size: seven presses to 12 px (none, 6, 7 … 12), one commit for the seven
        // (run 7's seven commits, one per press, is what the ruling forbids; run 8's four came
        // of a 150 ms window shorter than the gaps between the emulator's taps, and of the
        // Font size button's blur flushing the other row's first step). The article's 11 px
        // small print is lifted to 12.
        awaitRow(MINIMUM_FONT_SIZE_ROW_ID, MINIMUM_FONT_SIZE_ROW)
        SystemClock.sleep(600)
        val minimumTook = stepPresses(MINIMUM_FONT_SIZE_ROW_ID, MINIMUM_FONT_SIZE_ROW, MINIMUM_FONT_SIZE_PRESSES, "minimum-font-size-step-presses") {
            fonts().optInt("minimumSize") == 12
        }
        val smallLifted = poll(6_000) { articleValue(SMALL_FONT_SIZE_JS) == "12px" }
        finding("  after the presses: settings.fonts.minimumSize=${fonts().optInt("minimumSize")}, the row reads ${sliderValue(MINIMUM_FONT_SIZE_ROW_ID)}, the article's 11 px small print behind Settings at ${articleValue(SMALL_FONT_SIZE_JS)} (lifted to 12: $smallLifted)")
        check("seven presses on Minimum font size's + apply 12 px: the core's setting and the row's value", minimumTook && sliderValue(MINIMUM_FONT_SIZE_ROW_ID) == "12 px")
        if (!minimumTook) touchFault("the presses on Minimum font size's + did not take: settings.fonts.minimumSize is ${fonts().optInt("minimumSize")}, not 12")

        // Standard font: the action row opens the phone's picker sheet (each face drawn in
        // itself; its rows exceed the peek, so it opens expanded at the checked face), Cursive
        // under a finger sets the family and closes the sheet.
        val familyRow = rowPoint(STANDARD_FONT_ROW_ID, STANDARD_FONT_ROW)
        SystemClock.sleep(600)
        if (familyRow != null) {
            val listed = { sheetLists("Cursive") && sheetLists("Serif monospace") }
            val opened = scene("font-family-picker-open", JankBudget.Kind.OPEN, took = listed) { Finger().tap(familyRow) }
            check("a finger on Standard font opens the family picker sheet listing the fonts.xml aliases", opened)
            if (opened) {
                SystemClock.sleep(800)
                val faces = pickerFaces()
                val geometry = pickerGeometry()
                finding("  the picker's rows and the face each is drawn in: $faces; the tree lists Cursive: ${findNode { it == "Cursive" } != null}; the sheet: $geometry")
                check("each family row is drawn in its own face (RadioOption.font)", faces.count { it.second.contains("cursive") } >= 1 && faces.count { it.second.contains("monospace") } >= 1)
                check("the picker opens with the checked face in view – at its peek when the rows fit it, expanded and scrolled to the checked row when they exceed it (ruling 3's addition to §9.13)", pickerOpenedAtChecked(geometry))
                snap("standard-font-picker")
                beat()
                val cursive = optionPoint("Cursive")
                if (cursive != null) {
                    val set = { fonts().optString("standard") == "cursive" && !sheetUp() }
                    val took = scene("font-family-picker-pick", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = set) { Finger().tap(cursive) }
                    val family = poll(6_000) { articleValue(BODY_FONT_FAMILY_JS) == "cursive" }
                    finding("  after Cursive: settings.fonts.standard=${fonts().optString("standard")}, the row reads ${rowText("fonts-standard-phone")}, the article's body font-family behind Settings ${articleValue(BODY_FONT_FAMILY_JS)} (cursive: $family)")
                    check("a finger on Cursive sets the standard family and closes the picker (§9.13)", took)
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
        val reset = awaitRow(RESET_ROW_ID, RESET_ROW)
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
     * `presses` fingers in turn on the + of the ± row `rowId` (its label `label`; the button is
     * named "Increase `label`", §10.4), the `gesture` scene named `scene`. The Android
     * performance gate's ruling for #350's final run: a press sequence is ONE gesture scene with
     * the gesture budget's three long tasks for the whole of it, hold-repeat included, and the
     * row meets it by coalescing – each press steps the row's own value and the preview (a state
     * update and a label), and the commit (`settings.update`, the core's broadcast, the host's
     * `fonts.apply`, every page's restyle) runs ONCE per quiet sequence, the row's quiet window
     * (`FONTS_COMMIT_QUIET_MS`, 400 ms) after the last step or the hold's end. The fingers are
     * asked [STEP_PRESS_GAP_MS] apart – about 100 ms down to down – and land 150 to 300 ms
     * apart on the emulator (run 8: 146 to 285 ms; the UI thread's 150 to 400 ms frames on the
     * software GPU gate each synchronous injection), a person's own cadence, inside the window
     * either way – so the sequence is one.
     *
     * Three claims are made on the scene beside the budget's, the ruling's: at most three long
     * tasks over the whole sequence (the trace's count, `trace.longTasks`); exactly one
     * `fonts.apply` in the trace (the Android platform plants `performance.mark('fonts.apply')`
     * before it sends the command, a `blink.user_timing` event [BlinkTrace] counts by name, and
     * the chrome document's own timeline is read on both sides of the block as a second witness);
     * and the row's value moved on every press (a `MutationObserver` on the row's value label,
     * planted before the clock starts and read after it: one new value per press, the last the
     * row's). The button is placed before the clock starts ([controlPoint]: the tree's node
     * named for it, else the document's box – the tree's range node for the track, when it has
     * one, is noted). `took` is the claim polled after the block.
     *
     * The long tasks are read as RULING 5 counts them (`BlinkTrace.Reading.longTasks`: by the
     * thread's own clock, `tdur` over 50 ms, where the trace carries thread times), and the
     * finding carries the wall count and the two longest beside it – a wall count over the CPU's
     * is the thread off the CPU inside its tasks (the emulator's software GPU), not the chrome's
     * work. With `claims` false the sequence is REPORTED alone – the three readings in the
     * finding, no check: the single-press case of the ruling's condition (d), which is accepted
     * on the unit test (`fontsDraft.test.tsx`), so a run that is asked carries it in the table.
     */
    private fun stepPresses(rowId: String, label: String, presses: Int, scene: String, claims: Boolean = true, took: () -> Boolean): Boolean {
        val name = "Increase $label"
        val plus = controlPoint(name, "document.querySelector('[data-row=\"$rowId\"] button[aria-label=\"$name\"]')")
        val rangeNode = findNodeWhere { it.rangeInfo != null && ((it.contentDescription ?: it.text)?.toString() == label) }
        finding("  ± row $rowId: the + at ${plus?.let { "${it.x},${it.y}" } ?: "nowhere"}; the tree's range node for the track: ${rangeNode?.className ?: "none"}${rangeNode?.rangeInfo?.let { " at ${it.current} of ${it.max}" } ?: ""}")
        if (plus == null) {
            check("the $rowId row's + button is on screen to touch", false)
            return false
        }
        val before = sliderValue(rowId)
        val appliesBefore = fontsApplyMarks()
        val observing = chromeString(observeValueJs(rowId))
        Log.i(tag, "± row $rowId: $presses fingers on '$name' at ${plus.x},${plus.y}, ${STEP_PRESS_GAP_MS} ms between; value $before; observer: $observing; fonts.apply marks so far: $appliesBefore")
        val measured = traceFrames(scene, JankBudget.Kind.GESTURE) {
            repeat(presses) { i ->
                if (i > 0) SystemClock.sleep(STEP_PRESS_GAP_MS)
                Finger().tap(plus)
            }
            SystemClock.sleep(MOTION_MS)
        }
        val tookIt = poll(8_000, took)
        val moves = chromeJson(READ_VALUE_MOVES_JS)
        val values = moves.optJSONArray("values")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
        val times = moves.optJSONArray("times")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
        val appliesAfter = fontsApplyMarks()
        val applied = if (appliesBefore >= 0 && appliesAfter >= 0) appliesAfter - appliesBefore else -1
        val trace = measured.trace
        val longTasks = trace?.longTasks
        val marked = trace?.marks?.get("fonts.apply") ?: 0
        val after = sliderValue(rowId)
        // The count the claim reads is the ruling's (by CPU where the trace has thread times); the
        // wall count and both longest tasks are reported beside it.
        val longTasksRead = when {
            trace == null -> "no trace (${measured.traceMissing})"
            trace.longestTaskCpuMs != null ->
                "${trace.longTasks} by CPU (tdur over 50 ms, RULING 5), ${trace.longTasksWall} by wall; the longest ${"%.1f".format(trace.longestTaskCpuMs)} ms on the CPU, ${"%.0f".format(trace.longestTaskMs)} ms of wall time"
            else -> "${trace.longTasks} (no thread times in the trace: the wall count; the longest ${"%.0f".format(trace.longestTaskMs)} ms)"
        }
        finding(
            "  the sequence ($scene${if (claims) "" else ", reported"}): $presses ${if (presses == 1) "press" else "presses, ${STEP_PRESS_GAP_MS} ms between"}; the value moved $before -> ${values.joinToString(" -> ").ifEmpty { "(no move seen)" }} (at ${times.joinToString(", ")} ms of the chrome's clock), reads $after after; " +
                "long tasks over the whole sequence: $longTasksRead (budget ${JankBudget.GESTURE_BUDGET.longTasks}); " +
                "fonts.apply in the trace: $marked; in the chrome's timeline: ${if (applied >= 0) applied else "unread"}"
        )
        val withinBudget = longTasks != null && longTasks <= JankBudget.GESTURE_BUDGET.longTasks
        val oneApply = marked == 1 && (applied < 0 || applied == 1)
        val everyPress = values.size == presses && values.distinct().size == presses && values.none { it == before } && values.lastOrNull() == after
        if (claims) {
            check("$scene: at most ${JankBudget.GESTURE_BUDGET.longTasks} long tasks over the whole press sequence (the ruling: one gesture scene, no per-press budget)", withinBudget)
            check("$scene: exactly one fonts.apply per sequence in the trace (the commit coalesced: one settings.update, one broadcast, one host apply)", oneApply)
            check("$scene: the row's value moved on every press ($presses new values, each a step on from the last)", everyPress)
        } else {
            finding("  reported, no claim ($scene): within the long-task budget ${if (withinBudget) "yes" else "no"}; exactly one fonts.apply ${if (oneApply) "yes" else "no"}; the value moved on the press ${if (everyPress) "yes" else "no"}")
        }
        return tookIt
    }

    /**
     * One finger on the − of the ± row `rowId` outside any scene, until `took` – up to three
     * fingers, each given its window and commit: the reported single press undone, so the
     * sequence that follows starts where the run's claims expect it.
     */
    private fun stepBack(rowId: String, label: String, took: () -> Boolean): Boolean {
        val name = "Decrease $label"
        val minus = controlPoint(name, "document.querySelector('[data-row=\"$rowId\"] button[aria-label=\"$name\"]')") ?: return took()
        repeat(3) {
            Finger().tap(minus)
            if (poll(4_000, took)) return true
        }
        return took()
    }

    /**
     * How many `fonts.apply` marks the chrome document's performance timeline holds (the Android
     * platform's `performance.mark` before each `fonts.apply` it sends); -1 when the chrome did
     * not answer.
     */
    private fun fontsApplyMarks(): Int = chromeJs("performance.getEntriesByName('fonts.apply').length").trim().toIntOrNull() ?: -1

    /**
     * Plant a `MutationObserver` on the ± row's value label that records each new text with the
     * chrome's clock (`performance.now()`, ms) – nothing else runs in the chrome for it, so the
     * scene stays the fingers' – and answer with what the label reads; [READ_VALUE_MOVES_JS]
     * reads the record and stops the observer.
     */
    private fun observeValueJs(rowId: String): String =
        "(function(){var el=document.querySelector('[data-row=\"$rowId\"] .zen-settings-slider-value');if(!el)return 'no value label';" +
            "if(window.__zenStepRecord&&window.__zenStepRecord.stop)window.__zenStepRecord.stop();" +
            "var last=(el.textContent||'').trim();var rec=window.__zenStepRecord={from:last,values:[],times:[]};" +
            "var mo=new MutationObserver(function(){var v=(el.textContent||'').trim();if(v!==last){last=v;rec.values.push(v);rec.times.push(Math.round(performance.now()))}});" +
            "mo.observe(el,{childList:true,characterData:true,subtree:true});rec.stop=function(){mo.disconnect()};return 'observing '+last})()"

    // --- 3. CT-23 back, and Reset fonts -----------------------------------------------------------------

    private fun appearanceBackSection(from: String, to: String, document: String?) {
        finding("\nCT-23 back: Colour scheme $from -> $to, the article following again; Reset fonts on the open page")
        if (!openSettings(LOOK_SECTION)) {
            check("Look and Feel opens again", false)
            return
        }
        val schemeBack = colourScheme(from, to, measured = false)
        if (schemeBack) finding("  with Settings over it the article sees ${articleValue(SCHEME_JS)}")
        // Reset fonts: the action row under a finger – in the plain ink, no confirmation asked
        // (ruling 8: a preference reset destroys no data of the user's); the open article back
        // at 16 px, no floor, the platform's face – in place.
        var reset = false
        val resetRow = rowPoint(RESET_ROW_ID, RESET_ROW)
        if (resetRow != null) {
            val ink = rowInk(RESET_ROW_ID)
            finding("  the Reset fonts row's ink: $ink (the Standard font row's: ${rowInk(STANDARD_FONT_ROW_ID)})")
            check("Reset fonts stands in the plain ink, not the danger ink (ruling 8)", ink.isNotEmpty() && ink == rowInk(STANDARD_FONT_ROW_ID))
            SystemClock.sleep(600)
            Finger().tap(resetRow)
            reset = poll(6_000) { fonts().let { it.optInt("size") == 16 && it.optInt("minimumSize") == 0 && it.isNull("standard") } }
            if (!reset) touchFault("a touch on '$RESET_ROW' did not take: settings.fonts not back at the defaults within 6000 ms (${fonts()})")
            val asked = sheetUp()
            val behind = poll(6_000) { articleValue(BODY_FONT_SIZE_JS) == "16px" && articleValue(SMALL_FONT_SIZE_JS) == "11px" && articleValue(BODY_FONT_FAMILY_JS) != "cursive" }
            finding("  after Reset fonts: fonts ${fonts()}; a sheet up: $asked; behind Settings the article's body ${articleValue(BODY_FONT_SIZE_JS)} ${articleValue(BODY_FONT_FAMILY_JS)}, small print ${articleValue(SMALL_FONT_SIZE_JS)} (back at the defaults: $behind); the Reset row listed: ${"fonts-reset" in groupRows("fonts")}")
            check("Reset fonts puts settings.fonts back at the defaults on the press, no confirmation asked, and the row leaves the group", reset && !asked && "fonts-reset" !in groupRows("fonts"))
            SystemClock.sleep(600)
            snap("customise-fonts-reset")
        } else {
            check("the Reset fonts row is there to press", false)
        }
        ensureChromeClear()
        awaitPage(HOST, 10_000, "/")
        if (schemeBack) {
            val flipped = poll(8_000) { articleValue(SCHEME_JS) == to.lowercase() }
            finding("  the article sees ${articleValue(SCHEME_JS)} under the ${to.lowercase()} chrome; same document: ${articleValue("performance.timeOrigin") == document}")
            check("the article follows back to ${to.lowercase()}, still the same document", flipped && articleValue("performance.timeOrigin") == document)
        }
        if (reset) {
            val page = poll(8_000) { articleValue(BODY_FONT_SIZE_JS) == "16px" && articleValue(SMALL_FONT_SIZE_JS) == "11px" && articleValue(BODY_FONT_FAMILY_JS) != "cursive" }
            finding("  the article after Reset: ${articleMetrics()} (same document: ${articleValue("performance.timeOrigin") == document})")
            check("the open article is back in the default type (16 px, the 11 px small print at 11, the platform's face), the same document", page && articleValue("performance.timeOrigin") == document)
        }
        SystemClock.sleep(1_200)
        snap("article-${to.lowercase()}-reset")
        beat()
    }

    // --- 4. CT-41: Preferred languages --------------------------------------------------------------------

    private fun languagesSection() {
        finding("\nCT-41 Preferred languages (Settings > Languages): §10.4's item rows, German's item sheet and Move Up, Add language's page with its filter")
        if (!openSettings(LANGUAGES_SECTION)) {
            check("the app menu's Settings opens Languages", false)
            return
        }
        if (awaitRow(ADD_LANGUAGE_ROW_ID, ADD_LANGUAGE_ROW) == null) {
            check("Languages carries the Preferred languages group with its Add language row", false)
            ensureChromeClear()
            return
        }
        SystemClock.sleep(800)
        val rows = groupRows("preferred")
        val description = groupDescription("preferred")
        finding("  the group's rows: $rows; description: \"$description\"")
        check("the list's rows are English (United States) then German, one per language in the list's order, then Add language", rows == listOf("languages-preferred:en-US", GERMAN_ROW_ID, ADD_LANGUAGE_ROW_ID))
        check("the phone copy's two sentences say pages are translated into the first language and sites follow this device's languages, not this list (pageLanguages false; the review's nit 4)", description == "Pages are translated into the first language here. Sites that come in several languages follow this device’s languages, not this list.")
        val forms = itemRowForms("preferred")
        finding("  the language rows' form: $forms")
        check("each language row is §10.4's item row (ruling 2): one plain row per language that opens its item sheet (a button, aria-haspopup dialog), no ⋯, no chevron, no inline control", forms.size == 2 && forms.all { it.endsWith(" item") })
        snap("languages")
        beat()

        // German's row: the whole row opens its item sheet titled German – Move Up, Move Down
        // (at .4, the last row), Remove in the plain ink – and Move Up under a finger puts German
        // first with the sheet standing (the item's sheet, its rows the order's live state).
        val german = rowPoint(GERMAN_ROW_ID, "German")
        SystemClock.sleep(600)
        if (german != null) {
            val listed = { sheetTitle() == "German" && sheetLists("Move Up") && sheetLists("Remove") }
            val opened = scene("language-item-sheet-open", JankBudget.Kind.OPEN, took = listed) { Finger().tap(german) }
            check("a finger on German's row opens its item sheet titled German (Move Up / Move Down / Remove as action rows)", opened)
            if (opened) {
                SystemClock.sleep(800)
                val items = menuItems()
                val inks = sheetRowInks()
                finding("  the sheet's rows: $items; their ink: $inks; the tree lists Move Up: ${findNode { it == "Move Up" } != null}")
                check("Move Down is disabled on the last row, Move Up and Remove enabled (§9.30: listed at .4, never dropped)", items.any { it.startsWith("Move Down") && it.endsWith("disabled") } && items.any { it.startsWith("Move Up") && it.endsWith("enabled") } && items.any { it.startsWith("Remove") && it.endsWith("enabled") })
                check("Remove stands last in the plain ink – a preference removed is no loss of the user's data (§10.4, ruling 8)", items.lastOrNull()?.startsWith("Remove") == true && inks.optString("Remove").isNotEmpty() && inks.optString("Remove") == inks.optString("Move Up"))
                snap("language-item-sheet")
                beat()
                val up = optionPoint("Move Up")
                if (up != null) {
                    val moved = { languages().let { it.size == 2 && it[0] == "de" } }
                    val took = scene("language-item-sheet-move-up", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = moved) { Finger().tap(up) }
                    SystemClock.sleep(600)
                    val after = menuItems()
                    finding("  after Move Up: languages ${languages()}; rows ${groupRows("preferred")}; the sheet ${if (sheetUp()) "stands" else "is gone"}, its rows now $after")
                    check("Move Up puts German first (settings.languages de, en-US) and the rows follow the order", took && groupRows("preferred").take(2) == listOf(GERMAN_ROW_ID, "languages-preferred:en-US"))
                    check("the item sheet stays up after Move Up, Move Up now at .4 on the first row and Move Down enabled (the sheet is the item's; only Remove closes it)", sheetUp() && after.any { it.startsWith("Move Up") && it.endsWith("disabled") } && after.any { it.startsWith("Move Down") && it.endsWith("enabled") })
                    if (!took) touchFault("a touch on Move Up did not take: languages are ${languages()}")
                    snap("language-item-sheet-moved")
                    back()
                    val closed = poll(6_000) { !sheetUp() }
                    check("a back closes the item sheet on the reordered list", closed && groupRows("preferred").take(2) == listOf(GERMAN_ROW_ID, "languages-preferred:en-US"))
                } else {
                    touchFault("the item sheet listed no Move Up to touch")
                    back()
                }
            } else {
                touchFault("a touch on German's row opened no item sheet")
            }
        } else {
            check("German's row is on screen to touch", false)
        }
        SystemClock.sleep(800)
        snap("languages-reordered")
        beat()

        // Add language: the section's page (a drill-in, the filter field pinned over its own
        // scroller); `basq` typed narrows the list to Basque; Basque under a finger adds it and
        // the page leaves.
        val add = rowPoint(ADD_LANGUAGE_ROW_ID, ADD_LANGUAGE_ROW)
        SystemClock.sleep(600)
        if (add != null) {
            // The page is up once the chrome's document has it with the filter field and the
            // catalogue's first row (the field itself is an EditText named by its hint, which the
            // label reads never see: [findField]); whether the tree lists the row is noted below.
            val listed = { addPageUp() && chromeHas(FILTER_SELECTOR) && pickerLabels().firstOrNull() == "Afrikaans" }
            val opened = scene("add-language-page-open", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = listed) { Finger().tap(add) }
            check("a finger on Add language opens the Add language page (ruling 3: zen://settings/languages/add, a drill-in with the filter field pinned over the list)", opened)
            if (opened) {
                SystemClock.sleep(800)
                val all = pickerCount()
                val page = addPageGeometry()
                finding("  the page lists $all languages; $page; the filter field reads \"${filterValue()}\"; the tree's field: ${describeNode(findField(FILTER_LABEL))}; the tree lists Afrikaans: ${findNode { it.startsWith("Afrikaans") } != null}")
                check(
                    "the page is the drill-in titled Add language with Back to Languages, the field pinned at its head over the list's own scroller, the first row focused and no keyboard up (§9.22, §10.2)",
                    page.optString("title") == "Add language" && page.optString("back") == "Back to Languages" && page.optBoolean("filterPinned") && page.optBoolean("listScrolls") && page.optString("focused").startsWith("Afrikaans") && !imeShown()
                )
                check("the rows name each language in itself under the English, from the shipped table (ruling 7: Basque / euskara)", page.optInt("ownNames") >= 100)
                snap("add-language-page")
                beat()
                val field = fieldPoint(FILTER_LABEL, FILTER_SELECTOR)
                if (field != null) {
                    Finger().tap(field)
                    val focused = poll(4_000) { chromeString("document.activeElement&&document.activeElement.getAttribute('aria-label')||''") == FILTER_LABEL }
                    val ime = awaitIme(shown = true, timeoutMs = 4_000)
                    finding("  the filter field under a finger: focused=$focused, keyboard up=$ime")
                    if (!focused) touchFault("a touch on the filter field did not focus it")
                    typeText("basq")
                    val narrowed = poll(6_000) { pickerCount() == 1 && pickerLabels().firstOrNull() == "Basque" }
                    finding("  typed basq: the field reads \"${filterValue()}\", the list has ${pickerCount()} row(s): ${pickerLabels()}")
                    check("the filter narrows the list as it is typed (basq → Basque alone)", narrowed && filterValue() == "basq")
                    SystemClock.sleep(600)
                    snap("add-language-filtered")
                    beat()
                    if (imeShown()) {
                        back()
                        awaitIme(shown = false, timeoutMs = 6_000)
                        SystemClock.sleep(800)
                        check("the back with the keyboard up puts the keyboard away and leaves the page standing with its filter", !imeShown() && addPageUp() && filterValue() == "basq")
                    }
                    val basque = optionPoint("Basque", prefix = true)
                    if (basque != null) {
                        val added = { languages().contains("eu") && !addPageUp() }
                        val took = scene("add-language-pick", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = added) { Finger().tap(basque) }
                        finding("  after Basque: languages ${languages()}; the page ${if (addPageUp()) "stands" else "is gone"}; rows ${groupRows("preferred")}")
                        check("a finger on Basque adds it (settings.languages de, en-US, eu) and the page leaves as back would, the list showing the new row", took && groupRows("preferred") == listOf(GERMAN_ROW_ID, "languages-preferred:en-US", "languages-preferred:eu", ADD_LANGUAGE_ROW_ID))
                        if (!took) touchFault("a touch on Basque did not take: languages are ${languages()}")
                    } else {
                        touchFault("the filtered page listed no Basque row to touch")
                        back()
                    }
                } else {
                    check("the filter field is on screen to touch", false)
                    back()
                }
            } else {
                touchFault("a touch on Add language opened no Add language page")
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
        finding("\nCT-36 Reader View > Text preferences: Translate as the head's one action row, its target picker translating on the pick, then Show original")
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
        val head = readerHead()
        finding("  the sheet's rows: $rows; the head: $head")
        check(
            "Translate is the head's one action row, Listen's sibling after it and before Text size, no Translate into row (rulings 4 and 6, CT-36)",
            rows.indexOf("Listen to this article") == 0 && rows.indexOf("Translate") == 1 && rows.indexOf("Text size") == 2 && "Translate into" !in rows
        )
        check(
            "both head action rows carry their glyph (Listen audio-lines, Translate languages) and the setting rows none (ruling 5); Translate opens a dialog (aria-haspopup)",
            head.optJSONObject("listen")?.optString("glyph") == "lucide-audio-lines" && head.optJSONObject("translate")?.optString("glyph") == "lucide-languages" && head.optJSONObject("translate")?.optString("haspopup") == "dialog" && head.optInt("settingGlyphs", -1) == 0
        )
        check(
            "Text spacing stands whole above the peek's fold with the one head row (#265's measure kept, the lead's re-measure ~877 of the 915 peek)",
            head.optInt("spacingBottom", -1) > 0 && head.optInt("spacingBottom") <= head.optInt("scrollerBottom", -1)
        )
        SystemClock.sleep(600)
        snap("reader-prefs-translate")
        beat()

        // Translate under a finger: the target picker sheet comes up over the panel – expanded
        // (58 rows exceed its peek), scrolled to the checked German – and German under a finger
        // translates on the pick: the row turns busy with the progress; the article turns German.
        val translate = controlPoint("Translate", "document.querySelector('[data-reader-pref=\"translate\"]')")
        if (translate == null) {
            check("the Translate row is on screen to touch", false)
            backFromSheet(measured = false)
            return
        }
        val pickerUp = { targetPickerUp() && sheetLists("German") }
        val pickerOpened = scene("reader-translate-picker-open", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = pickerUp) { Finger().tap(translate) }
        check("a finger on Translate opens the target picker sheet titled Translate into over the panel", pickerOpened && sheetTitle() == "Translate into")
        if (!pickerOpened) {
            touchFault("a touch on Translate opened no target picker listing German")
            backFromSheet(measured = false)
            return
        }
        SystemClock.sleep(1_000)
        val picker = pickerGeometry()
        finding("  the target picker: $picker; the tree lists German: ${findNode { it == "German" || it.startsWith("German ") || it.startsWith("German\n") } != null}")
        check(
            "the picker opens expanded, scrolled to the checked target – German, the first preferred language after the move – in view, its rows naming each language in itself under the English from the shipped table (ruling 3's addition, ruling 7)",
            picker.optString("checked") == "German" && picker.optBoolean("expanded") && picker.optBoolean("checkedInView") && picker.optInt("ownNames") >= 40
        )
        snap("reader-translate-picker")
        beat()
        val german = optionPoint("German", prefix = true)
        if (german == null) {
            check("the picker lists German to touch", false)
            back()
            backFromSheet(measured = false)
            return
        }
        val t0 = SystemClock.uptimeMillis()
        // The pick closes the picker and reaches the core once the tab has a reader translation
        // state at all (the language told and the model fetched can be over before a poll sees
        // them working).
        val started = scene("reader-translate-pick", JankBudget.Kind.OPEN, timeoutMs = 10_000, took = { !targetPickerUp() && readerStatus().isNotEmpty() }) { Finger().tap(german) }
        finding("  real touch on German: the picker ${if (targetPickerUp()) "stands" else "is gone"}, status ${readerStatus()} after ${SystemClock.uptimeMillis() - t0} ms")
        check("the pick closes the picker and sets the translation going (the tab has a reader translation state)", started)
        if (!started) touchFault("a touch on German did not take: the picker stands or the tab has no reader translation state")
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
                check("while the core works the Translate row is busy with the progress as its second line, in the same row (§9.30)", rowBusy("Translate") && rowDescription("Translate").isNotEmpty())
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
        finding("  the rows now: ${sheetRows()}; Show original's second line: \"${rowDescription("Show original")}\"; a switch: ${chromeHas("[data-reader-pref=\"showOriginal\"][role=\"switch\"]")}")
        check("once translated the action row gives way to the Show original switch row in its place, its second line naming the target (Translated into German)", showOriginal && rowDescription("Show original") == "Translated into German" && "Translate" !in sheetRows() && sheetRows().indexOf("Show original") == 1 && chromeHas("[data-reader-pref=\"showOriginal\"][role=\"switch\"]"))
        SystemClock.sleep(800)
        snap("reader-prefs-translated")
        beat()

        // Show original under a finger: the English again, the translation kept; and back.
        pressExpecting("Show original", "the reader shows the article as written", timeoutMs = 8_000, prefix = true) {
            readerState()?.optBoolean("showOriginal") == true && readerText() == original
        }
        finding("  after Show original: showOriginal=${readerState()?.optBoolean("showOriginal")}, lang ${articleValue("document.documentElement.lang")}, text \"${readerText().take(60)}…\"")
        check("Show original on shows the English with the translation kept (translate.readerShowOriginal)", readerState()?.optBoolean("showOriginal") == true && readerText() == original)
        SystemClock.sleep(800)
        snap("reader-prefs-show-original")
        beat()
        pressExpecting("Show original", "the reader shows the German again", timeoutMs = 8_000, prefix = true) {
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
     * scene. True once the sheet lists Translate and Text size.
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
        val up = scene("reader-prefs-sheet-open", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = { rowNode("Translate") != null && rowNode("Text size") != null }) { Finger().tap(item) }
        if (!up) touchFault("a touch on $PREFERENCES_ITEM opened no sheet listing Translate")
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
    private fun chromeRect(selector: String): Rect? = chromeRectOf("document.querySelector(${JSONObject.quote(selector)})")

    /** Where the chrome element the script `element` evaluates to is on screen (device px), or null. */
    private fun chromeRectOf(element: String): Rect? {
        val raw = chromeString(
            "(function(){var e=$element;if(!e)return '';" +
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

    /** The object a script's JSON string evaluates to in the chrome (empty when it did not answer or was not an object). */
    private fun chromeJson(code: String): JSONObject = runCatching { JSONObject(chromeString(code)) }.getOrDefault(JSONObject())

    /** Whether the chrome's document has an element matching `selector` (a sheet's field, a row). */
    private fun chromeHas(selector: String): Boolean =
        chromeJs("Boolean(document.querySelector(${JSONObject.quote(selector)}))").trim() == "true"

    /** The `data-row` ids the chrome's document holds now, the first thirty, for a finding when the tree has none of them. */
    private fun domRows(): List<String> = jsonList(chromeString(
        "JSON.stringify(Array.from(document.querySelectorAll('[data-row]')).slice(0,30).map(function(e){return e.getAttribute('data-row')}))"
    ))

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

    /** What the ± row's value reads ("20 px"): the `.zen-settings-slider-value` on the label's line. */
    private fun sliderValue(rowId: String): String = chromeString(
        "(function(){var v=document.querySelector('[data-row=\"$rowId\"] .zen-settings-slider-value');return v?(v.textContent||'').trim():''})()"
    )

    /**
     * The form of the level row `rowId` as the chrome draws it (§10.4's ± row): its label and
     * value and whether they share a line, the step buttons in order (name, CSS px size,
     * disabled), whether a track stands between them, and whether end labels are drawn at all.
     */
    private fun sliderForm(rowId: String): JSONObject = chromeJson(
        "(function(){var r=document.querySelector('[data-row=\"$rowId\"]');if(!r)return '{}';" +
            "var l=r.querySelector('.zen-settings-slider-head .zen-settings-label'),v=r.querySelector('.zen-settings-slider-head .zen-settings-slider-value');" +
            "var lr=l&&l.getBoundingClientRect(),vr=v&&v.getBoundingClientRect();" +
            "var bs=Array.from(r.querySelectorAll('.zen-settings-slider-stepper button')).map(function(b){var br=b.getBoundingClientRect();" +
            "return {name:b.getAttribute('aria-label')||'',w:Math.round(br.width),h:Math.round(br.height),disabled:b.disabled||b.getAttribute('aria-disabled')==='true'}});" +
            "return JSON.stringify({label:l?(l.textContent||'').trim():'',value:v?(v.textContent||'').trim():'',sameLine:!!(lr&&vr&&Math.abs(lr.top-vr.top)<8&&vr.left>lr.right)," +
            "buttons:bs,track:!!r.querySelector('.zen-settings-slider-stepper [role=\"slider\"]'),ends:!!r.querySelector('.zen-settings-slider-ends')})})()"
    )

    /** Whether [sliderForm]'s reading is §10.4's ± row for `label`: value on the label's line, Decrease then Increase at 44, a track between, no end labels. */
    private fun stepRow(form: JSONObject, label: String): Boolean {
        val buttons = form.optJSONArray("buttons") ?: return false
        if (buttons.length() != 2) return false
        val minus = buttons.getJSONObject(0)
        val plus = buttons.getJSONObject(1)
        return form.optString("label") == label && form.optBoolean("sameLine") && form.optBoolean("track") && !form.optBoolean("ends") &&
            minus.optString("name") == "Decrease $label" && plus.optString("name") == "Increase $label" &&
            minus.optInt("w") >= 44 && minus.optInt("h") >= 44 && plus.optInt("w") >= 44 && plus.optInt("h") >= 44
    }

    /** The colour of the row's label (`.zen-settings-label`, else the row) as computed – the plain ink against the danger ink. */
    private fun rowInk(rowId: String): String = chromeString(
        "(function(){var r=document.querySelector('[data-row=\"$rowId\"]');if(!r)return '';var l=r.querySelector('.zen-settings-label')||r;return getComputedStyle(l).color})()"
    )

    /**
     * The form of each language row in the Settings group `groupId`, one line per row: its id,
     * element, `aria-haspopup`, and whether it carries a ⋯, a chevron or an inline control – the
     * line ends in `item` when it is §10.4's item row (a button opening a dialog, none of those).
     */
    private fun itemRowForms(groupId: String): List<String> = jsonList(chromeString(
        "(function(){var g=document.querySelector('[data-group=\"$groupId\"]');if(!g)return '[]';" +
            "var rs=Array.from(g.querySelectorAll('[data-row^=\"languages-preferred:\"]'));" +
            "return JSON.stringify(rs.map(function(r){var menu=!!r.querySelector('.zen-settings-row-menu, [aria-label^=\"Options for\"]');" +
            "var chevron=!!r.querySelector('svg.lucide-chevron-right, .zen-settings-summary');var control=!!r.querySelector('.zen-settings-control, .zen-settings-trailing button, [role=\"switch\"], .zen-v2-menulist');" +
            "var pop=r.getAttribute('aria-haspopup')||'';var item=r.tagName==='BUTTON'&&pop==='dialog'&&!menu&&!chevron&&!control;" +
            "return r.getAttribute('data-row')+' '+r.tagName.toLowerCase()+' haspopup='+(pop||'none')+' menu='+menu+' chevron='+chevron+' control='+control+(item?' item':' not-item')}))})()"
    ))

    /**
     * The Add language page as the chrome draws it: the drill-in's title and back button, the
     * filter field's box and whether it is pinned over the list's own scroller, the rows, how
     * many carry the language's own name under the English, and what has the focus.
     */
    private fun addPageGeometry(): JSONObject = chromeJson(
        "(function(){var root=document.querySelector(${JSONObject.quote(ADD_PAGE_SELECTOR)});if(!root)return '{}';" +
            "var drill=root.closest('.zen-settings-drill-in');var back=drill&&drill.querySelector('.zen-settings-back');var title=drill&&drill.querySelector('.zen-settings-bar-title');" +
            "var filter=root.querySelector('.zen-settings-add-language-filter');var fr=filter&&filter.getBoundingClientRect();" +
            "var list=root.querySelector('.zen-settings-add-language-list');var lr=list&&list.getBoundingClientRect();var lc=list&&getComputedStyle(list);" +
            "var rows=Array.from(root.querySelectorAll('[role=\"group\"] > button'));" +
            "var own=rows.filter(function(b){var d=b.querySelector('.zen-settings-description');return d&&(d.textContent||'').trim()}).length;" +
            "var a=document.activeElement;var al=a&&(a.querySelector('.zen-settings-label')||a);" +
            "return JSON.stringify({title:title?(title.textContent||'').trim():'',back:back?(back.getAttribute('aria-label')||''):'',list:root.getAttribute('data-list')||''," +
            "filterY:fr?Math.round(fr.top):-1,filterH:fr?Math.round(fr.height):-1,filterPinned:!!(fr&&lr&&fr.bottom<=lr.top+1),listScrolls:!!(lc&&lc.overflowY!=='visible')," +
            "listTop:lr?Math.round(lr.top):-1,listBottom:lr?Math.round(lr.bottom):-1,rows:rows.length,ownNames:own,focused:a?((a.getAttribute('aria-label')||(al&&al.textContent)||'').trim()):''})})()"
    )

    /**
     * The Text preferences sheet's head as the chrome draws it: the Listen and Translate rows
     * (top, height, the leading glyph's lucide class, `aria-haspopup`, busy), how many setting
     * rows carry a leading glyph, and where Text spacing's bottom edge stands against the
     * sheet's scroller at the peek.
     */
    private fun readerHead(): JSONObject = chromeJson(
        "(function(){var root=document.querySelector('[data-reader-prefs-rows]');if(!root)return '{}';" +
            "var sheet=root.closest('.zen-sheet');var scroller=sheet&&sheet.querySelector('.zen-sheet-scroll');var sr=scroller&&scroller.getBoundingClientRect();" +
            "function glyph(r){var f=r.firstElementChild;if(!f||!f.hasAttribute('aria-hidden'))return '';var g=f.querySelector('svg');if(!g)return '';" +
            "return Array.from(g.classList).filter(function(c){return c.indexOf('lucide-')===0}).join(' ')}" +
            "function row(sel){var r=root.querySelector(sel);if(!r)return null;var b=r.getBoundingClientRect();" +
            "return {y:Math.round(b.top),h:Math.round(b.height),glyph:glyph(r),haspopup:r.getAttribute('aria-haspopup')||'',busy:r.getAttribute('aria-busy')==='true'}}" +
            "var rows=Array.from(root.querySelectorAll('.zen-v2-row'));function label(e){var l=e.querySelector('.truncate');return l?(l.textContent||'').trim():''}" +
            "var spacing=rows.find(function(e){return label(e)==='Text spacing'});var spr=spacing&&spacing.getBoundingClientRect();" +
            "var settings=rows.filter(function(e){var t=label(e);return t&&t!=='Listen to this article'&&t!=='Translate'&&t!=='Show original'});" +
            "return JSON.stringify({listen:row('[data-reader-pref=\"listen\"]'),translate:row('[data-reader-pref=\"translate\"]'),viewport:window.innerHeight," +
            "sheetTop:sheet?Math.round(sheet.getBoundingClientRect().top):-1,scrollerTop:sr?Math.round(sr.top):-1,scrollerBottom:sr?Math.round(sr.bottom):-1," +
            "spacingTop:spr?Math.round(spr.top):-1,spacingBottom:spr?Math.round(spr.bottom):-1,settingRows:settings.length,settingGlyphs:settings.filter(function(e){return glyph(e)!==''}).length})})()"
    )

    /**
     * The topmost picker sheet's detent and where its checked option sits (§9.13 with the lead
     * check's addition): the sheet's box against the viewport (`expanded` when its top is in
     * the viewport's upper reach), its scroller's scroll, the options, the checked one and
     * whether it is inside the scroller, whether its rows fit the scroller (`fits`), how many
     * rows carry a second line (the language's own name), and what has the focus.
     */
    private fun pickerGeometry(): JSONObject = chromeJson(
        "(function(){var ss=document.querySelectorAll('.zen-sheet');var sheet=ss[ss.length-1];if(!sheet)return '{}';" +
            "var sr=sheet.getBoundingClientRect();var scroller=sheet.querySelector('.zen-sheet-scroll');var scr=scroller&&scroller.getBoundingClientRect();" +
            "var opts=Array.from(sheet.querySelectorAll('[role=\"radio\"], [role=\"option\"]'));" +
            "var checked=sheet.querySelector('[role=\"radio\"][aria-checked=\"true\"], [role=\"option\"][aria-selected=\"true\"]');var cr=checked&&checked.getBoundingClientRect();" +
            "function label(e){var l=e.querySelector('.zen-settings-label, .zen-v2-label, .truncate')||e;return (l.textContent||'').trim()}" +
            "var own=opts.filter(function(o){var d=o.querySelector('.zen-settings-description, .zen-v2-description');return d&&(d.textContent||'').trim()}).length;" +
            "var a=document.activeElement;" +
            "return JSON.stringify({viewport:window.innerHeight,top:Math.round(sr.top),bottom:Math.round(sr.bottom),expanded:sr.top<window.innerHeight*0.15," +
            "scrollerTop:scr?Math.round(scr.top):-1,scrollerBottom:scr?Math.round(scr.bottom):-1,scrollTop:scroller?Math.round(scroller.scrollTop):-1," +
            "fits:!!(scroller&&scroller.scrollHeight<=scroller.clientHeight+1),options:opts.length,ownNames:own,checked:checked?label(checked):''," +
            "checkedTop:cr?Math.round(cr.top):-1,checkedBottom:cr?Math.round(cr.bottom):-1,checkedInView:!!(cr&&scr&&cr.top>=scr.top-1&&cr.bottom<=scr.bottom+1)," +
            "focused:a&&sheet.contains(a)?label(a):''})})()"
    )

    /** Whether a picker opened as §9.13 with the lead check's addition asks: the checked option in view – at the peek when the rows fit, expanded otherwise. */
    private fun pickerOpenedAtChecked(geometry: JSONObject): Boolean =
        geometry.optString("checked").isNotEmpty() && geometry.optBoolean("checkedInView") && (geometry.optBoolean("fits") || geometry.optBoolean("expanded"))

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

    /** The topmost sheet's action rows (an item sheet's Move Up / Move Down / Remove) with their state, `label enabled|disabled`. */
    private fun menuItems(): List<String> = jsonList(chromeString(
        "(function(){var ds=document.querySelectorAll('[role=\"dialog\"]');var d=ds[ds.length-1];if(!d)return '[]';d=d.querySelector('[role=\"menu\"]')||d;" +
            "return JSON.stringify(Array.from(d.querySelectorAll('[role=\"menuitem\"], button[data-row], [role=\"menu\"] button')).map(function(b){var l=b.querySelector('.zen-settings-label')||b;var t=(l.textContent||'').trim();if(!t)return '';" +
            "return t+' '+((b.disabled||b.getAttribute('aria-disabled')==='true')?'disabled':'enabled')}).filter(Boolean))})()"
    ))

    /** The topmost sheet's action rows' label inks, `{label: color}` as computed (the plain ink against the danger ink). */
    private fun sheetRowInks(): JSONObject = chromeJson(
        "(function(){var ds=document.querySelectorAll('[role=\"dialog\"]');var d=ds[ds.length-1];if(!d)return '{}';var out={};" +
            "Array.from(d.querySelectorAll('button[data-row]')).forEach(function(b){var l=b.querySelector('.zen-settings-label')||b;var t=(l.textContent||'').trim();if(t)out[t]=getComputedStyle(l).color});" +
            "return JSON.stringify(out)})()"
    )

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
        "(function(){var f=document.querySelector(${JSONObject.quote(FILTER_SELECTOR)});return f?f.value:''})()"
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
            text != null && (text == label || text.startsWith("$label ") || text.startsWith("$label\n") || text.startsWith("$label,"))
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

    /**
     * Up to `timeoutMs` for `condition`, UiAutomation's node cache dropped before each read so a
     * condition on the tree sees the WebView's tree as it stands rather than as the cache kept
     * it, and a frame asked of the chrome between reads so Blink serialises its changes meanwhile
     * (the harness's remedy above [dropTreeCache]). Every claim a scene polls goes through here,
     * after the measured block, never inside it.
     */
    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            dropTreeCache()
            if (condition()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            nudgeFrame()
            SystemClock.sleep(200)
        }
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
        /**
         * The rows' `data-row` ids in the chrome's document (`sections.tsx`, `fonts.tsx`,
         * `languages.tsx`), for [awaitRow]'s document path. The level rows are the phone's own
         * (`fonts-size-phone`, the ± row; the desktop's `fonts-size` is its menulist of stops).
         */
        private const val COLOR_SCHEME_ROW_ID = "color-scheme"
        private const val FONT_SIZE_ROW_ID = "fonts-size-phone"
        private const val MINIMUM_FONT_SIZE_ROW_ID = "fonts-minimum-size-phone"
        private const val STANDARD_FONT_ROW_ID = "fonts-standard-phone"
        private const val RESET_ROW_ID = "fonts-reset"
        private const val GERMAN_ROW_ID = "languages-preferred:de"
        private const val ADD_LANGUAGE_ROW_ID = "languages-add"
        private const val FILTER_LABEL = "Find a language"
        /** The Add language page in the chrome's document and its pinned filter field (`AddLanguagePage.tsx`). */
        private const val ADD_PAGE_SELECTOR = ".zen-settings-add-language"
        private const val FILTER_SELECTOR = ".zen-settings-add-language-filter input"
        /**
         * The surface a finger's option is looked for on ([sheetControlJs]): the LAST sheet in
         * the document (a picker stacked over the Text preferences sheet), else the Add language
         * page when no sheet is up.
         */
        private const val LAST_SURFACE_JS =
            "(function(){var ss=document.querySelectorAll('.zen-sheet, [role=\"dialog\"]');return ss[ss.length-1]||document.querySelector('$ADD_PAGE_SELECTOR')})()"
        /**
         * How long the tree is given to list a Settings row after a section's drill-in before the
         * chrome's document stands in ([awaitRow]): a tree that has the row lists it within a
         * second or two even on the software GPU; one that lags the drill-in stays behind (fifteen
         * seconds bought nothing in runs 35747286900 and 35754718133).
         */
        private const val ROW_WAIT_MS = 4_000L
        /** The same for a control inside a row or a sheet ([controlPoint]); sheets have woken the tree in every run so far. */
        private const val CONTROL_WAIT_MS = 4_000L
        /** The app menu's row that opens the sheet (`core/menus.ts`; U+2026). */
        private const val PREFERENCES_ITEM = "Text Preferences…"
        /**
         * `FONT_SIZE_STEPS` climbs 16, 17, 18, 20 (three presses on + from the default 16 reach
         * 20 px); `MINIMUM_FONT_SIZE_STEPS` climbs none, 6, 7, 8, 9, 10, 11, 12 (seven presses
         * from none reach 12 px).
         */
        private const val FONT_SIZE_PRESSES = 3
        private const val MINIMUM_FONT_SIZE_PRESSES = 7
        /**
         * Between a finger's lift and the next finger on a step button: with the tap's 60 ms
         * down, about 100 ms down to down as asked – the hold's own repeat interval – and 150
         * to 300 ms as the emulator lands them (each injection waits on the UI thread's frame),
         * inside the row's 400 ms quiet window either way, so the sequence commits once (the
         * ruling); well under the 400 ms hold that starts the button repeating.
         */
        private const val STEP_PRESS_GAP_MS = 40L
        private val WORKING = setOf("detecting", "downloading", "translating")
        /** What a measured scene's block gives the motion after the finger (or the back). */
        private const val MOTION_MS = 3_000L
        /** The record [observeValueJs] keeps, as JSON (`from`, `values`, `times`), the observer stopped. */
        private const val READ_VALUE_MOVES_JS =
            "(function(){var r=window.__zenStepRecord;if(!r)return '{}';if(r.stop)r.stop();return JSON.stringify({from:r.from,values:r.values,times:r.times})})()"

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
