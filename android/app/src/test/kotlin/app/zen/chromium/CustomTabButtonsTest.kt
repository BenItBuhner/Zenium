package app.zen.chromium

import androidx.browser.customtabs.CustomTabsIntent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CustomTabButtonsTest {
    @Test
    fun idZeroIsTheTopBarUnlessTheActionBundleHoldsIt() {
        // No action bundle: the list's id-0 entry takes the top slot, the rest the bottom bar.
        val placed = CustomTabButtons.place(false, listOf(7, 0, 9))
        assertEquals(1, placed.top)
        assertEquals(listOf(0, 2), placed.bottom)
        // With the action bundle the top slot is taken; the list's id-0 entry is a duplicate and drops.
        val taken = CustomTabButtons.place(true, listOf(7, 0, 9))
        assertNull(taken.top)
        assertEquals(listOf(0, 2), taken.bottom)
    }

    @Test
    fun duplicateIdsDropAndTheBottomBarCapsAtFive() {
        val placed = CustomTabButtons.place(false, listOf(1, 2, 2, 3, 4, 5, 6, 7))
        assertNull(placed.top)
        // Indices of ids 1, 2, 3, 4, 5: the second 2 (index 2) and the sixth and seventh distinct ids drop.
        assertEquals(listOf(0, 1, 3, 4, 5), placed.bottom)
        assertEquals(CustomTabsIntent.getMaxToolbarItems(), CustomTabButtons.MAX_BOTTOM)
        assertEquals(CustomTabsIntent.TOOLBAR_ACTION_BUTTON_ID, CustomTabButtons.TOP_BAR_ID)
    }

    @Test
    fun clickTargetsAreDistinctRealIds() {
        assertEquals(listOf(11, 12), CustomTabButtons.clickTargets(intArrayOf(11, -1, 0, 12, 11)))
        assertEquals(emptyList<Int>(), CustomTabButtons.clickTargets(null))
    }

    @Test
    fun aRemoteViewsClickReportsItsIdInTheClickedIdExtra() {
        // Chrome's `CustomTabBottomBarDelegate`: the clicked view's id rides in this extra, by this
        // name, on the caller's `EXTRA_REMOTEVIEWS_PENDINGINTENT`; a caller reads nothing else.
        assertEquals("android.support.customtabs.extra.EXTRA_REMOTEVIEWS_CLICKED_ID" to 12, CustomTabButtons.remoteViewClick(12))
        assertEquals(CustomTabsIntent.EXTRA_REMOTEVIEWS_CLICKED_ID to 0x7f0a0033, CustomTabButtons.remoteViewClick(0x7f0a0033))
    }

    @Test
    fun theTopSlotIsTheCallersButtonElseShareUnlessShareIsOff() {
        // CCT-17, Chrome's adaptive toolbar button: the caller's action button always keeps the
        // slot, whatever it said of Share; without one, Share fills it unless Share is off.
        for (state in listOf(CustomTabsIntent.SHARE_STATE_DEFAULT, CustomTabsIntent.SHARE_STATE_ON, CustomTabsIntent.SHARE_STATE_OFF)) {
            assertEquals(CustomTabButtons.Slot.CALLER, CustomTabButtons.topSlot(callerButton = true, shareState = state))
        }
        assertEquals(CustomTabButtons.Slot.SHARE, CustomTabButtons.topSlot(callerButton = false, shareState = CustomTabsIntent.SHARE_STATE_DEFAULT))
        assertEquals(CustomTabButtons.Slot.SHARE, CustomTabButtons.topSlot(callerButton = false, shareState = CustomTabsIntent.SHARE_STATE_ON))
        assertEquals(CustomTabButtons.Slot.NONE, CustomTabButtons.topSlot(callerButton = false, shareState = CustomTabsIntent.SHARE_STATE_OFF))
        // A state the library does not name reads as the default, as Chrome's `getShareState` reads it.
        assertEquals(CustomTabButtons.Slot.SHARE, CustomTabButtons.topSlot(callerButton = false, shareState = 7))
    }

    @Test
    fun theLegacyShareMenuItemExtraFoldsIntoTheShareState() {
        // `EXTRA_SHARE_STATE` on or off is the word; the deprecated `EXTRA_DEFAULT_SHARE_MENU_ITEM`
        // only speaks when the state is the default, where false means off (Chrome's reading).
        assertEquals(CustomTabsIntent.SHARE_STATE_ON, CustomTabButtons.shareState(CustomTabsIntent.SHARE_STATE_ON, legacyShareItem = false))
        assertEquals(CustomTabsIntent.SHARE_STATE_OFF, CustomTabButtons.shareState(CustomTabsIntent.SHARE_STATE_OFF, legacyShareItem = true))
        assertEquals(CustomTabsIntent.SHARE_STATE_DEFAULT, CustomTabButtons.shareState(CustomTabsIntent.SHARE_STATE_DEFAULT, legacyShareItem = true))
        assertEquals(CustomTabsIntent.SHARE_STATE_OFF, CustomTabButtons.shareState(CustomTabsIntent.SHARE_STATE_DEFAULT, legacyShareItem = false))
        assertEquals(CustomTabsIntent.SHARE_STATE_DEFAULT, CustomTabButtons.shareState(7, legacyShareItem = true))
        // The menu's Share row and the toolbar's button read one state, so they never disagree.
        val off = CustomTabButtons.shareState(CustomTabsIntent.SHARE_STATE_DEFAULT, legacyShareItem = false)
        assertEquals(CustomTabButtons.Slot.NONE, CustomTabButtons.topSlot(callerButton = false, shareState = off))
    }

    @Test
    fun theExtrasZeniumReadsAreTheLibrarys() {
        // The provider reads the caller's extras by the library's names; a renamed constant would
        // silently turn the bottom toolbar off, so the names are pinned here.
        assertEquals("android.support.customtabs.extra.EXTRA_REMOTEVIEWS", CustomTabsIntent.EXTRA_REMOTEVIEWS)
        assertEquals("android.support.customtabs.extra.EXTRA_REMOTEVIEWS_VIEW_IDS", CustomTabsIntent.EXTRA_REMOTEVIEWS_VIEW_IDS)
        assertEquals("android.support.customtabs.extra.EXTRA_REMOTEVIEWS_PENDINGINTENT", CustomTabsIntent.EXTRA_REMOTEVIEWS_PENDINGINTENT)
        assertEquals("android.support.customtabs.extra.EXTRA_REMOTEVIEWS_CLICKED_ID", CustomTabsIntent.EXTRA_REMOTEVIEWS_CLICKED_ID)
        assertEquals("android.support.customtabs.extra.TOOLBAR_ITEMS", CustomTabsIntent.EXTRA_TOOLBAR_ITEMS)
        assertEquals("android.support.customtabs.customaction.ID", CustomTabsIntent.KEY_ID)
        assertEquals(
            "androidx.browser.customtabs.extra.SECONDARY_TOOLBAR_SWIPE_UP_GESTURE",
            CustomTabsIntent.EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE
        )
    }
}
