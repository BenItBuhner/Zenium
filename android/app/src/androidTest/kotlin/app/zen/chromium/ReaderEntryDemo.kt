package app.zen.chromium

import android.content.res.Configuration
import android.graphics.PointF
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The `android-reader-entry-demo` workflow: the reader entry's offer and the crossing into
 * Reader View on the phone (PUI-14, MOT-36; v2 §9.33, §11). Four loopback SITES on one port –
 * `127.0.0.1` to `.4`, each a site of its own to the entry's per-site memory – serve the
 * read-aloud demo's article (`read-aloud-demo-page.html`) at `/`, a re-titled copy at `/second`
 * and a page too short for the readability probe at `/plain`. Writes `reader-entry-findings.txt`
 * next to the stills (a `PASS` or `FAIL` per check; the run fails at its end when any did, or
 * when a touch did not take):
 *
 *  1. THE ENTRY (site A): the article loaded and read as an article by the reader core's probe
 *     (`tab.readerable`), the frame's top banner "Show Reader View?" with its glyph, its one
 *     action Show and the X – the same §9.33 host the connectivity banner uses – and nothing
 *     else on the stack; no crossing layer in the chrome at rest.
 *  2. THE CROSSING IN (the `reader-crossing-enter` scene, `open`): a real finger on Show; the
 *     chrome's crossing layer runs `covering` → `loading` (the reader's surface shown over the
 *     page's picture) → `landing` and leaves once the host has drawn the `zen://reader`
 *     document; the reader document up with the article's title; the offer gone; the pill at
 *     rest still the favicon, the host and the one site-information glyph (no reader chip).
 *  3. THE CROSSING OUT (`reader-crossing-exit`, `open`): the app menu's checked Reader View row
 *     under a finger; the same layer the other way (`exit`), the article back in its place.
 *     Whether the offer returns for the article after the exit (the action un-muted the site)
 *     is reported, not gated – the gate's question (f).
 *  4. THE MEMORY: a swipe off the strip (site A) mutes the site – its `/second` article shows no
 *     offer though the probe reads it as an article; the X (site B) does the same; leaving the
 *     page with the offer standing (site D: another document without an answer) does the same,
 *     Chrome's `ReaderModeManager` rule; and `/plain` (site B), which the probe does not read as
 *     an article, shows no strip at all.
 *  5. DARK (site C): the strip, the crossing in (`reader-crossing-enter-dark`), the reader
 *     document on its dark ground (`#18181c`), the crossing out (`reader-crossing-exit-dark`),
 *     the X – Zenium's own Dark first, the system's second, as [ReaderUiDemo] settles the order.
 *
 * The frame record ([traceFrames], `frames.jsonl`; PERF-3's harness and its scene names): the
 * app menu opened under a finger and dismissed with a back first (`menu-sheet-open` /
 * `menu-sheet-close`, the table's point of reference on this recipe), then the four crossing
 * scenes. Each block is the finger and [MOTION_MS] for what it does, nothing else – the node is
 * found and the finger's point fixed BEFORE the block, the claim polled AFTER it ([scene]); the
 * crossing's phases are read by a `MutationObserver` armed in the chrome's document before the
 * block ([armCrossingLog]: one attribute read per DOM change, no work of the reading inside the
 * trace) and collected after it. Every control pressed is a real injected finger with an
 * assertion (#198's rule). See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ReaderEntryDemo : DemoHarness("reader-entry-demo-state.json", MEDIA_PREFIX, "reader-entry-demo") {
    override val tag = "ReaderEntryDemo"
    private var servers: List<DemoServer> = emptyList()
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        val article = readAsset("read-aloud-demo-page.html")
        val second = article.replace("lighthouse keeper", "harbourmaster")
        val routes = mapOf(
            "/" to (HTML to article.toByteArray()),
            "/second" to (HTML to second.toByteArray()),
            "/plain" to (HTML to PLAIN_PAGE.toByteArray())
        )
        servers = SITES.map { address -> DemoServer(PORT, routes, address = address).also { it.start() } }
        try {
            runDemo()
        } finally {
            servers.forEach { runCatching { it.close() } }
        }
        if (failures > 0) throw AssertionError("$failures reader entry check(s) failed; see reader-entry-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "reader-entry-findings.txt")
        findings.writeText("Zenium Android reader entry checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        for ((i, server) in servers.withIndex()) finding("demo server ${SITES[i]}: ${server.selfCheck()}")
        val caps = coreState().getJSONObject("capabilities")
        finding("capabilities: phone=${caps.optBoolean("phone")}")
        awaitLoaded("$SITE_A/")
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        finding("article: ${describeTab()}; readerable=$readerable")
        check("the reader core finds the article readerable (what the offer waits for)", readerable)
        // A promo sheet from the default-browser campaign would sit over the page; answer it
        // off camera, and say so.
        if (findNode { it == "Not now" } != null) {
            finding("  a default-browser prompt is up at warm-up; Not now")
            touchTapLabel("Not now")
            SystemClock.sleep(1_500)
        }
        val close = closeUrlField()
        finding("URL field at warm-up: ${close.describe()}")
        check("the URL field is closed (or was never open) before the recording", close.ok)
        // The app menu once, off camera: the baseline scene reads a warm menu (ReaderUiDemo does the same).
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
            baselineScenes()
            entry()
            memory()
            dark()
            finding("\nend: ${describeTab()}${if (failures == 0) "" else "; $failures FAIL"}")
        } finally {
            framesFinding()
        }
    }

    // --- 0. the reference scene: the app menu ---------------------------------------------------------

    private fun baselineScenes() {
        ensureForeground()
        val menu = menuButtonPoint()
        val opened = scene("menu-sheet-open", JankBudget.Kind.OPEN, took = { chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) != null }) {
            Finger().tap(menu)
        }
        check("PERF-3 reference: the app menu opened under a finger (menu-sheet-open)", opened)
        if (!opened) {
            touchFault("a touch on the Menu button opened no app menu (menu-sheet-open)")
            back()
            awaitSurface(up = false, timeoutMs = 8_000)
            return
        }
        val closed = scene("menu-sheet-close", JankBudget.Kind.OPEN, timeoutMs = 8_000, took = { !chromeSurfaceUp() && findByLabel(MENU_HANDLE_LABEL) == null }) {
            back()
        }
        check("PERF-3 reference: the app menu went on a back (menu-sheet-close)", closed)
        SystemClock.sleep(600)
    }

    // --- 1. the entry and the crossing, both ways (site A) --------------------------------------------

    private fun entry() {
        finding("\nPUI-14 the entry: the article's offer on the §9.33 banner stack")
        val up = stripCheck("site A's article")
        snap("article-strip")
        beat()
        if (!up) {
            finding("  no offer: the crossing cannot be recorded")
            return
        }
        finding("\nMOT-36 the crossing in: Show under a finger")
        if (!crossIn("reader-crossing-enter")) return
        snap("reader")
        beat()
        finding("\nMOT-36 the crossing out: the app menu's Reader View row under a finger")
        crossOut("reader-crossing-exit")
        awaitLoaded("$SITE_A/")
        val returns = poll(8_000) { stripUp() }
        finding("  the offer returns for the article after the exit (the action un-muted the site): $returns (reported, not gated; the gate's question f)")
        snap("article-after-exit")
        beat()
    }

    /**
     * The strip as the page shows it: the title, the action and the X in the tree; one banner on
     * the stack with the glyph, the `status` role and its place at the frame's top, from the
     * chrome's document; no crossing layer at rest. True when the title is on screen.
     */
    private fun stripCheck(where: String): Boolean {
        val title = awaitNode(15_000) { it == STRIP_TITLE }
        val probe = bannerProbe()
        finding("  the banner stack on $where: $probe")
        check("$where: the offer '$STRIP_TITLE' is on screen", title != null)
        check("$where: the strip carries the one action '$STRIP_ACTION' and the X", findNode { it == STRIP_ACTION } != null && findNode { it == DISMISS_LABEL } != null)
        check(
            "$where: one banner on the stack – the glyph, the title, the action, role status, at the frame's top",
            probe.optInt("count") == 1 && probe.optString("title") == STRIP_TITLE && probe.optString("action") == STRIP_ACTION &&
                probe.optBoolean("glyph") && probe.optBoolean("close") && probe.optString("role") == "status" &&
                probe.optInt("top", Int.MAX_VALUE) * density < height / 2
        )
        check("$where: no crossing layer in the chrome at rest", !crossingPresent())
        return title != null
    }

    /**
     * Show under a finger as the `open` scene `name`: the button found and the crossing log armed
     * before the clock starts; after the block, the reader document up, the crossing layer gone
     * and the offer gone. The log's phases and their times go to the findings. False when the
     * finger went in and no reader came, or there was nothing to touch.
     */
    private fun crossIn(name: String): Boolean {
        val show = fingerOnButton(STRIP_ACTION) ?: run {
            check("a finger can reach '$STRIP_ACTION'", false)
            return false
        }
        armCrossingLog()
        val before = SystemClock.uptimeMillis()
        val entered = scene(name, JankBudget.Kind.OPEN, timeoutMs = 15_000, took = { isReader() && readerProbe().optString("title").isNotEmpty() && !crossingPresent() }) {
            Finger().tap(show)
        }
        val took = SystemClock.uptimeMillis() - before
        val log = crossingLog()
        finding("  the crossing's phases (ms from the first): ${describeLog(log)}")
        finding("  after the finger: ${describeTab()}; reader up in ≤ $took ms (the scene's block included)")
        if (!entered) {
            touchFault("a touch on $STRIP_ACTION did not bring the reader document up through the crossing")
            return false
        }
        val phases = log.map { it.second }
        check(
            "the crossing ran covering → loading (the surface shown over the picture) → landing, then left",
            phases.indexOf("enter:covering") >= 0 && phases.indexOf("enter:loading+surface") > phases.indexOf("enter:covering") &&
                phases.indexOf("enter:landing+surface") > phases.indexOf("enter:loading+surface") && phases.lastOrNull() == "none"
        )
        val probe = readerProbe()
        finding("  the reader document: $probe")
        check("the reader document carries the article's title", probe.optString("title").startsWith("The lighthouse keeper") || probe.optString("title").startsWith("a long night of tides") || probe.optString("title").startsWith("The harbourmaster"))
        check("the offer is gone with the crossing (no banner on the stack)", bannerProbe().optInt("count") == 0 && findNode { it == STRIP_TITLE } == null)
        val pill = pillProbe()
        finding("  the pill at rest in Reader View: $pill")
        check("the pill at rest is the favicon, the host and one site-information glyph: no reader chip (ReaderUiDemo's contract)", pill.optInt("chips") == 1 && pill.optInt("siteInfo") == 1 && pill.optInt("readerChip") == 0)
        return true
    }

    /**
     * The exit: the app menu opened and pulled (the harness's steps, outside any scene), the
     * checked Reader View row found, the log armed, then the finger on the row as the `open`
     * scene `name`; after the block the article back, the sheet and the crossing layer gone.
     */
    private fun crossOut(name: String): Boolean {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            check("the app menu opens on the reader page", false)
            return false
        }
        SystemClock.sleep(1_200)
        pullMenuUp()
        if (reveal(READER_ROW) == null) {
            check("the app menu carries the $READER_ROW row on the reader page", false)
            back()
            awaitSurface(up = false, timeoutMs = 8_000)
            return false
        }
        val row = fingerOn(READER_ROW) ?: run {
            check("a finger can reach the $READER_ROW row", false)
            back()
            awaitSurface(up = false, timeoutMs = 8_000)
            return false
        }
        armCrossingLog()
        val before = SystemClock.uptimeMillis()
        val left = scene(name, JankBudget.Kind.OPEN, timeoutMs = 15_000, took = { !isReader() && !chromeSurfaceUp() && !crossingPresent() }) {
            Finger().tap(row)
        }
        val took = SystemClock.uptimeMillis() - before
        val log = crossingLog()
        finding("  the exit's phases (ms from the first): ${describeLog(log)}")
        finding("  after the finger: ${describeTab()}; article back in ≤ $took ms (the scene's block included)")
        if (!left) {
            touchFault("a touch on the $READER_ROW row did not bring the article back through the crossing")
            return false
        }
        val phases = log.map { it.second }
        check(
            "the exit ran the crossing the other way: covering → loading → landing, then left",
            phases.indexOf("exit:covering") >= 0 && phases.indexOf("exit:loading+surface") > phases.indexOf("exit:covering") &&
                phases.indexOf("exit:landing+surface") > phases.indexOf("exit:loading+surface") && phases.lastOrNull() == "none"
        )
        return true
    }

    // --- 2. the memory: a swipe, the X, leaving the page, a page that is no article -----------------

    private fun memory() {
        finding("\nPUI-14 the memory: a refusal is remembered per site for the session")
        // Site A: the offer standing (it returned after the exit, or `/second` brings a fresh one).
        if (!stripUp()) {
            navigate("$SITE_A/second")
            poll(15_000) { tab()?.optBoolean("readerable") == true }
        }
        val title = waitFor(STRIP_TITLE, 10_000)
        check("site A: an offer stands to be swiped", title != null)
        if (title != null) {
            // From the title, not the action: a touch on a control stays the control's (FirstRunDemo's swipe).
            Finger().apply {
                down(title.left + 0.3f * title.width(), title.exactCenterY())
                moveBy(NUDGE, 0f, 80)
                moveBy(0.6f * width, 0f, 260)
                up()
            }
            val gone = waitForGone(STRIP_TITLE, 4_000)
            finding("  the swipe: strip gone=$gone; stack: ${bannerProbe()}")
            if (!gone) touchFault("a swipe on the strip did not take it off")
            check("site A: the swipe takes the strip off", gone)
            SystemClock.sleep(600)
        }
        val other = if (tab()?.optString("url") == "$SITE_A/") "$SITE_A/second" else "$SITE_A/"
        mutedCheck("site A after the swipe", other)
        snap("site-a-muted")
        beat()

        // Site B: no article, no strip; the X.
        finding("\nthe page that is no article")
        navigate("$SITE_B/plain")
        val plainReaderable = poll(4_000) { tab()?.optBoolean("readerable") == true }
        val plainStrip = poll(4_000) { stripUp() }
        finding("  ${describeTab()}; readerable=$plainReaderable; strip=$plainStrip")
        check("site B's /plain: the probe reads no article and no strip shows", !plainReaderable && !plainStrip)
        snap("plain-no-strip")
        beat()
        navigate("$SITE_B/")
        poll(15_000) { tab()?.optBoolean("readerable") == true }
        val bUp = stripCheck("site B's article (a site of its own: unmuted)")
        if (bUp) {
            val x = fingerOnButton(DISMISS_LABEL)
            if (x == null) {
                check("a finger can reach the X", false)
            } else {
                Finger().tap(x)
                val gone = waitForGone(STRIP_TITLE, 4_000)
                finding("  the X: strip gone=$gone; stack: ${bannerProbe()}")
                if (!gone) touchFault("a touch on the X did not take the strip off")
                check("site B: the X takes the strip off", gone)
            }
        }
        mutedCheck("site B after the X", "$SITE_B/second")
        snap("site-b-muted")
        beat()

        // Site D: the page left with the offer standing.
        finding("\nleaving the page with the offer standing (Chrome's scope destroyed = a dismissal)")
        navigate("$SITE_D/")
        poll(15_000) { tab()?.optBoolean("readerable") == true }
        val dUp = poll(10_000) { stripUp() }
        check("site D: the offer stands on the article", dUp)
        mutedCheck("site D after leaving the article with the offer standing", "$SITE_D/second")
        snap("site-d-muted")
        beat()
    }

    /** `url` on a muted site: loaded and read as an article, and no offer within four seconds. */
    private fun mutedCheck(where: String, url: String) {
        navigate(url)
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        val strip = poll(4_000) { stripUp() }
        finding("  $where: ${describeTab()}; readerable=$readerable; strip within 4 s=$strip")
        check("$where: another article of the site brings no offer (the site is muted for the session)", readerable && !strip)
    }

    // --- 3. dark (site C) -------------------------------------------------------------------------------

    /**
     * Zenium's own Dark first (`settings.update`; the host sets the app's night mode from the
     * chrome's answer), the system's second (`cmd uimode night yes`) – ReaderUiDemo's order,
     * which settles an open page's `prefers-color-scheme`; then the same acts on site C's
     * article, and the same order back to light.
     */
    private fun dark() {
        finding("\ndesign record: the strip, the crossing and the reader document in dark (site C)")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        val applied = poll(8_000) { activityNight() }
        finding("  Zenium's own Dark reached the app's night mode: $applied")
        shellCommand("cmd uimode night yes")
        SystemClock.sleep(2_500)
        ensureForeground()
        navigate("$SITE_C/")
        poll(15_000) { tab()?.optBoolean("readerable") == true }
        val pageDark = poll(8_000) { pageScheme() == "dark" }
        finding("  the article page's scheme: ${pageScheme()} (dark=$pageDark); the chrome's theme: ${chromeTheme()}")
        check("dark: the chrome is dark under the strip", chromeTheme() == "dark")
        val up = stripCheck("site C's article in dark")
        snap("article-strip-dark")
        beat()
        if (up && crossIn("reader-crossing-enter-dark")) {
            val probe = readerProbe()
            check("dark: the reader document paints its dark ground (${probe.optString("bg")})", probe.optString("scheme") == "dark" && probe.optString("bg").startsWith("rgb(24, 24, 28)"))
            snap("reader-dark")
            beat()
            crossOut("reader-crossing-exit-dark")
            awaitLoaded("$SITE_C/")
            val returns = poll(8_000) { stripUp() }
            finding("  dark: the offer returns after the exit: $returns (reported, not gated)")
            if (returns) {
                val x = fingerOnButton(DISMISS_LABEL)
                if (x != null) {
                    Finger().tap(x)
                    val gone = waitForGone(STRIP_TITLE, 4_000)
                    if (!gone) touchFault("dark: a touch on the X did not take the strip off")
                    check("dark: the X takes the strip off", gone)
                }
            }
        }
        // Back the same way round: Zenium's Light first, then the system's change.
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        poll(8_000) { !activityNight() }
        shellCommand("cmd uimode night no")
        SystemClock.sleep(1_500)
        finding("  back in light: the chrome's theme ${chromeTheme()}")
    }

    /** The activity's night bit, read on the main thread: Zenium's scheme as AppCompat applied it. */
    private fun activityNight(): Boolean {
        var night = false
        instrumentation.runOnMainSync {
            night = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        }
        return night
    }

    // --- the frame record ----------------------------------------------------------------------------

    /**
     * One scene through the harness's one helper ([traceFrames]): the block is `motion` – the
     * finger, or the back – and [MOTION_MS] for what it does; `took` is polled AFTER the block
     * for up to `timeoutMs` more (#198's rule, every finger with its assertion, kept out of the
     * frames). Answers whether `took` held.
     */
    private fun scene(name: String, kind: JankBudget.Kind, timeoutMs: Long = 6_000, took: () -> Boolean, motion: () -> Unit): Boolean {
        traceFrames(name, kind) {
            motion()
            SystemClock.sleep(MOTION_MS)
        }
        return poll(timeoutMs, took)
    }

    private fun Finger.tap(at: PointF) = tap(at.x, at.y)

    /** Where a finger lands on the node reading `label` exactly, found and settled before a scene's clock starts. */
    private fun fingerOn(label: String, timeoutMs: Long = 8_000): PointF? {
        val node = awaitNode(timeoutMs) { it == label || it.startsWith("$label ") || it.startsWith("$label\n") } ?: run {
            finding("  nothing on screen reads '$label'")
            return null
        }
        return pointOn(node, label)
    }

    /** Where a finger lands on the clickable node reading `label` (the strip's Show, its X); any node reading it when none is clickable. */
    private fun fingerOnButton(label: String, timeoutMs: Long = 8_000): PointF? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var clickable: AccessibilityNodeInfo? = null
        while (clickable == null && SystemClock.uptimeMillis() < deadline) {
            clickable = findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == label }
            if (clickable == null) SystemClock.sleep(200)
        }
        val node = clickable ?: findNode { it == label } ?: run {
            finding("  nothing on screen reads '$label'")
            return null
        }
        return pointOn(node, label)
    }

    private fun pointOn(node: AccessibilityNodeInfo, label: String): PointF? {
        val bounds = steadyBounds(node) ?: run {
            finding("  '$label' left the tree before the finger")
            return null
        }
        return touchPoint(bounds) ?: run {
            finding("  no part of '$label' ($bounds) is inside the touchable window")
            null
        }
    }

    /** The bar's Menu button, where [tapMenuButton] puts the finger: by label, else the default bar's end, on the pill's line. */
    private fun menuButtonPoint(): PointF =
        (findByLabel(MENU_LABEL) ?: waitFor(MENU_LABEL, 4_000))?.let { PointF(it.exactCenterX(), it.exactCenterY()) }
            ?: PointF(width - 30 * density, pillY)

    /**
     * The record's scenes, one line each, into the findings: HWUI's summary and long stage, the
     * trace's reading, the budget's verdict (the tables are the harness's `frames.txt`, the
     * record `frames.jsonl`).
     */
    private fun framesFinding() {
        val scenes = frameScenes
        if (scenes.isEmpty()) {
            finding("\nframes: no scene was measured")
            return
        }
        finding("\nframes (DemoHarness.traceFrames, PERF-3's harness; gate ${jankGate.key}; the emulator's software GPU makes every frame janky by construction: the trace columns, and the same scenes run to run on this one recipe, are the reading):")
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

    // --- the crossing's log -------------------------------------------------------------------------------

    /**
     * A `MutationObserver` in the chrome's document that notes every change of the crossing
     * layer's state – `<crossing>:<phase>`, `+surface` while the reader's surface is shown, `none`
     * without a layer – with the document's clock; armed (or emptied) before a scene's block, read
     * after it ([crossingLog]). One `querySelector` per DOM change is its whole cost.
     */
    private fun armCrossingLog() {
        chromeJs(
            "(function(){var w=window;if(!w.__zenCrossing){var log=[];var seen=null;var read=function(){" +
                "var el=document.querySelector('.zen-reader-crossing');var s=el?el.getAttribute('data-crossing')+':'+el.getAttribute('data-phase')+" +
                "(el.querySelector('.zen-reader-crossing-surface[data-shown]')?'+surface':''):'none';" +
                "if(s!==seen){seen=s;log.push([Math.round(performance.now()),s]);}};" +
                "new MutationObserver(read).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-phase','data-shown']});" +
                "w.__zenCrossing={log:log,read:read};read();}else{w.__zenCrossing.log.length=0;w.__zenCrossing.read();}return 'armed'})()"
        )
    }

    /** The log's entries since it was armed: (ms, state). */
    private fun crossingLog(): List<Pair<Long, String>> {
        val raw = jsonString(chromeJs("(function(){var c=window.__zenCrossing;return c?JSON.stringify(c.log):'[]'})()"))
        return runCatching {
            val a = JSONArray(raw)
            (0 until a.length()).map { i -> val e = a.getJSONArray(i); e.getLong(0) to e.getString(1) }
        }.getOrDefault(emptyList())
    }

    private fun describeLog(log: List<Pair<Long, String>>): String {
        if (log.isEmpty()) return "nothing logged"
        val first = log.first().first
        return log.joinToString(" → ") { (t, s) -> "$s@${t - first}" }
    }

    private fun crossingPresent(): Boolean =
        jsonString(chromeJs("(function(){return document.querySelector('.zen-reader-crossing')?'yes':'no'})()")) == "yes"

    // --- the strip, the pill, the page --------------------------------------------------------------------

    private fun stripUp(): Boolean = findNode { it == STRIP_TITLE } != null || bannerProbe().optString("title") == STRIP_TITLE

    /** The banner stack from the chrome's document: how many, the first's title, action, glyph, X, role and place (CSS px). */
    private fun bannerProbe(): JSONObject {
        val raw = jsonString(chromeJs(
            "(function(){var b=document.querySelectorAll('.zen-banner');var f=b[0];if(!f)return JSON.stringify({count:0});" +
                "var r=f.getBoundingClientRect();var t=f.querySelector('.zen-banner-title span');var a=f.querySelector('.zen-message-button');" +
                "return JSON.stringify({count:b.length,title:t?(t.textContent||'').trim():'',action:a?(a.textContent||'').trim():'',glyph:!!f.querySelector('.zen-message-glyph')," +
                "close:!!f.querySelector('.zen-message-close'),role:f.getAttribute('role'),top:Math.round(r.top),left:Math.round(r.left),width:Math.round(r.width),height:Math.round(r.height)," +
                "theme:document.documentElement.getAttribute('data-theme')})})()"
        ))
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    private fun chromeTheme(): String = jsonString(chromeJs("(function(){return document.documentElement.getAttribute('data-theme')||''})()"))

    /** The phone pill's chips, from the chrome's document: how many, the site-information glyph, any reader chip. */
    private fun pillProbe(): JSONObject {
        val raw = jsonString(chromeJs(
            "(function(){var p=document.querySelector('.zen-phone-pill');if(!p)return '{}';" +
                "return JSON.stringify({chips:p.querySelectorAll('[data-pill-chip]').length,siteInfo:p.querySelectorAll('[data-site-info]').length," +
                "readerChip:p.querySelectorAll('[data-reader-prefs-chip]').length,text:(p.textContent||'').trim().slice(0,40)})})()"
        ))
        return runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
    }

    private fun isReader(): Boolean = tab()?.optString("url")?.startsWith("zen://reader") == true

    /** The reader document from inside it: the title, its ground, the scheme it resolved to. */
    private fun readerProbe(): JSONObject {
        val raw = pageJs(
            "(function(){var d=document;return JSON.stringify({title:(d.querySelector('header h1')||{}).textContent||''," +
                "bg:getComputedStyle(d.body).backgroundColor,scheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    private fun pageScheme(): String =
        jsonString(pageJs("(function(){return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})()"))

    /** Evaluate in the demo tab's page; the raw JSON-encoded result. */
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
        return "url=${tab.optString("url").take(60)} title=\"${tab.optString("title").take(40)}…\" readerable=${tab.optBoolean("readerable")} loading=${tab.optBoolean("loading")}"
    }

    private fun navigate(url: String) {
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote(url)}}""")
        awaitLoaded(url)
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
        finding("  $url never finished loading: ${describeTab()}")
    }

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
        private const val PORT = 18153
        /** Four loopback addresses, four sites to the entry's memory, one port. */
        private val SITES = listOf("127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4")
        private const val SITE_A = "http://127.0.0.1:$PORT"
        private const val SITE_B = "http://127.0.0.2:$PORT"
        private const val SITE_C = "http://127.0.0.3:$PORT"
        private const val SITE_D = "http://127.0.0.4:$PORT"
        private const val TAB = "tab_demo"
        private const val HTML = "text/html; charset=utf-8"
        /** The stills' and the frame files' prefix (the harness's `shotPrefix`). */
        private const val MEDIA_PREFIX = "android-reader-entry"
        /** The strip's words (`lib/readerEntry.ts`). */
        private const val STRIP_TITLE = "Show Reader View?"
        private const val STRIP_ACTION = "Show"
        /** The banner's X (`BannerCard`'s `aria-label`). */
        private const val DISMISS_LABEL = "Dismiss"
        /** The app menu's row (`core/menus.ts`): the entry's second way in, checked in the reader. */
        private const val READER_ROW = "Reader View"
        /** Too short for the probe: one line of text, no article. */
        private const val PLAIN_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<title>Harbour notices</title><style>body{margin:0;padding:24px 20px;font:17px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff}" +
            "@media (prefers-color-scheme: dark){body{color:#e6e6e6;background:#121212}}</style></head>" +
            "<body><h1>Harbour notices</h1><p>The harbour office is closed on Sunday.</p></body></html>"
        /**
         * What a measured scene's block gives the motion after the finger: the crossing's picture,
         * its 120 ms fade, the core's extraction and navigation, the destination's load and the
         * host's draw at the emulator's pace, with room; the frames after the landing are not
         * rendered and cost the reading nothing. The claim is polled after it.
         */
        private const val MOTION_MS = 3_500L
    }
}
