package app.zen.chromium

import app.zen.chromium.UnresponsivePolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UnresponsivePolicyTest {
    private var now = 5_000_000L
    private val policy = UnresponsivePolicy { now }

    @Test
    fun `the first report shows the prompt, the reports that follow while it is up do not`() {
        assertEquals(Action.SHOW, policy.unresponsive())
        assertTrue(policy.showing)
        // The chrome's and the other tabs' reports of the same moment, and the platform's next interval.
        assertEquals(Action.NONE, policy.unresponsive())
        now += 5_000
        assertEquals(Action.NONE, policy.unresponsive())
    }

    @Test
    fun `the renderer answering again dismisses the prompt, once`() {
        assertEquals(Action.SHOW, policy.unresponsive())
        assertEquals(Action.DISMISS, policy.responsive())
        assertFalse(policy.showing)
        assertEquals("the other WebViews' responsive reports", Action.NONE, policy.responsive())
    }

    @Test
    fun `responsive without a prompt up is nothing`() {
        assertEquals(Action.NONE, policy.responsive())
    }

    @Test
    fun `wait keeps the prompt down while the renderer stays hung, until the grace has passed`() {
        assertEquals(Action.SHOW, policy.unresponsive())
        policy.waited()
        assertFalse(policy.showing)
        now += 5_000
        assertEquals(Action.NONE, policy.unresponsive())
        now += UnresponsivePolicy.WAIT_GRACE_MS - 5_001
        assertEquals("just short of the grace", Action.NONE, policy.unresponsive())
        now += 1
        assertEquals("still hung after the grace: asked again", Action.SHOW, policy.unresponsive())
    }

    @Test
    fun `a renderer that answered after wait starts over - the next hang prompts at once`() {
        assertEquals(Action.SHOW, policy.unresponsive())
        policy.waited()
        now += 1_000
        assertEquals("no prompt was up to dismiss", Action.NONE, policy.responsive())
        now += 1_000
        assertEquals(Action.SHOW, policy.unresponsive())
    }

    @Test
    fun `exit page ends the prompt and carries nothing over`() {
        assertEquals(Action.SHOW, policy.unresponsive())
        policy.ended()
        assertFalse(policy.showing)
        // The renderer is gone; the fresh one hanging later is asked about at once.
        now += 1_000
        assertEquals(Action.SHOW, policy.unresponsive())
    }

    @Test
    fun `the prompt names the page's host`() {
        assertEquals("example.com", UnresponsiveSite.of("https://example.com/a/b?c#d"))
        assertEquals("www.example.org", UnresponsiveSite.of("http://www.example.org"))
        assertEquals("10.0.2.2", UnresponsiveSite.of("http://10.0.2.2:8080/hang.html"))
        assertEquals("[::1]", UnresponsiveSite.of("http://[::1]:8080/"))
        assertEquals("example.net", UnresponsiveSite.of("https://user:secret@example.net/"))
        assertEquals(UnresponsiveSite.UNKNOWN, UnresponsiveSite.of(null))
        assertEquals(UnresponsiveSite.UNKNOWN, UnresponsiveSite.of(""))
        assertEquals(UnresponsiveSite.UNKNOWN, UnresponsiveSite.of("about:blank"))
        assertEquals(UnresponsiveSite.UNKNOWN, UnresponsiveSite.of("data:text/html,hi"))
    }
}
