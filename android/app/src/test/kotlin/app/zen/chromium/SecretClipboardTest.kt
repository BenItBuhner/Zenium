package app.zen.chromium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The decision behind `clipboard.clearText`: only the secret the core copied is taken away again. */
class SecretClipboardTest {
    @Test
    fun theCopiedSecretIsCleared() {
        assertTrue(SecretClipboard.holdsSecret("hunter2", "hunter2"))
    }

    @Test
    fun somethingTheUserCopiedSinceIsLeftAlone() {
        assertFalse(SecretClipboard.holdsSecret("a shopping list", "hunter2"))
        assertFalse(SecretClipboard.holdsSecret("hunter2 ", "hunter2"))
    }

    @Test
    fun anUnreadableOrEmptyClipboardIsLeftAlone() {
        // Android 10+ hides the clipboard from a backgrounded app: nothing is known, nothing cleared.
        assertFalse(SecretClipboard.holdsSecret(null, "hunter2"))
        assertFalse(SecretClipboard.holdsSecret("", "hunter2"))
    }

    @Test
    fun anEmptySecretNeverMatches() {
        assertFalse(SecretClipboard.holdsSecret("", ""))
        assertFalse(SecretClipboard.holdsSecret(null, ""))
    }
}
