package app.zen.chromium

import java.util.Locale
import kotlin.math.abs

/**
 * The jank budget behind `DemoHarness.measureFrames` / `traceFrames`: what a scene of each kind
 * may do before the gate speaks up. ONE place for the numbers; the harness applies them, the
 * workflow's summary shows them next to every scene, and `JankBudgetTest` pins the evaluation.
 *
 * WHAT IS GATED, AND WHAT IS ONLY REPORTED. The shared recipe (`.github/workflows/
 * android-emulator-demo.yml`: a `pixel_6` image – API 34 for most demos, API 35 for the sheet
 * recede demo –, `-gpu swangle`, 720x1600 at density 280) has no GPU: ANGLE over SwiftShader
 * composites every frame on the CPU, 100 ms and more per frame, so EVERY frame misses HWUI's
 * deadline (the janky share is 100 percent by construction) and the frame times are the software
 * GPU's, not the chrome's (services' #261 run and PERF-3's baseline both read 100 percent janky,
 * p50 300 to 500 ms, on every scene; the main-thread HWUI stages were 0 to 6 ms; the long stage
 * `sync` / `commands` / `delay`). An absolute frame-time threshold therefore gates nothing on this
 * recipe – the perf program's ruling (perf-program.md, THE HARNESS FLOOR) – and there is none
 * here. Frames, janky share, p50 / p90 / p95 / p99 and HWUI's stages stay in every record as
 * REPORTED columns. The gate reads two things the software GPU does not dominate:
 *
 *  1. The TRACE columns (`traceFrames`; [BlinkTrace]): the chrome WebView renderer's main-thread
 *     work in the scene – layouts and paints PER FRAME, the main-thread time per frame (its 95th
 *     percentile), the long tasks. That is where a stutter of the chrome is made (a bar that lays
 *     the page out on every scroll frame, a sheet that repaints its blur), and what Bennett's
 *     phone would feel: main-thread time and layout / paint counts per frame are the defensible
 *     before / after numbers; swangle frame times are not device performance.
 *  2. RATIOS against a same-run BASELINE scene (`measureFrames(..., baseline = "<scene>")`): the
 *     scene's p95 over the baseline's, the scene's janky share against the baseline's, both read
 *     on the same recipe minutes apart, so the recipe cancels out – recipe-independent by
 *     construction. The baseline is a scene of the same motion with the chrome's part removed
 *     (the bar-hide scroll's baseline is the same drag with the setting off), measured anywhere in
 *     the run: the verdicts are settled once the run is over, with every scene known.
 *
 * A scene that names no baseline and takes no trace is REPORTED ONLY, whatever the gate: the
 * record says so (`gated: []`). A scene that asked for a trace and got none, or names a baseline
 * the run never measured, is a breach: a gate that lets an unmeasured scene through is no gate.
 *
 * The gate itself ([Gate]): SOFT reports every scene and fails nothing; HARD fails the SCENE
 * whose budget is breached – a jank fault the harness raises at the end of the run with the
 * scene's table in the message, like a touch fault – never the run as a whole mid-sequence, so
 * the recording and the other claims are still made.
 *
 * PROVISIONAL VALUES. Every number below is PERF-3's seed, marked `provisional`, sized so the
 * gate reports without failing anything while PERF-1 (the bar-hide scroll) and PERF-2 (the menu
 * sheet) profile and fix. THE HAND-OVER: PERF-1 and PERF-2 hand over their FIXED scenes' trace
 * columns on the shared recipe (layouts and paints per frame, main-thread p95 per frame, long
 * tasks; two runs each) and their ratios against the baseline scene; the coordinator sets each
 * kind's [Budget] to the fixed numbers plus headroom – per-frame counts + 0.25, main-thread p95
 * + 25 percent, long tasks as measured, the p95 ratio + 0.25, the share + 10 points –, sets
 * `provisional = false`, and flips the gate to hard (`JANK_GATE=hard` through the shared
 * workflow's `jank-gate` input or the driver script's environment). No absolute frame-time
 * number goes into a budget; the caveat holds until a hardware-GPU recipe exists.
 */
object JankBudget {
    /** What a scene is: the kinds have budgets of their own because their frames are different work. */
    enum class Kind(val key: String) {
        /** A finger-driven motion: a scroll with the bar following, a sheet dragged by its handle. */
        GESTURE("gesture"),

        /** A release settling: the bar snapping home, a sheet springing back after a drag. */
        SPRING("spring"),

        /** A surface coming up or going: the menu sheet opening or closing (mount, spring and swap). */
        OPEN("open");

        companion object {
            fun parse(key: String?): Kind? = values().firstOrNull { it.key == key }
        }
    }

    /** How the gate acts on a breach. */
    enum class Gate(val key: String) {
        /** Report only: the scene's numbers and the breach go to the record and the summary, nothing fails. */
        SOFT("soft"),

        /** A breach fails the scene (a jank fault at the end of the run), the run's other claims are still made. */
        HARD("hard");

        companion object {
            /** `soft` unless the argument reads `hard` (any case); an unknown or missing value is soft. */
            fun parse(key: String?): Gate = if (key?.trim()?.lowercase() == HARD.key) HARD else SOFT
        }
    }

    /**
     * The budget of one scene kind. The RATIO half applies when the scene names a baseline: its
     * 95th percentile may be at most `p95Ratio` times the baseline's, its janky share at most
     * `sharePoints` (0 to 1) above the baseline's. The TRACE half applies when the scene took a
     * trace: at most `layoutsPerFrame` layouts and `paintsPerFrame` paints per main-thread frame,
     * a main-thread time per frame whose 95th percentile is at most `mainThreadP95Ms`, and at most
     * `longTasks` long tasks (over 50 ms) in the scene. `provisional` says the numbers are PERF-3's
     * seed, not the fixed baseline.
     */
    data class Budget(
        val p95Ratio: Double,
        val sharePoints: Double,
        val layoutsPerFrame: Double,
        val paintsPerFrame: Double,
        val mainThreadP95Ms: Double,
        val longTasks: Int,
        val provisional: Boolean
    ) {
        fun describe(): String =
            "vs baseline p95 <= ${number(p95Ratio)}x, janky <= +${number(sharePoints * 100)} pt; " +
                "trace layouts <= ${number(layoutsPerFrame)}/frame, paints <= ${number(paintsPerFrame)}/frame, " +
                "main-thread p95 <= ${number(mainThreadP95Ms)} ms, long tasks <= $longTasks" +
                if (provisional) " (provisional)" else ""
    }

    // --- THE NUMBERS -----------------------------------------------------------------------------
    //
    // PROVISIONAL: seeded from PERF-3's traced baseline run of the two adopted drivers on the
    // UNFIXED chrome, with headroom, so that the gate reports without failing anything (see the
    // class comment for the hand-over that replaces them). The ratio budgets are wide on purpose:
    // HWUI's histogram is 50 ms wide up there and a scene has 4 to 14 frames, so one bucket of
    // run-to-run noise on a 400 ms baseline is already 1.13x.
    //
    // The seeds' source, per kind (the run is named in the PR body and in
    // `internal/android-parity/perf-jank-gate-helper.md`; re-read two runs before tightening):
    //  - gesture: `bar-hide-scroll-{bottom,top}` against `bar-hide-scroll-setting-off` (BarHideDemo);
    //  - spring: `bar-hide-snap-home-{bottom,top}` (no baseline: trace columns alone);
    //  - open: `menu-sheet-open` / `menu-sheet-close` (SheetRecedeDemo, API 35; trace columns alone).

    /** A finger-driven scene: the bar-hide scroll under the finger, with the same drag with the setting off as its baseline. */
    val GESTURE_BUDGET = Budget(p95Ratio = 2.0, sharePoints = 0.10, layoutsPerFrame = 2.0, paintsPerFrame = 2.0, mainThreadP95Ms = 120.0, longTasks = 3, provisional = true)

    /** A release settling: the bar's snap home after the finger lifts. */
    val SPRING_BUDGET = Budget(p95Ratio = 2.0, sharePoints = 0.10, layoutsPerFrame = 2.0, paintsPerFrame = 2.0, mainThreadP95Ms = 120.0, longTasks = 3, provisional = true)

    /** A surface coming or going: the menu sheet's open and close (mount, spring, swap). */
    val OPEN_BUDGET = Budget(p95Ratio = 2.0, sharePoints = 0.10, layoutsPerFrame = 2.0, paintsPerFrame = 2.0, mainThreadP95Ms = 160.0, longTasks = 4, provisional = true)

    /** The budget of a kind. */
    fun budgetFor(kind: Kind): Budget = when (kind) {
        Kind.GESTURE -> GESTURE_BUDGET
        Kind.SPRING -> SPRING_BUDGET
        Kind.OPEN -> OPEN_BUDGET
    }

    // --- the evaluation --------------------------------------------------------------------------

    /**
     * What the gate reads of one scene: HWUI's frames since the reset, its janky share (0 to 1)
     * and 95th percentile (ms), the trace's reading (null when none was taken), and – when a trace
     * was asked for and not read – why (`traceMissing`), which is a breach in itself.
     */
    data class Reading(
        val frames: Int,
        val jankyShare: Double,
        val p95Ms: Int,
        val trace: BlinkTrace.Reading? = null,
        val traceMissing: String? = null
    )

    /**
     * A scene against its baseline: `p95` is the scene's 95th over the baseline's (null when the
     * baseline's is 0), `sharePoints` the scene's janky share less the baseline's (0 to 1, negative
     * when the scene is better).
     */
    data class Ratio(val p95: Double?, val sharePoints: Double) {
        fun describe(): String =
            "p95 ${p95?.let { number(it) + "x" } ?: "-"} the baseline's, janky ${if (sharePoints >= 0) "+" else "-"}${number(abs(sharePoints) * 100)} pt"
    }

    /** `scene` against `baseline`. */
    fun ratio(scene: Reading, baseline: Reading): Ratio = Ratio(
        p95 = if (baseline.p95Ms > 0) scene.p95Ms.toDouble() / baseline.p95Ms else null,
        sharePoints = scene.jankyShare - baseline.jankyShare
    )

    /**
     * The gate's word on one scene: `within` when every check that applied is inside its budget,
     * else the breaches by name. `gated` lists the halves that applied (`ratio`, `trace`); empty
     * means the scene is reported only. `notes` say what did not apply and why.
     */
    data class Verdict(val within: Boolean, val breaches: List<String>, val gated: List<String>, val notes: List<String>) {
        /** `within` / `reported only`, or the breaches joined. */
        fun describe(): String = when {
            !within -> "over: " + breaches.joinToString("; ")
            gated.isEmpty() -> "reported only (no baseline, no trace)"
            else -> "within (gated on ${gated.joinToString(" + ")})"
        }
    }

    /**
     * Hold `scene` against `budget`. `baselineName` is the scene it names as its baseline (null
     * for none) and `baseline` that scene's reading when the run measured it. A scene without
     * frames is a breach of its own; so is a named baseline the run did not measure, and a trace
     * asked for and not read.
     */
    fun evaluate(budget: Budget, scene: Reading, baselineName: String? = null, baseline: Reading? = null): Verdict {
        if (scene.frames <= 0) return Verdict(within = false, breaches = listOf("no frames were recorded for the scene"), gated = emptyList(), notes = emptyList())
        val breaches = ArrayList<String>()
        val gated = ArrayList<String>()
        val notes = ArrayList<String>()
        if (baselineName != null) {
            gated += "ratio"
            when {
                baseline == null -> breaches += "baseline '$baselineName' was not measured in this run"
                baseline.frames <= 0 -> breaches += "baseline '$baselineName' recorded no frames"
                else -> {
                    val ratio = ratio(scene, baseline)
                    val p95 = ratio.p95
                    if (p95 == null) {
                        breaches += "baseline '$baselineName' has a 95th percentile of 0 ms: no ratio"
                    } else if (p95 > budget.p95Ratio + EPSILON) {
                        breaches += "p95 ${scene.p95Ms} ms is ${number(p95)}x the baseline's ${baseline.p95Ms} ms > ${number(budget.p95Ratio)}x"
                    }
                    if (ratio.sharePoints > budget.sharePoints + EPSILON) {
                        breaches += "janky ${percent(scene.jankyShare)} is +${number(ratio.sharePoints * 100)} pt over the baseline's ${percent(baseline.jankyShare)} > +${number(budget.sharePoints * 100)} pt"
                    }
                }
            }
        }
        val trace = scene.trace
        if (trace != null) {
            gated += "trace"
            if (!trace.found) {
                breaches += "the trace has no renderer main thread"
            } else {
                val layouts = trace.perFrame(trace.layoutCount)
                val paints = trace.perFrame(trace.paintCount)
                if (layouts > budget.layoutsPerFrame + EPSILON) breaches += "layouts ${number(layouts)}/frame > ${number(budget.layoutsPerFrame)}/frame"
                if (paints > budget.paintsPerFrame + EPSILON) breaches += "paints ${number(paints)}/frame > ${number(budget.paintsPerFrame)}/frame"
                val p95 = trace.frameMs?.p95Ms
                if (p95 != null && p95 > budget.mainThreadP95Ms + EPSILON) breaches += "main-thread p95 ${number(p95)} ms/frame > ${number(budget.mainThreadP95Ms)} ms"
                if (trace.longTasks > budget.longTasks) breaches += "${trace.longTasks} long tasks > ${budget.longTasks}"
                if (trace.frames == 0) notes += "the trace saw no main-thread frame: the per-frame counts are the counts themselves"
            }
        } else if (scene.traceMissing != null) {
            gated += "trace"
            breaches += "no trace was read: ${scene.traceMissing}"
        }
        if (gated.isEmpty()) notes += "reported only: the scene names no baseline and took no trace"
        return Verdict(within = breaches.isEmpty(), breaches = breaches, gated = gated, notes = notes)
    }

    /** Whether the gate makes a breach a fault: only a hard gate does. */
    fun enforces(gate: Gate, verdict: Verdict): Boolean = gate == Gate.HARD && !verdict.within

    /** A share read as `janky / frames` is a ratio of integers: no rounding of it may count as a breach. */
    private const val EPSILON = 1e-9

    /** A number with at most two decimals, trailing zeros dropped (`2`, `1.5`, `0.25`). */
    private fun number(value: Double): String {
        val text = String.format(Locale.ROOT, "%.2f", value)
        return if (text.contains('.')) text.trimEnd('0').trimEnd('.') else text
    }

    private fun percent(share: Double): String = number(share * 100) + "%"
}
