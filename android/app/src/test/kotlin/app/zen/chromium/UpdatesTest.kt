package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    @Test
    fun `the debug build type's applicationId is a debug id`() {
        assertTrue(Updates.isDebugApplicationId("app.zen.chromium.debug"))
        assertTrue(Updates.isDebugApplicationId("org.example.zenium" + Updates.DEBUG_ID_SUFFIX))
    }

    @Test
    fun `release ids are not`() {
        assertFalse(Updates.isDebugApplicationId("app.zen.chromium"))
        assertFalse(Updates.isDebugApplicationId("app.zen.chromium.debugger"))
        assertFalse(Updates.isDebugApplicationId("app.zen.debug.chromium"))
        assertFalse(Updates.isDebugApplicationId(""))
    }

    @Test
    fun `the suffix is the one the build script appends`() {
        assertEquals(".debug", Updates.DEBUG_ID_SUFFIX)
    }
}
