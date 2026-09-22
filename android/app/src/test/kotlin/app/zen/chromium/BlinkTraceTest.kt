package app.zen.chromium

import app.zen.chromium.BlinkTrace.Window
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Chromium trace reader behind `DemoHarness.traceFrames` ([BlinkTrace]), fed a trace in the
 * shape `android.webkit.TracingController` writes (`src/test/resources/blinktrace/webview-scene.json`,
 * generated with known counts; its comment lists them): the renderer main thread `4242:4242` runs
 * 20 frames inside the window 1 000 000..2 000 000 µs – each a `RunTask` enclosing a
 * `ProxyMain::BeginMainFrame` with `UpdateLayoutTree` (20), `Layout` (10 as `X` slices and one
 * as a `B`/`E` pair), `Paint` (5) and `UpdateLayer` (15) nested – and one 80 ms long task with
 * 70 ms of script; one frame and a 120 ms task lie before and after the window; a compositor, a
 * worker, the browser process and a second one-frame `CrRendererMain` are there to be ignored;
 * the thread names come last, as Chrome's exporter writes them; the args read `"__stripped__"`.
 */
class BlinkTraceTest {
    private val fixture: String by lazy {
        BlinkTraceTest::class.java.getResourceAsStream("/blinktrace/webview-scene.json")!!.bufferedReader().use { it.readText() }
    }
    private val window = Window(1_000_000, 2_000_000)
    private val scene by lazy { BlinkTrace.parse(fixture, window) }
    private val whole by lazy { BlinkTrace.parse(fixture) }

    // --- the fixture in the window ---------------------------------------------------------------

    @Test
    fun `the renderer main thread's frames in the window - their count and main-thread time as mean, max and 95th`() {
        assertTrue(scene.found)
        assertEquals("4242:4242", scene.thread)
        assertEquals(20, scene.frames)
        val ms = scene.frameMs!!
        assertEquals(8.34, ms.meanMs, 1e-9)
        assertEquals(30.0, ms.maxMs, 1e-9)
        assertEquals(18.0, ms.p95Ms, 1e-9) // nearest rank: the 19th of 20 sorted, not the max
        assertFalse(scene.whole)
        assertEquals(1000.0, scene.windowMs, 1e-9)
        assertEquals(6, scene.threads)
        assertEquals(116, scene.events)
    }

    @Test
    fun `layouts, paints, style recalculations and layer updates are counted in the window and given per frame`() {
        assertEquals(11, scene.layoutCount) // 10 X slices and one B/E pair
        assertEquals(5, scene.paintCount)
        assertEquals(20, scene.styleRecalcCount)
        assertEquals(15, scene.layerChurn)
        assertEquals(0.55, scene.perFrame(scene.layoutCount), 1e-9)
        assertEquals(0.25, scene.perFrame(scene.paintCount), 1e-9)
        assertEquals(1.0, scene.perFrame(scene.styleRecalcCount), 1e-9)
        assertEquals(0.75, scene.perFrame(scene.layerChurn), 1e-9)
    }

    @Test
    fun `long tasks are the top-level slices over 50 ms - the frames' RunTasks are busy time, the work nested in them is not counted twice`() {
        assertEquals(1, scene.longTasks)
        assertEquals(80.0, scene.longestTaskMs, 1e-9)
        // 20 RunTasks of frame + 0.3 ms (172.8 ms) and the 80 ms task; the nested frames, layouts and script add nothing.
        assertEquals(252.8, scene.busyMs, 1e-9)
        assertEquals(12.64, scene.busyPerFrameMs, 1e-9)
        // FunctionCall 1 ms in a frame, FunctionCall 60 ms and EvaluateScript 10 ms in the long task.
        assertEquals(71.0, scene.scriptMs, 1e-9)
    }

    @Test
    fun `the style, layout and paint time is the slices' total, ms - the split of the busy time with the script`() {
        // 20 recalcs of 0.5 ms; 10 layouts of 1.5 ms and the B/E pair's 1.5 ms; 5 paints of 0.5 ms.
        assertEquals(10.0, scene.styleRecalcMs, 1e-9)
        assertEquals(16.5, scene.layoutMs, 1e-9)
        assertEquals(2.5, scene.paintMs, 1e-9)
        // The two recalcs outside the window (0.7 ms together) join in the whole trace.
        assertEquals(10.7, whole.styleRecalcMs, 1e-9)
        assertEquals(16.5, whole.layoutMs, 1e-9)
    }

    @Test
    fun `a layout nested in a layout counts its time once, as busy time does`() {
        val text = "[" + listOf(
            event(7, 1_000, "X", BlinkTrace.FRAME, 8_000),
            event(7, 1_500, "X", BlinkTrace.LAYOUT, 4_000),
            event(7, 2_000, "X", BlinkTrace.LAYOUT, 1_000),
            event(7, 6_000, "X", BlinkTrace.PAINT, 1_000),
            event(7, 6_200, "X", BlinkTrace.PAINT, 200),
            event(7, 7_000, "X", BlinkTrace.STYLE_RECALC, 500)
        ).joinToString(",") + "]"
        val reading = BlinkTrace.parse(text)
        assertEquals(2, reading.layoutCount)
        assertEquals(4.0, reading.layoutMs, 1e-9)
        assertEquals(2, reading.paintCount)
        assertEquals(1.0, reading.paintMs, 1e-9)
        assertEquals(0.5, reading.styleRecalcMs, 1e-9)
    }

    @Test
    fun `the thread is the CrRendererMain with the most frames - a second renderer's one-frame main thread is not it`() {
        assertEquals("4242:4242", scene.thread)
        assertEquals("4242:4242", whole.thread)
    }

    // --- the whole trace and the window's fallback -----------------------------------------------

    @Test
    fun `without a window the whole trace is read - the frame and the task outside the window count, and the span is the trace's`() {
        assertTrue(whole.whole)
        assertEquals(21, whole.frames)
        assertEquals(22, whole.styleRecalcCount)
        assertEquals(11, whole.layoutCount)
        assertEquals(2, whole.longTasks)
        assertEquals(120.0, whole.longestTaskMs, 1e-9)
        // The style recalc at 2 100 000 µs lies inside the 120 ms task: nested, not busy time of its own.
        assertEquals(378.5, whole.busyMs, 1e-9)
        assertEquals(8.180952, whole.frameMs!!.meanMs, 1e-6)
        assertEquals(18.0, whole.frameMs!!.p95Ms, 1e-9) // the 20th of 21 sorted
        assertEquals(1200.0, whole.windowMs, 1e-9) // 900 000 to 2 100 000 µs
        assertEquals(122, whole.events)
    }

    @Test
    fun `a window that holds no main-thread event while the trace has some reads the whole trace instead, and says so`() {
        var opened = 0
        val reading = BlinkTrace.parse({ opened++; fixture.reader() }, Window(5_000_000, 6_000_000))
        assertEquals(2, opened)
        assertTrue(reading.whole)
        assertEquals(21, reading.frames)
        assertEquals(1200.0, reading.windowMs, 1e-9)
        // A window that holds events is read once.
        opened = 0
        assertFalse(BlinkTrace.parse({ opened++; fixture.reader() }, window).whole)
        assertEquals(1, opened)
    }

    @Test
    fun `a window is inclusive at both ends and cuts by the event's start`() {
        // The 80 ms task starts at 1 915 000 µs: a window ending there holds it, one ending a µs earlier does not.
        assertEquals(1, BlinkTrace.parse(fixture, Window(1_000_000, 1_915_000)).longTasks)
        assertEquals(0, BlinkTrace.parse(fixture, Window(1_000_000, 1_914_999)).longTasks)
        assertTrue(Window(10, 20).holds(10.0))
        assertTrue(Window(10, 20).holds(20.0))
        assertFalse(Window(10, 20).holds(20.5))
        assertEquals(2.5, Window(1_000, 3_500).lengthMs, 1e-9)
    }

    // --- other shapes of trace -------------------------------------------------------------------

    private fun event(tid: Int, ts: Long, ph: String, name: String, dur: Long? = null, pid: Int = 1): String =
        """{"pid":$pid,"tid":$tid,"ts":$ts,"ph":"$ph","cat":"cc","name":"$name"${dur?.let { ",\"dur\":$it" } ?: ""},"args":{"data":{"frameId":"AF31"}}}"""

    @Test
    fun `a bare array with unnamed threads reads the thread that carries the frames, B and E pairs as slices, args as they come`() {
        val text = "[" + listOf(
            event(7, 1_000, "B", BlinkTrace.FRAME),
            event(7, 1_200, "X", BlinkTrace.LAYOUT, 300),
            event(7, 5_000, "E", BlinkTrace.FRAME),
            event(7, 9_000, "X", BlinkTrace.FRAME, 2_000),
            event(9, 1_100, "X", "ProxyImpl::ScheduledActionDraw", 400),
            event(9, 1_600, "X", "Scheduler::BeginImplFrame", 100)
        ).joinToString(",") + "]"
        val reading = BlinkTrace.parse(text)
        assertTrue(reading.found)
        assertEquals("1:7", reading.thread)
        assertEquals(2, reading.frames)
        assertEquals(3.0, reading.frameMs!!.meanMs, 1e-9) // (5000 - 1000) µs and 2000 µs
        assertEquals(4.0, reading.frameMs!!.maxMs, 1e-9)
        assertEquals(1, reading.layoutCount)
        assertEquals(6.0, reading.busyMs, 1e-9)
        assertEquals(2, reading.threads)
        assertEquals(4, reading.events)
        assertEquals(8.0, reading.windowMs, 1e-9)
    }

    @Test
    fun `V8's compile slices are the script time that was compiling - nested ones once, named in describe past half a ms`() {
        val text = "[" + listOf(
            event(7, 1_000, "X", BlinkTrace.FRAME, 60_000),
            event(7, 1_100, "X", "FunctionCall", 55_000),
            event(7, 1_200, "X", "V8.CompileLazy", 40_000),
            event(7, 1_300, "X", "V8.CompileIgnition", 30_000), // inside the lazy compile: counted once
            event(7, 50_000, "X", "v8.compile", 4_000),
            event(7, 70_000, "X", "V8.CompileCode", 300) // outside the window's frame, in the trace
        ).joinToString(",") + "]"
        val whole = BlinkTrace.parse(text)
        assertEquals(44.3, whole.compileMs, 1e-9)
        assertEquals(55.0, whole.scriptMs, 1e-9)
        assertTrue(whole.describe(), whole.describe().contains("script 55 (compiling 44), style 0"))
        val windowed = BlinkTrace.parse(text, Window(0, 60_000))
        assertEquals(44.0, windowed.compileMs, 1e-9)
        assertTrue(windowed.toJson(), windowed.toJson().contains("\"workMs\":{\"script\":55,\"styleRecalc\":0,\"layout\":0,\"paint\":0,\"compile\":44}"))
        assertFalse(scene.describe(), scene.describe().contains("compiling"))
    }

    @Test
    fun `the longest task's time on the CPU is its tdur - the gap to its wall time is the thread off the CPU, named in describe and the JSON, absent without thread times`() {
        val cpu = { tid: Int, ts: Long, name: String, dur: Long, tdur: Long ->
            """{"pid":1,"tid":$tid,"ts":$ts,"ph":"X","cat":"cc","name":"$name","dur":$dur,"tdur":$tdur,"tts":$ts,"args":"__stripped__"}"""
        }
        val text = "[" + listOf(
            event(7, 1_000, "X", BlinkTrace.FRAME, 8_000),
            cpu(7, 20_000, "RunTask", 92_000, 27_000), // the long task: 92 ms of wall time, 27 on the CPU
            cpu(7, 20_100, "FunctionCall", 76_000, 24_000),
            cpu(7, 200_000, "RunTask", 30_000, 30_000) // not the longest
        ).joinToString(",") + "]"
        val reading = BlinkTrace.parse(text)
        assertEquals(1, reading.longTasks)
        assertEquals(92.0, reading.longestTaskMs, 1e-9)
        assertEquals(27.0, reading.longestTaskCpuMs!!, 1e-9)
        assertTrue(reading.describe(), reading.describe().contains("long tasks 1 (longest 92 ms, 27 on the CPU)"))
        assertTrue(reading.toJson(), reading.toJson().contains("\"longestTaskMs\":92,\"longestTaskCpuMs\":27,"))
        // The captured scene ran its long task on the CPU throughout: 79.99 of its 80 ms.
        assertEquals(79.993, scene.longestTaskCpuMs!!, 1e-9)
        // Without thread times in the trace: nothing claimed, the key absent.
        val bare = BlinkTrace.parse("[" + listOf(event(7, 1_000, "X", BlinkTrace.FRAME, 8_000), event(7, 20_000, "X", "RunTask", 92_000)).joinToString(",") + "]")
        assertEquals(1, bare.longTasks)
        assertNull(bare.longestTaskCpuMs)
        assertFalse(bare.toJson(), bare.toJson().contains("longestTaskCpuMs"))
        assertTrue(bare.describe(), bare.describe().contains("long tasks 1 (longest 92 ms), busy"))
    }

    @Test
    fun `a trace with frames as instants alone counts them, with no main-thread time`() {
        val text = "[" + listOf(
            event(3, 100, "I", BlinkTrace.FRAME_INSTANT),
            event(3, 200, "I", BlinkTrace.FRAME_INSTANT),
            event(3, 300, "i", BlinkTrace.FRAME_INSTANT),
            event(3, 150, "X", BlinkTrace.LAYOUT, 20),
            event(3, 250, "X", BlinkTrace.PAINT, 20)
        ).joinToString(",") + "]"
        val reading = BlinkTrace.parse(text)
        assertTrue(reading.found)
        assertEquals(3, reading.frames)
        assertNull(reading.frameMs)
        assertEquals(1.0 / 3, reading.perFrame(reading.layoutCount), 1e-9)
        assertEquals(1.0 / 3, reading.perFrame(reading.paintCount), 1e-9)
        assertTrue(reading.toJson().contains("\"mainThreadMs\":null"))
    }

    @Test
    fun `a trace without a renderer main thread - no name, no frame - is not found, and counts nothing`() {
        val text = """{"traceEvents":[${event(9, 1_100, "X", "ProxyImpl::ScheduledActionDraw", 400)},${event(9, 1_600, "X", BlinkTrace.LAYOUT, 100)}]}"""
        val reading = BlinkTrace.parse(text)
        assertFalse(reading.found)
        assertNull(reading.thread)
        assertEquals(0, reading.frames)
        assertEquals(0, reading.layoutCount)
        assertEquals(1, reading.threads)
        assertEquals(0.5, reading.windowMs, 1e-9)
        assertTrue(reading.toJson().startsWith("{\"found\":false,\"thread\":null,\"frames\":0,\"mainThreadMs\":null"))
        assertEquals("trace: no renderer main thread in the trace (0 events, 1 threads)", reading.describe())
    }

    @Test
    fun `a named main thread without frames is still the thread read - its layouts count, per one frame`() {
        val text = "[" + listOf(
            event(5, 1_000, "X", BlinkTrace.LAYOUT, 300),
            event(5, 2_000, "X", BlinkTrace.LAYOUT, 300),
            """{"pid":1,"tid":5,"ts":0,"ph":"M","cat":"__metadata","name":"thread_name","args":{"name":"CrRendererMain"}}"""
        ).joinToString(",") + "]"
        val reading = BlinkTrace.parse(text)
        assertTrue(reading.found)
        assertEquals(0, reading.frames)
        assertEquals(2, reading.layoutCount)
        assertEquals(2.0, reading.perFrame(reading.layoutCount), 1e-9)
    }

    @Test
    fun `a truncated trace never throws - what was read before the cut stands, the frames find the thread without its name`() {
        val cut = fixture.substring(0, (fixture.length * 0.6).toInt())
        val reading = BlinkTrace.parse(cut, window)
        assertTrue(reading.found)
        assertEquals("4242:4242", reading.thread) // the thread_name metadata is past the cut: found by its frames
        assertTrue("frames ${reading.frames}", reading.frames in 1..20)
        assertFalse(reading.whole)
        // Cut inside a string, inside a number, right after a comma: all read as far as they go.
        for (at in listOf(35, 120, 187, 2_000, 15_001)) {
            val partial = BlinkTrace.parse(fixture.substring(0, at))
            assertTrue("cut at $at", partial.frames <= 21)
        }
    }

    @Test
    fun `an empty text, a text that is no JSON, an object without traceEvents, an empty array - all read as nothing`() {
        for (text in listOf("", "   ", "garbage", "{\"metadata\":{\"x\":1}}", "[]", "{\"traceEvents\":[]}", "{\"traceEvents\":[1,\"two\",null,[3]]}")) {
            val reading = BlinkTrace.parse(text, window)
            assertFalse(text, reading.found)
            assertEquals(text, 0, reading.frames)
            assertEquals(text, 0, reading.threads)
        }
    }

    @Test
    fun `escapes in strings, floats and exponents in numbers, events short of a tid or a ts are read past`() {
        val text = """{"displayTimeUnit":"ms","traceEvents":[
            {"pid":1,"tid":2,"ts":1.5e3,"ph":"X","cat":"cc","name":"ProxyMain::BeginMainFrame","dur":2500.25,"args":"__stripped__"},
            {"pid":1,"tid":2,"ts":2000,"ph":"X","cat":"blink","name":"Layout","dur":100,"args":{"text":"a \"quoted\" \\ \u00e9 \n tab\t/"}},
            {"pid":1,"ts":2100,"ph":"X","cat":"blink","name":"Layout","dur":100},
            {"pid":1,"tid":2,"ph":"X","cat":"blink","name":"Paint","dur":100},
            {"pid":1,"tid":2,"ts":0,"ph":"M","cat":"__metadata","name":"thread_name","args":{"name":"CrRendererMain"}}
        ],"metadata":{"clock-domain":"LINUX_CLOCK_MONOTONIC","nested":{"deep":[1,2,{"x":null}]}}}"""
        val reading = BlinkTrace.parse(text)
        assertTrue(reading.found)
        assertEquals(1, reading.frames)
        assertEquals(2.50025, reading.frameMs!!.maxMs, 1e-9)
        assertEquals(1, reading.layoutCount)
        assertEquals(0, reading.paintCount)
        assertEquals(2, reading.events)
    }

    // --- the reading's words ---------------------------------------------------------------------

    @Test
    fun `the JSON object has its keys in a fixed order and its numbers with their decimals, and parses back`() {
        val json = scene.toJson()
        assertEquals(
            "{\"found\":true,\"thread\":\"4242:4242\",\"frames\":20,\"mainThreadMs\":{\"mean\":8.34,\"max\":30,\"p95\":18}," +
                "\"busyMs\":252.8,\"busyPerFrameMs\":12.64,\"scriptMs\":71,\"workMs\":{\"script\":71,\"styleRecalc\":10,\"layout\":16.5,\"paint\":2.5,\"compile\":0}," +
                "\"layoutCount\":11,\"paintCount\":5,\"styleRecalcCount\":20," +
                "\"layerChurn\":15,\"longTasks\":1,\"longestTaskMs\":80,\"longestTaskCpuMs\":79.99,\"perFrame\":{\"layout\":0.55,\"paint\":0.25,\"styleRecalc\":1,\"layerChurn\":0.75}," +
                "\"events\":116,\"threads\":6,\"windowMs\":1000,\"whole\":false}",
            json
        )
        val o = JSONObject(json)
        assertEquals(18.0, o.getJSONObject("mainThreadMs").getDouble("p95"), 1e-9)
        assertEquals(0.55, o.getJSONObject("perFrame").getDouble("layout"), 1e-9)
        assertEquals(16.5, o.getJSONObject("workMs").getDouble("layout"), 1e-9)
    }

    @Test
    fun `describe reads as one line for the scene's table`() {
        assertEquals(
            "trace: 20 main-thread frames in 1000 ms; main-thread ms/frame mean 8.3 max 30.0 p95 18.0; " +
                "per frame: layouts 0.55 (11), paints 0.25 (5), style recalcs 1.00 (20), layer updates 0.8 (15); " +
                "long tasks 1 (longest 80 ms, 80 on the CPU), busy 253 ms: script 71, style 10, layout 17, paint 3 ms",
            scene.describe()
        )
        assertTrue(whole.describe(), whole.describe().startsWith("trace: 21 main-thread frames in 1200 ms (whole trace); "))
    }

    @Test
    fun `Stat is the mean, the max and the nearest-rank 95th percentile - empty is null`() {
        assertNull(BlinkTrace.Stat.of(emptyList()))
        assertEquals(BlinkTrace.Stat(5.0, 5.0, 5.0), BlinkTrace.Stat.of(listOf(5.0)))
        val twenty = BlinkTrace.Stat.of((1..20).map { it.toDouble() })!!
        assertEquals(10.5, twenty.meanMs, 1e-9)
        assertEquals(20.0, twenty.maxMs, 1e-9)
        assertEquals(19.0, twenty.p95Ms, 1e-9)
        assertEquals(95.0, BlinkTrace.Stat.of((100 downTo 1).map { it.toDouble() })!!.p95Ms, 1e-9)
    }

    @Test
    fun `the categories recorded are Blink's, the compositor's and the DevTools timeline's - the long task is the API's 50 ms`() {
        assertTrue(BlinkTrace.CATEGORIES.containsAll(listOf("blink", "cc", "v8", "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame")))
        assertEquals(50_000.0, BlinkTrace.LONG_TASK_US, 0.0)
        assertEquals("CrRendererMain", BlinkTrace.MAIN_THREAD)
    }
}
