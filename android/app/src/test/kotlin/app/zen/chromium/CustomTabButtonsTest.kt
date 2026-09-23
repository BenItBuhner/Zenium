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
