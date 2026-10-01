package app.zen.chromium

import java.util.Locale

/**
 * The frame arithmetic behind the sleeping-tab wake profile (TabWakePerfDemo): the window's
 * frames as `Window.OnFrameMetricsAvailableListener` reports them, cut to a scene's window,
 * summarised (percentiles, the frames over one and over two vsyncs, the longest), and judged
 * against the warm control on the same run. Free of Android so it runs on the JVM
 * (`WakeFramesTest`); compiled into the unit tests and the instrumentation alike
 * (`src/sharedTest`), never into the app.
 *
 * THREE READINGS of every frame. `totalMs` is HWUI's whole frame (`TOTAL_DURATION`: from the vsync
 * to the swap's end), which on the recipe's software GPU (`-gpu swangle`) is 100 ms and more for
 * every frame whatever the chrome does – the composite of a 720x1600 frame on the CPU. `uiMs` is
 * the UI thread's part of it: the delay before the frame began (`UNKNOWN_DELAY`: the vsync waited
 * while the main thread was busy with something else – a WebView's construction, a
 * `restoreState`, a bitmap's capture), the input handling, the animation callbacks, the measure
 * and layout, and the draw (the display list's recording). `ownMs` is `uiMs` without the
 * animation stage: inside that stage the chrome's WebView waits for the renderer's compositor to
 * answer its frame (the synchronous compositor's handshake), so with the one renderer every page
 * shares, a loading page's tiles stretch it for the chrome – a wait, not the host's work. The
 * host's own work on the UI thread – what a WebView built or a history restored inside the morph
 * moves, and what carries over to a phone – is `ownMs`, so that is the reading the bar is read on
 * when the recipe cannot hold 60 fps on the whole frame even for the warm control; the other two
 * are reported beside it.
 */
object WakeFrames {
    /** One vsync's budget at 60 Hz, in ms. */
    const val FRAME_MS = 16.7

    /** A frame twice the budget: the hitch a user sees. */
    const val HITCH_MS = 32.0

    /**
     * One frame of the app's window, in ms, as `FrameMetrics` reported it. `vsyncNs` is the
     * frame's `VSYNC_TIMESTAMP` (`CLOCK_MONOTONIC`, the clock of `System.nanoTime()`), the key a
     * scene's window is cut on. `gpuMs` is -1 where the metric does not exist (before API 31).
     */
    data class Frame(
        val vsyncNs: Long,
        val totalMs: Double,
        val delayMs: Double,
        val inputMs: Double,
        val animationMs: Double,
        val layoutMs: Double,
        val drawMs: Double,
        val syncMs: Double,
        val commandsMs: Double,
        val swapMs: Double,
        val gpuMs: Double = -1.0,
        val firstDraw: Boolean = false
    ) {
        /** The UI thread's part of the frame: the delay before it began plus input, animation, layout and draw. */
        val uiMs: Double get() = delayMs + inputMs + animationMs + layoutMs + drawMs

        /** The UI thread's own work in the frame: [uiMs] without the animation stage (the WebView's wait on the renderer). */
        val ownMs: Double get() = delayMs + inputMs + layoutMs + drawMs

        /** The stage that took longest, by name (the `stageMs` keys). */
        fun longestStage(): String = stages().maxByOrNull { it.value }?.key ?: "delay"

        fun stages(): Map<String, Double> = linkedMapOf(
            "delay" to delayMs,
            "input" to inputMs,
            "animation" to animationMs,
            "layout" to layoutMs,
            "draw" to drawMs,
            "sync" to syncMs,
            "commands" to commandsMs,
            "swap" to swapMs
        )
    }

    /** The frames of one window summarised: counts, percentiles (nearest rank), the longest frame. */
    data class Summary(
        val frames: Int,
        val p50: Double,
        val p95: Double,
        val p99: Double,
        val longest: Double,
        val mean: Double,
        val over16: Int,
        val over32: Int
    ) {
        /** The share of frames over two vsyncs, 0..1 (0 with no frame). */
        val over32Share: Double get() = if (frames == 0) 0.0 else over32.toDouble() / frames

        fun line(): String = String.format(
            Locale.ROOT,
            "%d frames; p50 %.1f, p95 %.1f, p99 %.1f, longest %.1f ms; mean %.1f; >16.7 ms: %d, >32 ms: %d",
            frames, p50, p95, p99, longest, mean, over16, over32
        )

        companion object {
            val EMPTY = Summary(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0)
        }
    }

    /** The frames whose vsync falls inside `[fromNs, toNs]`, in order. */
    fun window(frames: List<Frame>, fromNs: Long, toNs: Long): List<Frame> =
        frames.filter { it.vsyncNs in fromNs..toNs }.sortedBy { it.vsyncNs }

    /** Nearest-rank percentile of `values` (any order); 0 with none. */
    fun percentile(values: List<Double>, p: Double): Double {
        if (values.isEmpty()) return 0.0
        val sorted = values.sorted()
        val rank = Math.ceil(p / 100.0 * sorted.size).toInt().coerceIn(1, sorted.size)
        return sorted[rank - 1]
    }

    fun summarize(values: List<Double>): Summary {
        if (values.isEmpty()) return Summary.EMPTY
        return Summary(
            frames = values.size,
            p50 = percentile(values, 50.0),
            p95 = percentile(values, 95.0),
            p99 = percentile(values, 99.0),
            longest = values.max(),
            mean = values.sum() / values.size,
            over16 = values.count { it > FRAME_MS },
            over32 = values.count { it > HITCH_MS }
        )
    }

    /** The stage most often the longest among the frames over one vsync (by `uiMs`); null with none. */
    fun dominantStage(frames: List<Frame>): String? {
        val long = frames.filter { it.uiMs > FRAME_MS }
        if (long.isEmpty()) return null
        return long.groupingBy { it.longestStage() }.eachCount().maxByOrNull { it.value }?.key
    }

    /** Per stage, the mean and the longest over `frames`, in ms. */
    fun stageTotals(frames: List<Frame>): Map<String, Pair<Double, Double>> {
        if (frames.isEmpty()) return emptyMap()
        val keys = frames.first().stages().keys
        return keys.associateWith { key ->
            val values = frames.map { it.stages()[key] ?: 0.0 }
            (values.sum() / values.size) to values.max()
        }
    }

    /**
     * How a sleeping scene's frames are read against its warm control. ABSOLUTE is the program's
     * bar (p95 at or under one vsync, no frame over two): it applies, and is asserted, where the
     * control itself holds it on the lane – a device. Where even the warm control cannot hold it
     * (the emulator's software GPU: HWUI's whole frames run 100 ms and more for anything, and the
     * UI thread's own `delay` 150–480 ms a frame is the host GL pipe's backpressure), no
     * frame-time comparison is a claim: every one is a FACT line – the window's p95, longest and
     * share of frames over two vsyncs, each with its ratio against [Fact.denominator], the greater
     * of the control's longest frame and the run's p95 over every frame it recorded (the lane's
     * stall size, not one sample of it) – printed, never asserted. The reason is in the record:
     * the lane's longest frame in any state is one GL-pipe stall drawn from the same distribution
     * (the warm control's own longest switch frame was 554, 339 and 294 ms on three runs), so a
     * ratio rule over two single frames failed one run in three on the host GL pipe and taught
     * nothing. The deterministic claims (`create`, the spare's lifecycle, its memory) assert on
     * every lane.
     */
    sealed class Bar {
        object Absolute : Bar() {
            override fun toString(): String = "absolute (p95 <= 16.7 ms, no frame > 32 ms)"
        }

        /**
         * The emulator lane's reading: no frame-time claim asserted, every comparison a FACT line
         * against [denominator] = max(`controlLongest`, `runP95`).
         */
        data class Fact(val controlLongest: Double, val runP95: Double) : Bar() {
            val denominator: Double get() = maxOf(controlLongest, runP95)

            override fun toString(): String = String.format(
                Locale.ROOT,
                "FACT, not asserted: the warm control misses 60 fps on this lane; ratios against max(the control's longest %.1f, the run's all-frames p95 %.1f) = %.1f ms",
                controlLongest, runP95, denominator
            )
        }
    }

    /**
     * The bar for a control: absolute where the control holds 60 fps, FACT where the lane cannot.
     * `runP95` is the p95 of the same reading over every frame the run recorded, in every scene
     * and state.
     */
    fun bar(control: Summary, runP95: Double): Bar =
        if (control.frames > 0 && control.p95 <= FRAME_MS && control.longest <= HITCH_MS) Bar.Absolute
        else Bar.Fact(control.longest, runP95)

    /**
     * One claim's result: the `PASS` / `FAIL` line the findings carry and the reasons – or, with
     * `fact`, a `FACT` line that is a reading and not a pass: it never fails a run, and `reasons`
     * holds what it read.
     */
    data class Verdict(val scene: String, val pass: Boolean, val reasons: List<String>, val fact: Boolean = false) {
        /** Whether the line is a claim the run stands or falls on. */
        val asserted: Boolean get() = !fact

        /** A claim that failed – a FACT line never does. */
        val failed: Boolean get() = asserted && !pass

        fun line(): String = "${if (fact) "FACT" else if (pass) "PASS" else "FAIL"} $scene" + if (reasons.isEmpty()) "" else ": ${reasons.joinToString("; ")}"
    }

    /** Judge `sleeping` (a sleeping tab's scene) against `control` (the same gesture on the warm tab) under `bar`. */
    fun judge(scene: String, sleeping: Summary, control: Summary, bar: Bar): Verdict {
        when (bar) {
            is Bar.Absolute -> {
                if (sleeping.frames == 0) return Verdict(scene, false, listOf("no frame was recorded in the window"))
                val reasons = ArrayList<String>()
                if (sleeping.p95 > FRAME_MS) reasons += String.format(Locale.ROOT, "p95 %.1f ms over %.1f", sleeping.p95, FRAME_MS)
                if (sleeping.longest > HITCH_MS) reasons += String.format(Locale.ROOT, "%d frame(s) over %.0f ms (longest %.1f)", sleeping.over32, HITCH_MS, sleeping.longest)
                return Verdict(scene, reasons.isEmpty(), reasons)
            }
            is Bar.Fact -> {
                if (sleeping.frames == 0) return Verdict(scene, true, listOf("no frame was recorded in the window"), fact = true)
                val d = bar.denominator
                val facts = listOf(
                    String.format(Locale.ROOT, "p95 %.1f ms, %sx the denominator %.1f", sleeping.p95, ratio(sleeping.p95, d), d),
                    String.format(Locale.ROOT, "longest %.1f ms, %sx", sleeping.longest, ratio(sleeping.longest, d)),
                    String.format(
                        Locale.ROOT, "%d of %d frames over 32 ms (the control %d of %d, p95 %.1f, longest %.1f)",
                        sleeping.over32, sleeping.frames, control.over32, control.frames, control.p95, control.longest
                    )
                )
                return Verdict(scene, true, facts, fact = true)
            }
        }
    }

    /** A duration read against the warm control's as a FACT line: `shown 2880 ms after the tap, 1.23x the warm control's 2336`; either side unseen is said so. */
    fun factDuration(scene: String, what: String, subjectMs: Double, controlMs: Double): Verdict {
        val subject = if (subjectMs >= 0) String.format(Locale.ROOT, "%s %.0f ms after the tap", what, subjectMs) else "$what not seen"
        val control = when {
            subjectMs < 0 || controlMs < 0 -> if (controlMs >= 0) String.format(Locale.ROOT, "the warm control's %.0f", controlMs) else "the warm control's not seen"
            else -> String.format(Locale.ROOT, "%sx the warm control's %.0f", ratio(subjectMs, controlMs), controlMs)
        }
        return Verdict(scene, true, listOf("$subject, $control"), fact = true)
    }

    /** `a / b` to two places, or `-` with no denominator. */
    fun ratio(a: Double, b: Double): String = if (b > 0) String.format(Locale.ROOT, "%.2f", a / b) else "-"

    /**
     * The spare's lifecycle claim, exercised off the record: a spare stood and was dropped under
     * memory pressure, stood again and was dropped with its renderer. A step that could not be
     * exercised (no spare stood to drop) fails the claim too.
     */
    fun judgeSpareDrop(scene: String, stoodForPressure: Boolean, droppedOnPressure: Boolean, stoodForRenderer: Boolean, droppedWithRenderer: Boolean): Verdict {
        val reasons = ArrayList<String>()
        if (!stoodForPressure) reasons += "no spare stood to drop under memory pressure"
        else if (!droppedOnPressure) reasons += "the spare stood on after memory pressure"
        if (!stoodForRenderer) reasons += "no spare stood to drop with its renderer"
        else if (!droppedWithRenderer) reasons += "the spare stood on after its renderer went"
        return Verdict(scene, reasons.isEmpty(), reasons)
    }

    /** The spare's memory claim: one built, and this process's PSS grew by no more than `capKb`. */
    fun judgeSpareMemory(scene: String, built: Boolean, deltaKb: Long, capKb: Long): Verdict {
        val reasons = ArrayList<String>()
        if (!built) reasons += "no spare was built to measure"
        else if (deltaKb > capKb) reasons += "PSS grew $deltaKb KB, cap $capKb"
        return Verdict(scene, reasons.isEmpty(), reasons)
    }

    /** One wake of a sleeping tab as the host saw it: whether `TabHost.create` took the spare view, and how long it held the UI thread. */
    data class Wake(val tookSpare: Boolean, val createMs: Double)

    /**
     * The construction claim: every wake took the spare view and its `create` held the UI thread
     * no longer than `capMs` – the fifteen-odd milliseconds of a WebView's construction kept out
     * of the morph's frames. No wake at all fails too (the claim was not exercised).
     */
    fun judgeCreate(scene: String, wakes: List<Wake>, capMs: Double): Verdict {
        if (wakes.isEmpty()) return Verdict(scene, false, listOf("no wake was recorded"))
        val reasons = ArrayList<String>()
        val built = wakes.count { !it.tookSpare }
        if (built > 0) reasons += "$built of ${wakes.size} wake(s) built the view inside the morph (no spare stood)"
        val slow = wakes.filter { it.createMs > capMs }
        if (slow.isNotEmpty()) reasons += String.format(Locale.ROOT, "%d create(s) over %.1f ms (longest %.1f)", slow.size, capMs, slow.maxOf { it.createMs })
        return Verdict(scene, reasons.isEmpty(), reasons)
    }

    /** A Markdown table of named summaries (the report's before / after rows). */
    fun table(rows: List<Pair<String, Summary>>): String {
        val sb = StringBuilder()
        sb.append("| window | frames | p50 | p95 | p99 | longest | >16.7 ms | >32 ms |\n")
        sb.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n")
        for ((name, s) in rows) {
            sb.append(
                String.format(
                    Locale.ROOT, "| %s | %d | %.1f | %.1f | %.1f | %.1f | %d | %d |\n",
                    name, s.frames, s.p50, s.p95, s.p99, s.longest, s.over16, s.over32
                )
            )
        }
        return sb.toString()
    }
}
