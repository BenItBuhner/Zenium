package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * The host's side of the bridge's timing, flag-gated (services perf pass 4): for every string
 * the chrome sends, the moment it ARRIVED at the host's route – the first line of the route on
 * the thread that received it, the JavaBridge thread for a hop, `zen-bridge-port` for a string
 * off the asynchronous channel ([BridgePort]) – and the moment its work was DISPATCHED – the
 * first line of the main-thread task the route posted for it, or of the storage thread's take
 * for a storage call ([JsBridge.Calls]). Their difference is the receipt-to-dispatch latency the
 * WebView's trace cannot show: the host's main-thread tasks are not in the categories the harness
 * records (`BlinkTrace.CATEGORIES` has no `android_webview`), and a string's transit from the
 * chrome's frame to the host's task is what a change of transport can move by a frame.
 *
 * Host-only, by design: the measure reads the same in a build before the change of transport as
 * in one after it, so the two are comparable, and it is taken in the page's clock –
 * `System.nanoTime()` in microseconds is `CLOCK_MONOTONIC`, the trace's `ts`
 * (`SystemClock.uptimeNanos` is API 29; minSdk is 26) – so a sample lines up with the page's
 * `bridge:<entry>:<method>` mark of the same string, offline.
 *
 * OFF, a string costs one volatile read and a branch, nothing else (no time, no allocation: the
 * name is not even built). ON – the motion profile's driver (`MotionPerfDemo`) turns it on with
 * the page's marks and reads it per scene – a sample is a small object in a lock-free queue,
 * capped at [CAP] per read (the overflow counted, not stored). Never on in production.
 */
object BridgeLatency {
    /** The switch: set by the driver beside the page's `__zenBridgeTrace`; read on every string. */
    @Volatile
    var enabled: Boolean = false

    /** Samples kept per [drain]; the rest are counted in [overflow]. */
    const val CAP = 8192

    /** How a string reached the host: the synchronous `@JavascriptInterface` hop, or the port. */
    const val HOP = "hop"
    const val PORT = "port"

    /** What the string was: a `call` (an envelope with an id, dispatched on main), a storage call (dispatched on the storage thread), a `post`, a `batch`. */
    const val CALL = "call"
    const val STORAGE = "storage"
    const val POST = "post"
    const val BATCH = "batch"

    /**
     * Not a string of the chrome's but the host's answer to one (Q1, `view.shown`,
     * [PlacementAnswer]): `arrivedUs` is the moment the answer's signal came – the view's
     * visual-state callback, the frame that shows the page ([FRAME]), or the deadline with no
     * frame ([DEADLINE]) – and `dispatchedUs` the moment the reply left for the chrome (after
     * the two frames [Host.afterFrames] counts past the callback). `what` is
     * `view.shown:<tabId>`. Beside the page's `bridge:answer:view.shown:<tabId>:<shown>` and
     * `cover:drop:<tabId>` marks, the placement batch's and the ask's own samples, it puts the
     * landing's whole sequence – the batch's main task, the view's draw, the answer, the
     * chrome's drop – on the trace's one clock. An ask refused at once (no view, not shown)
     * leaves no sample: the ask's `call` sample and the page's `false` mark are its record.
     */
    const val SHOWN = "shown"
    const val FRAME = "frame"
    const val DEADLINE = "deadline"

    /** One string: where it came from, what it was, when it arrived and when its work began. */
    class Sample(val kind: String, val via: String, val arrivedUs: Long) {
        /** The method (a batch's methods joined with `+`), set once the route knows it. */
        @Volatile
        var what: String = ""

        /** When the work began, on its thread; 0 until it did. */
        @Volatile
        var dispatchedUs: Long = 0L

        /** Stamp the dispatch: the first line of the main-thread task, or of the storage thread's take. */
        fun dispatched() {
            dispatchedUs = now()
        }
    }

    private val samples = ConcurrentLinkedQueue<Sample>()
    private val count = AtomicInteger()

    /** Samples over [CAP] since the last [reset], not kept. */
    val overflow = AtomicInteger()

    /** The clock: `CLOCK_MONOTONIC` in microseconds, the trace's. */
    fun now(): Long = System.nanoTime() / 1_000

    /** The arrival stamp, or 0 when off: the FIRST line of a route, before the string's head is looked at. */
    fun stamp(): Long = if (enabled) now() else 0L

    /**
     * Record a string that arrived at [arrivedUs] (a [stamp]; nothing when 0 – the switch was off
     * as it arrived): null when off or over the cap, else the sample for the dispatch to stamp.
     */
    fun arrived(kind: String, via: String, arrivedUs: Long, what: String): Sample? {
        if (arrivedUs == 0L || !enabled) return null
        if (count.incrementAndGet() > CAP) {
            overflow.incrementAndGet()
            return null
        }
        val sample = Sample(kind, via, arrivedUs)
        sample.what = what
        samples.add(sample)
        return sample
    }

    /** Forget every sample (a scene's start). */
    fun reset() {
        samples.clear()
        count.set(0)
        overflow.set(0)
    }

    /**
     * Every sample since the last [reset] (the queue emptied), as JSON for the scene's record:
     * the raw samples that arrived inside `[fromUs, toUs]` (`s`: `[kind, via, what, arrivedUs,
     * dispatchedUs]`, 0 for a dispatch that had not come), the aggregate per `kind/via` over the
     * dispatched ones (`n`, `meanUs`, `p95Us`, `maxUs`), and the counts of what fell outside the
     * window, was still pending, or overflowed the cap.
     */
    fun drain(fromUs: Long = Long.MIN_VALUE, toUs: Long = Long.MAX_VALUE): JSONObject {
        val all = ArrayList<Sample>()
        while (true) all.add(samples.poll() ?: break)
        count.set(0)
        val inWindow = all.filter { it.arrivedUs in fromUs..toUs }
        val raw = JSONArray()
        for (s in inWindow) raw.put(JSONArray().put(s.kind).put(s.via).put(s.what).put(s.arrivedUs).put(s.dispatchedUs))
        val byKind = JSONObject()
        for ((key, group) in inWindow.filter { it.dispatchedUs != 0L }.groupBy { "${it.kind}/${it.via}" }.toSortedMap()) {
            val latencies = group.map { it.dispatchedUs - it.arrivedUs }.sorted()
            // Nearest rank, as the harness's `BlinkTrace.Stat` takes it.
            val rank = maxOf(1, Math.ceil(0.95 * latencies.size).toInt())
            byKind.put(
                key,
                JSONObject()
                    .put("n", latencies.size)
                    .put("meanUs", latencies.average().toLong())
                    .put("p95Us", latencies[rank - 1])
                    .put("maxUs", latencies.last())
            )
        }
        return JSONObject()
            .put("windowUs", JSONArray().put(fromUs).put(toUs))
            .put("s", raw)
            .put("byKind", byKind)
            .put("outside", all.size - inWindow.size)
            .put("pending", inWindow.count { it.dispatchedUs == 0L })
            .put("overflow", overflow.getAndSet(0))
    }

    /** One line of a [drain] for the findings: `call/hop n=12 mean 0.4 ms max 1.2 ms; …`. */
    fun describe(drained: JSONObject): String {
        val byKind = drained.optJSONObject("byKind") ?: return "no samples"
        if (byKind.length() == 0) return "no samples"
        val parts = ArrayList<String>()
        for (key in byKind.keys().asSequence().sorted()) {
            val v = byKind.getJSONObject(key)
            parts.add("$key n=${v.getInt("n")} mean ${ms(v.getLong("meanUs"))} p95 ${ms(v.getLong("p95Us"))} max ${ms(v.getLong("maxUs"))} ms")
        }
        val pending = drained.optInt("pending")
        val overflow = drained.optInt("overflow")
        if (pending > 0) parts.add("$pending pending")
        if (overflow > 0) parts.add("$overflow over the cap")
        return parts.joinToString("; ")
    }

    private fun ms(us: Long): String = String.format(java.util.Locale.ROOT, "%.2f", us / 1000.0)
}
