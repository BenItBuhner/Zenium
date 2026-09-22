package app.zen.chromium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugHooksTest {
    @Test
    fun `the hooks answer on a debuggable build alone`() {
        assertTrue(DebugHooks.enabled(debuggable = true))
        // A release build's `Host.debugEndRenderer` logs and leaves the renderer be.
        assertFalse(DebugHooks.enabled(debuggable = false))
    }
}
