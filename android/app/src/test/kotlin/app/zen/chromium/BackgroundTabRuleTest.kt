package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

class BackgroundTabRuleTest {
    private fun view(tabId: String, onScreen: Boolean, shownBefore: Boolean = true, behind: Boolean = false, switched: Boolean = false) =
        BackgroundTabRule.Tab(tabId, onScreen, shownBefore, behind, switched)

    @Test
    fun aSwitchLeavesTheTabThatWasOnScreenBehindTheOneThatIs() {
        // A was on screen, the core showed B and hid A: A is behind B.
        assertEquals(setOf("a"), BackgroundTabRule.behind(listOf(view("a", onScreen = false), view("b", onScreen = true))))
    }

    @Test
    fun theShowOfASwitchBeforeItsHideChangesNothing() {
        // The show lands first and the hide waits for the chrome's frame: both on screen, nobody behind.
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(listOf(view("a", onScreen = true), view("b", onScreen = true))))
    }

    @Test
    fun aCoverOverEveryTabIsNotASwitch() {
        // A sheet's recede, the URL field, the private lock: the tab on screen hidden with no tab
        // on it and no word from the core – the page under the cover stays visible to itself.
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(listOf(view("a", onScreen = false), view("b", onScreen = false, shownBefore = false))))
    }

    @Test
    fun theOverviewOpenIsASwitchAwayFromTheTabUnderIt() {
        // The overview opens over A (the lead's ruling on #728): the core names A's hide a switch,
        // and A is behind the overview with no tab on screen, as Chrome's tab is behind the switcher.
        assertEquals(setOf("a"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, switched = true), view("b", onScreen = false, shownBefore = false))))
        // The word reaches a view the stage had hidden already (the hide sent again for the
        // reason alone): the same pass, the same answer.
        assertEquals(setOf("a"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, switched = true))))
    }

    @Test
    fun theOverviewClosedWithoutAPickShowsTheTabAgain() {
        // Closed on A's own card: A's view is on screen again, its switch over – behind nothing.
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(listOf(view("a", onScreen = true, behind = true), view("b", onScreen = false, shownBefore = false))))
    }

    @Test
    fun anotherCardPickedFromTheOverviewLeavesTheCoveredTabBehind() {
        // B's card picked: B on screen, A – behind under the overview, and switched – stays behind B.
        assertEquals(setOf("a"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, behind = true, switched = true), view("b", onScreen = true))))
        // A tablet's split under the overview: both panes' tabs hear the switch; C's pick leaves both behind.
        assertEquals(setOf("a", "b"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, switched = true), view("b", onScreen = false, switched = true), view("c", onScreen = false, shownBefore = false))))
        assertEquals(setOf("a", "b"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, behind = true), view("b", onScreen = false, behind = true), view("c", onScreen = true))))
    }

    @Test
    fun aTabNeverOnScreenIsLeftAlone() {
        // A tab opened in the background, a tab restored at boot and not yet visited: not behind –
        // the boot's first show runs one pass that finds nobody behind, and nothing else changes.
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(listOf(view("a", onScreen = true), view("b", onScreen = false, shownBefore = false))))
        // Visited once and left: behind from then on.
        assertEquals(setOf("b"), BackgroundTabRule.behind(listOf(view("a", onScreen = true), view("b", onScreen = false))))
    }

    @Test
    fun aTabBehindStaysBehindUnderACoverUntilItIsOnScreenAgain() {
        // A behind B, then a sheet opens over B: A stays behind (its paused video must not resume
        // under the cover); B, hidden with nothing on screen and no word, is under a cover, not behind.
        assertEquals(setOf("a"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, behind = true), view("b", onScreen = false))))
        // The overview instead: B hears the switch too, and A stays behind as before.
        assertEquals(setOf("a", "b"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, behind = true), view("b", onScreen = false, switched = true))))
        // The card picked is A: A is on screen and behind nothing; B is behind A now.
        assertEquals(setOf("b"), BackgroundTabRule.behind(listOf(view("a", onScreen = true, behind = true), view("b", onScreen = false))))
    }

    @Test
    fun aSplitScreensTwoTabsAreBehindNothingAndTheOneAPaneLeavesIsBehind() {
        // A tablet's split: A and B on screen, C left by the right pane's switch to B.
        assertEquals(setOf("c"), BackgroundTabRule.behind(listOf(view("a", onScreen = true), view("b", onScreen = true), view("c", onScreen = false))))
    }

    @Test
    fun noViewsIsNobodyBehind() {
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(emptyList()))
    }
}
