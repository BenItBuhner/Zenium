package app.zen.chromium

import java.util.Locale

/**
 * The arithmetic behind the unload probe's latency harness (`UnloadProbeLatency`, androidTest;
 * seed A10 step 1): the two arms' samples summarised (nearest-rank median and p95, min, max,
 * mean), the arms' deltas, the PAIRED delta – each pair is one load with the probe and one
 * without, back to back on the same page, so the difference inside a pair cancels whatever the
 * device was doing around it – and the advisory verdict against the Design Lead's threshold
 * ([FRAME_MS]: more than one frame at 60 Hz is a cost the user can see). Free of Android so it
 * runs on the JVM (`UnloadProbeLatencyStatsTest`); compiled into the unit tests and the
 * instrumentation alike (`src/sharedTest`), never into the app.
 */
object UnloadProbeLatencyStats {
    /** One vsync at 60 Hz, in ms: the threshold the verdict reads the probe's added latency against. */
    const val FRAME_MS = 16.7

    /** The two arms: the same loads with the probe ahead of them, and without (the hold set). */
    enum class Arm(val label: String) {
        WITH("with probe"),
        WITHOUT("without");

        fun other(): Arm = if (this == WITH) WITHOUT else WITH
    }

    /**
     * One measured load: its pair, its arm, and how long after `loadUrl` returned the view's
     * words about the TARGET came, in ms – `onPageStarted` (the chrome's `startLoading`), the
     * history commit (`navigated`), the first progress report, `onPageFinished` (`stopLoading`);
     * a word that never came within the wait is [MISSED]. `probePending` is whether the view's
     * address right after `loadUrl` returned was the probe's: the arm's proof on every sample
     * (the probe's own navigation is pending until Chromium drops it; without one the target is).
     */
    data class Sample(
        val pair: Int,
        val arm: Arm,
        val startedMs: Double,
        val navigatedMs: Double,
        val progressMs: Double,
        val finishedMs: Double,
        val probePending: Boolean
    ) {
        /** Whether the arm's proof holds: the probe pending with it, the target pending without. */
        val armProven: Boolean get() = probePending == (arm == Arm.WITH)

        fun line(): String = String.format(
            Locale.ROOT, "pair %02d %-10s started %s navigated %s progress %s finished %s pending=%s%s",
            pair + 1, arm.label, ms(startedMs), ms(navigatedMs), ms(progressMs), ms(finishedMs),
            if (probePending) "probe" else "target", if (armProven) "" else " (ARM NOT PROVEN)"
        )
    }

    /** A word that never came. */
    const val MISSED = -1.0

    /** One arm's readings summarised: nearest-rank median and p95, the extremes, the mean; [n] counts the readings that came. */
    data class Summary(val arm: Arm, val n: Int, val missed: Int, val median: Double, val p95: Double, val min: Double, val max: Double, val mean: Double) {
        fun row(): String = String.format(
            Locale.ROOT, "%-12s %3d  %8.1f %8.1f %8.1f %8.1f %8.1f%s",
            arm.label, n, median, p95, min, max, mean, if (missed > 0) "  ($missed never came)" else ""
        )

        companion object {
            /** The rows' column heads, laid out as [row] lays the numbers. */
            val HEADER: String = String.format(Locale.ROOT, "%-12s %3s  %8s %8s %8s %8s %8s", "arm", "N", "median", "p95", "min", "max", "mean")

            fun empty(arm: Arm, missed: Int = 0) = Summary(arm, 0, missed, 0.0, 0.0, 0.0, 0.0, 0.0)
        }
    }

    /** Nearest-rank percentile of `values` (any order); 0 with none. The frame arithmetic's own. */
    fun percentile(values: List<Double>, p: Double): Double = WakeFrames.percentile(values, p)

    /** `values` summarised for `arm`; a [MISSED] reading is counted, not summarised. */
    fun summarise(arm: Arm, values: List<Double>): Summary {
        val came = values.filter { it != MISSED }
        if (came.isEmpty()) return Summary.empty(arm, values.size)
        return Summary(
            arm = arm,
            n = came.size,
            missed = values.size - came.size,
            median = percentile(came, 50.0),
            p95 = percentile(came, 95.0),
            min = came.min(),
            max = came.max(),
            mean = came.sum() / came.size
        )
    }

    /**
     * The paired deltas – with minus without inside each pair – summarised: [n] pairs with both
     * readings, their median, mean and extremes, and how many were over one frame ([FRAME_MS]).
     */
    data class Paired(val n: Int, val median: Double, val mean: Double, val min: Double, val max: Double, val overFrame: Int) {
        fun line(): String =
            if (n == 0) "paired delta (with - without, per pair): no pair with both readings"
            else String.format(
                Locale.ROOT, "paired delta (with - without, per pair): median %+.1f, mean %+.1f, min %+.1f, max %+.1f ms; %d of %d pairs over one frame (%.1f ms)",
                median, mean, min, max, overFrame, n, FRAME_MS
            )

        companion object {
            val NONE = Paired(0, 0.0, 0.0, 0.0, 0.0, 0)
        }
    }

    /** The paired deltas of `reading` over `samples`: a pair missing an arm or a reading is left out. */
    fun paired(samples: List<Sample>, reading: (Sample) -> Double): Paired {
        val deltas = samples.groupBy { it.pair }.values.mapNotNull { pair ->
            val with = pair.firstOrNull { it.arm == Arm.WITH }?.let(reading) ?: return@mapNotNull null
            val without = pair.firstOrNull { it.arm == Arm.WITHOUT }?.let(reading) ?: return@mapNotNull null
            if (with == MISSED || without == MISSED) null else with - without
        }
        if (deltas.isEmpty()) return Paired.NONE
        return Paired(
            n = deltas.size,
            median = percentile(deltas, 50.0),
            mean = deltas.sum() / deltas.size,
            min = deltas.min(),
            max = deltas.max(),
            overFrame = deltas.count { it > FRAME_MS }
        )
    }

    /** The arms' deltas, median to median and p95 to p95: `delta (with - without): median +248.0 ms, p95 +195.0 ms`. */
    fun armDeltaLine(with: Summary, without: Summary): String =
        if (with.n == 0 || without.n == 0) "delta (with - without): an arm has no reading"
        else String.format(Locale.ROOT, "delta (with - without): median %+.1f ms, p95 %+.1f ms", with.median - without.median, with.p95 - without.p95)

    /**
     * The advisory verdict, one line: the probe's added latency – the paired median, the
     * robust reading of "what the probe costs a load", with the arm medians' and p95s' deltas
     * beside it – against [FRAME_MS]. Advisory: the Design Lead decides step 2 (the armed-hook
     * skip) on it; the harness asserts nothing on it. Said with it: numbers from an emulator
     * are the emulator's, and a run short of the `asked` pairs is said to be.
     */
    fun verdict(paired: Paired, with: Summary, without: Summary, emulator: Boolean, asked: Int): String {
        val head = String.format(Locale.ROOT, "VERDICT (advisory; threshold > %.1f ms = more than one frame at 60 Hz): ", FRAME_MS)
        if (paired.n == 0) return head + "no pair with both readings; no verdict"
        val cost = String.format(
            Locale.ROOT, "the probe adds %+.1f ms median per load (paired; arm medians %+.1f, p95s %+.1f)",
            paired.median, with.median - without.median, with.p95 - without.p95
        )
        val reading = if (paired.median > FRAME_MS) {
            String.format(Locale.ROOT, " -- OVER one frame (%d of %d pairs over): step 2, the armed-hook skip, is indicated", paired.overFrame, paired.n)
        } else {
            String.format(Locale.ROOT, " -- within one frame (%d of %d pairs over): the probe may stay as it is", paired.overFrame, paired.n)
        }
        val notes = ArrayList<String>()
        if (emulator) notes += "EMULATOR numbers, not a device's"
        if (paired.n < asked) notes += "$asked pairs asked, ${paired.n} measured"
        return head + cost + reading + if (notes.isEmpty()) "" else "; " + notes.joinToString("; ")
    }

    /** The arm's proof over the run: `arm proof: 20/20 with-arm loads had the probe pending after loadUrl; 20/20 without-arm loads had the target`. */
    fun armProofLine(samples: List<Sample>): String {
        val with = samples.filter { it.arm == Arm.WITH }
        val without = samples.filter { it.arm == Arm.WITHOUT }
        return "arm proof: ${with.count { it.probePending }}/${with.size} with-arm loads had the probe's address pending after loadUrl; " +
            "${without.count { !it.probePending }}/${without.size} without-arm loads had the target's" +
            if (samples.all { it.armProven }) "" else " -- NOT EVERY SAMPLE PROVEN: see the samples"
    }

    /**
     * Whether the hold never took: every without-arm sample still had the probe pending. The
     * two arms were then the same measurement, and the run is void – the harness fails on it.
     */
    fun holdNeverTook(samples: List<Sample>): Boolean {
        val without = samples.filter { it.arm == Arm.WITHOUT }
        return without.isNotEmpty() && without.all { it.probePending }
    }

    /**
     * The findings block: `header` lines first (the device, the WebView, the page, the
     * conditions – the harness's words), then per reading the two arms' rows and the deltas,
     * the arm's proof and the verdict; fenced by `== unload probe latency ==` lines so it can be
     * found in a log and pasted whole.
     */
    fun block(header: List<String>, samples: List<Sample>, emulator: Boolean, asked: Int): String {
        val sb = StringBuilder()
        sb.append("== unload probe latency (A10 step 1) ==\n")
        for (line in header) sb.append(line).append('\n')
        val with = samples.filter { it.arm == Arm.WITH }
        val without = samples.filter { it.arm == Arm.WITHOUT }
        sb.append("samples: ${with.size} with the probe, ${without.size} without, $asked pairs asked\n")
        val readings = listOf<Pair<String, (Sample) -> Double>>(
            "loadUrl -> onPageStarted (the reading judged)" to { it.startedMs },
            "loadUrl -> history commit (navigated)" to { it.navigatedMs },
            "loadUrl -> first progress" to { it.progressMs },
            "loadUrl -> onPageFinished" to { it.finishedMs }
        )
        var judged: Pair<Paired, Pair<Summary, Summary>>? = null
        for ((name, reading) in readings) {
            val w = summarise(Arm.WITH, with.map(reading))
            val wo = summarise(Arm.WITHOUT, without.map(reading))
            val p = paired(samples, reading)
            sb.append("-- $name, ms --\n")
            sb.append(Summary.HEADER).append('\n')
            sb.append(w.row()).append('\n')
            sb.append(wo.row()).append('\n')
            sb.append(armDeltaLine(w, wo)).append('\n')
            sb.append(p.line()).append('\n')
            if (judged == null) judged = p to (w to wo)
        }
        sb.append(armProofLine(samples)).append('\n')
        val (p, arms) = checkNotNull(judged)
        sb.append(verdict(p, arms.first, arms.second, emulator, asked)).append('\n')
        sb.append("== end ==\n")
        return sb.toString()
    }

    private fun ms(value: Double): String = if (value == MISSED) "   never" else String.format(Locale.ROOT, "%8.1f", value)
}
