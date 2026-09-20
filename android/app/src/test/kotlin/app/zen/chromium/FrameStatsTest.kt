package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The framestats parser behind `DemoHarness.measureFrames` ([FrameStats]), fed dumps in the
 * shape `dumpsys gfxinfo <package> framestats` prints them (`src/test/resources/framestats/`):
 * an API 34 dump with the frame timeline's columns (`FrameDeadline`, `GpuCompleted`,
 * `CommandSubmissionCompleted`) and the legacy jank line, an API 29 one without them. The rows'
 * stage times are known to the millisecond (see the fixture's comment rows in the generator's
 * table: 0.5 / 0.3 / 1.2 / 2.0 / 3.0 / 0.8 / 40.0 / 2.2 ms for the first sampled frame), so the
 * readings are held to exact numbers.
 */
class FrameStatsTest {
    private fun fixture(name: String): String =
        FrameStatsTest::class.java.getResourceAsStream("/framestats/$name")!!.bufferedReader().use { it.readText() }

    private val api34 by lazy { FrameStats.parse(fixture("emulator-api34.txt")) }
    private val api29 by lazy { FrameStats.parse(fixture("emulator-api29.txt")) }

    // --- the summary -----------------------------------------------------------------------------

    @Test
    fun `the summary is read as HWUI prints it - frames, janky frames, the percentiles, the reasons`() {
        val s = api34.summary!!
        assertEquals(83, s.frames)
        assertEquals(41, s.janky)
        assertEquals(45, s.jankyLegacy)
        assertEquals(41.0 / 83, s.jankyShare, 1e-12)
        assertEquals(16, s.p50Ms)
        assertEquals(48, s.p90Ms)
        assertEquals(61, s.p95Ms)
        assertEquals(120, s.p99Ms)
        assertEquals(
            mapOf(
                "Missed Vsync" to 3, "High input latency" to 0, "Slow UI thread" to 12, "Slow bitmap uploads" to 0,
                "Slow issue draw commands" to 30, "Frame deadline missed" to 41, "Frame deadline missed (legacy)" to 45
            ),
            s.reasons
        )
    }

    @Test
    fun `the gpu percentile lines are not the frame percentiles`() {
        // "50th gpu percentile: 5ms" follows "50th percentile: 16ms" in the dump; the first wins and the gpu one never overwrites it.
        assertEquals(16, api34.summary!!.p50Ms)
        assertEquals(120, api34.summary!!.p99Ms)
    }

    // --- the frames ------------------------------------------------------------------------------

    @Test
    fun `a frame's stages are the gaps between the CSV's timestamps, read by column name`() {
        assertEquals(7, api34.frames.size)
        assertEquals(3, api34.skipped)
        val first = api34.frames[0]
        assertEquals(0L, first.flags)
        assertEquals(50.0, first.totalMs, 1e-9)
        assertEquals(16.666667, first.deadlineMs, 1e-9)
        assertTrue(first.long)
        val expected = mapOf(
            "delay" to 0.5, "input" to 0.3, "animation" to 1.2, "layout" to 2.0, "draw" to 3.0,
            "sync" to 0.8, "commands" to 40.0, "swap" to 2.2, "gpu" to 5.0
        )
        assertEquals(expected.keys.toList(), first.stages.keys.toList())
        for ((stage, ms) in expected) assertEquals(stage, ms, first.stages[stage]!!, 1e-9)
        // The eight summing stages add up to the total; the GPU's time runs alongside.
        assertEquals(first.totalMs, FrameStats.STAGES.take(FrameStats.SUMMING_STAGES).sumOf { first.stages[it.name]!! }, 1e-6)
        assertEquals("commands", first.longStage)
    }

    @Test
    fun `the long stage is the largest of the summing stages - the render thread, the UI thread's delay, the layout`() {
        assertEquals("commands", api34.frames[0].longStage)
        assertFalse(api34.frames[1].long) // 14.0 ms
        assertEquals("delay", api34.frames[2].longStage) // the UI thread answered the vsync 30 ms late
        assertEquals("layout", api34.frames[3].longStage) // 25 ms of measure and layout
        assertFalse(api34.frames[4].long) // 13.9 ms
        assertEquals("commands", api34.frames[5].longStage)
        assertFalse(api34.frames[6].long) // 16.0 ms against a 16.67 ms deadline
    }

    @Test
    fun `a GPU timestamp HWUI has not set leaves that stage out of the frame, and never makes it the long stage`() {
        val noGpu = api34.frames[1]
        assertFalse(noGpu.stages.containsKey("gpu"))
        assertEquals(8, noGpu.stages.size)
        // A frame whose GPU time is the largest number still names a summing stage.
        val frame = FrameStats.Frame(0, 20.0, 16.67, mapOf("draw" to 3.0, "commands" to 10.0, "gpu" to 400.0))
        assertEquals("commands", frame.longStage)
    }

    @Test
    fun `rows with flags set and frames in flight at the dump are skipped, not read`() {
        // Row 1: window visibility changed (flags 1); row 8: a skipped frame (flags 8); row 9: FrameCompleted 0.
        assertEquals(3, api34.skipped)
        assertTrue(api34.frames.all { it.flags == 0L })
        assertTrue(api34.frames.none { it.totalMs > 100 })
    }

    @Test
    fun `the analysis counts the long frames, each stage's mean and max, and names the stage most often long`() {
        val a = api34.analyse()
        assertEquals(7, a.sampled)
        assertEquals(3, a.skipped)
        assertEquals(4, a.long)
        assertEquals("commands", a.dominant)
        assertEquals(FrameStats.STAGES.map { it.name }, a.stages.keys.toList())
        val commands = a.stages["commands"]!!
        assertEquals(159.0 / 7, commands.meanMs, 1e-9)
        assertEquals(60.0, commands.maxMs, 1e-9)
        assertEquals(2, commands.longFrames)
        assertEquals(1, a.stages["delay"]!!.longFrames)
        assertEquals(1, a.stages["layout"]!!.longFrames)
        assertEquals(0, a.stages["swap"]!!.longFrames)
        val gpu = a.stages["gpu"]!!
        assertEquals(5.0, gpu.meanMs, 1e-9) // over the six frames that had one
        assertEquals(0, gpu.longFrames)
    }

    @Test
    fun `a tie between long stages goes to the earlier stage of the pipeline`() {
        val frames = listOf(
            FrameStats.Frame(0, 30.0, 16.67, mapOf("layout" to 20.0, "commands" to 5.0)),
            FrameStats.Frame(0, 30.0, 16.67, mapOf("layout" to 5.0, "commands" to 20.0))
        )
        assertEquals("layout", FrameStats.Dump(null, frames, 0).analyse().dominant)
        assertNull(FrameStats.Dump(null, emptyList(), 0).analyse().dominant)
    }

    @Test
    fun `an API 29 dump has no deadline, legacy count or GPU columns - the interval stands in and the absent stages are left out`() {
        val s = api29.summary!!
        assertEquals(27, s.frames)
        assertEquals(9, s.janky)
        assertEquals(-1, s.jankyLegacy)
        assertEquals(12, s.p50Ms)
        assertEquals(77, s.p99Ms)
        assertEquals(6, s.reasons.size)
        assertFalse(s.reasons.containsKey("Frame deadline missed (legacy)"))
        assertEquals(3, api29.frames.size)
        assertEquals(0, api29.skipped)
        val first = api29.frames[0]
        assertFalse(first.stages.containsKey("gpu"))
        assertEquals(8, first.stages.size)
        assertEquals(FrameStats.DEFAULT_INTERVAL_NS / 1e6, first.deadlineMs, 1e-9)
        assertEquals(50.0, first.totalMs, 1e-9)
        assertEquals("commands", first.longStage)
        assertEquals("delay", api29.frames[2].longStage)
    }

    @Test
    fun `a dump without the process has no summary and no frames, and an empty text reads the same`() {
        val dump = FrameStats.parse("Applications Graphics Acceleration Info:\nUptime: 1 Realtime: 1\n\nNo process found for: app.zen.chromium\n")
        assertNull(dump.summary)
        assertTrue(dump.frames.isEmpty())
        assertEquals(0, dump.skipped)
        val empty = FrameStats.parse("")
        assertNull(empty.summary)
        assertTrue(empty.frames.isEmpty())
    }

    @Test
    fun `odd text never throws - a marker without a header, a row short of its columns, letters where numbers go`() {
        val text = "Total frames rendered: 5\nJanky frames: x\n---PROFILEDATA---\nnot a header\n1,2\n---PROFILEDATA---\n" +
            "---PROFILEDATA---\nFlags,IntendedVsync,FrameCompleted,\n0,100,\n0,abc,def,\n0,1000000,3000000,\n---PROFILEDATA---\n"
        val dump = FrameStats.parse(text)
        assertEquals(5, dump.summary!!.frames)
        assertEquals(0, dump.summary!!.janky)
        assertEquals(1, dump.frames.size)
        assertEquals(2.0, dump.frames[0].totalMs, 1e-9)
        assertTrue(dump.frames[0].stages.isEmpty())
        assertEquals(2, dump.skipped)
    }

    // --- the scene -------------------------------------------------------------------------------

    private val budget = JankBudget.Budget(jankyShare = 0.6, p95Ms = 80, provisional = true)

    private fun scene(gate: JankBudget.Gate, budget: JankBudget.Budget = this.budget) =
        FrameStats.scene("bar-hide-scroll-bottom", JankBudget.Kind.GESTURE, gate, 1_789_938_000_000L, 2_400, api34, budget)

    @Test
    fun `the JSON line is one line, keys in a fixed order, and parses back to the numbers`() {
        val json = scene(JankBudget.Gate.SOFT).toJson()
        assertFalse(json.contains('\n'))
        assertTrue(json, json.startsWith("{\"v\":1,\"scene\":\"bar-hide-scroll-bottom\",\"kind\":\"gesture\",\"gate\":\"soft\",\"at\":\"2026-09-20T21:00:00Z\",\"durationMs\":2400,\"frames\":83,\"janky\":41,\"jankyShare\":0.494,\"jankyLegacy\":45,\"p50\":16,\"p90\":48,\"p95\":61,\"p99\":120,\"reasons\":{"))
        val o = JSONObject(json)
        assertEquals(41, o.getJSONObject("reasons").getInt("Frame deadline missed"))
        assertEquals(7, o.getInt("sampled"))
        assertEquals(3, o.getInt("skipped"))
        assertEquals(4, o.getInt("long"))
        val commands = o.getJSONObject("stageMs").getJSONObject("commands")
        assertEquals(22.71, commands.getDouble("mean"), 1e-9)
        assertEquals(60.0, commands.getDouble("max"), 1e-9)
        assertEquals(2, commands.getInt("long"))
        // The stages in the pipeline's order in the text itself (org.json keeps no order).
        val stageKeys = Regex(""""(\w+)":\{"mean"""").findAll(json.substringAfter("\"stageMs\":{")).map { it.groupValues[1] }.toList()
        assertEquals(FrameStats.STAGES.map { it.name }, stageKeys)
        assertEquals("commands", o.getString("dominant"))
        val b = o.getJSONObject("budget")
        assertEquals(0.6, b.getDouble("jankyShare"), 1e-9)
        assertEquals(80, b.getInt("p95"))
        assertTrue(b.getBoolean("provisional"))
        assertEquals("within", o.getString("verdict"))
        assertEquals(0, o.getJSONArray("breaches").length())
        assertFalse(o.getBoolean("enforced"))
    }

    @Test
    fun `a breach is named in the verdict, the JSON and the table, and enforced under a hard gate alone`() {
        val over = JankBudget.Budget(jankyShare = 0.3, p95Ms = 40, provisional = false)
        val soft = scene(JankBudget.Gate.SOFT, over)
        val hard = scene(JankBudget.Gate.HARD, over)
        assertEquals(listOf("janky 49% > 30%", "p95 61 ms > 40 ms"), soft.verdict.breaches)
        assertFalse(soft.verdict.within)
        assertFalse(soft.enforced)
        assertTrue(hard.enforced)
        assertTrue(soft.table(), soft.table().contains("over: janky 49% > 30%; p95 61 ms > 40 ms [reported: the gate is soft]"))
        assertTrue(hard.table(), hard.table().contains("[FAULT: the gate is hard]"))
        val o = JSONObject(hard.toJson())
        assertEquals("over", o.getString("verdict"))
        assertEquals("hard", o.getString("gate"))
        assertEquals(2, o.getJSONArray("breaches").length())
        assertTrue(o.getBoolean("enforced"))
        assertFalse(o.getJSONObject("budget").getBoolean("provisional"))
    }

    @Test
    fun `a scene without a summary is not measured - a breach in itself, and the JSON says zero frames`() {
        val dump = FrameStats.parse("No process found for: app.zen.chromium\n")
        val scene = FrameStats.scene("menu-open", JankBudget.Kind.OPEN, JankBudget.Gate.HARD, 0, 100, dump)
        assertNull(scene.summary)
        assertFalse(scene.verdict.within)
        assertEquals(listOf("no frames were recorded for the scene"), scene.verdict.breaches)
        assertTrue(scene.enforced)
        assertTrue(scene.table(), scene.table().contains("NOT MEASURED"))
        val o = JSONObject(scene.toJson())
        assertEquals(0, o.getInt("frames"))
        assertEquals(-1, o.getInt("jankyLegacy"))
        assertTrue(o.isNull("dominant"))
        assertEquals("open", o.getString("kind"))
        assertEquals(0, o.getJSONObject("reasons").length())
    }

    @Test
    fun `the table reads as one summary line, the sampling line, one row per stage and the reasons`() {
        val table = scene(JankBudget.Gate.SOFT).table()
        val lines = table.lines()
        assertEquals(
            "scene bar-hide-scroll-bottom (gesture, 2400 ms): 83 frames, 41 janky (49%), p50 16 p90 48 p95 61 p99 120 ms; budget janky <= 60%, p95 <= 80 ms (provisional): within",
            lines[0]
        )
        assertEquals("  sampled 7 frames (3 skipped), 4 past their deadline; long stage most often: commands", lines[1])
        assertEquals(listOf("stage", "mean", "ms", "max", "ms", "long"), lines[2].trim().split(Regex("\\s+")))
        assertEquals(listOf("commands", "22.71", "60.00", "2"), lines.first { it.trim().startsWith("commands") }.trim().split(Regex("\\s+")))
        assertEquals(listOf("gpu", "5.00", "5.00", "0"), lines.first { it.trim().startsWith("gpu") }.trim().split(Regex("\\s+")))
        // The stages in the pipeline's order, delay first, gpu last.
        assertEquals(FrameStats.STAGES.map { it.name }, lines.drop(3).take(9).map { it.trim().substringBefore(' ') })
        assertTrue(lines.last(), lines.last().startsWith("  reasons: Missed Vsync 3, High input latency 0, Slow UI thread 12"))
    }

    // --- JSON helpers ----------------------------------------------------------------------------

    @Test
    fun `quote escapes quotes, backslashes and control characters`() {
        assertEquals("\"plain\"", FrameStats.quote("plain"))
        assertEquals("\"a \\\"b\\\" \\\\ \\n\\r\\t\\u0001\"", FrameStats.quote("a \"b\" \\ \n\r\t\u0001"))
        assertEquals("\"\"", FrameStats.quote(""))
    }

    @Test
    fun `number keeps at most the decimals asked, drops trailing zeros, never writes an exponent, and makes NaN null`() {
        assertEquals("0.494", FrameStats.number(41.0 / 83, 4))
        assertEquals("22.71", FrameStats.number(159.0 / 7, 2))
        assertEquals("1", FrameStats.number(1.0, 4))
        assertEquals("0", FrameStats.number(0.0, 2))
        assertEquals("0.0001", FrameStats.number(1e-4, 4))
        assertEquals("0", FrameStats.number(1e-7, 4))
        assertEquals("123456789.5", FrameStats.number(123456789.5, 2))
        assertEquals("null", FrameStats.number(Double.NaN, 2))
        assertEquals("null", FrameStats.number(Double.POSITIVE_INFINITY, 2))
    }
}
