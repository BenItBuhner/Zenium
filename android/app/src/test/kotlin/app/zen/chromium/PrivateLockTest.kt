package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * "Lock private tabs when you leave Zenium" (INC-05 / SET-17), the host's half: the lock arms as
 * the window leaves with the switch on, private tabs open and a screen lock to pass, and comes
 * off by the screen lock passed, the last private tab closed, the switch turned off, or a screen
 * lock removed while the app was away. Off by default, as Chrome's; never persisted.
 */
class PrivateLockTest {
    private fun armed(): PrivateLock = PrivateLock().apply {
        setEnabled(true)
        setOpenTabs(2)
    }

    @Test
    fun offByDefaultAndTheSwitchAloneLocksNothing() {
        val lock = PrivateLock()
        assertFalse(lock.enabled)
        assertFalse(lock.locked)
        // The switch off: leaving locks nothing, private tabs or not.
        lock.setOpenTabs(3)
        assertFalse(lock.onLeave(screenLock = true))
        assertFalse(lock.locked)
        // The switch on, no private tab: nothing to lock.
        val empty = PrivateLock().apply { setEnabled(true) }
        assertFalse(empty.onLeave(screenLock = true))
        assertFalse(empty.locked)
    }

    @Test
    fun leavingLocksWithTheSwitchOnPrivateTabsOpenAndAScreenLockSet() {
        val lock = armed()
        assertTrue(lock.onLeave(screenLock = true))
        assertTrue(lock.locked)
        // Leaving again while locked (the credential activity in front, the screen off twice) changes nothing.
        assertFalse(lock.onLeave(screenLock = true))
        assertTrue(lock.locked)
    }

    /** The switch is disabled without a screen lock in Settings; the same rule holds at the source. */
    @Test
    fun aDeviceWithoutAScreenLockNeverLocks() {
        val lock = armed()
        assertFalse(lock.onLeave(screenLock = false))
        assertFalse(lock.locked)
    }

    @Test
    fun theScreenLockPassedReleasesTheLockOnce() {
        val lock = armed()
        lock.onLeave(screenLock = true)
        assertTrue(lock.release())
        assertFalse(lock.locked)
        // A second pass (a prompt answered late) is not a change to announce.
        assertFalse(lock.release())
    }

    @Test
    fun theLastPrivateTabClosedReleasesTheLock() {
        val lock = armed()
        lock.onLeave(screenLock = true)
        // One of two closed: still locked over the one left.
        assertFalse(lock.setOpenTabs(1))
        assertTrue(lock.locked)
        assertTrue(lock.setOpenTabs(0))
        assertFalse(lock.locked)
        // With none open the next leave locks nothing; a new private tab arms it again.
        assertFalse(lock.onLeave(screenLock = true))
        lock.setOpenTabs(1)
        assertTrue(lock.onLeave(screenLock = true))
    }

    @Test
    fun theSwitchTurnedOffReleasesTheLock() {
        val lock = armed()
        lock.onLeave(screenLock = true)
        assertTrue(lock.setEnabled(false))
        assertFalse(lock.locked)
        assertFalse(lock.enabled)
        // Turned on again: the tabs still open are not locked until the next leave.
        assertFalse(lock.setEnabled(true))
        assertFalse(lock.locked)
    }

    @Test
    fun aScreenLockRemovedWhileAwayLetsGoOnReturn() {
        val lock = armed()
        lock.onLeave(screenLock = true)
        // The screen lock still set: the lock holds for the prompt.
        assertFalse(lock.onReturn(screenLock = true))
        assertTrue(lock.locked)
        // Removed in the system settings meanwhile: nothing could pass it, so it comes off.
        assertTrue(lock.onReturn(screenLock = false))
        assertFalse(lock.locked)
    }

    /**
     * The lock is the host's, in memory: the core keeps the switch (`state.privateDevice`), the
     * host nothing across a start. The switch and the count reach it by their two messages, and
     * the prompt is the one `Reauth` the password manager already uses, with the weak class
     * (`BIOMETRIC_WEAK or DEVICE_CREDENTIAL`: the device PIN, pattern or password pass it).
     */
    @Test
    fun theLockIsWiredToTheHostAndNeverStored() {
        val sources = listOf("src/main/kotlin/app/zen/chromium", "app/src/main/kotlin/app/zen/chromium").map(::File).first { it.isDirectory }
        val host = File(sources, "Host.kt").readText()
        assertTrue("\"private.setLockOnLeave\"" in host)
        assertTrue("\"private.setOpenTabs\"" in host)
        assertTrue("\"private.unlock\"" in host)
        assertTrue("\"private.lock\"" in host)
        assertTrue("privateLock.onLeave(" in host)
        assertTrue("strong = false" in host.substringAfter("private fun unlockPrivateTabs"))
        val lock = File(sources, "PrivateLock.kt").readText()
        assertFalse("SharedPreferences" in lock)
        assertFalse("File(" in lock)
        assertEquals(false, PrivateLock().locked)
    }
}
