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
     * The switch's confirmation is not a departure: the device-credential activity (Android 10
     * and under) stops the window, and the prompt passed means the user was there. The stop is
     * noted under the prompt, never acted on by itself.
     */
    @Test
    fun aStopUnderAPromptThatPassesLocksNothing() {
        val lock = armed()
        assertFalse(lock.onLeave(screenLock = true, prompting = true))
        assertFalse(lock.locked)
        assertTrue(lock.stoppedUnderPrompt)
        assertFalse(lock.onPromptAnswered(ok = true, screenLock = true))
        assertFalse(lock.locked)
        assertFalse(lock.stoppedUnderPrompt)
    }

    /**
     * The hole the re-check found: Home, a call or the screen timing out while the switch's
     * confirmation is up. The system takes the prompt down as the task leaves (Android 11 and
     * later; `ERROR_CANCELED`), and whichever of the stop and the answer lands first, the user
     * must come back to locked private tabs – the one promise the switch makes.
     */
    @Test
    fun aRealDepartureDuringThePromptLocksOnTheAnswer() {
        // The stop first, the cancel after (the common order).
        val lock = armed()
        assertFalse(lock.onLeave(screenLock = true, prompting = true))
        assertFalse(lock.locked)
        assertTrue(lock.onPromptAnswered(ok = false, screenLock = true))
        assertTrue(lock.locked)
        assertFalse(lock.stoppedUnderPrompt)
        // The cancel first, then the stop with the prompt already gone: the plain leave arms.
        val raced = armed()
        assertFalse(raced.onPromptAnswered(ok = false, screenLock = true))
        assertFalse(raced.locked)
        assertTrue(raced.onLeave(screenLock = true, prompting = false))
        assertTrue(raced.locked)
    }

    /** A cancel in place – the sheet's Cancel, Back – with no stop seen is not a departure. */
    @Test
    fun aPromptCancelledInPlaceLocksNothing() {
        val lock = armed()
        assertFalse(lock.onPromptAnswered(ok = false, screenLock = true))
        assertFalse(lock.locked)
        // Unlock's own prompt cancelled while locked: still locked, nothing announced as new.
        lock.onLeave(screenLock = true)
        assertFalse(lock.onLeave(screenLock = true, prompting = true))
        assertFalse(lock.onPromptAnswered(ok = false, screenLock = true))
        assertTrue(lock.locked)
    }

    /** The answer arms on the same terms as a leave: the switch on, private tabs open, a screen lock to pass. */
    @Test
    fun theAnswerArmsOnTheSameTermsAsALeave() {
        // The switch flipped off under the prompt (its own message): nothing to arm.
        val off = armed().apply { setEnabled(false) }
        assertFalse(off.onLeave(screenLock = true, prompting = true))
        assertFalse(off.onPromptAnswered(ok = false, screenLock = true))
        assertFalse(off.locked)
        // The last private tab closed meanwhile (a "Close all" from the notification).
        val empty = armed().apply { setOpenTabs(0) }
        assertFalse(empty.onLeave(screenLock = true, prompting = true))
        assertFalse(empty.onPromptAnswered(ok = false, screenLock = true))
        assertFalse(empty.locked)
        // No screen lock to pass: never locks.
        val bare = armed()
        assertFalse(bare.onLeave(screenLock = false, prompting = true))
        assertFalse(bare.onPromptAnswered(ok = false, screenLock = false))
        assertFalse(bare.locked)
        // The stop is spent by the answer: a later cancel in place does not arm on it.
        val spent = armed()
        spent.onLeave(screenLock = true, prompting = true)
        spent.setEnabled(false)
        assertFalse(spent.onPromptAnswered(ok = false, screenLock = true))
        spent.setEnabled(true)
        assertFalse(spent.onPromptAnswered(ok = false, screenLock = true))
        assertFalse(spent.locked)
    }

    /**
     * The host's invariant: while the lock holds, no private page view is shown, whatever the
     * chrome's layout says (a card under the cover, the media notification's tap). The refused
     * views and the ones hidden as the lock went on are held for the release, and the guard stays
     * up while any is held; the core's own word on a view, or its destruction, ends the hold.
     */
    @Test
    fun aPrivateViewIsNeverShownUnderTheLockAndComesBackOnRelease() {
        val lock = armed()
        // Unlocked: every show goes through, nothing is held.
        assertFalse(lock.refusesShow("p1", private = true))
        assertFalse(lock.holdsHiddenViews)
        lock.onLeave(screenLock = true)
        // The views on screen as the lock went on are hidden and held.
        lock.hide("p1")
        assertTrue(lock.holdsHiddenViews)
        // A private view brought to the front under the lock is refused and held; a regular one shows.
        assertTrue(lock.refusesShow("p2", private = true))
        assertFalse(lock.refusesShow("r1", private = false))
        assertEquals(setOf("p1", "p2"), lock.hiddenViews)
        // The core's own word on p1 (its layout asks it hidden as the cover is up): the core's to bring back.
        assertTrue(lock.forget("p1"))
        assertFalse(lock.forget("p1"))
        assertEquals(setOf("p2"), lock.hiddenViews)
        // Released: what is held comes back to be shown, and nothing is held after.
        assertTrue(lock.release())
        assertEquals(setOf("p2"), lock.takeHidden())
        assertFalse(lock.holdsHiddenViews)
        assertFalse(lock.refusesShow("p2", private = true))
    }

    @Test
    fun aViewDestroyedUnderTheLockDropsOutOfTheHold() {
        val lock = armed()
        lock.onLeave(screenLock = true)
        assertTrue(lock.refusesShow("p1", private = true))
        assertTrue(lock.forget("p1"))
        assertFalse(lock.holdsHiddenViews)
        assertEquals(emptySet<String>(), lock.takeHidden())
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

    /**
     * The host's side of the decisions above, pinned at the source: `onStop` hands the lock the
     * prompt's state rather than skipping it (the departure-under-the-prompt hole), every prompt's
     * answer reaches the lock through `Reauth`'s hook, a show of a page view asks the lock first,
     * and the guard reads the lock's hold – the flag itself has its one writer (`PrivateBrowsingTest`).
     */
    @Test
    fun theHostArmsThroughTheLockAndNeverAroundIt() {
        val sources = listOf("src/main/kotlin/app/zen/chromium", "app/src/main/kotlin/app/zen/chromium").map(::File).first { it.isDirectory }
        val host = File(sources, "Host.kt").readText()
        val onStop = host.substringAfter("fun onStop()").substringBefore("\n    }\n")
        assertTrue("onStop hands the prompt's state to the lock", "privateLock.onLeave(reauth.available(), prompting = reauth.prompting)" in onStop)
        assertFalse("onStop no longer skips the lock under a prompt", "!reauth.prompting" in onStop)
        assertTrue("every prompt's answer reaches the lock", "Reauth(activity) { ok -> onPromptAnswered(ok) }" in host)
        assertTrue("privateLock.onPromptAnswered(ok, reauth.available())" in host)
        val setVisible = host.substringAfter("private fun setTabVisible(").substringBefore("\n    }\n")
        assertTrue("a show asks the lock first", "privateLock.refusesShow(tabId, Profiles.isPrivate(view.containerId))" in setVisible)
        assertTrue("the core's word ends the hold", "privateLock.forget(tabId)" in setVisible)
        assertTrue("lockedContent = privateLock.holdsHiddenViews" in host)
        val reauth = File(sources, "Reauth.kt").readText()
        // The hook fires ahead of the caller's callback, once per prompt: the lock is armed before the chrome hears the answer.
        val once = reauth.substringAfter("val once =").substringBefore("prompting = true")
        assertTrue(once.indexOf("onAnswered(ok)") in 0 until once.indexOf("callback(ok)"))
    }
}
