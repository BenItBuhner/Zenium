package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

class BackgroundTabRuleTest {
    private fun view(tabId: String, onScreen: Boolean, shownBefore: Boolean = true, behind: Boolean = false) =
        BackgroundTabRule.View(tabId, onScreen, shownBefore, behind)

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
        // The overview (a sheet's recede, the private lock) hides the tab on screen with no tab on
        // it: the page under the cover stays visible to itself, as before.
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(listOf(view("a", onScreen = false), view("b", onScreen = false, shownBefore = false))))
    }

    @Test
    fun aTabNeverOnScreenIsLeftAlone() {
        // A tab opened in the background, a tab restored at boot and not yet visited: not behind,
        // so nothing of the boot or the new-tab path changes.
        assertEquals(emptySet<String>(), BackgroundTabRule.behind(listOf(view("a", onScreen = true), view("b", onScreen = false, shownBefore = false))))
        // Visited once and left: behind from then on.
        assertEquals(setOf("b"), BackgroundTabRule.behind(listOf(view("a", onScreen = true), view("b", onScreen = false))))
    }

    @Test
    fun aTabBehindStaysBehindUnderACoverUntilItIsOnScreenAgain() {
        // A behind B, then the overview opens over B: A stays behind (its paused video must not
        // resume under the cover); B, hidden with nothing on screen, is under a cover, not behind.
        assertEquals(setOf("a"), BackgroundTabRule.behind(listOf(view("a", onScreen = false, behind = true), view("b", onScreen = false))))
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
