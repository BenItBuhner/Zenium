package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The answer to a page's `beforeunload` objection (`UnloadObjection`, OS-40 / §9.23 on touch
 * hosts): a page the user is not looking at never puts a sheet in front of them. A check in
 * flight – every touch close path – settles as leave; an agent's page leaves silently; a hidden
 * user page stays; only the shown user page is asked, as before.
 */
class UnloadObjectionTest {
    private fun decide(isShown: Boolean, agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean = false) =
        UnloadObjection.decide(isShown = isShown, agentDriven = agentDriven, checkInFlight = checkInFlight, reloadAsked = reloadAsked)

    @Test
    fun theShownUsersPageIsAskedAsBefore() {
        assertEquals(UnloadObjection.Sheet(reload = false), decide(isShown = true, agentDriven = false, checkInFlight = false))
        assertEquals(UnloadObjection.Sheet(reload = true), decide(isShown = true, agentDriven = false, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun aHiddenUsersPageStaysWithoutASheet() {
        assertEquals(UnloadObjection.StayHidden, decide(isShown = false, agentDriven = false, checkInFlight = false))
        // The chrome's reload of a hidden tab is cancelled the same way.
        assertEquals(UnloadObjection.StayHidden, decide(isShown = false, agentDriven = false, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun aCheckInFlightSettlesAsLeaveWhoeverDrivesThePageShownOrNot() {
        for (shown in listOf(true, false)) for (agent in listOf(true, false)) {
            assertEquals("shown=$shown agent=$agent", UnloadObjection.SettleCheck, decide(isShown = shown, agentDriven = agent, checkInFlight = true))
            // A reload is never asked under a check; the word is ignored either way.
            assertEquals("shown=$shown agent=$agent reload", UnloadObjection.SettleCheck, decide(isShown = shown, agentDriven = agent, checkInFlight = true, reloadAsked = true))
        }
    }

    @Test
    fun anAgentDrivenPageLeavesWithoutASheetShownOrNot() {
        for (shown in listOf(true, false)) {
            assertEquals(UnloadObjection.LeaveSilently(reload = false), decide(isShown = shown, agentDriven = true, checkInFlight = false))
            assertEquals(UnloadObjection.LeaveSilently(reload = true), decide(isShown = shown, agentDriven = true, checkInFlight = false, reloadAsked = true))
        }
    }

    @Test
    fun theWholeTable() {
        for (shown in listOf(true, false)) for (agent in listOf(true, false)) for (check in listOf(true, false)) for (reload in listOf(true, false)) {
            val decision = decide(shown, agent, check, reload)
            val row = "shown=$shown agent=$agent check=$check reload=$reload"
            // Only the shown user page, outside a check, sees a sheet.
            assertEquals(row, shown && !agent && !check, decision is UnloadObjection.Sheet)
            assertEquals(row, check, decision is UnloadObjection.SettleCheck)
            assertEquals(row, agent && !check, decision is UnloadObjection.LeaveSilently)
            assertEquals(row, !shown && !agent && !check, decision is UnloadObjection.StayHidden)
            // The reload word stands only without a check, whoever drives the page.
            val reloadWord = when (decision) {
                is UnloadObjection.Sheet -> decision.reload
                is UnloadObjection.LeaveSilently -> decision.reload
                UnloadObjection.SettleCheck, UnloadObjection.StayHidden -> false
            }
            if (decision is UnloadObjection.Sheet || decision is UnloadObjection.LeaveSilently) assertEquals(row, reload, reloadWord)
        }
    }
}
