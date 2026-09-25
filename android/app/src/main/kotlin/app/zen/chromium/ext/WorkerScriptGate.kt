package app.zen.chromium.ext

import java.util.concurrent.ConcurrentHashMap

/**
 * Whether a background document's request for its own worker script is the page's own, or a
 * second run of the script.
 *
 * An MV3 worker is emulated by a page at the worker script's own URL (so `self.location` reads
 * as in Chrome), and the generated page loads the script with one `<script src>` for that path
 * (`backgroundPageHtml` in the core's `boot.ts`): a sub-resource request of the background
 * document for the document's own path, the one such request a document legitimately makes.
 * The worker realm keeps a bare `document` (the standing bare-`window` limit), and a worker
 * script that appends a `<script src>` through it with a relative src resolves that src against
 * the page's URL – the script's own – so the served origin answered the file again and the whole
 * bundle ran a second time as a classic script of the page: a fresh scope, its own listeners and
 * ports, its own loader appending the next element. tl;dv's Firebase Auth build
 * (`<script src="?onload=__iframefcb<N>">`, its gapi URL empty) chained 115 such runs in 103 s
 * on compat round 18's AOSP lane, and the guest's low-memory killer took WebView's one sandboxed
 * renderer – every tab's document, every extension's background and the chrome – at 2.55 GB RSS.
 * Chrome's worker has no `document`: the append throws a ReferenceError once and the loader
 * rejects; the extension runs without gapi.
 *
 * So a background document's own script is served ONCE per document. [documentServed] when the
 * main-frame answer for the background document goes out (its own tag is still to come);
 * [scriptRequest] for each sub-resource request of that document for the worker's path:
 * [Verdict.SERVE] for the first of the document – the page's own tag – and a refusal for every
 * later one, which reaches the appended element as its `error` event, the loader's own rejection
 * path ([Verdict.REFUSE] the document's first refusal, the one the host logs; [Verdict.REFUSED_AGAIN]
 * the rest, silent). No legitimate worker path asks a second time: `importScripts` inlines the
 * script text, a module worker's import of its own URL is answered by the module map, and a
 * worker does not fetch its own script. A document that was never announced admits one request
 * (the page's tag must never be refused; a stale entry is cleared by the next document's answer).
 *
 * WebView's IO threads call [documentServed] and [scriptRequest] in the requests' order (the
 * document's answer is out before its parser asks for the script); the main thread reads
 * [refusals] for the one count line as the background view goes, then calls [forget], and
 * [reset] for a new runtime. Pure, so the JVM unit tests cover it.
 */
class WorkerScriptGate {
    enum class Verdict { SERVE, REFUSE, REFUSED_AGAIN }

    /** The ids whose current background document has had its worker script served. */
    private val served: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /** Refusals of the current document, per id (a count, so the first is told apart). */
    private val refused = ConcurrentHashMap<String, Int>()

    /** The background document itself is being served: its own `<script src>` is still to come. */
    fun documentServed(extensionId: String) = forget(extensionId)

    /** The background view went (stopped, restarted): nothing is remembered until its next document. */
    fun forget(extensionId: String) {
        served.remove(extensionId)
        refused.remove(extensionId)
    }

    /** A sub-resource request of the background document for the worker script's own path. */
    fun scriptRequest(extensionId: String): Verdict {
        if (served.add(extensionId)) return Verdict.SERVE
        val count = refused.merge(extensionId, 1, Int::plus) ?: 1
        return if (count == 1) Verdict.REFUSE else Verdict.REFUSED_AGAIN
    }

    /** How many requests of the current document were refused (for the log and the tests). */
    fun refusals(extensionId: String): Int = refused[extensionId] ?: 0

    /** Every extension went (a new runtime): nothing is remembered. */
    fun reset() {
        served.clear()
        refused.clear()
    }
}
