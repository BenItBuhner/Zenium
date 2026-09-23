package app.zen.chromium

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Admission of a bridge string by its RAW length, ahead of any parse, against two limits sized
 * to the Java heap the process was given.
 *
 * A call the chrome hands the host (`__zenNative.call/post/batch`) arrives as one string on the
 * WebView's bridge thread and is parsed, then posted to the main thread with its arguments; a
 * page's message to an extension arrives the same way on the main thread. Compat round 9's fix
 * 11 capped the chars of calls posted and not yet dispatched at 24 M, and the process still died
 * in Trust Wallet's row on WebView 156 (compat round 9 section 6, round 10's carry): the cap was
 * checked AFTER `JSONObject(json)` had built the refused call whole (the bridge thread allocated
 * every refused 144-KB broadcast twice over, 35-55 MB of large objects a second for the GC), and
 * 24 M chars – 24-48 MB of strings and each queued call's parsed arguments beside them – was
 * most of a 192-MB heap shared with the WebView's own Java side. Here the length of the string
 * as it came off JNI decides, before anything of it is parsed:
 *
 *  - [messageLimitChars]: a single string longer than this is refused whatever the queue holds
 *    (Chrome refuses a message over `kMaxMessageLength`, 64 MB, with [MESSAGE_TOO_LONG]; the
 *    phone's limit is what its heap can parse and hold – a 192-MB heap allows 6 M chars, a
 *    512-MB one 16 M, the ceiling);
 *  - [queueLimitChars]: the chars of admitted calls the main thread has not yet dispatched; a
 *    call that would take the queue past it is refused, so a chrome outrunning the main thread
 *    costs messages, not the process (a 192-MB heap allows 8 M chars, a 576-MB one the 24-M
 *    ceiling; the message limit never exceeds it).
 *
 * The limits come from `Runtime.maxMemory()` (the heap's growth limit, what `OutOfMemoryError`
 * is thrown against), with a floor for the smallest heaps – below it the caps would refuse the
 * messages extensions actually send – and a ceiling where a larger heap buys nothing more. A
 * refused message is not the process's problem: it is answered, when it can be, with Chrome's
 * word for a message its channel will not carry, [MESSAGE_TOO_LONG].
 */
class BridgeAdmission(heapBytes: Long) {
    /** Chars one string may have; over it, refused unparsed. */
    val messageLimitChars: Long = (heapBytes / MESSAGE_HEAP_DIVISOR).coerceIn(MESSAGE_FLOOR_CHARS, MESSAGE_CEILING_CHARS)

    /** Chars of admitted calls the main thread may hold undispatched at once. */
    val queueLimitChars: Long = (heapBytes / QUEUE_HEAP_DIVISOR).coerceIn(QUEUE_FLOOR_CHARS, QUEUE_CEILING_CHARS)

    private val queued = AtomicLong()

    /** Strings refused so far (either limit), for the driver's per-row `bridgeRefused`. */
    val refused = AtomicInteger()

    /** What the queue holds now, for the log line and the test. */
    val queuedChars: Long get() = queued.get()

    sealed class Verdict(val message: String?) {
        /** Admitted and reserved in the queue: [release] the same count once dispatched. */
        object Admitted : Verdict(null)
        /** Longer than [messageLimitChars]. */
        object TooLong : Verdict(MESSAGE_TOO_LONG)
        /** The queue would pass [queueLimitChars]. */
        object QueueFull : Verdict(MESSAGE_TOO_LONG)
    }

    /**
     * Admit a string of [chars] to the queue (reserving its chars) or refuse it. A refusal counts
     * in [refused]; the reservation of an admitted string ends with [release].
     */
    fun admit(chars: Int): Verdict {
        val size = chars.toLong()
        if (size > messageLimitChars) {
            refused.incrementAndGet()
            return Verdict.TooLong
        }
        // A reservation that races past the limit by one call is fine: the limit is a
        // budget, not a fence; two calls cannot both see room for a queue's worth.
        if (queued.get() + size > queueLimitChars) {
            refused.incrementAndGet()
            return Verdict.QueueFull
        }
        queued.addAndGet(size)
        return Verdict.Admitted
    }

    /** The main thread took the admitted string of [chars]. */
    fun release(chars: Int) {
        queued.addAndGet(-chars.toLong())
    }

    /**
     * Length alone, for a string that is not queued (a synchronous call, a page's message on the
     * main thread): true when it is within [messageLimitChars]; otherwise counted and refused.
     */
    fun admitUnqueued(chars: Int): Boolean {
        if (chars.toLong() <= messageLimitChars) return true
        refused.incrementAndGet()
        return false
    }

    /** The `id` and `method` a refused call carries, read off its head without parsing it. */
    class Head(val id: Int, val method: String)

    companion object {
        /** Chrome's error for a message over its maximum (`kMessageTooLongError`). */
        const val MESSAGE_TOO_LONG = "Message length exceeded maximum allowed length."

        const val MESSAGE_HEAP_DIVISOR = 32L
        const val MESSAGE_FLOOR_CHARS = 2L * 1024 * 1024
        const val MESSAGE_CEILING_CHARS = 16L * 1024 * 1024
        const val QUEUE_HEAP_DIVISOR = 24L
        const val QUEUE_FLOOR_CHARS = 3L * 1024 * 1024
        const val QUEUE_CEILING_CHARS = 24L * 1024 * 1024

        /** The bridge's calls begin `{"id":<n>,"method":"<name>"` (bridge.ts's `NativeCall`); the head is read within this many chars. */
        private const val HEAD_CHARS = 512
        private val HEAD = Regex("""^\s*\{\s*"id"\s*:\s*(-?\d+)\s*,\s*"method"\s*:\s*"((?:[^"\\]|\\.)*)"""")

        /** Read a call's `id` and `method` from its first chars, or null when the string is not a call of the bridge's shape. */
        fun head(json: String): Head? {
            val m = HEAD.find(json.substring(0, minOf(json.length, HEAD_CHARS))) ?: return null
            val id = m.groupValues[1].toIntOrNull() ?: return null
            return Head(id, m.groupValues[2])
        }

        /** The `method` of a one-way command, `{"method":"<name>",...}`, from its head. */
        private val COMMAND_HEAD = Regex("""^\s*\{\s*"method"\s*:\s*"((?:[^"\\]|\\.)*)"""")

        fun commandMethod(json: String): String? =
            COMMAND_HEAD.find(json.substring(0, minOf(json.length, HEAD_CHARS)))?.groupValues?.get(1)
    }
}
