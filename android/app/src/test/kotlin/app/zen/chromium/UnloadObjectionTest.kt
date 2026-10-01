package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The answer to a page's `beforeunload` objection (`UnloadObjection`, OS-40): the user's sheet
 * for the page in front of them that they drive, a silent Leave for a hidden or agent-driven
 * page, and a check in flight settled as leave – never a sheet over the page the user is on.
 */
class UnloadObjectionTest {
    private fun decide(isShown: Boolean, agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean = false) =
        UnloadObjection.decide(isShown = isShown, agentDriven = agentDriven, checkInFlight = checkInFlight, reloadAsked = reloadAsked)

    @Test
    fun theShownUserDrivenPageIsAskedAsBefore() {
        assertEquals(UnloadObjection.Sheet(reload = false), decide(isShown = true, agentDriven = false, checkInFlight = false))
        assertEquals(UnloadObjection.Sheet(reload = true), decide(isShown = true, agentDriven = false, checkInFlight = false, reloadAsked = true))
        // Under a check the sheet is "Leave site?", whatever the core asked for just before.
        assertEquals(UnloadObjection.Sheet(reload = false), decide(isShown = true, agentDriven = false, checkInFlight = true))
        assertEquals(UnloadObjection.Sheet(reload = false), decide(isShown = true, agentDriven = false, checkInFlight = true, reloadAsked = true))
    }

    @Test
    fun aHiddenPageLeavesWithoutASheet() {
        assertEquals(UnloadObjection.LeaveSilently(reload = false), decide(isShown = false, agentDriven = false, checkInFlight = false))
        assertEquals(UnloadObjection.LeaveSilently(reload = true), decide(isShown = false, agentDriven = false, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun anAgentDrivenPageLeavesWithoutASheetShownOrNot() {
        assertEquals(UnloadObjection.LeaveSilently(reload = false), decide(isShown = true, agentDriven = true, checkInFlight = false))
        assertEquals(UnloadObjection.LeaveSilently(reload = false), decide(isShown = false, agentDriven = true, checkInFlight = false))
        assertEquals(UnloadObjection.LeaveSilently(reload = true), decide(isShown = true, agentDriven = true, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun aCheckInFlightOnAPageNobodyIsAskedForSettlesAsLeave() {
        assertEquals(UnloadObjection.SettleCheck, decide(isShown = false, agentDriven = false, checkInFlight = true))
        assertEquals(UnloadObjection.SettleCheck, decide(isShown = true, agentDriven = true, checkInFlight = true))
        assertEquals(UnloadObjection.SettleCheck, decide(isShown = false, agentDriven = true, checkInFlight = true))
        // A reload is never asked under a check; the word is ignored either way.
        assertEquals(UnloadObjection.SettleCheck, decide(isShown = false, agentDriven = false, checkInFlight = true, reloadAsked = true))
    }

    @Test
    fun theWholeTableHasASheetOnlyForTheShownUserDrivenPage() {
        for (isShown in listOf(true, false)) for (agentDriven in listOf(true, false)) for (check in listOf(true, false)) for (reload in listOf(true, false)) {
            val decision = decide(isShown, agentDriven, check, reload)
            val expectSheet = isShown && !agentDriven
            assertEquals("shown=$isShown agent=$agentDriven check=$check reload=$reload", expectSheet, decision is UnloadObjection.Sheet)
            if (!expectSheet) assertEquals("shown=$isShown agent=$agentDriven check=$check reload=$reload", check, decision is UnloadObjection.SettleCheck)
        }
    }
}
