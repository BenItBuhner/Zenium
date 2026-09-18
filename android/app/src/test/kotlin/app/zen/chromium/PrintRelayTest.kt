package app.zen.chromium

import app.zen.chromium.PrintRelay.Step
import app.zen.chromium.PrintRelay.Take
import org.junit.Assert.assertEquals
import org.junit.Test

class PrintRelayTest {
    // --- handing the page to the spooler ---------------------------------------------------------

    @Test
    fun `bytes the spooler took mean carrying on, however long the pipe was full before`() {
        assertEquals(Step.CONTINUE, PrintRelay.nextStep(written = 4096, cancelled = false, idleMs = 0))
        assertEquals(Step.CONTINUE, PrintRelay.nextStep(written = 1, cancelled = false, idleMs = PrintRelay.IDLE_LIMIT_MS - 1))
    }

    @Test
    fun `a full pipe is waited on, one poll step at a time`() {
        assertEquals(Step.WAIT, PrintRelay.nextStep(written = 0, cancelled = false, idleMs = 0))
        assertEquals(Step.WAIT, PrintRelay.nextStep(written = 0, cancelled = false, idleMs = PrintRelay.IDLE_LIMIT_MS - PrintRelay.POLL_STEP_MS))
    }

    @Test
    fun `a spooler that has taken nothing for the idle limit is given up on`() {
        assertEquals(Step.GIVE_UP, PrintRelay.nextStep(written = 0, cancelled = false, idleMs = PrintRelay.IDLE_LIMIT_MS))
        assertEquals(Step.GIVE_UP, PrintRelay.nextStep(written = 0, cancelled = false, idleMs = PrintRelay.IDLE_LIMIT_MS + 1))
    }

    @Test
    fun `the spooler's cancellation wins over progress and waiting alike`() {
        assertEquals(Step.CANCEL, PrintRelay.nextStep(written = 4096, cancelled = true, idleMs = 0))
        assertEquals(Step.CANCEL, PrintRelay.nextStep(written = 0, cancelled = true, idleMs = 0))
        assertEquals(Step.CANCEL, PrintRelay.nextStep(written = 0, cancelled = true, idleMs = PrintRelay.IDLE_LIMIT_MS))
    }

    // --- taking the page from the WebView: when its descriptor may close -------------------------

    @Test
    fun `while the framework holds the descriptor it passed, the WebView's stays open whatever the file holds`() {
        // The WebView has not reported: it may still write into the descriptor's number.
        assertEquals(Take.WAIT, take(destinationClosed = false, size = 0, grew = false))
        assertEquals(Take.WAIT, take(destinationClosed = false, size = 1_000_000, grew = false))
        assertEquals(Take.WAIT, take(destinationClosed = false, size = 1_000_000, grew = false, wanted = false))
    }

    @Test
    fun `once the framework has closed its descriptor, a file that stopped growing is the whole page`() {
        // Still growing: the session ended mid-write and the renderer is finishing its one write.
        assertEquals(Take.WAIT, take(destinationClosed = true, size = 4096, grew = true))
        assertEquals(Take.DELIVER, take(destinationClosed = true, size = 4096, grew = false))
    }

    @Test
    fun `a page the spooler cancelled or the finished session no longer wants is dropped, once written`() {
        assertEquals(Take.WAIT, take(destinationClosed = true, size = 4096, grew = true, wanted = false))
        assertEquals(Take.DISCARD, take(destinationClosed = true, size = 4096, grew = false, wanted = false))
    }

    @Test
    fun `an empty file after the framework's close waits for the renderer's write up to the grace period`() {
        assertEquals(Take.WAIT, take(destinationClosed = true, size = 0, grew = false, closedForMs = 0))
        assertEquals(Take.WAIT, take(destinationClosed = true, size = 0, grew = false, closedForMs = PrintRelay.WRITE_GRACE_MS - 1))
        assertEquals(Take.DISCARD, take(destinationClosed = true, size = 0, grew = false, closedForMs = PrintRelay.WRITE_GRACE_MS))
        assertEquals(Take.DISCARD, take(destinationClosed = true, size = 0, grew = false, closedForMs = PrintRelay.WRITE_GRACE_MS, wanted = false))
    }

    private fun take(
        destinationClosed: Boolean,
        size: Long,
        grew: Boolean,
        closedForMs: Long = 0,
        wanted: Boolean = true
    ): Take = PrintRelay.takeStep(destinationClosed, size, grew, closedForMs, wanted)
}
