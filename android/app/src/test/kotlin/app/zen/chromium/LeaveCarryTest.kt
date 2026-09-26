package app.zen.chromium

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The user's Leave at a page's `beforeunload` objection, carried to the re-issued load of the
 * navigation it was given for (`LeaveCarry`): the tap's objection is asked once, the held
 * navigation's browser-initiated re-issue is not asked again.
 */
class LeaveCarryTest {
    private val carry = LeaveCarry(windowMs = 2_000L)

    @Test
    fun aLeaveCarriesToTheHoldThatFollowsAndAnswersTheReissuedLoadsObjectionOnce() {
        carry.leaveChosen(now = 10_000L)
        // The renderer starts the navigation the moment the sheet answers; the hook holds it.
        val letGo = carry.holds(now = 10_030L)
        assertTrue(letGo)
        // The core answered; the view re-issued the load and the browser asked the page again.
        carry.resumed(now = 10_080L, letGo = letGo)
        assertTrue(carry.answers(now = 10_120L))
        // Spent: another objection is the sheet's.
        assertFalse(carry.answers(now = 10_130L))
    }

    @Test
    fun theWatchdogsResumeStillCarriesTheLeave() {
        // The core did not answer within its 1.5 s: the hold resumes on the pushed document. The
        // Leave is the hold's, not the clock's, so the second objection is answered all the same.
        carry.leaveChosen(now = 0L)
        val letGo = carry.holds(now = 20L)
        carry.resumed(now = 1_520L, letGo = letGo)
        assertTrue(carry.answers(now = 1_600L))
    }

    @Test
    fun aHoldLongAfterTheLeaveIsNotTheNavigationItWasGivenFor() {
        carry.leaveChosen(now = 0L)
        assertFalse(carry.holds(now = 2_000L))
        // And the Leave is spent by the asking.
        assertFalse(carry.holds(now = 2_001L))
    }

    @Test
    fun aLateSecondObjectionIsAskedAgainTheSafeSide() {
        carry.leaveChosen(now = 0L)
        carry.resumed(now = 100L, letGo = carry.holds(now = 20L))
        assertFalse(carry.answers(now = 2_100L))
    }

    @Test
    fun aLeaveCarriesToExactlyOneHold() {
        carry.leaveChosen(now = 0L)
        assertTrue(carry.holds(now = 10L))
        // A redirect hop held next, say: not the navigation the user was asked about.
        assertFalse(carry.holds(now = 20L))
    }

    @Test
    fun aHoldWithoutALeaveResumesWithNothingToAnswer() {
        // The page did not object (or the user was never asked): the re-issued load's objection,
        // should the page raise one, is the sheet's.
        carry.resumed(now = 100L, letGo = carry.holds(now = 50L))
        assertFalse(carry.answers(now = 150L))
    }

    @Test
    fun anotherLoadOrTheDocumentStartingDropsWhatWasCarried() {
        carry.leaveChosen(now = 0L)
        carry.reset()
        assertFalse(carry.holds(now = 10L))
        carry.leaveChosen(now = 100L)
        carry.resumed(now = 150L, letGo = carry.holds(now = 120L))
        carry.reset()
        assertFalse(carry.answers(now = 200L))
    }

    @Test
    fun aNewLeaveSupersedesACarriedOne() {
        carry.leaveChosen(now = 0L)
        carry.resumed(now = 50L, letGo = carry.holds(now = 20L))
        // The user was asked again (a sheet the window missed) and chose to leave once more:
        // that Leave is for the navigation on its way now, the old carry is not an answer.
        carry.leaveChosen(now = 3_000L)
        assertFalse(carry.answers(now = 3_010L))
        assertTrue(carry.holds(now = 3_020L))
    }

    @Test
    fun theClockGoingBackwardsCarriesNothing() {
        carry.leaveChosen(now = 1_000L)
        assertFalse(carry.holds(now = 900L))
    }
}
