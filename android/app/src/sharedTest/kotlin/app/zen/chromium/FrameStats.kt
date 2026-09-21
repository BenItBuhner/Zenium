package app.zen.chromium

import java.time.Instant
import java.util.Locale

/**
 * `adb shell dumpsys gfxinfo <package> framestats` read into numbers, kept free of Android so the
 * parser runs on the JVM (`FrameStatsTest`, fed a dump captured on the emulator). Compiled into
 * the unit tests and the instrumentation alike (`src/sharedTest`), never into the app. The
 * harness's `measureFrames` (DemoHarness.kt) resets the stats, runs a scene, dumps them and hands
 * the text here; what comes back is one [Scene]: the summary HWUI keeps since the reset, the last
 * frames' stage timings from the CSV, the chrome renderer's main-thread reading when the scene
 * took a trace ([BlinkTrace], `traceFrames`), the ratios against the scene's baseline, and the
 * budget's verdict (`JankBudget`).
 *
 * Two things in the dump, two readings:
 *
 *  - The SUMMARY block ("Total frames rendered", "Janky frames", the 50th to 99th percentiles,
 *    the "Number …" jank reasons) counts every frame since the reset: these are the gate's
 *    numbers, as HWUI itself computes them (the percentiles come off its histogram, so they are
 *    bucketed: whole milliseconds low, coarser steps high).
 *  - The FRAMESTATS CSV (between the `---PROFILEDATA---` markers, one block per window) holds
 *    the last frames – HWUI keeps about 120 – as nanosecond timestamps of each stage's start,
 *    one column per stage, named in its header. The columns differ between Android versions
 *    (API 29 has no `FrameDeadline`, `GpuCompleted` or `CommandSubmissionCompleted`), so they
 *    are read by NAME, and a stage whose columns the dump lacks is simply absent.
 *
 * A frame's stages, each the gap between two of those timestamps (`FrameMetrics`' definitions,
 * which the "Profile GPU rendering" bars draw):
 *
 *  - `delay`      IntendedVsync → HandleInputStart: the UI thread answered the vsync late – it
 *                 was busy with something else (for this chrome: the WebView's work on the main
 *                 thread, the bridge, the core);
 *  - `input`      HandleInputStart → AnimationStart: input events dispatched to the views;
 *  - `animation`  AnimationStart → PerformTraversalsStart: Choreographer animation callbacks;
 *  - `layout`     PerformTraversalsStart → DrawStart: measure and layout of the view tree;
 *  - `draw`       DrawStart → SyncQueued: the display lists recorded (a WebView's `onDraw` puts
 *                 its draw functor here);
 *  - `sync`       SyncQueued → IssueDrawCommandsStart: the display lists handed to the render
 *                 thread – INCLUDING the wait for that thread (SyncQueued → SyncStart, which
 *                 `FrameMetrics` leaves out): a long `sync` means the render thread was still
 *                 busy with the frame before;
 *  - `commands`   IssueDrawCommandsStart → SwapBuffers: the render thread issuing the draw
 *                 commands – the GPU-side work as the CPU sees it; for a WebView, its compositor
 *                 drawing through the functor. On the emulator's software GPU this is the stage
 *                 the recipe inflates;
 *  - `swap`       SwapBuffers → FrameCompleted: `eglSwapBuffers` (long when the buffer queue is
 *                 full: the app ahead of the compositor);
 *  - `gpu`        CommandSubmissionCompleted → GpuCompleted (Android 12+): the GPU's own time,
 *                 asynchronous to the frame's CPU work. Reported, never the LONG STAGE: it does
 *                 not add to the frame's total, and on the software GPU it is the recipe's cost.
 *
 * The first eight sum to the frame's total (IntendedVsync → FrameCompleted); the long stage of a
 * long frame is the largest of them. A frame is LONG when its total runs past its deadline: the
 * `FrameDeadline` column when the dump has one, else its `FrameInterval`, else 16.67 ms. That is
 * this reading's own count over the sampled frames; the gate uses HWUI's "Janky frames" from the
 * summary, which adds the pipeline's allowance. Rows with a non-zero `Flags` value (the window
 * laid out anew, a skipped frame, a surface canvas) are expected to be long and are left out of
 * the stage reading, counted as `skipped`.
 */
object FrameStats {
    /** One stage of a frame: its name and the two timestamp columns it runs between. */
    class Stage(val name: String, val from: String, val to: String)

    /** The stages in the order HWUI runs them; the first [SUMMING_STAGES] add up to the frame's total. */
    val STAGES: List<Stage> = listOf(
        Stage("delay", "IntendedVsync", "HandleInputStart"),
        Stage("input", "HandleInputStart", "AnimationStart"),
        Stage("animation", "AnimationStart", "PerformTraversalsStart"),
        Stage("layout", "PerformTraversalsStart", "DrawStart"),
        Stage("draw", "DrawStart", "SyncQueued"),
        Stage("sync", "SyncQueued", "IssueDrawCommandsStart"),
        Stage("commands", "IssueDrawCommandsStart", "SwapBuffers"),
        Stage("swap", "SwapBuffers", "FrameCompleted"),
        Stage("gpu", "CommandSubmissionCompleted", "GpuCompleted")
    )

    /** How many of [STAGES], from the first, make up the frame's total; the rest run alongside it. */
    const val SUMMING_STAGES = 8

    /** The frame interval assumed when the dump carries neither a deadline nor an interval (60 Hz). */
    const val DEFAULT_INTERVAL_NS = 16_666_667L

    /** The summary HWUI keeps since the last reset: the gate's numbers. */
    data class Summary(
        /** "Total frames rendered". */
        val frames: Int,
        /** "Janky frames" – the frames past their deadline, by HWUI's own rule. */
        val janky: Int,
        /** "Janky frames (legacy)": past one frame interval; -1 when the dump has no such line (before Android 12). */
        val jankyLegacy: Int,
        val p50Ms: Int,
        val p90Ms: Int,
        val p95Ms: Int,
        val p99Ms: Int,
        /** The "Number …" lines, keyed as in the dump (`Missed Vsync`, `Slow UI thread`, …). */
        val reasons: Map<String, Int>
    ) {
        /** `janky / frames`, 0 with no frames. */
        val jankyShare: Double get() = if (frames > 0) janky.toDouble() / frames else 0.0
    }

    /** One row of the framestats CSV, read into stage durations (ms). */
    data class Frame(
        val flags: Long,
        /** IntendedVsync → FrameCompleted. */
        val totalMs: Double,
        /** The frame's own deadline, from its intended vsync. */
        val deadlineMs: Double,
        /** Stage name → ms, for the stages whose columns the dump had and whose timestamps were set. */
        val stages: Map<String, Double>
    ) {
        /** Past its deadline. */
        val long: Boolean get() = totalMs > deadlineMs

        /** The largest of the stages that add up to the total; null when none was read. */
        val longStage: String?
            get() = stages.entries.filter { it.key in SUMMING_STAGE_NAMES }.maxByOrNull { it.value }?.key
    }

    private val SUMMING_STAGE_NAMES: Set<String> = STAGES.take(SUMMING_STAGES).map { it.name }.toSet()

    /** One stage over the sampled frames. */
    data class StageStat(val meanMs: Double, val maxMs: Double, /** Long frames whose long stage this was. */ val longFrames: Int)

    /** The CSV's frames read together: how many, how many long, each stage's mean and max, and the stage most often long. */
    data class Analysis(
        /** Frames read (flags 0, complete). */
        val sampled: Int,
        /** Rows left out: a non-zero `Flags`, or a frame not complete at the dump. */
        val skipped: Int,
        /** Sampled frames past their deadline. */
        val long: Int,
        /** Stage name → its statistics, in [STAGES] order, for the stages the dump had. */
        val stages: Map<String, StageStat>,
        /** The stage that was the long one in most long frames; null with no long frame. */
        val dominant: String?
    )

    /** The whole dump: the summary (null when the text has none: the process was not found, or the dump is empty) and the frames. */
    data class Dump(val summary: Summary?, val frames: List<Frame>, val skipped: Int) {
        fun analyse(): Analysis {
            val sampled = frames
            val stats = LinkedHashMap<String, StageStat>()
            val longStages = HashMap<String, Int>()
            for (frame in sampled) {
                if (frame.long) frame.longStage?.let { longStages[it] = (longStages[it] ?: 0) + 1 }
            }
            for (stage in STAGES) {
                val values = sampled.mapNotNull { it.stages[stage.name] }
                if (values.isEmpty()) continue
                stats[stage.name] = StageStat(values.average(), values.max(), longStages[stage.name] ?: 0)
            }
            val dominant = longStages.entries.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { STAGE_ORDER[it.key] ?: Int.MAX_VALUE }).firstOrNull()?.key
            return Analysis(sampled.size, skipped, sampled.count { it.long }, stats, dominant)
        }
    }

    private val STAGE_ORDER: Map<String, Int> = STAGES.withIndex().associate { it.value.name to it.index }

    // --- parsing ---------------------------------------------------------------------------------

    private val TOTAL = Regex("""^\s*Total frames rendered:\s*(\d+)""", RegexOption.MULTILINE)
    private val JANKY = Regex("""^\s*Janky frames:\s*(\d+)""", RegexOption.MULTILINE)
    private val JANKY_LEGACY = Regex("""^\s*Janky frames \(legacy\):\s*(\d+)""", RegexOption.MULTILINE)
    /** "90th percentile: 16ms" – not the "90th gpu percentile" lines, which say `gpu` before `percentile`. */
    private val PERCENTILE = Regex("""^\s*(\d+)th percentile:\s*(\d+)ms""", RegexOption.MULTILINE)
    /** "Number Slow UI thread: 3", "Number Frame deadline missed (legacy): 5". */
    private val REASON = Regex("""^\s*Number ([A-Za-z ()]+?):\s*(\d+)\s*$""", RegexOption.MULTILINE)
    private const val PROFILE_MARKER = "---PROFILEDATA---"

    /** Read a `dumpsys gfxinfo <package> framestats` dump. Never throws on odd text: what cannot be read is left out. */
    fun parse(text: String): Dump {
        val summary = parseSummary(text)
        val frames = ArrayList<Frame>()
        var skipped = 0
        val lines = text.lines()
        var i = 0
        while (i < lines.size) {
            if (lines[i].trim() != PROFILE_MARKER) {
                i++
                continue
            }
            // The header follows the opening marker; rows follow until the closing one.
            val header = lines.getOrNull(i + 1)?.trim()?.takeIf { it.startsWith("Flags,") }
            if (header == null) {
                i++
                continue
            }
            val columns = header.split(',').map { it.trim() }.filter { it.isNotEmpty() }
            val index = columns.withIndex().associate { it.value to it.index }
            i += 2
            while (i < lines.size && lines[i].trim() != PROFILE_MARKER) {
                val row = lines[i].trim()
                i++
                if (row.isEmpty() || !row[0].isDigit()) continue
                val values = row.split(',').map { it.trim() }
                when (val frame = readFrame(values, index)) {
                    null -> skipped++
                    else -> frames += frame
                }
            }
            i++
        }
        return Dump(summary, frames, skipped)
    }

    private fun parseSummary(text: String): Summary? {
        val frames = TOTAL.find(text)?.groupValues?.get(1)?.toIntOrNull() ?: return null
        val janky = JANKY.find(text)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val legacy = JANKY_LEGACY.find(text)?.groupValues?.get(1)?.toIntOrNull() ?: -1
        val percentiles = HashMap<Int, Int>()
        for (match in PERCENTILE.findAll(text)) {
            val which = match.groupValues[1].toIntOrNull() ?: continue
            // The first block's values (one process); a later process's lines never overwrite them.
            if (!percentiles.containsKey(which)) percentiles[which] = match.groupValues[2].toIntOrNull() ?: 0
        }
        val reasons = LinkedHashMap<String, Int>()
        for (match in REASON.findAll(text)) {
            val name = match.groupValues[1].trim()
            if (!reasons.containsKey(name)) reasons[name] = match.groupValues[2].toIntOrNull() ?: 0
        }
        return Summary(
            frames, janky, legacy,
            percentiles[50] ?: 0, percentiles[90] ?: 0, percentiles[95] ?: 0, percentiles[99] ?: 0,
            reasons
        )
    }

    /** One CSV row by the header's names; null for a row to skip (flags set, incomplete, or unreadable). */
    private fun readFrame(values: List<String>, index: Map<String, Int>): Frame? {
        fun at(column: String): Long? = index[column]?.let { values.getOrNull(it) }?.toLongOrNull()
        val flags = at("Flags") ?: return null
        val intended = at("IntendedVsync") ?: return null
        val completed = at("FrameCompleted") ?: return null
        if (flags != 0L || completed <= 0L || completed < intended) return null
        val deadline = at("FrameDeadline")?.takeIf { it > intended }?.let { it - intended }
            ?: at("FrameInterval")?.takeIf { it > 0 }
            ?: DEFAULT_INTERVAL_NS
        val stages = LinkedHashMap<String, Double>()
        for (stage in STAGES) {
            val from = at(stage.from) ?: continue
            val to = at(stage.to) ?: continue
            // A timestamp HWUI has not set (the GPU not done at the dump) reads 0 or lies before its start.
            if (from <= 0L || to <= 0L || to < from) continue
            stages[stage.name] = (to - from) / 1e6
        }
        return Frame(flags, (completed - intended) / 1e6, deadline / 1e6, stages)
    }

    // --- the scene -------------------------------------------------------------------------------

    /**
     * One measured scene: what `measureFrames` / `traceFrames` records. [summary] is null when the
     * dump had none; the verdict then says the scene was not measured. [baseline] names the
     * same-run scene the ratios are read against (null for none); [ratio] is those ratios once
     * the baseline is known ([resolve]); [trace] is the renderer main thread's reading when the
     * scene took a trace, and [traceMissing] why it has none although it asked for one.
     */
    data class Scene(
        val name: String,
        val kind: JankBudget.Kind,
        val gate: JankBudget.Gate,
        /** When the scene began, epoch ms (wall clock). */
        val startedAtMs: Long,
        /** How long the scene's block ran, ms (the frames recorded may run a little past it). */
        val durationMs: Long,
        val summary: Summary?,
        val analysis: Analysis,
        val baseline: String?,
        val trace: BlinkTrace.Reading?,
        val traceMissing: String?,
        val budget: JankBudget.Budget,
        val ratio: JankBudget.Ratio?,
        val verdict: JankBudget.Verdict
    ) {
        /** The gate makes the breach a fault: hard and over. */
        val enforced: Boolean get() = JankBudget.enforces(gate, verdict)

        /** What the gate reads of this scene. */
        fun reading(): JankBudget.Reading =
            JankBudget.Reading(summary?.frames ?: 0, summary?.jankyShare ?: 0.0, summary?.p95Ms ?: 0, trace, traceMissing)

        /** One JSON object on one line (`frames.jsonl`), keys in a fixed order. Schema version 2; see the harness docs. */
        fun toJson(): String {
            val sb = StringBuilder("{")
            sb.append("\"v\":2")
            sb.append(",\"scene\":").append(quote(name))
            sb.append(",\"kind\":").append(quote(kind.key))
            sb.append(",\"gate\":").append(quote(gate.key))
            sb.append(",\"at\":").append(quote(Instant.ofEpochMilli(startedAtMs).toString()))
            sb.append(",\"durationMs\":").append(durationMs)
            sb.append(",\"baseline\":").append(baseline?.let { quote(it) } ?: "null")
            val s = summary
            sb.append(",\"frames\":").append(s?.frames ?: 0)
            sb.append(",\"janky\":").append(s?.janky ?: 0)
            sb.append(",\"jankyShare\":").append(number(s?.jankyShare ?: 0.0, 4))
            sb.append(",\"jankyLegacy\":").append(s?.jankyLegacy ?: -1)
            sb.append(",\"p50\":").append(s?.p50Ms ?: 0)
            sb.append(",\"p90\":").append(s?.p90Ms ?: 0)
            sb.append(",\"p95\":").append(s?.p95Ms ?: 0)
            sb.append(",\"p99\":").append(s?.p99Ms ?: 0)
            sb.append(",\"reasons\":{")
            s?.reasons?.entries?.joinTo(sb, ",") { quote(it.key) + ":" + it.value }
            sb.append("}")
            sb.append(",\"sampled\":").append(analysis.sampled)
            sb.append(",\"skipped\":").append(analysis.skipped)
            sb.append(",\"long\":").append(analysis.long)
            sb.append(",\"stageMs\":{")
            analysis.stages.entries.joinTo(sb, ",") {
                quote(it.key) + ":{\"mean\":" + number(it.value.meanMs, 2) + ",\"max\":" + number(it.value.maxMs, 2) + ",\"long\":" + it.value.longFrames + "}"
            }
            sb.append("}")
            sb.append(",\"dominant\":").append(analysis.dominant?.let { quote(it) } ?: "null")
            sb.append(",\"ratio\":")
            if (ratio == null) {
                sb.append("null")
            } else {
                sb.append("{\"p95\":").append(ratio.p95?.let { number(it, 3) } ?: "null")
                    .append(",\"sharePoints\":").append(number(ratio.sharePoints, 4)).append("}")
            }
            sb.append(",\"trace\":").append(trace?.toJson() ?: "null")
            sb.append(",\"traceMissing\":").append(traceMissing?.let { quote(it) } ?: "null")
            sb.append(",\"budget\":{\"p95Ratio\":").append(number(budget.p95Ratio, 3))
                .append(",\"sharePoints\":").append(number(budget.sharePoints, 4))
                .append(",\"layoutsPerFrame\":").append(number(budget.layoutsPerFrame, 3))
                .append(",\"paintsPerFrame\":").append(number(budget.paintsPerFrame, 3))
                .append(",\"mainThreadP95Ms\":").append(number(budget.mainThreadP95Ms, 2))
                .append(",\"longTasks\":").append(budget.longTasks)
                .append(",\"provisional\":").append(budget.provisional).append("}")
            sb.append(",\"gated\":[")
            verdict.gated.joinTo(sb, ",") { quote(it) }
            sb.append("]")
            sb.append(",\"verdict\":").append(quote(if (verdict.within) "within" else "over"))
            sb.append(",\"breaches\":[")
            verdict.breaches.joinTo(sb, ",") { quote(it) }
            sb.append("]")
            sb.append(",\"notes\":[")
            verdict.notes.joinTo(sb, ",") { quote(it) }
            sb.append("]")
            sb.append(",\"enforced\":").append(enforced)
            sb.append("}")
            return sb.toString()
        }

        /**
         * The scene for a human, several lines: the summary line, the baseline and trace lines
         * when the scene has them, the sampling line, then one line per stage. What the driver logs.
         */
        fun table(): String {
            val s = summary
            val sb = StringBuilder()
            sb.append("scene ").append(name).append(" (").append(kind.key).append(", ").append(durationMs).append(" ms): ")
            if (s == null) {
                sb.append("NOT MEASURED (no summary in the dump)")
            } else {
                sb.append(s.frames).append(" frames, ").append(s.janky).append(" janky (")
                    .append(String.format(Locale.ROOT, "%.0f", s.jankyShare * 100)).append("%), ")
                    .append("p50 ").append(s.p50Ms).append(" p90 ").append(s.p90Ms).append(" p95 ").append(s.p95Ms).append(" p99 ").append(s.p99Ms).append(" ms")
            }
            sb.append("; budget ").append(budget.describe()).append(": ").append(verdict.describe())
            if (enforced) sb.append(" [FAULT: the gate is hard]") else if (!verdict.within) sb.append(" [reported: the gate is ").append(gate.key).append("]")
            sb.append('\n')
            if (baseline != null) {
                sb.append("  vs baseline ").append(baseline).append(": ").append(ratio?.describe() ?: "not measured in this run").append('\n')
            }
            if (trace != null) sb.append("  ").append(trace.describe()).append('\n')
            else if (traceMissing != null) sb.append("  trace: none read (").append(traceMissing).append(")\n")
            sb.append("  sampled ").append(analysis.sampled).append(" frames (").append(analysis.skipped).append(" skipped), ")
                .append(analysis.long).append(" past their deadline; long stage most often: ").append(analysis.dominant ?: "-").append('\n')
            if (analysis.stages.isNotEmpty()) {
                sb.append(String.format(Locale.ROOT, "  %-10s %9s %9s %6s%n", "stage", "mean ms", "max ms", "long"))
                for ((stage, stat) in analysis.stages) {
                    sb.append(String.format(Locale.ROOT, "  %-10s %9.2f %9.2f %6d%n", stage, stat.meanMs, stat.maxMs, stat.longFrames))
                }
            }
            s?.reasons?.takeIf { it.isNotEmpty() }?.let { reasons ->
                sb.append("  reasons: ").append(reasons.entries.joinToString(", ") { "${it.key} ${it.value}" }).append('\n')
            }
            return sb.toString().trimEnd()
        }
    }

    /**
     * Build the [Scene] of one measurement: the dump read against the kind's budget, with the
     * trace's reading (or why there is none) and the ratios against `baseline` when it is among
     * `measured` (the scenes measured so far; [resolve] settles the rest once the run is over).
     */
    fun scene(
        name: String,
        kind: JankBudget.Kind,
        gate: JankBudget.Gate,
        startedAtMs: Long,
        durationMs: Long,
        dump: Dump,
        budget: JankBudget.Budget = JankBudget.budgetFor(kind),
        baseline: String? = null,
        trace: BlinkTrace.Reading? = null,
        traceMissing: String? = null,
        measured: List<Scene> = emptyList()
    ): Scene {
        val unsettled = Scene(
            name, kind, gate, startedAtMs, durationMs, dump.summary, dump.analyse(), baseline, trace, traceMissing, budget,
            ratio = null, verdict = JankBudget.Verdict(within = true, breaches = emptyList(), gated = emptyList(), notes = emptyList())
        )
        return settle(unsettled, measured)
    }

    /**
     * Every scene's verdict read again with all of `scenes` known: a baseline measured after the
     * scene that names it counts now. What the harness writes down once the run is over.
     */
    fun resolve(scenes: List<Scene>): List<Scene> = scenes.map { settle(it, scenes) }

    /** `scene`'s ratio and verdict against the baseline it names among `known` (the latest of that name). */
    private fun settle(scene: Scene, known: List<Scene>): Scene {
        val baseline = scene.baseline?.let { name -> known.lastOrNull { it.name == name && it !== scene } }
        val reading = scene.reading()
        val baselineReading = baseline?.reading()
        val ratio = if (baselineReading != null && baselineReading.frames > 0 && reading.frames > 0) JankBudget.ratio(reading, baselineReading) else null
        return scene.copy(ratio = ratio, verdict = JankBudget.evaluate(scene.budget, reading, scene.baseline, baselineReading))
    }

    // --- JSON ------------------------------------------------------------------------------------

    /** A JSON string literal: quotes, backslashes and control characters escaped. */
    fun quote(value: String): String {
        val sb = StringBuilder("\"")
        for (ch in value) {
            when {
                ch == '"' -> sb.append("\\\"")
                ch == '\\' -> sb.append("\\\\")
                ch == '\n' -> sb.append("\\n")
                ch == '\r' -> sb.append("\\r")
                ch == '\t' -> sb.append("\\t")
                ch < ' ' -> sb.append(String.format(Locale.ROOT, "\\u%04x", ch.code))
                else -> sb.append(ch)
            }
        }
        return sb.append('"').toString()
    }

    /** A number with at most `decimals` places, a dot for the decimal mark, no exponent; NaN and infinities become null. */
    fun number(value: Double, decimals: Int): String {
        if (value.isNaN() || value.isInfinite()) return "null"
        val text = String.format(Locale.ROOT, "%.${decimals}f", value)
        return if (text.contains('.')) text.trimEnd('0').trimEnd('.') else text
    }
}
