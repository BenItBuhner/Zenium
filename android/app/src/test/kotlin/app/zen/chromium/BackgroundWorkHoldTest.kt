package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundWorkHoldTest {
    @Test
    fun `the hold is the launch intent's extra, on a debuggable build alone`() {
        assertTrue(BackgroundWorkHold.requested(extraSet = true, debuggable = true))
        // A normal launch carries no extra: never held, whatever the build.
        assertFalse(BackgroundWorkHold.requested(extraSet = false, debuggable = true))
        assertFalse(BackgroundWorkHold.requested(extraSet = false, debuggable = false))
        // Another app starting a release build with the extra must not put the protection lists off.
        assertFalse(BackgroundWorkHold.requested(extraSet = true, debuggable = false))
    }

    @Test
    fun `the names the harness and the chrome agree on`() {
        // The intent extra the harness puts on the launch (`-e holdBackgroundWork true`), namespaced
        // so no other extra of the activity's can collide with it.
        assertEquals("app.zen.chromium.extra.HOLD_BACKGROUND_WORK", BackgroundWorkHold.EXTRA_HOLD)
        // The host event `Host.releaseBackgroundWork()` raises: the key of the chrome's
        // `HostEventPayloads` (`src/android/platform.ts`), which calls `browser.background.release()`.
        assertEquals("background.release", BackgroundWorkHold.RELEASE_EVENT)
    }
}
