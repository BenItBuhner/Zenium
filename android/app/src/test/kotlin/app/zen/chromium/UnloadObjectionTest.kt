package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The answer to a page's `beforeunload` objection (`UnloadObjection`, OS-40 / §9.23 on touch
 * hosts): a page the user is not looking at never puts a sheet in front of them. A check in
 * flight – every touch close path – settles as leave; an agent's page leaves silently; a user
 * page that is not in front stays; only the tab in front is asked, as before. "In front" is the
 * tab's word, not the view's: the view GONE under the URL field or the app menu is still the
 * tab the user is on.
 */
class UnloadObjectionTest {
    private fun decide(inFront: Boolean, agentDriven: Boolean, checkInFlight: Boolean, reloadAsked: Boolean = false) =
        UnloadObjection.decide(inFront = inFront, agentDriven = agentDriven, checkInFlight = checkInFlight, reloadAsked = reloadAsked)

    @Test
    fun theTabInFrontIsAskedAsBefore() {
        assertEquals(UnloadObjection.Sheet(reload = false), decide(inFront = true, agentDriven = false, checkInFlight = false))
        assertEquals(UnloadObjection.Sheet(reload = true), decide(inFront = true, agentDriven = false, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun aUsersPageNotInFrontStaysWithoutASheet() {
        assertEquals(UnloadObjection.StayHidden, decide(inFront = false, agentDriven = false, checkInFlight = false))
        // The chrome's reload of a tab behind another is cancelled the same way.
        assertEquals(UnloadObjection.StayHidden, decide(inFront = false, agentDriven = false, checkInFlight = false, reloadAsked = true))
    }

    @Test
    fun aCheckInFlightSettlesAsLeaveWhoeverDrivesThePageInFrontOrNot() {
        for (front in listOf(true, false)) for (agent in listOf(true, false)) {
            assertEquals("front=$front agent=$agent", UnloadObjection.SettleCheck, decide(inFront = front, agentDriven = agent, checkInFlight = true))
            // A reload is never asked under a check; the word is ignored either way.
            assertEquals("front=$front agent=$agent reload", UnloadObjection.SettleCheck, decide(inFront = front, agentDriven = agent, checkInFlight = true, reloadAsked = true))
        }
    }

    @Test
    fun anAgentDrivenPageLeavesWithoutASheetInFrontOrNot() {
        for (front in listOf(true, false)) {
            assertEquals(UnloadObjection.LeaveSilently(reload = false), decide(inFront = front, agentDriven = true, checkInFlight = false))
            assertEquals(UnloadObjection.LeaveSilently(reload = true), decide(inFront = front, agentDriven = true, checkInFlight = false, reloadAsked = true))
        }
    }

    @Test
    fun theWholeTable() {
        for (front in listOf(true, false)) for (agent in listOf(true, false)) for (check in listOf(true, false)) for (reload in listOf(true, false)) {
            val decision = decide(front, agent, check, reload)
            val row = "front=$front agent=$agent check=$check reload=$reload"
            // Only the user's tab in front, outside a check, sees a sheet.
            assertEquals(row, front && !agent && !check, decision is UnloadObjection.Sheet)
            assertEquals(row, check, decision is UnloadObjection.SettleCheck)
            assertEquals(row, agent && !check, decision is UnloadObjection.LeaveSilently)
            assertEquals(row, !front && !agent && !check, decision is UnloadObjection.StayHidden)
            // The reload word stands only without a check, whoever drives the page.
            val reloadWord = when (decision) {
                is UnloadObjection.Sheet -> decision.reload
                is UnloadObjection.LeaveSilently -> decision.reload
                UnloadObjection.SettleCheck, UnloadObjection.StayHidden -> false
            }
            if (decision is UnloadObjection.Sheet || decision is UnloadObjection.LeaveSilently) assertEquals(row, reload, reloadWord)
        }
    }

    /**
     * The predicate the table is fed: the tab's word, not the view's. The shown tab's view is
     * GONE under the URL field and the app menu (a cover, not a switch: the host's pass leaves
     * it in front), so a typed address or a menu Reload still reaches the sheet; only a tab
     * behind another, or under the overview, is out of the user's sight.
     */
    @Test
    fun inFrontIsTheTabsWordNotTheViews() {
        // Drawn: in front, whatever the posted pass last said (it runs a frame after a show).
        assertTrue(UnloadObjection.inFront(shown = true, behind = false))
        assertTrue(UnloadObjection.inFront(shown = true, behind = true))
        // GONE under a chrome surface (the URL field, a menu, a sheet): still the tab the user is on.
        assertTrue(UnloadObjection.inFront(shown = false, behind = false))
        // GONE behind another tab, or under the tab overview: not in front.
        assertFalse(UnloadObjection.inFront(shown = false, behind = true))
    }
}
