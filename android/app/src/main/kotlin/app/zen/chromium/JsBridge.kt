package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * `window.__zenNative` inside the chrome WebView. `call` is asynchronous and answered through
 * `__zenHost.resolve/reject`; `post` is asynchronous and one way (no answer at all); `batch` is
 * `post` for a list of commands in one hop; `callSync` blocks the JS thread and is reserved for
 * boot data and last-chance persistence. All arrive on WebView's bridge thread and are handed to
 * the main thread.
 *
 * Every one of them holds the chrome's JS thread while the WebView carries the string over to
 * this thread and back, a wait that is the device's scheduling more than the parse (the tab
 * swipe profile, #312): the chrome sends a layout report's view ops – four to six of them –
 * through [batch] for that reason, one hop and one main-thread task for the report. The one
 * payload whose parse IS the wait – a document the core's store writes (`state.json` on its
 * debounce, tens to hundreds of KB on thirty tabs: 143 ms of the overview's fold, #349) – is not
 * parsed on this thread at all: a storage call goes to the storage thread as the raw string
 * ([Calls]).
 *
 * THE PORT IS THE BRIDGE (services perf pass 4): once the page holds the host's asynchronous
 * channel ([BridgePort], asked for at boot), every `call`, `post` and `batch` string comes
 * through it instead – the same strings, without the hop's wait – and [route] dispatches each
 * by its shape into the same three routes ([Calls.call], [Calls.post], [Calls.batch]) the JNI
 * entries are. [callSync] alone stays a hop: it is synchronous by nature.
 */
class JsBridge(
    private val host: Host,
    /**
     * The string's admission by its raw length, before any parse: a single string over the heap's
     * message limit, or one the main thread's queue of undispatched calls has no room for, is
     * refused as it came off JNI. The bridge thread parses a call and posts it, so a main thread
     * slower than the chrome's calls arrive holds every posted one on the heap, arguments and all:
     * an extension's state broadcast on a port at a few hundred KB tens of times a second (Trust
     * Wallet's to its worker, compat rounds 9 and 10) grew that queue until the process died of
     * `OutOfMemoryError`, and round 9's cap, checked after the parse and sized without the heap,
     * did not hold it (BridgeAdmission). A refused `call` is rejected with Chrome's error for a
     * message its channel will not carry, a refused `post` or `batch` is dropped, each logged and
     * counted in [refused]. The chrome's own traffic never comes near either limit.
     */
    val admission: BridgeAdmission = BridgeAdmission(Runtime.getRuntime().maxMemory())
) {
    private val main = Handler(Looper.getMainLooper())

    /** Strings refused at either limit, for instrumentation (the driver's per-row `bridgeRefused`). */
    val refused: AtomicInteger get() = admission.refused

    /** The three routes apart from the WebView and the host ([Calls]): its threads are the host's, its answers the chrome's. */
    private val calls = Calls(
        admission,
        storage = { work -> host.storage.execute(work) },
        main = { work -> main.post(work) },
        dispatch = { id, method, args ->
            host.dispatch(method, args) { result ->
                if (result is Host.Rejection) host.chrome.reject(id, result.message) else host.chrome.resolve(id, result)
            }
        },
        dispatchStorage = { id, method, args ->
            host.dispatchStorage(method, args) { result ->
                if (result is Host.Rejection) host.chrome.reject(id, result.message) else host.chrome.resolve(id, result)
            }
        },
        // One way: nothing goes back to the chrome; a rejection is logged here instead.
        dispatchOneWay = { method, args ->
            host.dispatch(method, args) { result ->
                if (result is Host.Rejection) Log.w(TAG, "native $method rejected: ${result.message}")
            }
        },
        reject = { id, message -> host.chrome.reject(id, message) },
        log = { message, error -> if (error == null) Log.w(TAG, message) else Log.w(TAG, message, error) }
    )

    @JavascriptInterface
    fun call(json: String) = calls.call(json)

    /**
     * One way: dispatched like [call], but nothing goes back to the chrome. For the commands the
     * chrome sends every frame and whose answer it never reads (`chrome.setBarHide`, the bar
     * hide's frame): each `resolve` of a [call] is an `evaluateJavascript` on the chrome's main
     * thread, a task per frame beside the frame's own work (the bar hide profile, #270). A
     * rejection or a failure is logged here instead.
     */
    @JavascriptInterface
    fun post(json: String) = calls.post(json)

    /**
     * One way like [post], for a JSON array of `{ method, args }`: the commands run in order in
     * ONE main-thread task, so a layout report's view ops (the bounds, the radius, the cover, a
     * visibility flip, the glance to the front: `TabHost`) land in the same frame of the host's
     * as they left the chrome's, and cost the chrome's thread one hop instead of one each. A
     * command that fails is logged and the rest still run: they are each other's siblings, not
     * each other's premises. Against the queue's limit as one call of the array's size (a batch
     * refused is dropped whole, and logged, like a `post`).
     */
    @JavascriptInterface
    fun batch(json: String) = calls.batch(json)

    /**
     * A string off the asynchronous channel ([BridgePort], on its handler thread): dispatched BY
     * ITS SHAPE into the route its hop would have taken – [call], [post] or [batch], the same
     * functions the JNI entries above are, reached without the hop ([Calls.route]).
     */
    fun route(json: String) = calls.route(json)

    /**
     * The three routes of the bridge, apart from the WebView and the host (so the unit test runs
     * them with threads of its own): [call], [post] and [batch], each admission FIRST, on the raw
     * length – a refused string is never parsed; a refused call is answered off its head so the
     * chrome's promise still settles, a refused post or batch is dropped and logged – then the
     * parse and the dispatch. Every string arrives on the thread it came in on – the JavaBridge
     * thread for a hop, the port's handler thread for a string off the asynchronous channel
     * ([BridgePort]; since services perf pass 4 every asynchronous entry, the port being the
     * bridge once the page holds it, and [route] tells them apart by shape) – and is parsed
     * THERE, never on the main thread; the main thread gets the parsed call as ONE task per
     * string, a batch's commands in one task, in the order the strings were received. For a
     * `call`:
     *
     *  - every call but a storage call is parsed on the receiving thread and dispatched on the
     *    main thread (`Host.dispatch`), as ever;
     *  - a STORAGE CALL ([STORAGE_CALLS]: the core's stores writing their documents – `state.json`
     *    on its debounce, the history, the downloads, a document in pieces – and removing one) is
     *    handed to the storage thread AS THE RAW STRING and parsed THERE, then dispatched there
     *    (`Host.dispatchStorage`): the chrome's JS thread waits on this thread for the whole hop,
     *    and the payload of such a call is the document itself, so its parse was the wait (the
     *    overview's fold on thirty tabs, #349: 143 ms of the frame with 1 ms of it on the CPU, the
     *    renderer waiting for this thread's `JSONObject(json)`). The write itself ran on the
     *    storage thread already; now the parse does too, and nothing of the call touches the main
     *    thread until its reply.
     *
     * THE ORDER HOLDS: `Storage`'s executor is ONE thread with a FIFO queue. The calls' parses are
     * queued on it in the order the calls arrived, each parse queues the call's write behind every
     * parse before it, so two writes of one document land in the order the chrome sent them – and
     * the core's `JsonStore` starts the next write of a document once the one before it has
     * landed (the reply comes after the write, as before), so no two are ever in flight at once.
     * A refused call parses nothing, as before; a storage call on a closed storage (the host is
     * destroyed) is rejected instead of parsed, its reservation returned.
     */
    class Calls(
        val admission: BridgeAdmission,
        /** Run `work` on the storage thread, behind every write queued so far; false when the storage is closed (nothing runs). */
        private val storage: (work: () -> Unit) -> Boolean,
        /** Run `work` on the main thread. */
        private val main: (work: () -> Unit) -> Unit,
        /** The host's dispatch of a parsed call, on the main thread; its reply answers the chrome. */
        private val dispatch: (id: Int, method: String, args: JSONObject) -> Unit,
        /** The host's dispatch of a parsed storage call, on the storage thread; its reply reaches the chrome through the main thread. */
        private val dispatchStorage: (id: Int, method: String, args: JSONObject) -> Unit,
        /** The host's dispatch of a one-way command (a `post`'s, a batch's), on the main thread; nothing goes back to the chrome, a rejection is logged by the host. */
        private val dispatchOneWay: (method: String, args: JSONObject) -> Unit,
        /** The chrome's promise rejected, on the main thread. */
        private val reject: (id: Int, message: String) -> Unit,
        private val log: (message: String, error: Throwable?) -> Unit,
        /** The parse of an admitted string (the test's spy on which thread it runs on). */
        private val parse: (json: String) -> JSONObject = { JSONObject(it) },
        /** The parse of an admitted batch (the test's spy, as [parse]). */
        private val parseArray: (json: String) -> JSONArray = { JSONArray(it) }
    ) {
        /** Strings off the port of no shape the bridge knows ([route]): dropped, never parsed; logged the first time and every hundredth. */
        val unknown = AtomicInteger()

        /**
         * Admits [json] by its raw length, reserving it in the queue: null when admitted, the
         * refusal otherwise (logged: the first, then every hundredth; [what] names the call off its head).
         */
        fun admit(json: String, what: () -> String): BridgeAdmission.Verdict? {
            val verdict = admission.admit(json.length)
            if (verdict === BridgeAdmission.Verdict.Admitted) return null
            val count = admission.refused.get()
            if (count == 1 || count % 100 == 0) {
                val reason = if (verdict === BridgeAdmission.Verdict.TooLong) "over the message limit of ${admission.messageLimitChars} chars" else "the main thread's queue holds ${admission.queuedChars} chars of calls"
                log("${what()} (${json.length} chars) refused, $reason ($count so far)", null)
            }
            return verdict
        }

        /** Parses an admitted string; a malformed one is logged and its reservation returned. */
        fun parseAdmitted(json: String, kind: String): JSONObject? = try {
            parse(json)
        } catch (e: Exception) {
            admission.release(json.length)
            log("bad $kind payload", e)
            null
        }

        /**
         * One `call` string, from the hop ([via] `hop`) or the port (`port`): its arrival is
         * stamped first, before the head is looked at, and its dispatch as the task it becomes
         * begins on its thread ([BridgeLatency], flag-gated).
         */
        fun call(json: String, via: String = BridgeLatency.HOP) {
            val arrivedUs = BridgeLatency.stamp()
            // Admission first, on the raw length: a refused call is never parsed. Its id and
            // method come off the string's head, so the chrome's promise still settles.
            val head = BridgeAdmission.head(json)
            val refusal = admit(json) { head?.method ?: "a call" }
            if (refusal != null) {
                if (head == null) return
                main { reject(head.id, refusal.message ?: BridgeAdmission.MESSAGE_TOO_LONG) }
                return
            }
            if (head != null && head.method in STORAGE_CALLS) {
                val sample = BridgeLatency.arrived(BridgeLatency.STORAGE, via, arrivedUs, head.method)
                // The raw string to the storage thread; parsed and dispatched there, behind every
                // storage call before it. The reservation ends as the parse begins, as it does when
                // the main thread takes a call: the string is the storage thread's from here.
                val queued = storage {
                    sample?.dispatched()
                    admission.release(json.length)
                    val call = try {
                        parse(json)
                    } catch (e: Exception) {
                        log("bad call payload", e)
                        return@storage
                    }
                    val id = call.optInt("id")
                    val method = call.str("method")
                    try {
                        dispatchStorage(id, method, call.obj("args"))
                    } catch (e: Exception) {
                        log("native $method failed", e)
                        main { reject(id, e.message ?: e.javaClass.simpleName) }
                    }
                }
                if (!queued) {
                    admission.release(json.length)
                    main { reject(head.id, "${head.method} refused: ${Storage.CLOSED}") }
                }
                return
            }
            val call = parseAdmitted(json, "call") ?: return
            val id = call.optInt("id")
            val method = call.str("method")
            val args = call.obj("args")
            val sample = BridgeLatency.arrived(BridgeLatency.CALL, via, arrivedUs, method)
            main {
                sample?.dispatched()
                admission.release(json.length)
                try {
                    dispatch(id, method, args)
                } catch (e: Exception) {
                    log("native $method failed", e)
                    reject(id, e.message ?: e.javaClass.simpleName)
                }
            }
        }

        /**
         * One `post` string (`{ method, args }`, no id), from the hop or the port: admission,
         * the parse on the receiving thread, one main-thread task that dispatches it one way. A
         * refused or malformed post is dropped and logged.
         */
        fun post(json: String, via: String = BridgeLatency.HOP) {
            val arrivedUs = BridgeLatency.stamp()
            if (admit(json) { BridgeAdmission.commandMethod(json) ?: "a post" } != null) return
            val call = parseAdmitted(json, "post") ?: return
            val method = call.str("method")
            val args = call.obj("args")
            val sample = BridgeLatency.arrived(BridgeLatency.POST, via, arrivedUs, method)
            main {
                sample?.dispatched()
                admission.release(json.length)
                oneWay(method, args)
            }
        }

        /**
         * One `batch` string (a JSON array of `{ method, args }`), from the hop or the port:
         * admission as one string of the array's size, the parse on the receiving thread, and ONE
         * main-thread task that dispatches the commands in order, one way – a command that fails
         * is logged and the rest still run. A refused or malformed batch is dropped whole and
         * logged.
         */
        fun batch(json: String, via: String = BridgeLatency.HOP) {
            val arrivedUs = BridgeLatency.stamp()
            if (admit(json) { "a batch" } != null) return
            val commands = try {
                parseArray(json)
            } catch (e: Exception) {
                admission.release(json.length)
                log("bad batch payload", e)
                return
            }
            val sample = if (arrivedUs == 0L) null else BridgeLatency.arrived(BridgeLatency.BATCH, via, arrivedUs, batchMethods(commands))
            main {
                sample?.dispatched()
                admission.release(json.length)
                for (i in 0 until commands.length()) {
                    val command = commands.optJSONObject(i)
                    if (command == null) log("bad batch command at $i", null) else oneWay(command.str("method"), command.obj("args"))
                }
            }
        }

        /** One command dispatched one way on the main thread; a failure is logged here, never thrown into the task (a batch's siblings still run). */
        private fun oneWay(method: String, args: JSONObject) {
            try {
                dispatchOneWay(method, args)
            } catch (e: Exception) {
                log("native $method failed", e)
            }
        }

        /**
         * A string off the port, dispatched BY ITS SHAPE into the route its hop would have taken
         * – the page sends the same strings through the port that it sent through the entries
         * (`bridge.ts`), and the shapes are the entries': a JSON array (first non-space char `[`)
         * is a [batch]; an envelope with an id (`{"id":n,"method":"…"`, `BridgeAdmission.head`)
         * is a [call]; one without (`{"method":"…"`, `BridgeAdmission.commandMethod`) is a
         * [post]. Admission then applies per kind as the hops apply it (a call refused is
         * answered, a post or batch refused is dropped), and every parse runs on the port's
         * thread, none on main. A string of no shape the bridge knows is logged (the first, then
         * every hundredth), dropped and counted in [unknown]; nothing of it is parsed or admitted.
         *
         * THE ORDER: one port, read on one thread, and every route posts its main-thread task
         * (or hands its string to the storage thread) synchronously in here, so the main thread's
         * tasks are queued in the order the strings were received – the page's order – across
         * the kinds, a batch one task as through the hop.
         */
        fun route(json: String) {
            var at = 0
            while (at < json.length && json[at].isWhitespace()) at++
            when {
                at < json.length && json[at] == '[' -> batch(json, BridgeLatency.PORT)
                BridgeAdmission.head(json) != null -> call(json, BridgeLatency.PORT)
                BridgeAdmission.commandMethod(json) != null -> post(json, BridgeLatency.PORT)
                else -> {
                    val count = unknown.incrementAndGet()
                    if (count == 1 || count % 100 == 0) log("a port message of no shape the bridge knows (${json.length} chars, first '${json.getOrNull(at) ?: ' '}') was dropped ($count so far)", null)
                }
            }
        }
    }

    @JavascriptInterface
    fun callSync(json: String): String {
        // Nothing is queued, but nothing over the message limit is parsed either.
        if (!admission.admitUnqueued(json.length)) {
            Log.w(TAG, "a sync call of ${json.length} chars refused, over the message limit of ${admission.messageLimitChars} chars")
            return ""
        }
        val call = try {
            JSONObject(json)
        } catch (e: Exception) {
            return ""
        }
        return try {
            encodeResult(host.dispatchSync(call.str("method"), call.obj("args")))
        } catch (e: Exception) {
            Log.w(TAG, "native sync ${call.str("method")} failed", e)
            ""
        }
    }

    companion object {
        const val TAG = "ZenBridge"

        /** A batch's commands' methods joined with `+`, the page's name for it (`bridge:batch:<m1+m2>`); built only under [BridgeLatency]'s switch. */
        fun batchMethods(calls: JSONArray): String {
            val sb = StringBuilder()
            for (i in 0 until calls.length()) {
                if (i > 0) sb.append('+')
                sb.append(calls.optJSONObject(i)?.optString("method") ?: "?")
            }
            return sb.toString()
        }

        /**
         * The calls parsed and dispatched on the storage thread rather than this one ([Calls]):
         * the core's stores' writes and removals through `AndroidStoreIO` (`src/android/storeIo.ts`)
         * – a document whole, a document in pieces, a removal – every one of them a call whose
         * payload is the document (or a piece of it) and whose work is the storage thread's. The
         * synchronous ones (`storage.writeSync`, the reads) come through [callSync] and are not
         * routed: they run on the bridge thread by design.
         */
        val STORAGE_CALLS: Set<String> = setOf(
            "storage.write",
            "storage.remove",
            "storage.writeBegin",
            "storage.writeChunk",
            "storage.writeEnd",
            "storage.writeAbort"
        )
    }
}
