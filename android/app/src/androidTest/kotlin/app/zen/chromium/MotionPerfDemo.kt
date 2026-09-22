package app.zen.chromium

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
import java.util.zip.GZIPInputStream
import kotlin.math.roundToInt

/**
 * The performance program's profile of the phone's whole-app motion (perf-program.md, PERF-5's
 * items after PERF-4's hand-over), one scene per motion, every scene through the harness's
 * [traceFrames] (HWUI's frame statistics, reported; the chrome WebView's own Chromium trace,
 * read into the renderer main thread's frames – its time per frame, its style / layout / paint
 * split, its long tasks – which is where a stutter of the chrome is made). Real touches on the
 * address pill over loopback copies of pages ([DemoServer]: github.com's repository page, a long
 * article, the bar-hide demo's page), the same pages in the same order every run, so a before
 * and an after compare on one recipe.
 *
 * THE TAB SWIPE on the pill (#27 / #84), in the pieces a finger makes of it:
 *
 *  - `tab-swipe-begin`: the touch comes down on the pill and crosses the slop; the chrome
 *    snapshots the live page (`overlay.snapshot`), decodes it into the current tab's card and
 *    the track appears in the page's place. The one long task of a swipe lives here.
 *  - (the finger then rests on the pill with the track up, off the record: the chrome is idle
 *    under a held finger – 0 main-thread frames in 1.2 s over four runs of a hold scene)
 *  - `tab-swipe-drag`: the finger carries the track most of one card to the left between two
 *    loose tabs (no group ribbon on any card of the track). PERF-4's first hypothesis lives
 *    here: every move re-renders the stage's cards through React before their transforms are
 *    written.
 *  - `tab-swipe-release`: the lift; the snappy spring lands the track on the next tab, the
 *    core activates it, the live page returns.
 *  - `tab-swipe-fling`: a quick flick back, down to rest, in one scene: the way most swipes
 *    are made.
 *  - `tab-swipe-grouped-drag`: the drag again between two tabs of a group, whose cards wear
 *    the group's ribbon (`backdrop-filter` + an opacity that follows the finger: PERF-4's
 *    second hypothesis), read against `tab-swipe-drag`.
 *
 * THE OVERVIEW's open and close (#26 / #147: the grid scales and fades in on `.zen-overview`
 * while the hero card – the page's stand-in – morphs between the page's frame and its card by
 * the rect-lerp of v2 §11.4, a layout per frame BY DESIGN, whose cost is measured here and
 * reported before anything about it changes), on the seeded six tabs and again on thirty
 * (twenty-four more created unloaded, `tab.create` with `load: false`: a card each, no page, no
 * picture – the grid's size and nothing else; the `-30` scenes), see [overviewScenes]:
 *
 *  - `overview-pull-begin`: the touch on the pill, the slop upward, the page's capture, the
 *    overview's mount (its grid rendered for the first time this open).
 *  - `overview-pull-drag`: the finger carrying the grid in over three quarters of the travel
 *    (`overview.progress` follows the finger; the hero's rect-lerp runs per frame).
 *  - `overview-pull-settle`: the lift; the spring opens the rest of the way.
 *  - `overview-close-pick`: a tap on the page's own card; the hero grows back into the page.
 *  - `overview-fling-open`: a quick pull let go half way in (past the swipe's commit fraction,
 *    so the release commits on position); the spring carries the open from there, the capture
 *    and the mount in the scene.
 *  - `overview-back-drag` / `overview-back-commit` (the six tabs only): the system's back gesture
 *    from the left edge held a third of the way across, the overview receding on its progress;
 *    then the release, which closes it. The run puts the system in gesture navigation with its
 *    back animations before the launch for these (the shared recipe sets three-button
 *    navigation); the pill sits higher by the difference of the two navigation bars' insets.
 *
 * THE GROUP FOLD in the open overview (v2 §11.4: a group folding or unfolding runs its height on
 * the gentle spring – a layout per frame, BY DESIGN – while the cells below hold where they were,
 * frame by frame, and glide to their slots once the height has settled), the `overview-group`
 * group, on the six tabs and on thirty, the overview opened off the record by the fling, see
 * [groupScenes]:
 *
 *  - `overview-group-fold`: a tap on the Docs group's header; the group shrinks to its header,
 *    the cards below (four; twenty-eight on thirty) hold, then glide up.
 *  - `overview-group-unfold`: the tap again; the group grows back, the cards below hold, then
 *    glide down.
 *
 *  The hold the user sees – the cards below static from the tap to their glide; PERF-5 saw ~2.0 s
 *  of it on the emulator at OverviewDemo's step 7 – is what these measure: the probe keeps a
 *  timeline of every frame that wrote the group's height or a cell's transform, and the findings
 *  read the hold's length off it, the height animation's frames and their intervals against the
 *  spring's own time (the spring's 64 ms step clamp stretches it by the frame rate's shortfall),
 *  the release's lag after the settle, and the glide – see [foldNumbers].
 *
 * The groups are picked by the `scenes` argument (`DEMO_SCENES`: `all`, or a comma list of
 * `tab-swipe`, `overview`, `overview-group`), so a branch profiling one motion pays for its
 * scenes alone.
 *
 * The scenes are measured BEFORE the recorder rolls (screenrecord composes a second copy of
 * every frame on the emulator's software GPU); the recorded part is the media: the slow swipe,
 * the fling back, the grouped swipe; the overview pulled in, open, and picked closed. The
 * app's startup sweeps (Safe Browsing's, the blocker's) are held for the run when the workflow
 * asks (`holdBackgroundWork`, #313); without the hold the scenes start after the sweeps' window,
 * which would otherwise land in a scene as long tasks of the app's, not the motion's.
 *
 * Beside the harness's numbers an in-chrome probe (a MutationObserver on the chrome's tree)
 * counts what each scene wrote to the DOM: the cards' style writes (one per card per frame
 * moved), the dim layers', the ribbons', the pill's (and the pill's remounts: its content is
 * keyed by the tab under the finger), the root's, and the nodes added and removed – the
 * attribution the trace's stripped arguments cannot give. Its counts go to `perf-motion.json`
 * and `findings.txt` in the findings, per scene, with the core's active tab before and after.
 * The scenes that begin with a touch also run the page's own sampler over themselves (the JS
 * Self-Profiling API, open to a debug build's document): the scene's script BY FUNCTION, the
 * long task's included, which the WebView's trace cannot name (its arguments are stripped, its
 * V8 sampler's with them) – see [scene].
 */
@RunWith(AndroidJUnit4::class)
class MotionPerfDemo : DemoHarness("perf-motion-demo-state.json", "perf-motion", "perf-motion") {
    override val tag = "MotionPerfDemo"
    private val theme = InstrumentationRegistry.getArguments().getString("theme").let {
        if (it == "dark") "dark" else "light"
    }
    /** The scene groups this run measures (`scenes`: `all` or a comma list of `tab-swipe`, `overview`, `overview-group`). */
    private val groups: Set<String> = InstrumentationRegistry.getArguments().getString("scenes").let { arg ->
        if (arg.isNullOrBlank() || arg == "all") GROUPS else arg.split(',').map { it.trim() }.filter { it in GROUPS }.toSet()
    }
    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val scenes = JSONArray()
    /** The last [scene]'s record in [scenes], for a driver step that adds to it (the fold's numbers). */
    private var lastScene: JSONObject? = null
    private var launchedAt = 0L
    /** Gesture navigation is on (set before the launch for the overview's back scenes). */
    private var gestural = false
    /** [beforeLaunch] changed the navigation mode; [restoreNavigation] puts it back at the end. */
    private var navigationChanged = false
    /** `enable_back_animation` as the system had it before the launch (`null` / empty when unset). */
    private var backAnimationBefore = ""

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("bar-hide-demo-page.html").toByteArray()),
                "/github" to ("text/html; charset=utf-8" to pageFixture("github-repo")),
                "/article" to ("text/html; charset=utf-8" to pageFixture("article"))
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            restoreNavigation()
            File(out, "perf-motion.json").writeText(
                JSONObject().put("package", app.packageName).put("theme", theme)
                    .put("window", JSONObject().put("width", width).put("height", height).put("density", density.toDouble()))
                    .put("scenes", scenes).toString(2)
            )
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$theme\"")

    override fun beforeLaunch() {
        // The overview's predictive back scenes are the system's back gesture: gesture navigation
        // and its animations, before the app starts (the shared recipe sets three-button
        // navigation, whose bar has no gesture zone; the window's insets – the pill's place –
        // change with the mode, so this comes before the harness measures the window).
        if ("overview" in groups) {
            backAnimationBefore = shellCommand("settings get global enable_back_animation").trim()
            shellCommand("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
            shellCommand("cmd overlay enable com.android.internal.systemui.navbar.gestural")
            shellCommand("settings put global enable_back_animation 1")
            SystemClock.sleep(3_000)
            gestural = shellCommand("cmd overlay list").lines().any { it.contains("[x] com.android.internal.systemui.navbar.gestural") }
            navigationChanged = true
            Log.i(tag, "navigation: ${if (gestural) "gestural" else "NOT gestural (the back scenes are skipped)"}")
        }
        launchedAt = SystemClock.uptimeMillis()
    }

    /**
     * The system's navigation back to the shared recipe's three-button mode (and the back
     * animation setting to what it was) once the profile is done: the functional drivers chained
     * after it on the same boot (android-motion-perf.sh) run under the mode their own workflows
     * give them. Only at the end – the mode change moves the window's insets, and the pill's
     * place was measured at the launch – and only when [beforeLaunch] changed it.
     */
    private fun restoreNavigation() {
        if (!navigationChanged) return
        shellCommand("cmd overlay disable com.android.internal.systemui.navbar.gestural")
        shellCommand("cmd overlay enable com.android.internal.systemui.navbar.threebutton")
        if (backAnimationBefore.isEmpty() || backAnimationBefore == "null") {
            shellCommand("settings delete global enable_back_animation")
        } else {
            shellCommand("settings put global enable_back_animation $backAnimationBefore")
        }
        val threeButton = shellCommand("cmd overlay list").lines().any { it.contains("[x] com.android.internal.systemui.navbar.threebutton") }
        Log.i(tag, "navigation restored: ${if (threeButton) "three-button" else "NOT three-button"}; enable_back_animation ${backAnimationBefore.ifEmpty { "unset" }}")
    }

    // --- warm-up: the pictures, then the measured scenes ------------------------------------------

    override fun warmUp() {
        ensureForeground()
        finding("Zenium Android motion profile ($theme; ${width}x$height, density $density; ${webViewVersion()})")
        finding("demo server: ${server.selfCheck()}")
        // Every tab of the track visited and captured, so each card has its picture: a touch on
        // the pill that does not swipe snapshots the active page the way a swipe's first touch does.
        for (tabId in TRACK) {
            activate(tabId)
            touchWithoutGesture()
            settle()
        }
        activate(START_TAB)
        settle()
        finding("chrome probe: ${installProbe()}")
        // Pay for the touch pipeline off the record: one swipe there and back.
        flingLeft()
        settle()
        flingRight()
        settle()
        // The app's startup sweeps (Safe Browsing's lists, the blocker's) are the app's long
        // tasks, not the swipe's: held for the run (`holdBackgroundWork`), or waited out.
        val sinceLaunch = SystemClock.uptimeMillis() - launchedAt
        if (holdBackgroundWork) {
            finding("the startup sweeps are held for the run")
        } else if (sinceLaunch < SWEEP_MS) {
            finding("waiting ${SWEEP_MS - sinceLaunch} ms for the startup sweeps to pass")
            SystemClock.sleep(SWEEP_MS - sinceLaunch)
        }
        finding("active tab before the scenes: ${activeTabId()}; groups: ${groups.joinToString(", ")}")
        if ("tab-swipe" in groups) measureTabSwipe()
        if ("overview" in groups || "overview-group" in groups) measureOverview()
    }

    /**
     * The recorded media: the slow swipe, the fling back, the grouped swipe; the overview's pull
     * and its return; the group folded and unfolded in the open overview.
     */
    override fun demo() {
        activate(START_TAB)
        settle()
        if ("tab-swipe" in groups) {
            shot("swipe-rest")
            slowSwipe()
            SystemClock.sleep(RELEASE_MS)
            shot("swipe-landed")
            flingRight()
            settle()
            activate(GROUP_TAB)
            settle()
            shot("grouped-rest")
            slowSwipe()
            SystemClock.sleep(RELEASE_MS)
            shot("grouped-landed")
            settle()
        }
        if ("overview" in groups) {
            activate(START_TAB)
            settle()
            val f = Finger()
            f.down(pillCenterX, pillY)
            f.settleIn(0f, -NUDGE)
            f.moveBy(0f, -PULL_FRACTION * overviewTravel, PULL_MS)
            f.hold(DRAG_TAIL_MS)
            shot("overview-pulled")
            f.up()
            awaitOverview(open = true)
            SystemClock.sleep(OPEN_REST_MS)
            shot("overview-open")
            pickActiveCard()
            awaitOverview(open = false)
            SystemClock.sleep(CLOSE_REST_MS)
            shot("overview-returned")
        }
        if ("overview-group" in groups) {
            activate(START_TAB)
            settle()
            if (openOverview()) {
                val header = groupHeaderRect()
                if (header != null) {
                    // Each tap's effect checked before its still, as the scenes' taps are: a tap
                    // the system drops (`leaveGroup`) would leave a still named for a state it
                    // does not show, and the group folded behind the pick.
                    Finger().tap(header.exactCenterX(), header.exactCenterY())
                    SystemClock.sleep(FOLD_SETTLE_MS)
                    leaveGroup(collapsed = true, "group-folded")
                    shot("group-folded")
                    Finger().tap(header.exactCenterX(), header.exactCenterY())
                    SystemClock.sleep(FOLD_SETTLE_MS)
                    leaveGroup(collapsed = false, "group-unfolded")
                    shot("group-unfolded")
                }
                pickActiveCard()
                awaitOverview(open = false)
                SystemClock.sleep(CLOSE_REST_MS)
            }
        }
    }

    // --- the overview ------------------------------------------------------------------------------

    /**
     * The overview's scenes on the seeded six tabs, then on thirty: the pull in its pieces, the
     * pick that closes it, a fling open, and (under gesture navigation) the system's back gesture
     * over it (`overview`); the group folded and unfolded in the open overview (`overview-group`).
     * The thirty are the six plus [EXTRA_TABS] created unloaded (`load: false`: a card each in the
     * grid, no page behind it, no picture in it), so the second set is the grid's size and nothing
     * else; the back scenes run on the six alone.
     */
    private fun measureOverview() {
        val pull = "overview" in groups
        val fold = "overview-group" in groups
        if (pull) finding("overview: navigation ${if (gestural) "gestural (the back scenes run)" else "three-button (the back scenes are skipped)"}")
        activate(START_TAB)
        settle()
        if (pull) overviewScenes("", back = gestural)
        if (fold) groupScenes("")
        var made = 0
        for (i in 1..EXTRA_TABS) {
            val id = coreInvoke("tab.create", "{\"url\":${JSONObject.quote("$ORIGIN/article?extra=$i")},\"active\":false,\"load\":false}")
            if (id.isNotEmpty()) made++
        }
        finding("overview: $made tabs created unloaded; ${coreState().getJSONObject("tabs").length()} tabs in the core")
        activate(START_TAB)
        settle()
        if (pull) overviewScenes("-30", back = false)
        if (fold) groupScenes("-30")
    }

    // --- the group fold ----------------------------------------------------------------------------

    /**
     * The group fold's scenes in the open overview, named with `suffix`: a tap on the Docs group's
     * header folds it (`overview-group-fold`), a second tap unfolds it (`overview-group-unfold`);
     * each scene is the tap and [FOLD_SETTLE_MS] for the height animation, the hold and the glide
     * to land, its script sampled by function. The overview is opened off the record by the fling
     * and closed by the pick afterwards; the group is left as it was seeded (open). The Docs group
     * heads the grid (`tabOrderOf`: the group's tabs first), so every loose card is below it.
     */
    private fun groupScenes(suffix: String) {
        if (!openOverview()) {
            finding("overview-group$suffix: the overview did not open; the group scenes are skipped")
            return
        }
        val found = groupHeaderRect()
        if (found == null) {
            finding("overview-group$suffix: no $GROUP_NAME group header on screen (${groupState()}); the group scenes are skipped")
            closeOverview()
            return
        }
        // The fold scene folds an OPEN group, as seeded: a group left folded (a tap of the set
        // before this one that the system dropped, say) is unfolded off the record first, so the
        // scene's name says what its tap did.
        leaveGroup(collapsed = false, "overview-group$suffix (before the scenes)")
        val header = groupHeaderRect() ?: found
        finding("overview-group$suffix: ${cardsInGrid()} cards in the grid; the $GROUP_NAME group ${groupState()}; header at $header")
        scene("overview-group-fold$suffix", JankBudget.Kind.SPRING, profile = true) {
            Finger().tap(header.exactCenterX(), header.exactCenterY())
            SystemClock.sleep(FOLD_SETTLE_MS)
        }
        finding("overview-group-fold$suffix: ${groupState()}; ${foldLine()}")
        SystemClock.sleep(FOLD_REST_MS)
        leaveGroup(collapsed = true, "overview-group-fold$suffix")
        // The header stays where it was (the group folds from its header down); read again in case.
        val again = groupHeaderRect() ?: header
        scene("overview-group-unfold$suffix", JankBudget.Kind.SPRING, profile = true) {
            Finger().tap(again.exactCenterX(), again.exactCenterY())
            SystemClock.sleep(FOLD_SETTLE_MS)
        }
        finding("overview-group-unfold$suffix: ${groupState()}; ${foldLine()}")
        SystemClock.sleep(FOLD_REST_MS)
        leaveGroup(collapsed = false, "overview-group-unfold$suffix")
        closeOverview()
    }

    /**
     * The group as the step `name` should have left it (or should find it), off the record: an
     * injected tap the system drops (#339's retry saw the InputDispatcher drop OverviewDemo's
     * step-7 tap, "no targets were found") folds nothing, and the next scene would then fold where
     * it should unfold; so when the state is not `collapsed`, the header is tapped again and the
     * fold given its time, and the finding says so (a scene's own numbers say "the tap folded
     * nothing"). Every tap on the group – the scenes', the recorded pass's, and the scenes' own
     * starting state – is checked through here.
     */
    private fun leaveGroup(collapsed: Boolean, name: String) {
        if (groupState().startsWith("collapsed") == collapsed) return
        val header = groupHeaderRect()
        if (header == null) {
            finding("$name: the group is ${groupState()} and its header is off screen; left as it is")
            return
        }
        finding("$name: the group is ${groupState()}, not ${if (collapsed) "collapsed" else "open"} as it should be (a tap did not take); tapped off the record")
        Finger().tap(header.exactCenterX(), header.exactCenterY())
        SystemClock.sleep(FOLD_SETTLE_MS)
        finding("$name: the group is ${groupState()} after the off-record tap")
    }

    /**
     * The overview opened off the record by the fling (the way most opens are made), at rest;
     * false when it did not open in time. Nothing when it is up already.
     */
    private fun openOverview(): Boolean {
        if (overviewState() == "closed") {
            val g = Finger()
            g.down(pillCenterX, pillY)
            g.moveBy(0f, -NUDGE, 60)
            g.moveBy(0f, -FLING_FRACTION * overviewTravel, FLING_MS)
            g.up()
        }
        val opened = awaitOverview(open = true)
        SystemClock.sleep(OPEN_REST_MS)
        return opened
    }

    /** The overview closed by the pick of the active tab's card (a back when the card is not found), and a rest. */
    private fun closeOverview() {
        pickActiveCard()
        awaitOverview(open = false)
        SystemClock.sleep(CLOSE_REST_MS)
    }

    /**
     * The on-screen box of the Docs group's header in the open overview: the accessibility tree's
     * (the card's name, "Docs, tab group, 2 tabs", by its leading name: [groupCard]), else the
     * DOM's; null when there is none.
     */
    private fun groupHeaderRect(): android.graphics.Rect? =
        findByLabel(groupCard(GROUP_NAME)) ?: domRect(".zen-overview .zen-group > .zen-group-header")

    /** `open, 392 px tall`, `collapsed, clipped, 44 px tall (inline 44px)`, or `no group card`. */
    private fun groupState(): String = jsString(
        "(function(){var e=document.querySelector('.zen-overview .zen-group');if(!e)return 'no group card';" +
            "return (e.hasAttribute('data-collapsed')?'collapsed':'open')+(e.hasAttribute('data-clip')?', clipped':'')+" +
            "', '+Math.round(e.getBoundingClientRect().height)+' px tall'+(e.style.height?' (inline '+e.style.height+')':'')})()"
    )

    /** The last scene's fold numbers ([foldNumbers]) written into its record and described for the findings. */
    private fun foldLine(): String {
        val json = lastScene ?: return "no scene"
        val fold = foldNumbers(json.optJSONObject("probe") ?: JSONObject())
        if (fold != null) json.put("fold", fold)
        return describeFold(fold)
    }

    /**
     * The fold's numbers out of the probe's timeline (`tl`, see [installProbe]: one entry per
     * frame that wrote a cell, `[t, h, n, y]` – the group shell's inline height that frame in px
     * (-1 when it was not written; -2 when it was cleared, the spring at rest), the cells' style
     * writes and the first one's translateY – and `[t, "down" | "click"]` for the tap's events).
     * Times in ms from the tap's `pointerdown` (from the first height write without one). Null when
     * no height was written: the tap folded nothing.
     *
     *  - the height animation: its first write's delay after the tap (the click's dispatch and
     *    the React commit that starts the spring), its frames, their wall time, and the spring's
     *    own time – each interval clamped at the spring's 64 ms step ([SPRING_STEP_CLAMP_MS],
     *    `SpringAnimation.tick`) – whose ratio is how far the frame rate stretched it; the mean and
     *    the longest interval; the height it ran from and to; its direction's reversals (the
     *    gentle spring overshoots a hair by design: one is expected) and its rests (a second rest
     *    is a spring run again);
     *  - the cells below: their style writes per height frame (the tracker's compensation, one
     *    write per cell per frame; the commit's clearing doubles the first frame's);
     *  - the hold: from the tap to the glide's first frame – the cards below static meanwhile –
     *    and the release's lag after the settle (one frame when the release runs at the rest;
     *    more when it waited on a glide in flight); the glide's frames, length and travel.
     */
    private fun foldNumbers(probe: JSONObject): JSONObject? {
        val tl = probe.optJSONArray("tl") ?: return null
        var down = Double.NaN
        var click = Double.NaN
        val frames = ArrayList<DoubleArray>()
        for (i in 0 until tl.length()) {
            val e = tl.getJSONArray(i)
            if (e.length() == 2) {
                when (e.getString(1)) {
                    "down" -> if (down.isNaN()) down = e.getDouble(0)
                    "click" -> if (click.isNaN()) click = e.getDouble(0)
                }
            } else frames += doubleArrayOf(e.getDouble(0), e.getDouble(1), e.getDouble(2), e.getDouble(3))
        }
        val heights = frames.filter { it[1] >= 0 }
        if (heights.isEmpty()) return null
        val t0 = if (down.isNaN()) heights.first()[0] else down
        var wall = 0.0
        var spring = 0.0
        var longest = 0.0
        for (i in 1 until heights.size) {
            val d = heights[i][0] - heights[i - 1][0]
            wall += d
            spring += Math.min(d, SPRING_STEP_CLAMP_MS)
            longest = Math.max(longest, d)
        }
        var reversals = 0
        var lastSign = 0
        for (i in 1 until heights.size) {
            val s = Math.signum(heights[i][1] - heights[i - 1][1]).toInt()
            if (s == 0) continue
            if (lastSign != 0 && s != lastSign) reversals++
            lastSign = s
        }
        val rests = frames.count { it[1] == -2.0 }
        val settledAt = frames.last { it[1] != -1.0 }[0]
        val glide = frames.filter { it[0] > settledAt && it[2] > 0 }
        val travel = frames.filter { it[0] >= settledAt }.maxOfOrNull { Math.abs(it[3]) } ?: 0.0
        val o = JSONObject()
            .put("clickMs", if (click.isNaN()) JSONObject.NULL else r1(click - t0))
            .put("heightFirstMs", r1(heights.first()[0] - t0))
            .put("heightLastMs", r1(heights.last()[0] - t0))
            .put("heightFrames", heights.size)
            .put("heightFrom", r1(heights.first()[1]))
            .put("heightTo", r1(heights.last()[1]))
            .put("heightWallMs", r1(wall))
            .put("heightSpringMs", r1(spring))
            .put("stretch", if (spring > 0) r1(wall / spring) else 1.0)
            .put("frameMeanMs", if (heights.size > 1) r1(wall / (heights.size - 1)) else 0.0)
            .put("frameMaxMs", r1(longest))
            .put("reversals", reversals)
            .put("rests", rests)
            .put("cellWritesPerHeightFrame", r1(heights.sumOf { it[2] } / heights.size))
            .put("settledMs", r1(settledAt - t0))
        if (glide.isNotEmpty()) {
            o.put("holdMs", r1(glide.first()[0] - t0))
                .put("releaseLagMs", r1(glide.first()[0] - settledAt))
                .put("glideFrames", glide.size)
                .put("glideMs", r1(glide.last()[0] - glide.first()[0]))
                .put("glidePx", r1(travel))
                .put("glideFrameMeanMs", if (glide.size > 1) r1((glide.last()[0] - glide.first()[0]) / (glide.size - 1)) else 0.0)
        }
        return o
    }

    /** [foldNumbers] as a line of the findings. */
    private fun describeFold(o: JSONObject?): String {
        if (o == null) return "no height was written: the tap folded nothing"
        val line = StringBuilder()
        line.append("height first written ${o.optDouble("heightFirstMs")} ms after the tap (click at ${o.opt("clickMs")} ms), ")
        line.append("${o.optInt("heightFrames")} frames over ${o.optDouble("heightWallMs")} ms (mean ${o.optDouble("frameMeanMs")}, max ${o.optDouble("frameMaxMs")} ms/frame; ")
        line.append("${o.optDouble("heightSpringMs")} ms of spring time at the ${SPRING_STEP_CLAMP_MS.toInt()} ms clamp: ${o.optDouble("stretch")}x stretched), ")
        line.append("${o.optDouble("heightFrom")} -> ${o.optDouble("heightTo")} px, ${o.optInt("reversals")} reversal(s), ${o.optInt("rests")} rest(s); ")
        line.append("${o.optDouble("cellWritesPerHeightFrame")} cell writes per height frame; ")
        if (o.has("holdMs")) {
            line.append("HOLD ${o.optDouble("holdMs")} ms from the tap to the glide's first frame (${o.optDouble("releaseLagMs")} ms after the settle); ")
            line.append("glide ${o.optInt("glideFrames")} frames over ${o.optDouble("glideMs")} ms (mean ${o.optDouble("glideFrameMeanMs")} ms/frame), ${o.optDouble("glidePx")} px")
        } else line.append("NO GLIDE followed the settle in the scene's window")
        return line.toString()
    }

    private fun r1(v: Double): Double = Math.round(v * 10) / 10.0

    /**
     * One set of the overview's scenes, named with `suffix`:
     *
     *  - `overview-pull-begin`: the touch on the pill, the slop upward, the capture of the page
     *    and the overview's mount (its grid rendered for the first time this open: every card).
     *  - `overview-pull-drag`: the finger carrying the grid in over [PULL_FRACTION] of the travel;
     *    `overview.progress` follows it, the hero card morphs (the rect-lerp) each frame.
     *  - `overview-pull-settle`: the lift; the spring opens the rest of the way.
     *  - `overview-close-pick`: a tap on the page's own card; the hero grows back into the page,
     *    the page returns (`layout.report`).
     *  - `overview-fling-open`: a quick pull let go at [FLING_FRACTION] of the travel, the spring
     *    carrying the open from there; the capture and the mount are in it (the way most opens are
     *    made). Closed again off the record by the same pick.
     *  - `overview-back-drag` / `overview-back-commit` (with `back`): the system's back gesture
     *    from the left edge held a third of the way across, the overview receding on its progress;
     *    then the release, which closes it.
     */
    private fun overviewScenes(suffix: String, back: Boolean) {
        val hero = activeTabId()
        val f = Finger()
        scene("overview-pull-begin$suffix", JankBudget.Kind.OPEN, profile = true) {
            f.down(pillCenterX, pillY)
            f.settleIn(0f, -NUDGE)
        }
        scene("overview-pull-drag$suffix", JankBudget.Kind.GESTURE, profile = true) {
            f.moveBy(0f, -PULL_FRACTION * overviewTravel, PULL_MS)
            f.hold(DRAG_TAIL_MS)
        }
        scene("overview-pull-settle$suffix", JankBudget.Kind.SPRING) {
            f.up()
            SystemClock.sleep(OPEN_SETTLE_MS)
        }
        finding("overview-pull$suffix: ${overviewState()}; hero $hero; ${cardsInGrid()} cards in the grid")
        val opened = awaitOverview(open = true)
        SystemClock.sleep(OPEN_REST_MS)
        // The card is found while the overview is up; with none (the overview never opened, or
        // the hero has no card) the scene is a back over the overview – never over the page,
        // where a back would leave the app (the fling's release under load once snapped the
        // overview closed, and the back meant for it ended the run).
        val card = if (opened) activeCardRect() else null
        scene("overview-close-pick$suffix", JankBudget.Kind.SPRING, profile = true) {
            if (card != null) Finger().tap(card.exactCenterX(), card.exactCenterY()) else backOverOverview()
            SystemClock.sleep(CLOSE_SETTLE_MS)
        }
        finding("overview-close-pick$suffix: ${if (card != null) "tapped the card at $card" else "NO CARD FOUND for $hero, closed with back"}; ${overviewState()}; active ${activeTabId()}")
        awaitOverview(open = false)
        SystemClock.sleep(CLOSE_REST_MS)

        scene("overview-fling-open$suffix", JankBudget.Kind.SPRING) {
            val g = Finger()
            g.down(pillCenterX, pillY)
            g.moveBy(0f, -NUDGE, 60)
            g.moveBy(0f, -FLING_FRACTION * overviewTravel, FLING_MS)
            g.up()
            SystemClock.sleep(OPEN_SETTLE_MS)
        }
        finding("overview-fling-open$suffix: ${overviewState()}")
        awaitOverview(open = true)
        SystemClock.sleep(OPEN_REST_MS)

        if (back && awaitSurface(true, 4_000)) {
            val b = Finger()
            scene("overview-back-drag$suffix", JankBudget.Kind.GESTURE) {
                b.down(EDGE_X, height * 0.6f)
                b.moveBy(BACK_FRACTION * width, 0f, BACK_MS)
                b.hold(DRAG_TAIL_MS)
            }
            finding("overview-back-drag$suffix: ${overviewState()}")
            scene("overview-back-commit$suffix", JankBudget.Kind.SPRING) {
                b.up()
                SystemClock.sleep(CLOSE_SETTLE_MS)
            }
            finding("overview-back-commit$suffix: ${overviewState()}; active ${activeTabId()}")
            if (!awaitOverview(open = false)) {
                finding("overview-back-commit$suffix: the overview did not close on the gesture; closing with back")
                backOverOverview()
                awaitOverview(open = false)
            }
        } else {
            if (back) finding("overview-back$suffix: the host reports no surface up for the back gesture; the back scenes are skipped")
            pickActiveCard()
            awaitOverview(open = false)
        }
        SystemClock.sleep(CLOSE_REST_MS)
    }

    /**
     * A tap on the active tab's card in the open overview (a back when the card is not found);
     * nothing when the overview is not up – a back on the page would leave the app.
     */
    private fun pickActiveCard() {
        if (overviewState() == "closed") {
            finding("pick: the overview is closed already; nothing to pick")
            return
        }
        val card = activeCardRect()
        if (card != null) Finger().tap(card.exactCenterX(), card.exactCenterY()) else backOverOverview()
    }

    /** A back while the overview is up; none when it is closed (a back on the page would leave the app). */
    private fun backOverOverview() {
        if (overviewState() == "closed") {
            finding("back: the overview is closed already; the back is not sent")
            return
        }
        back()
    }

    /** The on-screen box of the active tab's card in the overview's grid, null when there is none. */
    private fun activeCardRect(): android.graphics.Rect? = domRect(".zen-overview [data-tab-id=${JSONObject.quote(activeTabId())}]")

    /**
     * The on-screen box of the first element `selector` matches (`getBoundingClientRect` in
     * device px); the chrome fills the window, so the DOM's origin is the screen's – checked once
     * against the accessibility tree's box of the overview's Spaces button, like OverviewMotionDemo.
     */
    private fun domRect(selector: String): android.graphics.Rect? {
        val text = jsString(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';var r=e.getBoundingClientRect();" +
                "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})})()"
        )
        if (text.isEmpty()) return null
        val o = JSONObject(text)
        val d = o.getDouble("d")
        calibrate()
        return android.graphics.Rect(
            (o.getDouble("l") * d + originX).roundToInt(),
            (o.getDouble("t") * d + originY).roundToInt(),
            (o.getDouble("r") * d + originX).roundToInt(),
            (o.getDouble("b") * d + originY).roundToInt()
        )
    }

    private var originX = 0f
    private var originY = 0f
    private var calibrated = false

    private fun calibrate() {
        if (calibrated) return
        val text = jsString(
            "(function(){var e=document.querySelector('.zen-overview [aria-label=\"Spaces\"]');if(!e)return '';var r=e.getBoundingClientRect();" +
                "return JSON.stringify({x:(r.left+r.right)/2*window.devicePixelRatio,y:(r.top+r.bottom)/2*window.devicePixelRatio})})()"
        )
        if (text.isEmpty()) return
        val fromTree = findByLabel("Spaces") ?: return
        val o = JSONObject(text)
        val dx = fromTree.exactCenterX() - o.getDouble("x").toFloat()
        val dy = fromTree.exactCenterY() - o.getDouble("y").toFloat()
        calibrated = true
        if (Math.abs(dx) <= MAX_ORIGIN_OFFSET && Math.abs(dy) <= MAX_ORIGIN_OFFSET) {
            originX = dx
            originY = dy
        }
        finding("coordinates: the DOM's origin is ${originX.roundToInt()}, ${originY.roundToInt()} px into the screen (Spaces button: tree $fromTree, DOM centre ${o.getDouble("x").roundToInt()}, ${o.getDouble("y").roundToInt()})")
    }

    /** A JS expression's string result ("" when the chrome never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    /** `open` (at rest, scale 1), `at <transform>` (in motion), or `closed` (no `.zen-overview`). */
    private fun overviewState(): String =
        jsString("(function(){var e=document.querySelector('.zen-overview');if(!e)return 'closed';return e.style.transform==='scale(1)'?'open':'at '+e.style.transform+' opacity '+e.style.opacity})()")

    private fun cardsInGrid(): Int = jsString("String(document.querySelectorAll('.zen-overview [data-tab-id]').length)").toIntOrNull() ?: -1

    /** Poll the chrome until the overview is open at rest (or gone, with `open = false`); false when it is not in time. */
    private fun awaitOverview(open: Boolean, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val state = overviewState()
            if ((open && state == "open") || (!open && state == "closed")) return true
            SystemClock.sleep(200)
        }
        finding("the overview is ${overviewState()} after $timeoutMs ms, ${if (open) "not open" else "not closed"}")
        return false
    }

    // --- the tab swipe -----------------------------------------------------------------------------

    private fun measureTabSwipe() {
        val f = Finger()
        val before = activeTabId()
        // The begin: the touch, the slop, the capture, the track. Sampled: the one long task of a
        // swipe is the first touch's listener, and the trace has no name for it.
        scene("tab-swipe-begin", JankBudget.Kind.OPEN, profile = true) {
            f.down(pill.right - 10f, pillY)
            f.settleIn(-NUDGE, 0f)
        }
        // The finger rests on the pill with the track up before the drag – off the record since the
        // fourth run: four runs of a `tab-swipe-hold` scene saw 0 main-thread frames and 1 ms busy
        // in 1.2 s (the chrome is idle under a held finger), and a scene without frames is a
        // breach of the gate's by design, not a result.
        f.hold(HOLD_MS)
        scene("tab-swipe-drag", JankBudget.Kind.GESTURE) {
            f.moveBy(-DRAG_FRACTION * advance(), 0f, DRAG_MS)
            f.hold(DRAG_TAIL_MS)
        }
        scene("tab-swipe-release", JankBudget.Kind.SPRING) {
            f.up()
            SystemClock.sleep(RELEASE_MS)
        }
        val after = activeTabId()
        val next = TRACK.getOrNull(TRACK.indexOf(before) + 1)
        finding("tab-swipe: $before -> $after (${if (after == next) "the next tab" else "NOT the next tab"})")

        // The fling back, whole (sampled: a second first touch).
        scene("tab-swipe-fling", JankBudget.Kind.SPRING, profile = true) {
            flingRight()
            SystemClock.sleep(RELEASE_MS)
        }
        finding("tab-swipe-fling: $after -> ${activeTabId()} (${if (activeTabId() == before) "back" else "NOT back"})")

        // The grouped drag: the same drag between the two tabs of the group, their ribbons on.
        activate(GROUP_TAB)
        settle()
        val g = Finger()
        g.down(pill.right - 10f, pillY)
        g.settleIn(-NUDGE, 0f)
        scene("tab-swipe-grouped-drag", JankBudget.Kind.GESTURE, baseline = "tab-swipe-drag") {
            g.moveBy(-DRAG_FRACTION * advance(), 0f, DRAG_MS)
            g.hold(DRAG_TAIL_MS)
        }
        g.up()
        SystemClock.sleep(RELEASE_MS)
        finding("tab-swipe-grouped: $GROUP_TAB -> ${activeTabId()}")
    }

    /** The recorded slow swipe: down at the pill's right end, the slop, one card left, lift. */
    private fun slowSwipe() {
        val f = Finger()
        f.down(pill.right - 10f, pillY)
        f.settleIn(-NUDGE, 0f)
        f.moveBy(-DRAG_FRACTION * advance(), 0f, DRAG_MS)
        f.hold(DRAG_TAIL_MS)
        f.up()
    }

    /** One card's advance on the track in device px: the page's width plus the 16 CSS px gap (`CARD_GAP`). */
    private fun advance(): Float = width + 16f * density

    // --- one scene ---------------------------------------------------------------------------------

    /**
     * One traced scene: the probe's counters zeroed, the block under [traceFrames], the counters
     * read after it (never inside: a read of the chrome is work the app did not do for the user)
     * and written down with the scene's trace line. With [profile], the page's sampler runs over
     * the scene too (started before the touch, stopped after the window) and the scene's script by
     * function joins the line and the JSON: for the scenes with a long task to name, since the
     * sampler's signals are a cost of their own on the thread they sample.
     */
    private fun scene(name: String, kind: JankBudget.Kind, baseline: String? = null, profile: Boolean = false, block: () -> Unit): FrameStats.Scene {
        resetProbe()
        val activeBefore = activeTabId()
        val sampling = if (profile) startProfile() else null
        val result = traceFrames(name, kind, baseline, block)
        val profiled = if (profile) stopProfile() else null
        val probe = readProbe()
        val json = JSONObject().put("scene", name).put("kind", kind.key).put("activeBefore", activeBefore).put("activeAfter", activeTabId())
            .put("probe", probe)
        result.trace?.let { json.put("trace", JSONObject(it.toJson())) }
        result.traceMissing?.let { json.put("traceMissing", it) }
        profiled?.let { json.put("profile", it) }
        scenes.put(json)
        lastScene = json
        val frames = result.trace?.frames ?: 0
        finding(
            "[$name] ${result.trace?.describe() ?: "trace: ${result.traceMissing}"}; probe: ${describeProbe(probe, frames)}; " +
                "listeners: ${describeEvents(probe)}; commands: ${describeCommands(probe)}" +
                (if (sampling != null) "; script by function ($sampling): ${profiled?.let { describeProfile(it) } ?: "none"}" else "")
        )
        return result
    }

    // --- the chrome's probe ---------------------------------------------------------------------

    /**
     * A MutationObserver over the chrome's tree, counting the inline style writes by their target
     * – the stage's cards, its dim layers, the group ribbons, the pill, the root – and the nodes
     * added and removed (the stage's mount, the pill's remount when the tab under the finger
     * changes). Style writes alone (`attributeFilter`): a class change is not a per-frame thing
     * here. Beside it, the time the chrome's listeners take per touch event, by type (`ev`: a
     * capture listener on the window is the first to run for an event and a bubble listener on
     * the window the last, so their gap is every listener between, React's root ones and the
     * microtasks each of them leaves behind – the trace has the dispatch's time but not its
     * event's name; listeners on `document`, `#root` and its first child cut the longest one
     * into React's capture listener, the path inside and React's bubble listener, and
     * `performance.mark`s at the cuts put them in the trace), and the commands the chrome sent
     * the core (`cmd`, by name: what a scene asks of the host). Installed once; reset per scene.
     *
     * For the group fold, the writes to the grid's cells (the elements carrying `data-cell`) are
     * counted apart – the group card's shell (`group`: its height, one write per frame of its
     * spring) and the cards (`cell`: the tracker's transforms, one per card per frame held or
     * gliding) – and kept as a TIMELINE (`tl`, up to [TIMELINE_MAX] entries a scene): one entry per
     * observer callback that wrote a cell, `[t, h, n, y]` – the time, the shell's inline height in
     * px as the frame left it (-1: not written this frame; -2: cleared, the spring at rest), the
     * cards' writes and the first written card's translateY – and `[t, "down"]` / `[t, "click"]`
     * for the tap's events. The observer runs once per task, after the frame's script (a
     * microtask), so an entry is a frame of the animation: [foldNumbers] reads the hold and the
     * glide off it.
     */
    private fun installProbe(): String = chromeJs(
        "(function(){if(window.__motion)return 'kept';" +
            "var p=window.__motion={};" + RESET_JS +
            "var inPill=function(n){return !!(n&&n.closest&&n.closest('.zen-phone-pill'))};" +
            "var isStage=function(n){return n.nodeType===1&&(n.classList.contains('zen-stage-card')||(n.querySelector&&!!n.querySelector('.zen-stage-card')))};" +
            "new MutationObserver(function(rs){var fh,fn=0,fy;for(var i=0;i<rs.length;i++){var r=rs[i],t=r.target;" +
            "if(r.type==='attributes'){var c=t.classList;" +
            // The hero wears `zen-stage-card` too: it is read first. Inside it, the title row's
            // height and opacity and the picture's scale are the hero's inner writes.
            "if(c&&c.contains('zen-overview-hero'))p.hero++;else if(c&&c.contains('zen-stage-card'))p.card++;else if(c&&c.contains('zen-stage-dim'))p.dim++;" +
            "else if(c&&c.contains('zen-group-ribbon'))p.ribbon++;else if(c&&c.contains('zen-overview'))p.overview++;else if(c&&c.contains('zen-overview-card'))p.ovCard++;" +
            "else if(t===document.documentElement)p.root++;else if(inPill(t))p.pill++;" +
            // A cell of the grid: the group card's shell (its height) or a card (its transform).
            "else if(t.hasAttribute&&t.hasAttribute('data-cell')){if(c.contains('zen-group')){p.group++;var hs=t.style.height;fh=hs===''?-2:parseFloat(hs)}" +
            "else{p.cell++;fn++;if(fy===undefined){var tf=t.style.transform,k=tf.indexOf(',');fy=k<0?0:parseFloat(tf.slice(k+1))}}}" +
            "else if(t.closest&&t.closest('.zen-overview-hero'))p.heroInner++;else if(t.closest&&t.closest('.zen-overview'))p.ovInner++;else p.other++}" +
            "else{p.added+=r.addedNodes.length;p.removed+=r.removedNodes.length;" +
            "for(var j=0;j<r.addedNodes.length;j++){if(isStage(r.addedNodes[j]))p.stageMounts++}" +
            "if(inPill(t)&&r.addedNodes.length)p.pillRemounts++}}" +
            "if((fh!==undefined||fn>0)&&p.tl.length<$TIMELINE_MAX)p.tl.push([Math.round(performance.now()*10)/10,fh===undefined?-1:Math.round(fh*10)/10,fn,fy===undefined?0:Math.round(fy*10)/10])})" +
            ".observe(document.documentElement,{attributes:true,attributeFilter:['style'],childList:true,subtree:true});" +
            "var at={},root=document.getElementById('root'),inner=root&&root.firstElementChild;" +
            "var seg=function(r,k,d){if(d>(r[k]||0))r[k]=d};" +
            "['pointerover','pointerenter','pointerdown','touchstart','pointermove','touchmove','pointerup','touchend','pointercancel','gotpointercapture','lostpointercapture','click']" +
            ".forEach(function(ty){var t={};" +
            "window.addEventListener(ty,function(){at[ty]=t.w0=performance.now();performance.mark('probe:'+ty+':w0');var r=p.ev[ty]||(p.ev[ty]={n:0,ms:0,max:0});r.n++;" +
            "if((ty==='pointerdown'||ty==='click')&&p.tl.length<$TIMELINE_MAX)p.tl.push([Math.round(t.w0*10)/10,ty==='click'?'click':'down'])},true);" +
            // React's listeners sit on #root, capture and bubble, registered before these: a
            // capture listener on #root runs after React's capture one, a bubble listener on
            // #root's first child before React's bubble one. So the cuts are React's capture
            // listener (d0 → r0), the path inside (r0 → i1), React's bubble listener (i1 → d1).
            "document.addEventListener(ty,function(){t.d0=performance.now()},true);" +
            "if(root)root.addEventListener(ty,function(){t.r0=performance.now();performance.mark('probe:'+ty+':r0')},true);" +
            "if(inner)inner.addEventListener(ty,function(){t.i1=performance.now();performance.mark('probe:'+ty+':i1')},false);" +
            "document.addEventListener(ty,function(){t.d1=performance.now()},false);" +
            "window.addEventListener(ty,function(){var now=performance.now();performance.mark('probe:'+ty+':w1');var d=now-(at[ty]||now);var r=p.ev[ty];r.ms+=d;if(d>r.max)r.max=d;" +
            "if(t.d0&&t.r0)seg(r,'reactCapture',t.r0-t.d0);if(t.r0&&t.i1)seg(r,'inner',t.i1-t.r0);if(t.i1&&t.d1)seg(r,'reactBubble',t.d1-t.i1);t={}},false)});" +
            "if(window.zen&&typeof window.zen.invoke==='function'){var o=window.zen.invoke;window.zen.invoke=function(n){p.cmd[n]=(p.cmd[n]||0)+1;return o.apply(this,arguments)}}" +
            PROFILER_JS +
            "return 'installed'})()"
    )

    /**
     * The scene's script by function, if the chrome's document may profile itself (`Profiler`,
     * the JS Self-Profiling API; a debug build's document carries the `Document-Policy` for it,
     * `ChromeWebView.profilable`). Started before the scene's touch and stopped after its window;
     * its samples folded in the page into the top frames by SELF time (the function on top of the
     * stack), by INCLUSIVE time (anywhere on it) and the longest stretch of consecutive script
     * samples with its own top frames – a long task's attribution, which the WebView's trace
     * cannot give (its `FunctionCall`s carry no name). A sample's time is the gap to the next,
     * capped at five intervals (a stretch the sampler missed is not one function's). The bundle
     * is minified: a frame's `file:line:col` is what its source map resolves.
     */
    private fun startProfile(): String = chromeJs("window.__motion?window.__motion.prof.start($PROFILE_INTERVAL_MS):'no probe'").trim('"')

    private fun stopProfile(): JSONObject? {
        val stopped = chromeJs("window.__motion?window.__motion.prof.stop():'no probe'").trim('"')
        if (stopped != "stopping") {
            finding("profile: $stopped")
            return null
        }
        val deadline = SystemClock.uptimeMillis() + PROFILE_WAIT_MS
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = chromeJs("JSON.stringify(window.__motion.profile)")
            val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return null
            if (text != "pending") return runCatching { JSONObject(text) }.getOrNull()
            SystemClock.sleep(50)
        }
        finding("profile: the sampler's stop did not resolve in $PROFILE_WAIT_MS ms")
        return null
    }

    /** `dispatchEvent (index-abc.js:1:23456) 30 ms, …; longest stretch 62 ms: …`. */
    private fun describeProfile(p: JSONObject): String {
        p.optString("error").takeIf { it.isNotEmpty() }?.let { return "error $it" }
        val frames = { a: JSONArray? ->
            if (a == null || a.length() == 0) "none" else (0 until a.length()).joinToString(", ") { i ->
                val f = a.getJSONObject(i)
                val at = f.optString("url").takeIf { it.isNotEmpty() }?.let { " ($it:${f.optInt("line")}:${f.optInt("col")})" } ?: ""
                "${f.optString("fn").ifEmpty { "(anonymous)" }}$at ${f.optInt("ms")} ms"
            }
        }
        val longest = p.optJSONObject("longest")
        return "${p.optInt("samples")} samples every ${p.optInt("intervalMs")} ms, script ${p.optInt("scriptMs")} of ${p.optInt("totalMs")} ms; " +
            "self: ${frames(p.optJSONArray("self"))}; inclusive: ${frames(p.optJSONArray("inclusive"))}" +
            (longest?.let { "; longest stretch ${it.optInt("ms")} ms: ${frames(it.optJSONArray("self"))}" } ?: "")
    }

    private fun resetProbe() {
        chromeJs("(function(){var p=window.__motion;if(p){$RESET_JS}})()")
    }

    /**
     * The probe's counters as a line, the zero ones left out: `cards 76 (3.62/frame), dims 38, …,
     * nodes +1/-1`. The style writes of the things that move per frame carry their per-frame rate.
     */
    private fun describeProbe(probe: JSONObject, frames: Int): String {
        val per = { key: String -> if (frames > 0) String.format(java.util.Locale.ROOT, " (%.2f/frame)", probe.optInt(key) / frames.toDouble()) else "" }
        val parts = ArrayList<String>()
        for ((key, label, rated) in PROBE_COUNTERS) {
            val n = probe.optInt(key)
            if (n > 0) parts += "$label $n" + (if (rated) per(key) else "")
        }
        parts += "nodes +${probe.optInt("added")}/-${probe.optInt("removed")}"
        if (probe.optInt("stageMounts") > 0) parts += "stage mounts ${probe.optInt("stageMounts")}"
        if (probe.optInt("pillRemounts") > 0) parts += "pill remounts ${probe.optInt("pillRemounts")}"
        return parts.joinToString(", ")
    }

    /** The probe's listener times as a line: `pointerdown 1x 0.2 ms (max 0.2)`, the types with time in them, the longest first. */
    private fun describeEvents(probe: JSONObject): String {
        val ev = probe.optJSONObject("ev") ?: return "-"
        val parts = ev.keys().asSequence().map { it to ev.getJSONObject(it) }
            .sortedByDescending { it.second.optDouble("max", 0.0) }
            .filter { it.second.optDouble("ms", 0.0) >= 0.5 }
            .map { (ty, r) ->
                val cuts = listOf("reactCapture", "inner", "reactBubble").filter { r.has(it) }
                    .map { "${it.removePrefix("react").lowercase()} ${f1(r.optDouble(it))}" }
                "$ty ${r.optInt("n")}x ${f1(r.optDouble("ms"))} ms (max ${f1(r.optDouble("max"))}" +
                    (if (cuts.isEmpty()) ")" else "; longest: ${cuts.joinToString(", ")})")
            }
            .toList()
        return if (parts.isEmpty()) "none over 0.5 ms" else parts.joinToString(", ")
    }

    private fun describeCommands(probe: JSONObject): String {
        val cmd = probe.optJSONObject("cmd") ?: return "-"
        val parts = cmd.keys().asSequence().map { it to cmd.optInt(it) }.sortedByDescending { it.second }.map { "${it.first} ${it.second}" }.toList()
        return if (parts.isEmpty()) "none" else parts.joinToString(", ")
    }

    private fun f1(v: Double): String = String.format(java.util.Locale.ROOT, "%.1f", v)

    private fun readProbe(): JSONObject {
        val raw = chromeJs("JSON.stringify(window.__motion||{},function(k,v){return k==='prof'||k==='profiler'||k==='profile'?undefined:v})")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
    }

    // --- the core and the pages ------------------------------------------------------------------

    /** Make `tabId` the active tab through the core and wait for its page to be loaded and shown. */
    private fun activate(tabId: String) {
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val deadline = SystemClock.uptimeMillis() + LOAD_TIMEOUT_MS
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(tabId)
                last = "${view?.url} @ ${view?.progress}"
                loaded = view != null && view.progress == 100 && (view.url ?: "").startsWith(ORIGIN)
            }
            if (loaded && activeTabId() == tabId) {
                SystemClock.sleep(LOADED_SETTLE_MS)
                return
            }
            SystemClock.sleep(250)
        }
        finding("$tabId did not load in time (view at $last)")
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id", "") ?: ""

    /** A page fixture kept gzipped in the tree (`perf/<name>.html.gz`); AAPT2 may have unpacked it (see BarHidePerfDemo). */
    private fun pageFixture(name: String): ByteArray {
        val assets = instrumentation.context.assets
        val plain = runCatching { assets.open("perf/$name.html") }.getOrNull()
        if (plain != null) return plain.use { it.readBytes() }
        return GZIPInputStream(assets.open("perf/$name.html.gz")).use { it.readBytes() }
    }

    private fun webViewVersion(): String =
        runCatching { android.webkit.WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "WebView ?"

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    companion object {
        private const val PORT = 18170
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /** The track in the pill's order (`tabOrderOf`: the group's tabs first, then the loose ones). */
        private val TRACK = listOf("tab_doc_a", "tab_doc_b", "tab_github", "tab_article", "tab_long", "tab_extra")
        /** The plain scenes start here: the cards on the track around it are all loose tabs. */
        private const val START_TAB = "tab_article"
        /** The grouped scene starts on the group's first tab and drags to its second. */
        private const val GROUP_TAB = "tab_doc_a"
        /** The startup sweeps' window from the app's launch (the blocker's at 20 s, Safe Browsing's at 35 s since #313), waited out when they are not held. */
        private const val SWEEP_MS = 40_000L
        private const val LOAD_TIMEOUT_MS = 30_000L
        private const val LOADED_SETTLE_MS = 1_500L
        private const val HOLD_MS = 1_200L
        private const val DRAG_MS = 1_200L
        private const val DRAG_TAIL_MS = 300L
        /** How much of one card the drag carries the track; the release's spring does the rest. */
        private const val DRAG_FRACTION = 0.9f
        /** The spring, the core's activation and the live page's return after a lift. */
        private const val RELEASE_MS = 3_000L
        /** The sampler's interval asked for; Chromium rounds it up to its base interval (10 ms) and the probe reports the one it got. */
        private const val PROFILE_INTERVAL_MS = 10
        private const val PROFILE_WAIT_MS = 4_000L

        /** The scene groups a run can measure (`scenes`). */
        private val GROUPS = setOf("tab-swipe", "overview", "overview-group")
        /** The seeded group the fold scenes fold and unfold (`folder_docs`: the two Docs tabs, at the head of the grid). */
        private const val GROUP_NAME = "Docs"
        /**
         * The fold scene's window after the tap: the height spring, the hold and the glide (about a
         * second at 60 Hz; the emulator's frame rate stretches both springs by its shortfall under
         * the step clamp, so the window is generous and the timeline says where the motion ended).
         */
        private const val FOLD_SETTLE_MS = 5_000L
        private const val FOLD_REST_MS = 1_500L
        /**
         * `SpringAnimation.tick`'s longest step: a frame longer than this advances the spring by
         * this much only. The twin of `SPRING_STEP_CLAMP_MS` in `lib/motion/spring.ts`, which is
         * the source; `spring.test.ts` pins the two equal, so a change there fails here by name.
         */
        private const val SPRING_STEP_CLAMP_MS = 64.0
        /** The probe's timeline cap per scene (a frame's entry each; the thirty-tab glide is under a hundred). */
        private const val TIMELINE_MAX = 800
        /** Tabs created unloaded for the overview's second set: the six seeded plus these make thirty. */
        private const val EXTRA_TABS = 24
        /** How far the pull carries the overview in before the lift; the spring does the rest. */
        private const val PULL_FRACTION = 0.75f
        private const val PULL_MS = 1_200L
        /**
         * The fling lets go this far in, quickly. Past the swipe's commit fraction (0.45 of the
         * travel, `SWIPE_THRESHOLDS`) so the release commits on POSITION whatever the chrome's
         * velocity tracker made of the injected moves: at a quarter of the travel over 150 ms the
         * open hung on the velocity estimate alone and went either way run to run (open on six tabs
         * and closed on thirty in one run, the reverse in the next), and a fling that closed took
         * the back scenes after it off the record. Still a quick pull: 0.5 of the travel in 220 ms.
         */
        private const val FLING_FRACTION = 0.5f
        private const val FLING_MS = 220L
        /** The spring's open and the grid's rest after a lift; the morph back and the page's return after a pick. */
        private const val OPEN_SETTLE_MS = 2_500L
        private const val CLOSE_SETTLE_MS = 3_000L
        /** A rest between scenes, so the next touch begins a gesture of its own. */
        private const val OPEN_REST_MS = 1_500L
        private const val CLOSE_REST_MS = 2_500L
        /** The back gesture: from the screen's left edge, this far across, over this long (BackDemo's thumb). */
        private const val EDGE_X = 2f
        private const val BACK_FRACTION = 0.33f
        private const val BACK_MS = 650L
        /** How far the DOM's origin may sit from the screen's before the calibration is disbelieved. */
        private const val MAX_ORIGIN_OFFSET = 64f

        /**
         * The probe's counters in the order the findings print them: key, label, whether the
         * per-frame rate is worth printing (the things that move per frame).
         */
        private val PROBE_COUNTERS = listOf(
            Triple("card", "cards", true),
            Triple("hero", "hero", true),
            Triple("heroInner", "hero inner", true),
            Triple("overview", "overview root", true),
            Triple("ovCard", "overview cards", true),
            Triple("group", "group height", true),
            Triple("cell", "cells", true),
            Triple("ovInner", "overview inner", true),
            Triple("dim", "dims", false),
            Triple("ribbon", "ribbons", false),
            Triple("pill", "pill", false),
            Triple("root", "root", false),
            Triple("other", "other", false)
        )

        /** The probe's counters at zero (runs where `p` is the probe's object). */
        private const val RESET_JS =
            "p.card=0;p.hero=0;p.heroInner=0;p.overview=0;p.ovCard=0;p.group=0;p.cell=0;p.ovInner=0;p.dim=0;p.ribbon=0;p.pill=0;p.root=0;p.other=0;" +
                "p.added=0;p.removed=0;p.stageMounts=0;p.pillRemounts=0;p.ev={};p.cmd={};p.tl=[];"

        /**
         * The probe's sampler (`window.__motion.prof`): `start(ms)` opens a `Profiler` over the
         * document, `stop()` folds its trace into `window.__motion.profile` (`'pending'` until the
         * promise lands): the samples, the interval, the time in script and off it, the top frames
         * by self and by inclusive time, the longest stretch of consecutive script samples with its
         * top self frames. Runs inside `installProbe`'s closure, where `p` is the probe's object.
         */
        private const val PROFILER_JS =
            "p.prof={start:function(iv){if(typeof Profiler!=='function')return 'no Profiler (the document carries no js-profiling policy)';" +
                "try{p.profiler=new Profiler({sampleInterval:iv,maxBufferSize:40000});p.profile=null;return 'sampling every '+p.profiler.sampleInterval+' ms'}" +
                "catch(e){return 'refused: '+e}}," +
                "stop:function(){var pr=p.profiler;if(!pr)return 'not started';p.profiler=null;p.profile='pending';var iv=pr.sampleInterval||10;" +
                "pr.stop().then(function(t){p.profile=fold(t,iv)},function(e){p.profile={error:String(e)}});return 'stopping'}};" +
                "function fold(t,iv){var fr=t.frames,st=t.stacks,ss=t.samples,rs=t.resources,self={},incl={},off=0,total=0,runs=[],run=null,n=ss.length;" +
                "for(var i=0;i<n;i++){var s=ss[i],dt=i+1<n?ss[i+1].timestamp-s.timestamp:iv;if(dt>5*iv)dt=5*iv;total+=dt;" +
                "if(s.stackId===undefined){off+=dt;if(run){runs.push(run);run=null}continue}" +
                "if(!run)run={ms:0,self:{}};run.ms+=dt;var sid=s.stackId,leaf=true,seen={};" +
                "while(sid!==undefined){var e=st[sid],fid=e.frameId;if(leaf){self[fid]=(self[fid]||0)+dt;run.self[fid]=(run.self[fid]||0)+dt;leaf=false}" +
                "if(!seen[fid]){incl[fid]=(incl[fid]||0)+dt;seen[fid]=1}sid=e.parentId}}" +
                "if(run)runs.push(run);runs.sort(function(a,b){return b.ms-a.ms});" +
                "var label=function(fid){var f=fr[fid],u=f.resourceId!==undefined?rs[f.resourceId]:'';return {fn:f.name||'',url:u?u.slice(u.lastIndexOf('/')+1):'',line:f.line||0,col:f.column||0}};" +
                "var top=function(m,k){return Object.keys(m).sort(function(a,b){return m[b]-m[a]}).slice(0,k).map(function(fid){var l=label(fid);l.ms=Math.round(m[fid]);return l})};" +
                "return {samples:n,intervalMs:iv,totalMs:Math.round(total),scriptMs:Math.round(total-off),self:top(self,8),inclusive:top(incl,8)," +
                "longest:runs.length?{ms:Math.round(runs[0].ms),self:top(runs[0].self,5)}:null}}"
    }
}
