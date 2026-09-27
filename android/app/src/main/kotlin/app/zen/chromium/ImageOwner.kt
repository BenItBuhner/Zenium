package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The host side of the frame-owner protocol for the phone's image search (services pass 12
 * item 1; the interface document's §2, §5 and §6.1): "Search image with …" on an image that
 * lives in a sub-frame. Today the thumbnail script runs in the top document's world with the
 * hit-tested URL interpolated into it, where a hostile top page's hooked `fetch` / `Image`
 * reads the URL (#555's recorded gap). Here the URL goes down to no frame at all: the host
 * broadcasts a nonce to every frame's page script (`zen:image-owner?`), each frame answers
 * with the salted hashes of the image URLs it already holds (`zen:image-owner`), the first
 * answer containing `H = sha256(nonce ‖ url)` names the owner, and the owner alone is asked to
 * thumbnail its own image (`zen:image-thumbnail`) and hands back #555's `ImageFetchResult`,
 * which goes to the core untouched (`view.imageThumbnail`, `Host`); the core's
 * `parseImageFetchResult` is what checks it.
 *
 * Frames are told apart by their `JavaScriptReplyProxy`: androidx hands one Java object per
 * frame document (`JavaScriptReplyProxyImpl.forInvocationHandler` → the peer stored on
 * Chromium's `JsReplyProxy`, `AwSupportLibIsomorphic.getOrCreateSupportLibObject`; a new
 * document in the frame gets a new one, `JsToBrowserMessaging::SetBrowserToJsMessaging`), with
 * no `equals` / `hashCode` of its own, so the registry and the matching are by identity. A
 * sub-frame's proxy is registered from its `hello` ([registerFrame]); the main document's is the
 * tab's `replyProxy`, handed to [start] and broadcast last (§5 rule 1). A gone frame's proxy
 * drops what is posted to it without a word (`JsReplyProxy.postMessage`:
 * `if (mNativeJsReplyProxy == 0) return`), so nothing is pruned on failure: the registry is cleared
 * with the view ([destroy]) and capped at [OWNER_MAX_FRAMES], the oldest dropped first.
 *
 * The main document's boundary is the MAIN FRAME's hello, not `onPageStarted`
 * ([documentStarted]). Every hello carries its document's navigation start
 * (`performance.timeOrigin`, one clock for every frame), and a sub-frame's navigation begins
 * after its parent document's, so the new document's frames all stamp at or after the main
 * frame's: the boundary drops the frames stamped before it (the old document's) and keeps the
 * rest. WebView 113 posts `onPageStarted` at commit as a Java `Handler` message
 * (`AwWebContentsObserver.didFinishNavigationInPrimaryMainFrame` → `postOnPageStarted`) while
 * it calls the message listener inline from the native task that delivered the frame's hello
 * (`WebMessageListenerHolder.onPostMessage`), and the native pump drains its immediate tasks
 * before yielding to the Java queue (`MessagePumpForUI::DoNonDelayedLooperWork`), so a
 * sub-frame whose hello shared a burst with the main frame's commit was registered and then
 * cleared by `onPageStarted`, and its image fell to the address route (`no-owner`). Ordered by
 * the stamps, a frame of the new document survives whichever order its hello and the boundary
 * land in; a stale entry (a frame that navigated itself keeps its old proxy here until the next
 * boundary or the cap) costs a request the [OWNER_COLLECT_MS] wait at most, never a wrong owner.
 *
 * Pure, as `PageMessages.kt` is: the timers run on an injected scheduler, the nonce comes from
 * an injected random source and the messages leave through [post], so every case of the
 * document's §7.2 runs on the JVM. [P] is the proxy type (`JavaScriptReplyProxy` in the app).
 * Everything runs on the main thread, where `Host.dispatch` and the message listener already
 * are (the proxy's `postMessage` is a UI-thread call).
 */
class ImageOwner<P : Any>(
    /** Run the block after the delay; returns what cancels it (the main handler's `postDelayed`). */
    private val schedule: (delayMs: Long, block: () -> Unit) -> (() -> Unit),
    /** `count` random bytes for the nonce (`SecureRandom` in the app). */
    private val randomBytes: (count: Int) -> ByteArray,
    /** Deliver JSON text to a frame's proxy (`proxy.postMessage`, inside a `runCatching`). */
    private val post: (frame: P, json: String) -> Unit
) {
    /**
     * The sub-frames' proxies, by identity, oldest first, each with its document's navigation
     * start (NaN for a hello that carried none); never the main document's.
     */
    private val frames = LinkedHashMap<P, Double>()
    /** The one request live for the tab (Q5), or none. */
    private var live: Request<P>? = null

    /** How many sub-frame proxies are registered (tests, diagnostics). */
    val frameCount: Int get() = frames.size

    /** Whether a request is live (tests, diagnostics). */
    val busy: Boolean get() = live != null

    /**
     * A sub-frame's page script said hello: its proxy joins the frames the next question reaches,
     * stamped with its document's navigation start ([documentStart]; NaN when the hello carried
     * none, and the next boundary drops it). The same proxy again (it cannot happen for one
     * document, whose script says hello once) keeps its place and its stamp; the 257th drops the
     * oldest.
     */
    fun registerFrame(proxy: P, documentStart: Double) {
        if (frames.containsKey(proxy)) return
        if (frames.size >= OWNER_MAX_FRAMES) {
            val oldest = frames.keys.iterator()
            oldest.next()
            oldest.remove()
        }
        frames[proxy] = documentStart
    }

    /**
     * `view.imageThumbnail`: ask the frames who holds [src] and have the owner thumbnail it.
     * [reply] gets the `ImageFetchResult` JSON text exactly once – the owner's result, or
     * `{ ok:false, reason }` with `no-owner` (no frame claimed the URL within [OWNER_COLLECT_MS],
     * or every asked frame answered without it, or there was no frame to ask), `timeout` (the
     * owner did not answer within [OWNER_THUMBNAIL_MS]; also what a request killed by a newer
     * one, by a new main document or by the view's end answers), `too-large` (a result past the
     * size the core asked for) or `unsupported` ([legacy]: the `addJavascriptInterface` bridge
     * tells no frames apart and has no reply proxy, so the core keeps today's path there). The
     * question goes to the registered sub-frames in their order and to [mainFrame] last; the URL
     * is hashed as it came, cut at its first `#` (§2.6).
     */
    fun start(
        src: String,
        bounds: JSONObject,
        quality: Double,
        maxBytes: Long,
        mainFrame: P?,
        legacy: Boolean,
        reply: (String) -> Unit
    ) {
        if (legacy) {
            reply(failure(UNSUPPORTED))
            return
        }
        live?.let { finish(it, failure(TIMEOUT)) }
        val targets = ArrayList<P>(frames.size + 1)
        targets.addAll(frames.keys)
        if (mainFrame != null) targets.add(mainFrame)
        if (targets.isEmpty()) {
            reply(failure(NO_OWNER))
            return
        }
        val nonce = hex(randomBytes(16))
        val request = Request(nonce, hashFor(nonce, hashInput(src)), targets, mainFrame, bounds, quality, maxBytes, reply)
        live = request
        val question = json("v" to 1, "type" to QUESTION, "nonce" to nonce, "alg" to "sha256").toString()
        for (frame in targets) post(frame, question)
        if (live !== request) return
        request.timer = schedule(OWNER_COLLECT_MS) { if (live === request) finish(request, failure(NO_OWNER)) }
    }

    /**
     * A `zen:image-owner` or `zen:image-thumbnail` the router forwarded, from the frame whose
     * proxy is [proxy] (null on the legacy bridge, where nothing is heard). Anything but
     * protocol version 1 is ignored; so is a message for a nonce that is not the live one.
     */
    fun onMessage(message: JSONObject, proxy: P?, isMainFrame: Boolean) {
        if (proxy == null || (message.opt("v") as? Number)?.toDouble() != 1.0) return
        when (message.optString("type")) {
            ANSWER -> onAnswer(message, proxy, isMainFrame)
            THUMBNAIL -> onThumbnail(message, proxy)
        }
    }

    /**
     * A frame's hashes. Dropped when the nonce is not the live one (never issued, or dead), when
     * an owner is already named, when the frame was not asked or answered already, or when the
     * frame's word on being the main frame disagrees with the proxy's (browser-attributed both;
     * they cannot). The first answer whose list contains `H` names the owner and gets the ask;
     * with every asked frame answered and none matching the request ends early with `no-owner`.
     */
    private fun onAnswer(message: JSONObject, proxy: P, isMainFrame: Boolean) {
        val request = live ?: return
        if (message.optString("nonce") != request.nonce || request.owner != null) return
        if (isMainFrame != (proxy === request.mainFrame)) return
        val index = request.frames.indexOfFirst { it === proxy }
        if (index < 0 || request.answered[index]) return
        val hashes = message.optJSONArray("hashes") ?: return
        request.answered[index] = true
        request.answeredCount++
        if (contains(hashes, request.hash)) {
            request.owner = proxy
            request.timer?.invoke()
            val ask = json(
                "v" to 1, "type" to THUMBNAIL, "nonce" to request.nonce, "hash" to request.hash,
                "bounds" to request.bounds, "quality" to request.quality, "maxBytes" to request.maxBytes
            ).toString()
            post(proxy, ask)
            if (live !== request) return
            request.timer = schedule(OWNER_THUMBNAIL_MS) { if (live === request) finish(request, failure(TIMEOUT)) }
        } else if (request.answeredCount == request.frames.size) {
            finish(request, failure(NO_OWNER))
        }
    }

    /**
     * The owner's thumbnail or refusal: taken from the owner's proxy for the live nonce alone,
     * and handed to the core as it came – save a result whose base64 is longer than the bytes
     * the core allowed can encode to (`4/3 · maxBytes`), which is `too-large` here.
     */
    private fun onThumbnail(message: JSONObject, proxy: P) {
        val request = live ?: return
        if (message.optString("nonce") != request.nonce) return
        if (request.owner == null || proxy !== request.owner) return
        val result = message.optJSONObject("result") ?: return
        val base64 = result.optJSONObject("thumbnail")?.optString("base64") ?: ""
        if (base64.length.toLong() * 3 > request.maxBytes * 4) {
            finish(request, failure(TOO_LARGE))
            return
        }
        finish(request, result.toString())
    }

    /**
     * The main frame's hello: a new main document, whose navigation started at [documentStart]
     * (`performance.timeOrigin`; NaN when the hello carried none). The frames stamped before it
     * were the old document's and go, and so does one whose stamp is unknown; a frame stamped at
     * or after it is the new document's – its hello landed before the main frame's, which the
     * stamps make harmless – and stays. Without a stamp everything goes, as `onPageStarted` once
     * did. Any live request was the old document's: its reply is `timeout` (the core takes the
     * address route).
     */
    fun documentStarted(documentStart: Double) {
        if (documentStart.isNaN()) {
            frames.clear()
        } else {
            frames.values.removeAll { stamp -> stamp.isNaN() || stamp < documentStart }
        }
        live?.let { finish(it, failure(TIMEOUT)) }
    }

    /** The view is going: every frame is forgotten and a live request answers `timeout`. */
    fun destroy() {
        frames.clear()
        live?.let { finish(it, failure(TIMEOUT)) }
    }

    private fun finish(request: Request<P>, json: String) {
        request.timer?.invoke()
        request.timer = null
        if (live === request) live = null
        request.reply(json)
    }

    private class Request<P : Any>(
        val nonce: String,
        /** `H`: what an owner's `hashes` must contain. */
        val hash: String,
        /** The frames the question went to, in broadcast order. */
        val frames: List<P>,
        val mainFrame: P?,
        val bounds: JSONObject,
        val quality: Double,
        val maxBytes: Long,
        val reply: (String) -> Unit
    ) {
        var owner: P? = null
        val answered = BooleanArray(frames.size)
        var answeredCount = 0
        /** What cancels the timer running – the collect window, then the owner's deadline. */
        var timer: (() -> Unit)? = null
    }

    companion object {
        /** Host → every frame: the nonce (no hash goes down, §2.1 option B). */
        const val QUESTION = "zen:image-owner?"
        /** Frame → host: its salted hashes (§2.2). */
        const val ANSWER = PageMessageRoute.IMAGE_OWNER
        /** Host → owner: the ask (§2.3); owner → host: the result (§2.4). */
        const val THUMBNAIL = PageMessageRoute.IMAGE_THUMBNAIL
        /** From the broadcast: how long the host waits for answers while none has matched. */
        const val OWNER_COLLECT_MS = 300L
        /** From the ask: how long the host waits for the owner's thumbnail. */
        const val OWNER_THUMBNAIL_MS = 15_000L
        /** The most hashes the host reads out of one answer (the frame's cap, §2.2). */
        const val OWNER_MAX_HASHES = 2048
        /** The most sub-frame proxies kept per tab; past it the oldest goes. */
        const val OWNER_MAX_FRAMES = 256
        const val NO_OWNER = "no-owner"
        const val TIMEOUT = "timeout"
        const val UNSUPPORTED = "unsupported"
        const val TOO_LARGE = "too-large"

        /** An `ImageFetchResult` refusal as JSON text. */
        fun failure(reason: String): String = json("ok" to false, "reason" to reason).toString()

        /** The URL as hashed: cut at its first `#`, nothing else changed (§2.6). */
        fun hashInput(url: String): String = url.substringBefore('#')

        /** `lowercase_hex(SHA-256(UTF-8(nonce ‖ url)))` (§2.5). */
        fun hashFor(nonce: String, url: String): String =
            hex(MessageDigest.getInstance("SHA-256").digest((nonce + url).toByteArray(Charsets.UTF_8)))

        private fun hex(bytes: ByteArray): String {
            val out = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                val v = b.toInt() and 0xff
                out.append(HEX[v ushr 4]).append(HEX[v and 0xf])
            }
            return out.toString()
        }

        private const val HEX = "0123456789abcdef"

        /** Whether the answer's list names the hash – `contains`, never one value's equality (§5 rule 2). */
        private fun contains(hashes: JSONArray, hash: String): Boolean {
            val n = minOf(hashes.length(), OWNER_MAX_HASHES)
            for (i in 0 until n) if (hashes.optString(i) == hash) return true
            return false
        }
    }
}
