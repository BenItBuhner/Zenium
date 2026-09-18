package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfilesTest {
    @Test
    fun everyContainerHasAProfileOfItsOwn() {
        assertEquals("Default", Profiles.nameFor(Profiles.DEFAULT_CONTAINER))
        assertEquals("zen-private", Profiles.nameFor(Profiles.PRIVATE_CONTAINER))
        assertEquals("zen-container-work", Profiles.nameFor("work"))
        // The core's PRIVATE_CONTAINER_ID (shared/types.ts).
        assertEquals("private", Profiles.PRIVATE_CONTAINER)
    }

    @Test
    fun onlyThePrivateContainerIsPrivate() {
        assertTrue(Profiles.isPrivate(Profiles.PRIVATE_CONTAINER))
        assertFalse(Profiles.isPrivate(Profiles.DEFAULT_CONTAINER))
        assertFalse(Profiles.isPrivate("work"))
    }
}
