package app.zen.chromium

import java.io.BufferedReader
import java.io.Reader
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max

/**
 * The chrome WebView's own Chromium trace (`android.webkit.TracingController`, Trace Event JSON)
 * read into the renderer MAIN THREAD's work over a scene: what `dumpsys gfxinfo` cannot see. HWUI's
 * stages are the Android UI thread's and the render thread's; Blink's style recalculation, layout,
 * paint and script – where a stutter of the chrome is made – run on the WebView renderer's main
 * thread (`CrRendererMain`), and on the emulator's software GPU they are the numbers the recipe does
 * NOT dominate. Plain Kotlin (`src/sharedTest`): the harness's `traceFrames` (DemoHarness.kt)
 * parses the scene's trace on the device with it, `BlinkTraceTest` feeds it a captured trace on the
 * JVM, and a driver that traces a whole run itself (PERF-1's and PERF-2's profiles) cuts its scenes
 * out of that trace with [parse] and a [Window] instead of a parser of its own.
 *
 * The trace is `{"traceEvents":[...],"metadata":{...}}` (or a bare array), one event per object:
 * `ph` (the phase), `name`, `cat`, `ts` (µs, `CLOCK_MONOTONIC`, absolute), `dur` (µs, for `X`),
 * `pid`, `tid`, `args` (WebView's tracing strips them to the string `"__stripped__"`, except the
 * metadata's: `{"name":"CrRendererMain"}` on a `thread_name` event). It is read as a stream, event
 * by event, so a long scene costs memory for its main-thread slices alone, never for the JSON.
 *
 * What is counted, on the renderer main thread with the most frames (WebView runs ONE renderer per
 * app, so the chrome's and the page's WebViews share that thread: the numbers are the process's
 * main-thread work during the scene, the page's included – the same for the baseline and the fix):
 *
 *  - a FRAME is `ProxyMain::BeginMainFrame` (an `X` slice: the main thread's part of one frame –
 *    the animation callbacks, style, layout, pre-paint, paint and the commit); its duration is the
 *    frame's MAIN-THREAD TIME, reported as mean, max and 95th percentile over the scene's frames
 *    ([Reading.frameMs]). The `BeginMainThreadFrame` instants stand in for the count when a
 *    trace has the instants without the slices;
 *  - `Layout`, `Paint`, `UpdateLayoutTree` (a style recalculation): the DevTools timeline's events,
 *    counted over the scene and given per frame ([Reading.perFrame]); a scroll or a spring that
 *    moves a promoted layer by `transform` / `opacity` alone lays out and paints nothing per frame;
 *  - `UpdateLayer` ([Reading.layerChurn]): the composited content layers cc visits – and re-records
 *    where invalidated – in each commit; it rises with the layer count and with the frames that
 *    commit at all (a compositor-driven animation commits nothing). Reported, not budgeted;
 *  - LONG TASKS: top-level slices (nothing on the thread encloses them) longer than
 *    [LONG_TASK_US]: the 50 ms of the Long Tasks API; [Reading.busyMs] is the top-level slices'
 *    total, the thread's busy time in the window, and [Reading.scriptMs] the `FunctionCall` and
 *    `EvaluateScript` slices' total.
 *
 * The [Window] cuts the trace to the scene (the block's `System.nanoTime()` bounds, in µs: the
 * same clock as `ts`); an event belongs to the window its `ts` falls in. When the window holds no
 * main-thread event while the trace has some (a clock the trace does not share, a driver that
 * passed the wrong bounds), the WHOLE trace is read instead and [Reading.whole] says so.
 */
object BlinkTrace {
    /** The renderer main thread's name in the trace's metadata. */
    const val MAIN_THREAD = "CrRendererMain"
    const val FRAME = "ProxyMain::BeginMainFrame"
    const val FRAME_INSTANT = "BeginMainThreadFrame"
    const val LAYOUT = "Layout"
    const val PAINT = "Paint"
    const val STYLE_RECALC = "UpdateLayoutTree"
    const val LAYER_UPDATE = "UpdateLayer"
    val SCRIPT: Set<String> = setOf("FunctionCall", "EvaluateScript")
    /** A top-level slice this long is a long task (the Long Tasks API's 50 ms). */
    const val LONG_TASK_US = 50_000.0

    /**
     * The categories a scene's trace records – the same set PERF-1's and PERF-2's profiles record,
     * so one trace serves every reader: `blink` (style, layout, paint), `cc` (the compositor's
     * frames), `v8` (script and GC), `renderer.scheduler`, `input`, the DevTools timeline (which
     * names `Layout` / `Paint` / `UpdateLayoutTree` / `FunctionCall` as the Performance panel
     * does; its disabled-by-default part carries `RunTask` and `UpdateLayer`), and
     * `blink.user_timing`, whose events are `performance.mark()` calls by name.
     */
    val CATEGORIES: List<String> = listOf(
        "blink",
        "blink.user_timing",
        "cc",
        "v8",
        "renderer.scheduler",
        "input",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame"
    )

    /** A stretch of the trace's clock, µs (`CLOCK_MONOTONIC`, as `System.nanoTime() / 1000`). */
    data class Window(val fromUs: Long, val toUs: Long) {
        val lengthMs: Double get() = (toUs - fromUs) / 1e3
        fun holds(ts: Double): Boolean = ts >= fromUs && ts <= toUs
    }

    /** Mean, max and 95th percentile (nearest rank) of a set of durations, ms. */
    data class Stat(val meanMs: Double, val maxMs: Double, val p95Ms: Double) {
        companion object {
            fun of(valuesMs: List<Double>): Stat? {
                if (valuesMs.isEmpty()) return null
                val sorted = valuesMs.sorted()
                val rank = max(1, ceil(0.95 * sorted.size).toInt())
                return Stat(sorted.average(), sorted.last(), sorted[rank - 1])
            }
        }
    }

    /** The renderer main thread's work in the window: what `traceFrames` records under `trace`. */
    data class Reading(
        /** The thread was found (named `CrRendererMain`, or carrying frames); the counts are zero without it. */
        val found: Boolean,
        /** `pid:tid` of the thread read; null when none was found. */
        val thread: String?,
        /** Main-thread frames in the window (`ProxyMain::BeginMainFrame`). */
        val frames: Int,
        /** Main-thread time per frame, ms; null when the trace had the frames as instants alone, or no frame. */
        val frameMs: Stat?,
        /** The thread's busy time in the window: the top-level slices' total, ms. */
        val busyMs: Double,
        /** `FunctionCall` and `EvaluateScript` slices' total, ms. */
        val scriptMs: Double,
        val layoutCount: Int,
        val paintCount: Int,
        val styleRecalcCount: Int,
        /** `UpdateLayer` slices: layers visited by the commits. */
        val layerChurn: Int,
        /** Top-level slices longer than [LONG_TASK_US]. */
        val longTasks: Int,
        /** The longest top-level slice, ms. */
        val longestTaskMs: Double,
        /** Events read on the thread in the window (slices, pairs and instants). */
        val events: Int,
        /** Threads the trace named or carried events for. */
        val threads: Int,
        /** The window's length, ms – the trace's own span when the whole trace was read. */
        val windowMs: Double,
        /** The whole trace was read: no window was given, or the window held no main-thread event. */
        val whole: Boolean
    ) {
        /** `count` per frame – per one frame when the trace saw none, so a count without frames still reads. */
        fun perFrame(count: Int): Double = count.toDouble() / max(frames, 1)

        /** [busyMs] per frame, the same way. */
        val busyPerFrameMs: Double get() = busyMs / max(frames, 1)

        /** The reading as the `trace` object of a `frames.jsonl` line (keys in a fixed order). */
        fun toJson(): String {
            val sb = StringBuilder("{")
            sb.append("\"found\":").append(found)
            sb.append(",\"thread\":").append(thread?.let { FrameStats.quote(it) } ?: "null")
            sb.append(",\"frames\":").append(frames)
            sb.append(",\"mainThreadMs\":")
            if (frameMs == null) {
                sb.append("null")
            } else {
                sb.append("{\"mean\":").append(FrameStats.number(frameMs.meanMs, 2))
                    .append(",\"max\":").append(FrameStats.number(frameMs.maxMs, 2))
                    .append(",\"p95\":").append(FrameStats.number(frameMs.p95Ms, 2)).append("}")
            }
            sb.append(",\"busyMs\":").append(FrameStats.number(busyMs, 2))
            sb.append(",\"busyPerFrameMs\":").append(FrameStats.number(busyPerFrameMs, 2))
            sb.append(",\"scriptMs\":").append(FrameStats.number(scriptMs, 2))
            sb.append(",\"layoutCount\":").append(layoutCount)
            sb.append(",\"paintCount\":").append(paintCount)
            sb.append(",\"styleRecalcCount\":").append(styleRecalcCount)
            sb.append(",\"layerChurn\":").append(layerChurn)
            sb.append(",\"longTasks\":").append(longTasks)
            sb.append(",\"longestTaskMs\":").append(FrameStats.number(longestTaskMs, 2))
            sb.append(",\"perFrame\":{\"layout\":").append(FrameStats.number(perFrame(layoutCount), 3))
                .append(",\"paint\":").append(FrameStats.number(perFrame(paintCount), 3))
                .append(",\"styleRecalc\":").append(FrameStats.number(perFrame(styleRecalcCount), 3))
                .append(",\"layerChurn\":").append(FrameStats.number(perFrame(layerChurn), 3)).append("}")
            sb.append(",\"events\":").append(events)
            sb.append(",\"threads\":").append(threads)
            sb.append(",\"windowMs\":").append(FrameStats.number(windowMs, 1))
            sb.append(",\"whole\":").append(whole)
            return sb.append("}").toString()
        }

        /** The reading for a human, one line (what the scene's table carries). */
        fun describe(): String {
            if (!found) return "trace: no renderer main thread in the trace ($events events, $threads threads)"
            val f1 = { v: Double -> String.format(Locale.ROOT, "%.1f", v) }
            val f2 = { v: Double -> String.format(Locale.ROOT, "%.2f", v) }
            val f0 = { v: Double -> String.format(Locale.ROOT, "%.0f", v) }
            val sb = StringBuilder()
            sb.append("trace: ").append(frames).append(" main-thread frames in ").append(f0(windowMs)).append(" ms")
            if (whole) sb.append(" (whole trace)")
            if (frameMs != null) {
                sb.append("; main-thread ms/frame mean ").append(f1(frameMs.meanMs)).append(" max ").append(f1(frameMs.maxMs)).append(" p95 ").append(f1(frameMs.p95Ms))
            }
            sb.append("; per frame: layouts ").append(f2(perFrame(layoutCount))).append(" (").append(layoutCount).append(")")
                .append(", paints ").append(f2(perFrame(paintCount))).append(" (").append(paintCount).append(")")
                .append(", style recalcs ").append(f2(perFrame(styleRecalcCount))).append(" (").append(styleRecalcCount).append(")")
                .append(", layer updates ").append(f1(perFrame(layerChurn))).append(" (").append(layerChurn).append(")")
            sb.append("; long tasks ").append(longTasks).append(" (longest ").append(f0(longestTaskMs)).append(" ms)")
                .append(", busy ").append(f0(busyMs)).append(" ms, script ").append(f0(scriptMs)).append(" ms")
            return sb.toString()
        }
    }

    // --- reading ---------------------------------------------------------------------------------

    /**
     * Read a trace, the renderer main thread's work inside `window` (the whole trace with null).
     * `open` gives a fresh reader of the text; it is called a second time when the window holds
     * none of the thread's events while the trace has some, to read the whole trace instead.
     * Never throws on odd JSON: what was read before the text went wrong is what counts.
     */
    fun parse(open: () -> Reader, window: Window? = null): Reading {
        val first = open().use { read(it, window) }
        if (window != null && first.reading.events == 0 && first.everything > 0) {
            return open().use { read(it, null) }.reading
        }
        return first.reading
    }

    /** The same on a string. */
    fun parse(text: String, window: Window? = null): Reading = parse({ text.reader() }, window)

    private data class Slice(val ts: Double, val dur: Double)

    private class ThreadAcc {
        var name: String? = null
        var events = 0
        var everything = 0
        var frameInstants = 0
        val frameMs = ArrayList<Double>()
        var layout = 0
        var paint = 0
        var styleRecalc = 0
        var layerUpdates = 0
        var scriptUs = 0.0
        val slices = ArrayList<Slice>()
        val open = ArrayList<Pair<String, Double>>()
        var minTs = Double.MAX_VALUE
        var maxTs = -Double.MAX_VALUE

        fun slice(name: String, ts: Double, durUs: Double) {
            slices += Slice(ts, durUs)
            when (name) {
                FRAME -> frameMs += durUs / 1e3
                LAYOUT -> layout++
                PAINT -> paint++
                STYLE_RECALC -> styleRecalc++
                LAYER_UPDATE -> layerUpdates++
                in SCRIPT -> scriptUs += durUs
            }
        }

        fun span(ts: Double) {
            if (ts < minTs) minTs = ts
            if (ts > maxTs) maxTs = ts
        }
    }

    /** One pass' result: the reading, and how many events the thread read (or every thread, when none was found) had in the whole trace. */
    private class Pass(val reading: Reading, val everything: Int)

    private fun read(reader: Reader, window: Window?): Pass {
        val threads = LinkedHashMap<Long, ThreadAcc>()
        var everything = 0
        val json = Json(reader as? BufferedReader ?: BufferedReader(reader, 1 shl 16))
        try {
            json.events { event ->
                val ph = event["ph"] as? String ?: return@events
                val pid = (event["pid"] as? Number)?.toLong() ?: return@events
                val tid = (event["tid"] as? Number)?.toLong() ?: return@events
                val key = (pid shl 32) or (tid and 0xffffffffL)
                val thread = threads.getOrPut(key) { ThreadAcc() }
                if (ph == "M") {
                    if (event["name"] == "thread_name") thread.name = (event["args"] as? Map<*, *>)?.get("name") as? String
                    return@events
                }
                val ts = (event["ts"] as? Number)?.toDouble() ?: return@events
                val name = event["name"] as? String ?: ""
                thread.everything++
                everything++
                thread.span(ts)
                if (window != null && !window.holds(ts)) return@events
                when (ph) {
                    "X" -> {
                        thread.events++
                        thread.slice(name, ts, (event["dur"] as? Number)?.toDouble() ?: 0.0)
                    }
                    "B" -> {
                        thread.events++
                        thread.open += name to ts
                    }
                    "E" -> {
                        thread.events++
                        val begun = thread.open.removeLastOrNull() ?: return@events
                        thread.slice(begun.first, begun.second, ts - begun.second)
                    }
                    "I", "i", "R", "n" -> {
                        thread.events++
                        if (name == FRAME_INSTANT) thread.frameInstants++
                    }
                }
            }
        } catch (e: RuntimeException) {
            // Odd JSON (a truncated write, a stray character): what was read before it stands.
        }
        val main = threads.entries
            .filter { it.value.name == MAIN_THREAD }
            .ifEmpty { threads.entries.filter { it.value.frameMs.isNotEmpty() || it.value.frameInstants > 0 } }
            .maxWithOrNull(compareBy<Map.Entry<Long, ThreadAcc>> { it.value.frameMs.size }.thenBy { it.value.frameInstants }.thenBy { it.value.events })
        val spanned = threads.values.filter { it.maxTs >= it.minTs }
        val traceFrom = spanned.minOfOrNull { it.minTs }
        val traceTo = spanned.maxOfOrNull { it.maxTs }
        val windowMs = window?.lengthMs ?: if (traceFrom != null && traceTo != null) (traceTo - traceFrom) / 1e3 else 0.0
        if (main == null) {
            return Pass(Reading(false, null, 0, null, 0.0, 0.0, 0, 0, 0, 0, 0, 0.0, 0, threads.size, windowMs, window == null), everything)
        }
        val t = main.value
        val sorted = t.slices.sortedWith(compareBy<Slice> { it.ts }.thenByDescending { it.dur })
        var end = -Double.MAX_VALUE
        var busyUs = 0.0
        var longTasks = 0
        var longestUs = 0.0
        for (slice in sorted) {
            if (slice.ts < end) continue
            end = slice.ts + slice.dur
            busyUs += slice.dur
            if (slice.dur > LONG_TASK_US) longTasks++
            if (slice.dur > longestUs) longestUs = slice.dur
        }
        val frames = if (t.frameMs.isNotEmpty()) t.frameMs.size else t.frameInstants
        return Pass(
            Reading(
                found = true,
                thread = "${main.key ushr 32}:${main.key and 0xffffffffL}",
                frames = frames,
                frameMs = Stat.of(t.frameMs),
                busyMs = busyUs / 1e3,
                scriptMs = t.scriptUs / 1e3,
                layoutCount = t.layout,
                paintCount = t.paint,
                styleRecalcCount = t.styleRecalc,
                layerChurn = t.layerUpdates,
                longTasks = longTasks,
                longestTaskMs = longestUs / 1e3,
                events = t.events,
                threads = threads.size,
                windowMs = windowMs,
                whole = window == null
            ),
            t.everything
        )
    }

    // --- a small JSON reader ----------------------------------------------------------------------
    //
    // Enough JSON for a trace: objects, arrays, strings with escapes, numbers, the literals. The
    // events are handed out one at a time from the `traceEvents` array (or a bare top-level array),
    // so the text is walked once and only the event in hand is a Map.

    private class Json(private val reader: Reader) {
        private var peeked = NONE

        /** Call `handle` with every event object of the trace. */
        fun events(handle: (Map<String, Any?>) -> Unit) {
            skipWs()
            when (peek()) {
                '['.code -> array(handle)
                '{'.code -> {
                    next()
                    skipWs()
                    if (peek() == '}'.code) return
                    while (true) {
                        val key = string()
                        expect(':')
                        skipWs()
                        if (key == "traceEvents" && peek() == '['.code) array(handle) else value()
                        skipWs()
                        when (next()) {
                            ','.code -> skipWs()
                            '}'.code -> return
                            else -> throw IllegalStateException("object")
                        }
                    }
                }
                else -> throw IllegalStateException("trace")
            }
        }

        private fun array(handle: (Map<String, Any?>) -> Unit) {
            expect('[')
            skipWs()
            if (peek() == ']'.code) {
                next()
                return
            }
            while (true) {
                val element = value()
                @Suppress("UNCHECKED_CAST")
                if (element is Map<*, *>) handle(element as Map<String, Any?>)
                skipWs()
                when (next()) {
                    ','.code -> continue
                    ']'.code -> return
                    else -> throw IllegalStateException("array")
                }
            }
        }

        private fun value(): Any? {
            skipWs()
            return when (val c = peek()) {
                '{'.code -> obj()
                '['.code -> list()
                '"'.code -> string()
                't'.code -> literal("true", true)
                'f'.code -> literal("false", false)
                'n'.code -> literal("null", null)
                else -> if (c == '-'.code || c in '0'.code..'9'.code) number() else throw IllegalStateException("value")
            }
        }

        private fun obj(): Map<String, Any?> {
            expect('{')
            val map = LinkedHashMap<String, Any?>()
            skipWs()
            if (peek() == '}'.code) {
                next()
                return map
            }
            while (true) {
                val key = string()
                expect(':')
                map[key] = value()
                skipWs()
                when (next()) {
                    ','.code -> continue
                    '}'.code -> return map
                    else -> throw IllegalStateException("object")
                }
            }
        }

        private fun list(): List<Any?> {
            expect('[')
            val list = ArrayList<Any?>()
            skipWs()
            if (peek() == ']'.code) {
                next()
                return list
            }
            while (true) {
                list += value()
                skipWs()
                when (next()) {
                    ','.code -> continue
                    ']'.code -> return list
                    else -> throw IllegalStateException("array")
                }
            }
        }

        private fun string(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                when (val c = next()) {
                    '"'.code -> return sb.toString()
                    '\\'.code -> when (val e = next()) {
                        '"'.code -> sb.append('"')
                        '\\'.code -> sb.append('\\')
                        '/'.code -> sb.append('/')
                        'b'.code -> sb.append('\b')
                        'f'.code -> sb.append('\u000c')
                        'n'.code -> sb.append('\n')
                        'r'.code -> sb.append('\r')
                        't'.code -> sb.append('\t')
                        'u'.code -> {
                            var code = 0
                            repeat(4) { code = code * 16 + Character.digit(next(), 16).also { d -> if (d < 0) throw IllegalStateException("escape") } }
                            sb.append(code.toChar())
                        }
                        else -> throw IllegalStateException("escape $e")
                    }
                    else -> sb.append(c.toChar())
                }
            }
        }

        private fun number(): Number {
            val sb = StringBuilder()
            var floating = false
            while (true) {
                val c = peek()
                if (c in '0'.code..'9'.code || c == '-'.code) {
                    sb.append(c.toChar())
                } else if (c == '.'.code || c == 'e'.code || c == 'E'.code || c == '+'.code) {
                    floating = true
                    sb.append(c.toChar())
                } else {
                    break
                }
                next()
            }
            val token = sb.toString()
            return if (floating) token.toDouble() else token.toLongOrNull() ?: token.toDouble()
        }

        private fun literal(word: String, value: Any?): Any? {
            for (ch in word) if (next() != ch.code) throw IllegalStateException("literal")
            return value
        }

        private fun peek(): Int {
            if (peeked == NONE) peeked = reader.read()
            if (peeked < 0) throw IllegalStateException("end")
            return peeked
        }

        private fun next(): Int {
            val c = peek()
            peeked = NONE
            return c
        }

        private fun expect(c: Char) {
            skipWs()
            if (next() != c.code) throw IllegalStateException("expected $c")
        }

        private fun skipWs() {
            while (true) {
                if (peeked == NONE) peeked = reader.read()
                if (peeked == ' '.code || peeked == '\n'.code || peeked == '\r'.code || peeked == '\t'.code) peeked = NONE else return
            }
        }

        companion object {
            private const val NONE = -2
        }
    }
}
