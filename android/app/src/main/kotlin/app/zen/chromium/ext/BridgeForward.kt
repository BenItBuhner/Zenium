package app.zen.chromium.ext

import app.zen.chromium.json
import app.zen.chromium.str
import org.json.JSONObject

/**
 * The page-to-host flood guard: between a frame's admitted bridge messages and the chrome's core.
 *
 * Every bridge message the host does not answer itself becomes an `ext.message` host event: its
 * text copied into the event, quoted into a script and run in the chrome's renderer by
 * `evaluateJavascript`, where the core parses it again. Each such message is under the bridge's
 * length limit ([app.zen.chromium.BridgeAdmission]); the limit says nothing about how many come.
 * Clear Cache (compat round 11, row 11) called `action.setIcon({imageData})` 2480 times in a
 * burst, some 0.3 M chars of pixels each: on WebView 113 the main thread took 101.8 s to work the
 * copies off, on 156 the allocation outran the collector and the process died in
 * `ChromeWebView.hostEvent`. The guard makes the forward a paced, bounded path:
 *
 *  1. Action state coalesces. `setIcon`, `setBadgeText`, `setBadgeBackgroundColor`,
 *     `setBadgeTextColor`, `setTitle` and `setPopup` of one endpoint, one namespace and one tab
 *     (or the global value) are last-wins in Chrome: only the newest value need reach the core.
 *     The first of a frame goes at once; a later one within the frame waits for the next frame,
 *     and a newer one replaces it in place while it waits, the replaced call answered as Chrome
 *     answers these (resolved with nothing). Nothing observable is lost: the core would have
 *     applied the values in turn and kept the last.
 *  2. A frame budget paces the forward: a bucket of [Limits.frameChars] of message text per
 *     frame (one message always goes once the bucket is positive; a bigger one takes the bucket
 *     into debt, paid off frame by frame), [Limits.frameCount] messages per frame, and
 *     [Limits.iconsPerFrame] icon rewrites – the pixels of a `setIcon` are scaled on this side
 *     ([Sink.rewrite]) before they cross. The rest waits, in arrival order per source, and goes
 *     at the next frames; nothing goes while the chrome is not [ready] to take events (a
 *     rebuilding chrome used to have every pending script queued unbounded).
 *  3. What waits is bounded per source and overall, in chars and in count. Over a bound, a
 *     coalescable arrival drops the oldest pending coalescable state of its source (its caller
 *     answered with an error); any other arrival is refused: a `call` or `msg` hears an error, a
 *     port message is dropped with its port left as it is, the rest go silently – and the
 *     extension's error console gets a line ([Sink.warn], at most one per source per
 *     [Limits.warnEveryFrames] frames; the ring folds repeats). The chars bounds weigh what an
 *     arrival adds: a small one ([Limits.smallChars] or less – a `storage.set`, a `tabs.query`)
 *     is never refused for the big messages waiting ahead of it, only the count bounds hold it
 *     (Trust Wallet's background, compat round 11b: its store broadcasts of 144 K chars filled
 *     the source's chars and its 200-char storage calls were refused in their shadow). The
 *     small ones a source can have waiting are bounded by [Limits.sourceCount] times
 *     [Limits.smallChars] on top of [Limits.sourceChars], so the heap's bound stands.
 *
 * Plain Kotlin, main-thread only: the frame scheduler, the ready check and the sink are the
 * caller's ([Extensions] hands a Choreographer, the chrome's ready flag and the `ext.message`,
 * reply and console paths), so the tests drive frames by hand.
 */
class BridgeForward(
    private val limits: Limits = Limits(),
    private val frames: (Runnable) -> Unit,
    private val ready: () -> Boolean,
    private val sink: Sink
) {
    data class Limits(
        /**
         * Message text forwarded per frame, as a bucket: it refills by this much each frame (to
         * this much at most) and one message goes whenever it is positive, however long. Sized
         * against the collector: a forwarded char is copied a few times on the way to the
         * chrome's renderer, and 156's concurrent collector kept up with ~70 MB/s on the
         * emulator where Clear Cache's flood killed it.
         */
        val frameChars: Int = 64 * 1024,
        /** Messages forwarded per frame (each is an `evaluateJavascript`). */
        val frameCount: Int = 256,
        /** `setIcon` pixel rewrites per frame (a parse of the pixels and a scale, main thread). */
        val iconsPerFrame: Int = 1,
        /**
         * Pending chars per source, checked when the source already has something waiting, for
         * an arrival over [smallChars]; the small ones are held to [sourceCount] alone.
         */
        val sourceChars: Int = 2 * 1024 * 1024,
        /** Pending messages per source (a small message's only bound; see [smallChars]). */
        val sourceCount: Int = 2048,
        /** Pending chars over every source, checked when something is already waiting, for an arrival over [smallChars]. */
        val totalChars: Int = 6 * 1024 * 1024,
        /** Pending messages over every source. */
        val totalCount: Int = 4096,
        /**
         * A message this long or shorter adds no weight worth a refusal: it waits its turn behind
         * whatever is pending, under the count bounds alone. At most [sourceCount] of them a
         * source (2 M chars at the defaults), on top of [sourceChars] of bigger ones.
         */
        val smallChars: Int = 1024,
        /** Frames between two console lines of one source. */
        val warnEveryFrames: Int = 60
    )

    /** One endpoint as a sender: identity, attribution for the console, and its reply proxy. */
    class Source(
        val ep: String,
        val extensionId: String,
        /** The endpoint's context (`background`, `content`, `popup`, …). */
        val context: String,
        /** The frame's URL, for the console line. */
        val url: String,
        /** Posts a reply to the frame (its `JavaScriptReplyProxy`). */
        val reply: (String) -> Unit
    )

    interface Sink {
        /** One message for the core, as `ext.message`'s fields: build the event and hand it on. */
        fun forward(ep: String, tabId: String?, top: Boolean, origin: String, text: CharSequence)

        /**
         * A `setIcon` about to cross: the message text with its pixels scaled to what the chrome
         * draws, or null to forward [text] as it came (no `imageData`, or nothing usable in it).
         */
        fun rewrite(message: JSONObject, text: String): String?

        /** A warning line for the source's extension's error console. */
        fun warn(source: Source, message: String)
    }

    private class Entry(
        var source: Source,
        var message: JSONObject,
        var text: String,
        val key: Key?,
        val icon: Boolean,
        val tabId: String?,
        val top: Boolean,
        val origin: String
    )

    private data class Key(val ep: String, val ns: String, val method: String, val tabId: String)

    private class Queue(var source: Source) {
        val entries = ArrayDeque<Entry>()
        var chars = 0L
    }

    private val queues = LinkedHashMap<String, Queue>()
    private val byKey = HashMap<Key, Entry>()
    private val forwardedKeys = HashSet<Key>()
    /**
     * Per endpoint and console line, the frame it was last written (kept apart from the queue,
     * which comes and goes): a flood earns each of its lines once per [Limits.warnEveryFrames].
     */
    private val warnedFrames = HashMap<Pair<String, String>, Int>()
    private var scheduled = false
    private var frame = 0
    private var tokens = limits.frameChars.toLong()
    private var forwardedThisFrame = 0
    private var iconsThisFrame = 0

    /** Messages waiting right now, over every source. */
    var pendingCount = 0
        private set
    var pendingChars = 0L
        private set

    // Counters for the instrumentation (read off the main thread by the drivers) and the tests.
    @Volatile var forwarded = 0L
        private set
    @Volatile var superseded = 0L
        private set
    @Volatile var dropped = 0L
        private set
    @Volatile var refused = 0L
        private set

    /**
     * A message admitted for the core: [message] its envelope ([BridgeEnvelope.read]), [text] the
     * text as the frame wrote it. Forwarded now, held for a later frame, folded into a pending
     * one, dropped or refused – the caller is done with it either way.
     */
    fun offer(source: Source, message: JSONObject, text: String, tabId: String?, top: Boolean, origin: String) {
        val method = message.str("method")
        val ns = message.str("ns")
        val coalescable = message.str("t") == "call" && ns in ACTION_NAMESPACES && method in COALESCED_METHODS
        val key = if (coalescable) ActionCalls.detailsTabId(message, text)?.let { Key(source.ep, ns, method, it) } else null
        val entry = Entry(source, message, text, key, coalescable && method == "setIcon", tabId, top, origin)
        val queue = queues[source.ep]
        if (queue != null) queue.source = source
        val idle = queue == null || queue.entries.isEmpty()
        if (idle && canForwardNow(entry)) {
            forward(entry)
            return
        }
        if (key != null) {
            val pending = byKey[key]
            if (pending != null) {
                supersede(pending, entry)
                return
            }
        }
        hold(queue ?: Queue(source).also { queues[source.ep] = it }, entry)
    }

    /** The endpoints in [eps] are gone: whatever they had waiting goes with them, unanswered. */
    fun forget(eps: Collection<String>) {
        for (ep in eps) {
            warnedFrames.keys.removeAll { it.first == ep }
            val queue = queues.remove(ep) ?: continue
            for (entry in queue.entries) release(queue, entry)
        }
    }

    /** Every endpoint of extension [id] is gone (a detach). */
    fun forgetExtension(id: String) {
        forget(queues.values.filter { it.source.extensionId == id }.map { it.source.ep })
    }

    private fun canForwardNow(entry: Entry): Boolean {
        if (!ready()) return false
        if (tokens <= 0 || forwardedThisFrame >= limits.frameCount) return false
        if (entry.key != null && entry.key in forwardedKeys) return false
        if (entry.icon && iconsThisFrame >= limits.iconsPerFrame) return false
        return true
    }

    private fun forward(entry: Entry) {
        var text: CharSequence = entry.text
        if (entry.icon) {
            iconsThisFrame++
            sink.rewrite(entry.message, entry.text)?.let { text = it }
        }
        tokens -= text.length
        forwardedThisFrame++
        forwarded++
        entry.key?.let { forwardedKeys.add(it) }
        sink.forward(entry.source.ep, entry.tabId, entry.top, entry.origin, text)
        schedule()
    }

    /** A newer value for a pending action state: it takes the pending one's place; that caller is answered. */
    private fun supersede(pending: Entry, newer: Entry) {
        val queue = queues[pending.source.ep]
        val delta = newer.text.length - pending.text.length
        if (queue != null) queue.chars += delta
        pendingChars += delta
        pending.source.reply(replyOk(pending))
        superseded++
        pending.source = newer.source
        pending.message = newer.message
        pending.text = newer.text
    }

    private fun hold(queue: Queue, entry: Entry) {
        val chars = entry.text.length
        while (overBound(queue, chars)) {
            if (entry.key == null) {
                refuse(queue, entry)
                return
            }
            val victim = queue.entries.firstOrNull { it.key != null }
            if (victim == null) {
                refuse(queue, entry)
                return
            }
            drop(queue, victim)
        }
        queue.entries.addLast(entry)
        queue.chars += chars
        pendingCount++
        pendingChars += chars
        entry.key?.let { byKey[it] = entry }
        schedule()
    }

    /**
     * Whether holding [chars] more for [queue] would pass a bound: the count bounds for any
     * arrival, the chars bounds (once something waits) for one over [Limits.smallChars].
     */
    private fun overBound(queue: Queue, chars: Int): Boolean {
        if (queue.entries.size >= limits.sourceCount || pendingCount >= limits.totalCount) return true
        if (chars <= limits.smallChars) return false
        if (queue.entries.isNotEmpty() && queue.chars + chars > limits.sourceChars) return true
        if (pendingCount > 0 && pendingChars + chars > limits.totalChars) return true
        return false
    }

    private fun drop(queue: Queue, victim: Entry) {
        queue.entries.remove(victim)
        release(queue, victim)
        dropped++
        victim.source.reply(replyError(victim, STATE_DROPPED))
        warn(queue, WARN_STATE_DROPPED)
    }

    private fun refuse(queue: Queue, entry: Entry) {
        refused++
        when (entry.message.str("t")) {
            "msg", "call" -> entry.source.reply(replyError(entry, MESSAGE_REFUSED))
        }
        warn(queue, WARN_MESSAGE_REFUSED)
        if (queue.entries.isEmpty()) queues.remove(queue.source.ep)
    }

    private fun release(queue: Queue, entry: Entry) {
        queue.chars -= entry.text.length
        pendingCount--
        pendingChars -= entry.text.length
        entry.key?.let { if (byKey[it] === entry) byKey.remove(it) }
    }

    private fun warn(queue: Queue, message: String) {
        val key = queue.source.ep to message
        val last = warnedFrames[key]
        if (last != null && frame - last < limits.warnEveryFrames) return
        warnedFrames[key] = frame
        sink.warn(queue.source, message)
    }

    private fun replyOk(entry: Entry): String =
        json("t" to "reply", "ep" to entry.source.ep, "id" to entry.message.opt("id"), "ok" to true, "result" to null).toString()

    private fun replyError(entry: Entry, error: String): String =
        json("t" to "reply", "ep" to entry.source.ep, "id" to entry.message.opt("id"), "ok" to false, "error" to error).toString()

    private fun schedule() {
        if (scheduled) return
        scheduled = true
        frames(Runnable { tick() })
    }

    /** The next frame: the budget refills, what waited goes as far as the budget lets it. */
    private fun tick() {
        scheduled = false
        frame++
        tokens = minOf(tokens + limits.frameChars, limits.frameChars.toLong())
        forwardedThisFrame = 0
        iconsThisFrame = 0
        forwardedKeys.clear()
        if (pendingCount == 0) return
        if (ready()) drain()
        if (pendingCount > 0) schedule()
    }

    /**
     * Round-robin over the sources with something waiting, one message of each per pass, while
     * the frame's budget lasts. A source whose head is an icon past the frame's rewrite budget
     * sits out the frame: order within a source holds.
     */
    private fun drain() {
        val order = ArrayList(queues.values)
        var progressed = true
        while (progressed && tokens > 0 && forwardedThisFrame < limits.frameCount) {
            progressed = false
            for (queue in order) {
                if (tokens <= 0 || forwardedThisFrame >= limits.frameCount) break
                val head = queue.entries.firstOrNull() ?: continue
                if (head.icon && iconsThisFrame >= limits.iconsPerFrame) continue
                queue.entries.removeFirst()
                release(queue, head)
                forward(head)
                progressed = true
            }
        }
        queues.values.removeAll { it.entries.isEmpty() }
    }

    companion object {
        val ACTION_NAMESPACES = setOf("action", "browserAction", "pageAction")
        val COALESCED_METHODS = setOf("setIcon", "setBadgeText", "setBadgeBackgroundColor", "setBadgeTextColor", "setTitle", "setPopup")

        /** The error a superseded-then-dropped action update's caller hears. */
        const val STATE_DROPPED = "Zenium dropped this action update: too many action updates from this frame were waiting to reach the browser."
        /** The error a refused `call` or `msg` hears. */
        const val MESSAGE_REFUSED = "Zenium dropped this message: too many messages from this frame were waiting to reach the browser."
        /** The console lines (fixed texts: the error console folds repeats). */
        const val WARN_STATE_DROPPED = "Action state updates (setIcon, setBadgeText, …) were dropped: too many were waiting for the browser. The page updates its action faster than the browser draws it."
        const val WARN_MESSAGE_REFUSED = "Bridge messages were dropped: too many were waiting for the browser. The page sends faster than the browser can take; batch or throttle its calls."
    }
}
