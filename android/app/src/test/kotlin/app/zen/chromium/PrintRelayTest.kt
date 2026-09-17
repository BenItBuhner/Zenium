package app.zen.chromium

import app.zen.chromium.PrintRelay.Step
import org.junit.Assert.assertEquals
import org.junit.Test

class PrintRelayTest {
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
}
