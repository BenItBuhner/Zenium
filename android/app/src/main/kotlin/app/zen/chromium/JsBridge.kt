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

    /** The `call` route apart from the WebView and the host ([Calls]): its threads are the host's, its answers the chrome's. */
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
        reject = { id, message -> host.chrome.reject(id, message) },
        log = { message, error -> if (error == null) Log.w(TAG, message) else Log.w(TAG, message, error) }
    )

    /**
     * Admits [json] by its raw length, reserving it in the queue: null when admitted, the refusal
     * otherwise (logged: the first, then every hundredth; [what] names the call off its head).
     */
    private fun admit(json: String, what: () -> String): BridgeAdmission.Verdict? =
        calls.admit(json, what)

    /** Parses an admitted string; a malformed one is logged and its reservation returned. */
    private fun parseAdmitted(json: String, kind: String): JSONObject? = calls.parseAdmitted(json, kind)

    /** Posts [block] for an admitted string of [chars] to the main thread; the reservation ends as it runs. */
    private fun dispatchLater(chars: Int, block: () -> Unit) {
        main.post {
            admission.release(chars)
            block()
        }
    }

    @JavascriptInterface
    fun call(json: String) = calls.call(json)

    /**
     * The route of one `call` string, apart from the WebView and the host (so the unit test runs
     * it with threads of its own): admission FIRST, on the raw length – a refused call is never
     * parsed, and is answered off its head so the chrome's promise still settles. Then the parse
     * and the dispatch:
     *
     *  - every call but a storage call is parsed HERE, on the bridge thread, and dispatched on the
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
        /** The chrome's promise rejected, on the main thread. */
        private val reject: (id: Int, message: String) -> Unit,
        private val log: (message: String, error: Throwable?) -> Unit,
        /** The parse of an admitted string (the test's spy on which thread it runs on). */
        private val parse: (json: String) -> JSONObject = { JSONObject(it) }
    ) {
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

        fun call(json: String) {
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
                // The raw string to the storage thread; parsed and dispatched there, behind every
                // storage call before it. The reservation ends as the parse begins, as it does when
                // the main thread takes a call: the string is the storage thread's from here.
                val queued = storage {
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
            main {
                admission.release(json.length)
                try {
                    dispatch(id, method, args)
                } catch (e: Exception) {
                    log("native $method failed", e)
                    reject(id, e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    /**
     * One way: dispatched like [call], but nothing goes back to the chrome. For the commands the
     * chrome sends every frame and whose answer it never reads (`chrome.setBarHide`, the bar
     * hide's frame): each `resolve` of a [call] is an `evaluateJavascript` on the chrome's main
     * thread, a task per frame beside the frame's own work (the bar hide profile, #270). A
     * rejection or a failure is logged here instead.
     */
    @JavascriptInterface
    fun post(json: String) {
        if (admit(json) { BridgeAdmission.commandMethod(json) ?: "a post" } != null) return
        val call = parseAdmitted(json, "post") ?: return
        dispatchLater(json.length) { dispatchOneWay(call) }
    }

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
    fun batch(json: String) {
        if (admit(json) { "a batch" } != null) return
        val calls = try {
            JSONArray(json)
        } catch (e: Exception) {
            admission.release(json.length)
            Log.w(TAG, "bad batch payload", e)
            return
        }
        dispatchLater(json.length) {
            for (i in 0 until calls.length()) {
                val call = calls.optJSONObject(i)
                if (call == null) Log.w(TAG, "bad batch command at $i") else dispatchOneWay(call)
            }
        }
    }

    /** Dispatch a `{ method, args }` on the main thread with nothing going back to the chrome; a rejection or a failure is logged here instead. */
    private fun dispatchOneWay(call: JSONObject) {
        val method = call.str("method")
        try {
            host.dispatch(method, call.obj("args")) { result ->
                if (result is Host.Rejection) Log.w(TAG, "native $method rejected: ${result.message}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "native $method failed", e)
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
