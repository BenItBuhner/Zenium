package app.zen.chromium.ext

import app.zen.chromium.ext.WorkerScriptGate.Verdict
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The gate a background document's requests for its own worker script pass: the generated
 * page's one `<script src>` is served, a `<script>` the worker script appended through the page's
 * bare `document` (tl;dv's Firebase Auth loader, `?onload=__iframefcb<N>`) is refused.
 */
class WorkerScriptGateTest {
    private val tldv = "lknmjhcajhfbbglglccadlfdjbaiifig"
    private val other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    @Test
    fun `the page's own script tag is served and the appended ones are refused, the first refusal told apart`() {
        val gate = WorkerScriptGate()
        gate.documentServed(tldv)
        // The generated page's `<script src="/background.js">`.
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        // `<script src="?onload=__iframefcb425151">` appended by the worker script, and the next.
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSED_AGAIN, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSED_AGAIN, gate.scriptRequest(tldv))
        assertEquals(3, gate.refusals(tldv))
    }

    @Test
    fun `a new document of the same background serves its own tag once more and counts afresh`() {
        val gate = WorkerScriptGate()
        gate.documentServed(tldv)
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
        // The worker restarted (or the page reloaded): the main-frame answer goes out again.
        gate.documentServed(tldv)
        assertEquals(0, gate.refusals(tldv))
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
        assertEquals(1, gate.refusals(tldv))
    }

    @Test
    fun `extensions are gated apart`() {
        val gate = WorkerScriptGate()
        gate.documentServed(tldv)
        gate.documentServed(other)
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
        // The other extension's page has not asked yet: its own tag is still to be served.
        assertEquals(Verdict.SERVE, gate.scriptRequest(other))
        assertEquals(0, gate.refusals(other))
        assertEquals(1, gate.refusals(tldv))
    }

    @Test
    fun `a document never announced still gets its one script, so the page's tag is never refused`() {
        val gate = WorkerScriptGate()
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
    }

    @Test
    fun `a stopped background is forgotten, its count read first, and the next document is served once again`() {
        val gate = WorkerScriptGate()
        gate.documentServed(tldv)
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSED_AGAIN, gate.scriptRequest(tldv))
        // stopBackground: the count goes to the log, then the document is forgotten.
        assertEquals(2, gate.refusals(tldv))
        gate.forget(tldv)
        assertEquals(0, gate.refusals(tldv))
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
    }

    @Test
    fun `a reset forgets every document, and the next requests are served once again`() {
        val gate = WorkerScriptGate()
        gate.documentServed(tldv)
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
        gate.reset()
        assertEquals(0, gate.refusals(tldv))
        assertEquals(Verdict.SERVE, gate.scriptRequest(tldv))
        assertEquals(Verdict.REFUSE, gate.scriptRequest(tldv))
    }
}
