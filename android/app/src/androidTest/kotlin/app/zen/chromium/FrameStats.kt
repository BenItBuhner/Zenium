package app.zen.chromium

import android.os.Process
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * Frame stats around a driver's gesture scenes (Bennett's rule of 2026-09-20: performance is a
 * shipping requirement, every driver run records them), as #259's ImportDemo reads them: each
 * scene sits between a `dumpsys gfxinfo <package> reset` and a `… framestats` read [SETTLE_MS]
 * after its motion settled, and the app menu opened under a finger and dismissed with a back is
 * the baseline every driver plays first, under the Android program's scene names
 * `menu-sheet-open` / `menu-sheet-close` (PERF-3), so the PR's scenes read against one table.
 * Per scene the total frames, the janky count and share and the 50th / 90th / 99th percentile
 * frame times go to a JSON array ([json]), a fixed-width table ([table]) and the logcat (`FRAMES`
 * lines); the raw dumps to `<prefix>-framestats.txt` in `out`. Reported, not gated: the gate on
 * janky frames is the Android program's (PERF-3) and is adopted when it lands. The emulator's
 * software GPU inflates every frame time; the before / after on one recipe is the reading.
 *
 * `shell` runs a command through the instrumentation's UiAutomation (the driver's own).
 */
class FrameStats(
    private val tag: String,
    private val packageName: String,
    private val out: File,
    prefix: String,
    private val shell: (String) -> String
) {
    /**
     * One gesture scene's frames as HWUI counts them for the app's process: the `dumpsys gfxinfo`
     * summary since the reset before the scene – every frame the window drew; the chrome WebView
     * and the page draw through the activity's render thread, so their frames are these – and the
     * times of the frames its `framestats` ring still held at the read, a cross-check on the
     * summary's percentiles (its histogram is 50 ms wide above 100 ms).
     */
    class Summary(
        val total: Int,
        val janky: Int,
        val jankyPercent: Double,
        /** Android 12+'s second count, the pre-12 rule (a frame longer than the vsync period). */
        val jankyLegacy: Int?,
        val p50: Int,
        val p90: Int,
        val p99: Int,
        /** HWUI's `Number …` counters (missed vsync, slow UI thread, slow draw commands, …), the reasons behind the janky count. */
        val reasons: Map<String, Int>,
        /** FrameCompleted − IntendedVsync in ms for the ring's `Flags == 0` frames (the others are first frames or window resizes, out of the count by Android's own rule). */
        val ringMs: List<Double>
    )

    /** A scene as it played: `stats` null when the dump held no summary for this process. */
    class Scene(val name: String, val played: Boolean, val gestureMs: Long, val stats: Summary?)

    /** The scenes in the order they played. */
    val scenes = ArrayList<Scene>()

    private val dumps = File(out, "$prefix-framestats.txt").also {
        it.writeText("dumpsys gfxinfo $packageName framestats, read $SETTLE_MS ms after each gesture scene settled (the counters reset before it)\n\n")
    }

    /**
     * The frames of one gesture scene: the process's HWUI counters reset before it, `body`
     * played – the finger and the wait for what it does, nothing else; no still inside – then
     * [SETTLE_MS] for its last frames to land, and the counters read. A scene whose motion did
     * not happen (`body` false, or it threw) is read all the same and listed as not played.
     * Answers what `body` answered.
     */
    fun scene(name: String, body: () -> Boolean): Boolean {
        shell("dumpsys gfxinfo $packageName reset")
        SystemClock.sleep(RESET_SETTLE_MS)
        val started = SystemClock.uptimeMillis()
        var played = false
        try {
            played = body()
        } finally {
            val gestureMs = SystemClock.uptimeMillis() - started
            SystemClock.sleep(SETTLE_MS)
            val dump = shell("dumpsys gfxinfo $packageName framestats")
            val stats = parse(dump)
            scenes += Scene(name, played, gestureMs, stats)
            dumps.appendText("=== $name (${if (played) "played" else "NOT played"}, gesture $gestureMs ms, read $SETTLE_MS ms after) ===\n$dump\n\n")
            val line = if (stats == null) "no HWUI summary for $packageName in the dump (${dump.length} chars)" else describe(stats, gestureMs)
            Log.i(tag, "FRAMES $name: $line${if (played) "" else " – the scene did not play; not counted"}")
        }
        return played
    }

    /**
     * The HWUI summary for this process out of a `dumpsys gfxinfo <package> framestats` dump
     * (the block headed `Graphics info for pid <ours>` – the WebView's sandboxed renderers carry
     * the package name too and draw no frames of their own) and the frame times out of its
     * PROFILEDATA rings; null without a summary.
     */
    private fun parse(dump: String): Summary? {
        val blocks = dump.split("** Graphics info for pid ")
        val mine = blocks.drop(1).firstOrNull { it.startsWith("${Process.myPid()} ") }
            ?: blocks.drop(1).firstOrNull { "Total frames rendered:" in it }
            ?: return null
        fun int(pattern: String): Int? =
            Regex(pattern, RegexOption.MULTILINE).find(mine)?.groupValues?.get(1)?.toIntOrNull()
        val total = int("""^Total frames rendered: (\d+)""") ?: return null
        val janky = Regex("""^Janky frames: (\d+) \((\d+(?:\.\d+)?)%\)""", RegexOption.MULTILINE).find(mine)
        val reasons = LinkedHashMap<String, Int>()
        for (match in Regex("""^Number (.+?): (\d+)""", RegexOption.MULTILINE).findAll(mine)) {
            reasons[match.groupValues[1]] = match.groupValues[2].toInt()
        }
        return Summary(
            total = total,
            janky = janky?.groupValues?.get(1)?.toIntOrNull() ?: 0,
            jankyPercent = janky?.groupValues?.get(2)?.toDoubleOrNull() ?: 0.0,
            jankyLegacy = int("""^Janky frames \(legacy\): (\d+) \("""),
            p50 = int("""^50th percentile: (\d+)ms""") ?: -1,
            p90 = int("""^90th percentile: (\d+)ms""") ?: -1,
            p99 = int("""^99th percentile: (\d+)ms""") ?: -1,
            reasons = reasons,
            ringMs = ringFrameTimes(mine)
        )
    }

    /** FrameCompleted − IntendedVsync, in ms, for every `Flags == 0` row of every PROFILEDATA block (the columns found by name: they differ by release). */
    private fun ringFrameTimes(block: String): List<Double> {
        val times = ArrayList<Double>()
        val lines = block.lines()
        var i = 0
        while (i < lines.size) {
            if (lines[i].trim() != "---PROFILEDATA---") {
                i++
                continue
            }
            val header = lines.getOrNull(i + 1)?.split(',')?.map { it.trim() } ?: break
            val flags = header.indexOf("Flags")
            val vsync = header.indexOf("IntendedVsync")
            val done = header.indexOf("FrameCompleted")
            i += 2
            while (i < lines.size && lines[i].trim() != "---PROFILEDATA---") {
                val cells = lines[i].split(',')
                if (flags >= 0 && vsync >= 0 && done >= 0 && cells.size > maxOf(flags, vsync, done)) {
                    val flag = cells[flags].trim().toLongOrNull()
                    val from = cells[vsync].trim().toLongOrNull()
                    val to = cells[done].trim().toLongOrNull()
                    if (flag == 0L && from != null && to != null && to > from) times.add((to - from) / 1_000_000.0)
                }
                i++
            }
            i++
        }
        return times
    }

    /** The ring's frame count and 50th / 90th / 99th percentile times in ms, with how many ran past 16.7 ms; null for an empty ring. */
    private fun ringSummary(ringMs: List<Double>): JSONObject? {
        if (ringMs.isEmpty()) return null
        val sorted = ringMs.sorted()
        fun at(p: Double): Double = sorted[((sorted.size - 1) * p).toInt()]
        return JSONObject()
            .put("frames", sorted.size)
            .put("p50", at(0.5))
            .put("p90", at(0.9))
            .put("p99", at(0.99))
            .put("over16_7", sorted.count { it > 16.7 })
    }

    private fun ms(value: Double): String = "%.1f".format(Locale.US, value)

    private fun describe(s: Summary, gestureMs: Long): String {
        val ring = ringSummary(s.ringMs)?.let {
            "; ring ${it.getInt("frames")} frames p50 ${ms(it.getDouble("p50"))} p90 ${ms(it.getDouble("p90"))} p99 ${ms(it.getDouble("p99"))} ms, ${it.getInt("over16_7")} over 16.7"
        } ?: ""
        return "${s.total} frames, ${s.janky} janky (${ms(s.jankyPercent)} %)" +
            (s.jankyLegacy?.let { ", $it by the pre-12 rule" } ?: "") +
            ", p50 ${s.p50} ms, p90 ${s.p90} ms, p99 ${s.p99} ms, gesture $gestureMs ms$ring"
    }

    /** The scenes for the run's results JSON: one object each, in the order they played. */
    fun json(): JSONArray {
        val list = JSONArray()
        for (scene in scenes) {
            val entry = JSONObject().put("scene", scene.name).put("played", scene.played).put("gestureMs", scene.gestureMs)
            val s = scene.stats
            if (s == null) {
                entry.put("summary", JSONObject.NULL)
            } else {
                entry.put("frames", s.total)
                    .put("janky", s.janky)
                    .put("jankyPercent", s.jankyPercent)
                    .put("jankyLegacy", s.jankyLegacy ?: JSONObject.NULL)
                    .put("p50", s.p50)
                    .put("p90", s.p90)
                    .put("p99", s.p99)
                    .put("reasons", JSONObject(s.reasons))
                    .put("ring", ringSummary(s.ringMs) ?: JSONObject.NULL)
            }
            list.put(entry)
        }
        return list
    }

    /**
     * The scenes as one table: a fixed-width block for the run's frames file and the findings,
     * and the same rows as Markdown for the PR body. `flowNote` says what the PR's scenes are.
     */
    fun table(flowNote: String): String {
        val sb = StringBuilder()
        sb.append("Frame stats – dumpsys gfxinfo $packageName: the counters reset before each gesture scene and read $SETTLE_MS ms after its motion settled.\n")
        sb.append("frames is every frame the window drew in the scene; janky is HWUI's count of them past their deadline (and its share of the total); p50 / p90 / p99 are its histogram's percentiles in ms (50 ms buckets above 100 ms); gesture is the finger and the wait for what it did, in ms; ring is the framestats ring's own frame times at the read (FrameCompleted - IntendedVsync, Flags == 0), a cross-check.\n")
        sb.append("menu-sheet-open / menu-sheet-close are the baseline: the app menu, a sheet main had before this PR, under a finger and a back, under the Android program's scene names. $flowNote\n")
        sb.append("Reported, not gated: the harness's gate on janky frames is the Android program's (PERF-3) and is adopted when it lands. The emulator's software GPU inflates every frame time; the before / after on one recipe is the reading.\n\n")
        sb.append(String.format(Locale.US, "%-34s %7s %16s %8s %8s %8s %9s  %s%n", "scene", "frames", "janky", "p50", "p90", "p99", "gesture", "ring (frames, p50 / p90 / p99 ms, over 16.7)"))
        for (scene in scenes) sb.append(row(scene)).append('\n')
        sb.append("\nMarkdown:\n\n| scene | frames | janky | p50 | p90 | p99 | gesture ms | ring (frames, p50 / p90 / p99 ms, over 16.7) |\n|---|---|---|---|---|---|---|---|\n")
        for (scene in scenes) sb.append(markdownRow(scene)).append('\n')
        return sb.toString()
    }

    private fun cells(scene: Scene): List<String> {
        val s = scene.stats
        val played = if (scene.played) scene.name else "${scene.name} (not played)"
        if (s == null) return listOf(played, "–", "no summary", "–", "–", "–", scene.gestureMs.toString(), "–")
        val ring = ringSummary(s.ringMs)?.let { "${it.getInt("frames")}, ${ms(it.getDouble("p50"))} / ${ms(it.getDouble("p90"))} / ${ms(it.getDouble("p99"))}, ${it.getInt("over16_7")}" } ?: "empty"
        return listOf(
            played,
            s.total.toString(),
            "${s.janky} (${ms(s.jankyPercent)} %)",
            s.p50.toString(),
            s.p90.toString(),
            s.p99.toString(),
            scene.gestureMs.toString(),
            ring
        )
    }

    private fun row(scene: Scene): String {
        val c = cells(scene)
        return String.format(Locale.US, "%-34s %7s %16s %8s %8s %8s %9s  %s", c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7])
    }

    private fun markdownRow(scene: Scene): String = "| " + cells(scene).joinToString(" | ") + " |"

    companion object {
        /** After a scene's motion settled, before the read: its last frames land. */
        const val SETTLE_MS = 1_200L
        /** After the reset, before the gesture: the reset's own work is not the scene's. */
        const val RESET_SETTLE_MS = 300L
    }
}
