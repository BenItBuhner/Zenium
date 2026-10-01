package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The answer to a page's `beforeunload` objection (`UnloadObjection`, OS-40): the user's sheet
 * for every page the user drives, as before – under the unload check or not – and for a page an
 * agent drives a silent Leave, or a check in flight settled as leave; never a sheet for the user
 * from an agent's page.
 */
class UnloadObjectionTest {
    private fun decide(agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean = false) =
        UnloadObjection.decide(agentDriven = agentDriven, checkInFlight = checkInFlight, reloadAsked = reloadAsked)

    @Test
    fun theUsersPageIsAskedAsBefore() {
        assertEquals(UnloadObjection.Sheet(reload = false), decide(agentDriven = false, checkInFlight = false))
        assertEquals(UnloadObjection.Sheet(reload = true), decide(agentDriven = false, checkInFlight = false, reloadAsked = true))
        // Under a check the sheet is "Leave site?", whatever the core asked for just before.
        assertEquals(UnloadObjection.Sheet(reload = false), decide(agentDriven = false, checkInFlight = true))
        assertEquals(UnloadObjection.Sheet(reload = false), decide(agentDriven = false, checkInFlight = true, reloadAsked = true))
    }

    @Test
    fun anAgentDrivenPageLeavesWithoutASheet() {
        assertEquals(UnloadObjection.LeaveSilently(reload = false), decide(agentDriven = true, checkInFlight = false))
        assertEquals(UnloadObjection.LeaveSilently(reload = true), decide(agentDriven = true, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun aCheckInFlightOnAnAgentDrivenPageSettlesAsLeave() {
        assertEquals(UnloadObjection.SettleCheck, decide(agentDriven = true, checkInFlight = true))
        // A reload is never asked under a check; the word is ignored either way.
        assertEquals(UnloadObjection.SettleCheck, decide(agentDriven = true, checkInFlight = true, reloadAsked = true))
    }

    @Test
    fun theWholeTableTurnsOnTheAgentAlone() {
        for (agentDriven in listOf(true, false)) for (check in listOf(true, false)) for (reload in listOf(true, false)) {
            val decision = decide(agentDriven, check, reload)
            val row = "agent=$agentDriven check=$check reload=$reload"
            assertEquals(row, !agentDriven, decision is UnloadObjection.Sheet)
            if (agentDriven) assertEquals(row, check, decision is UnloadObjection.SettleCheck)
            // The reload word stands only without a check, whoever drives the page.
            val reloadWord = when (decision) {
                is UnloadObjection.Sheet -> decision.reload
                is UnloadObjection.LeaveSilently -> decision.reload
                UnloadObjection.SettleCheck -> false
            }
            assertEquals(row, reload && !check, reloadWord)
        }
    }
}
