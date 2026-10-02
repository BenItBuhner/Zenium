package app.zen.chromium.ext

/**
 * The compat sweep's Java heap peak PER STEP of a row (CompatSweep.kt's `MemorySampler`), kept
 * free of Android so it runs on the JVM (`SweepHeapStepsTest`) and compiled into the unit tests
 * and the instrumentation alike (`src/sharedTest`), never into the app.
 *
 * Compat round 22 read the OOM row's ART peak rising (Adblock Ad Blocker Pro on 113: 168.7 →
 * 184.8 MB of the 192 MB cap) while its settled heap fell 28 MB, and could not say at which step:
 * the sampler kept the row's one peak value. Here every sample of the row carries its time, the
 * driver marks its steps as it enters them (the install, the background, the popup, the options
 * page, the core check, the settle, the split, the cleanup; the same-process restart), and the
 * runtime's own `configure` / `configured` lines cut the install into the plan's arrival, the
 * compile and the units' attach. A sample belongs to the runtime segment holding it (the latest
 * to begin when two nest), else to the driver's last mark at or before it, else to `before`.
 */
object SweepHeapSteps {
    /** One reading of the Java heap in use (bytes) at an epoch millisecond. */
    data class Sample(val atMs: Long, val heapBytes: Long)

    /** The driver entering a step: the step runs from here to the next mark. */
    data class Mark(val atMs: Long, val step: String)

    /** A runtime segment overlaid on the driver's steps (`compile 1`, `attach 1`, …). */
    data class Segment(val fromMs: Long, val toMs: Long, val name: String)

    /** A step's peak: its highest sample, when, how many samples it had, its first and last sample's time. */
    data class StepPeak(val step: String, val peakBytes: Long, val peakAtMs: Long, val samples: Int, val fromMs: Long, val toMs: Long)

    /**
     * A runtime log line of an extension's configure: the plan's arrival (`configure <id8>
     * <version>: N unit(s) planned, … heap A/M MB, …`) or its end after the attach
     * (`configured <id8> <version>: N unit(s), … in C ms, … heap B/M MB`). Read off `logcat -v
     * epoch` through [parseConfigureLine].
     */
    data class ConfigureLine(val atMs: Long, val id8: String, val version: String, val configured: Boolean, val units: Int, val heapMb: Int, val maxMb: Int, val compileMs: Long?)

    private val EPOCH_LINE = Regex("""^\s*(\d+)\.(\d{1,3})\s+\d+\s+\d+\s+[VDIWEF]\s+ZenExt\s*:\s*(.*)$""")
    private val ARRIVAL = Regex("""^configure ([a-p]{8}) (\S+): (\d+) unit\(s\) planned, .*heap (\d+)/(\d+) MB""")
    private val CONFIGURED = Regex("""^configured ([a-p]{8}) (\S+): (\d+) unit\(s\), .* in (\d+) ms, .*heap (\d+)/(\d+) MB""")

    const val BEFORE = "before"

    fun stepOf(atMs: Long, marks: List<Mark>, segments: List<Segment>): String {
        val segment = segments.filter { atMs >= it.fromMs && atMs <= it.toMs }.maxByOrNull { it.fromMs }
        if (segment != null) return segment.name
        return marks.filter { it.atMs <= atMs }.maxByOrNull { it.atMs }?.step ?: BEFORE
    }

    /** Every step's peak in the order the steps were first seen; a step without a sample is absent. */
    fun attribute(samples: List<Sample>, marks: List<Mark>, segments: List<Segment>): List<StepPeak> {
        val out = LinkedHashMap<String, StepPeak>()
        for (sample in samples) {
            val step = stepOf(sample.atMs, marks, segments)
            val had = out[step]
            out[step] = if (had == null) {
                StepPeak(step, sample.heapBytes, sample.atMs, 1, sample.atMs, sample.atMs)
            } else {
                val higher = sample.heapBytes > had.peakBytes
                had.copy(
                    peakBytes = if (higher) sample.heapBytes else had.peakBytes,
                    peakAtMs = if (higher) sample.atMs else had.peakAtMs,
                    samples = had.samples + 1,
                    fromMs = minOf(had.fromMs, sample.atMs),
                    toMs = maxOf(had.toMs, sample.atMs)
                )
            }
        }
        return out.values.toList()
    }

    /** The row's peak step: the highest step peak, the earlier one when equal. */
    fun peak(peaks: List<StepPeak>): StepPeak? = peaks.maxWithOrNull(compareBy<StepPeak> { it.peakBytes }.thenByDescending { it.peakAtMs })

    /** One `logcat -v epoch` line; null unless it is the runtime's `configure` / `configured` line. */
    fun parseConfigureLine(line: String): ConfigureLine? {
        val epoch = EPOCH_LINE.find(line) ?: return null
        val atMs = epoch.groupValues[1].toLong() * 1000 + epoch.groupValues[2].padEnd(3, '0').toLong()
        val message = epoch.groupValues[3]
        ARRIVAL.find(message)?.let { m ->
            return ConfigureLine(atMs, m.groupValues[1], m.groupValues[2], false, m.groupValues[3].toInt(), m.groupValues[4].toInt(), m.groupValues[5].toInt(), null)
        }
        CONFIGURED.find(message)?.let { m ->
            return ConfigureLine(atMs, m.groupValues[1], m.groupValues[2], true, m.groupValues[3].toInt(), m.groupValues[5].toInt(), m.groupValues[6].toInt(), m.groupValues[4].toLong())
        }
        return null
    }

    /**
     * The runtime's segments for one extension off its lines in time order: each arrival paired
     * with the next `configured` of the same id gives `compile n` (the arrival to the arrival plus
     * the configured line's compile time – the io executor's part) and `attach n` (from there to
     * the configured line – the main thread's install into every tab). An arrival without a
     * `configured` behind it (a configure dropped or still in flight) is left out.
     */
    fun segments(lines: List<ConfigureLine>, id8: String): List<Segment> {
        val own = lines.filter { it.id8 == id8 }.sortedBy { it.atMs }
        val out = ArrayList<Segment>()
        var n = 0
        var i = 0
        while (i < own.size) {
            val arrival = own[i]
            if (arrival.configured) {
                i++
                continue
            }
            val j = (i + 1 until own.size).firstOrNull { own[it].configured } ?: break
            val end = own[j]
            n++
            val compiled = minOf(arrival.atMs + (end.compileMs ?: 0L), end.atMs)
            out.add(Segment(arrival.atMs, compiled, "compile $n"))
            if (end.atMs > compiled) out.add(Segment(compiled + 1, end.atMs, "attach $n"))
            i = j + 1
        }
        return out
    }

    /**
     * A row whose Java heap peak comes within a tenth of the cap, or twenty mebibytes above
     * its BEFORE, is a regression line of its own. The sweep's log already says
     * `WITHIN A TENTH OF THE CAP` when `peak * 10 >= cap * 9`; this is that inequality on
     * bytes, plus the +20 MiB growth. A non-positive peak or cap is neither.
     */
    data class PeakGate(val withinTenthOfCap: Boolean, val grown20MiB: Boolean) {
        val regression: Boolean get() = withinTenthOfCap || grown20MiB
    }

    fun peakGate(peakBytes: Long, maxBytes: Long, beforePeakBytes: Long? = null): PeakGate {
        if (peakBytes <= 0L || maxBytes <= 0L) return PeakGate(false, false)
        return PeakGate(
            withinTenthOfCap = peakBytes * 10 >= maxBytes * 9,
            grown20MiB = beforePeakBytes != null && peakBytes >= beforePeakBytes + 20L * 1_048_576L
        )
    }
}
