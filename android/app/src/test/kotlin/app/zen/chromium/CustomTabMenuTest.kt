package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabMenuTest {
    @Test
    fun zeniumRowsWithoutCallerItems() {
        val groups = CustomTabMenu.groups(emptyList(), share = true)
        assertEquals(
            listOf(
                listOf(
                    CustomTabMenu.Item.Share, CustomTabMenu.Item.CopyLink, CustomTabMenu.Item.FindInPage,
                    CustomTabMenu.Item.AddToHomeScreen, CustomTabMenu.Item.DesktopSite(checked = false)
                ),
                listOf(CustomTabMenu.Item.OpenInZenium)
            ),
            groups
        )
    }

    @Test
    fun shareCanBeTurnedOffByTheCaller() {
        val page = CustomTabMenu.groups(emptyList(), share = false).first()
        assertEquals(
            listOf(
                CustomTabMenu.Item.CopyLink, CustomTabMenu.Item.FindInPage,
                CustomTabMenu.Item.AddToHomeScreen, CustomTabMenu.Item.DesktopSite(checked = false)
            ),
            page
        )
    }

    @Test
    fun theDesktopSiteRowCarriesTheTabsState() {
        val page = CustomTabMenu.groups(emptyList(), share = true, desktopSite = true).first()
        assertEquals(CustomTabMenu.Item.DesktopSite(checked = true), page.last())
    }

    @Test
    fun aCustomTabReloadsFromItsIconRowNotATextRow() {
        // §9.13: Reload reads once, in the icon row; the text row is the web app's (no icon row there).
        val rows = CustomTabMenu.groups(listOf("Save"), share = true).flatten()
        assertFalse(rows.contains(CustomTabMenu.Item.Reload))
        assertTrue(CustomTabMenu.webAppGroups().flatten().contains(CustomTabMenu.Item.Reload))
    }

    @Test
    fun callerItemsComeFirstKeepTheirIndexAndAreCapped() {
        val titles = listOf("Save for later", " ", "Open in app", "Three", "Four", "Five", "Six", "Seven")
        val groups = CustomTabMenu.groups(titles, share = true)
        assertEquals(3, groups.size)
        val caller = groups.first().map { it as CustomTabMenu.Item.Caller }
        // The blank title is skipped and indices stay those of the intent, so the right PendingIntent fires.
        assertEquals(listOf(0, 2, 3, 4, 5), caller.map { it.index })
        assertEquals(listOf("Save for later", "Open in app", "Three", "Four", "Five"), caller.map { it.title })
        assertEquals(CustomTabConfig.MAX_MENU_ITEMS, caller.size)
    }

    @Test
    fun theIconRowIsChromesFiveInOrder() {
        val row = CustomTabMenu.iconRow(CustomTabMenu.PageState(), bookmarks = true, download = true)
        assertEquals(
            listOf(
                CustomTabMenu.Icon.Forward, CustomTabMenu.Icon.Bookmark, CustomTabMenu.Icon.Download,
                CustomTabMenu.Icon.Info, CustomTabMenu.Icon.Reload
            ),
            row.map { it.icon }
        )
    }

    @Test
    fun forwardIsEnabledOnlyWithAForwardEntry() {
        val without = CustomTabMenu.iconRow(CustomTabMenu.PageState(canGoForward = false), bookmarks = true, download = true)
        val with = CustomTabMenu.iconRow(CustomTabMenu.PageState(canGoForward = true), bookmarks = true, download = true)
        assertFalse(without.first { it.icon == CustomTabMenu.Icon.Forward }.enabled)
        assertTrue(with.first { it.icon == CustomTabMenu.Icon.Forward }.enabled)
        // Every other button stands enabled either way.
        assertTrue(without.filter { it.icon != CustomTabMenu.Icon.Forward }.all { it.enabled })
    }

    @Test
    fun theStarFillsOnABookmarkedPage() {
        val plain = star(CustomTabMenu.Star.None)
        val stored = star(CustomTabMenu.Star.Stored)
        assertFalse(plain.filled)
        assertTrue(stored.filled)
    }

    @Test
    fun theStarNamesWhatItsTapDoes() {
        // A filing in the inbox is what the next tap withdraws, so it is not the browser's `Edit Bookmark`:
        // the pending star is filled and marked pending (the sheet reads it `Remove Bookmark`); the stored
        // star is filled and not (its tap opens the editor in Zenium); an empty star is neither.
        val none = star(CustomTabMenu.Star.None)
        val pending = star(CustomTabMenu.Star.Pending)
        val stored = star(CustomTabMenu.Star.Stored)
        assertFalse(none.filled)
        assertFalse(none.pending)
        assertTrue(pending.filled)
        assertTrue(pending.pending)
        assertTrue(stored.filled)
        assertFalse(stored.pending)
    }

    private fun star(state: CustomTabMenu.Star): CustomTabMenu.IconButton =
        CustomTabMenu.iconRow(CustomTabMenu.PageState(bookmark = state), bookmarks = true, download = true)
            .first { it.icon == CustomTabMenu.Icon.Bookmark }

    @Test
    fun addToHomeScreenLeavesTheMenuWhereTheLauncherCannotPin() {
        // As Chrome's row does: out of the sheet, not a row whose tap does nothing.
        val page = CustomTabMenu.groups(emptyList(), share = true, addToHomeScreen = false).first()
        assertEquals(
            listOf(
                CustomTabMenu.Item.Share, CustomTabMenu.Item.CopyLink, CustomTabMenu.Item.FindInPage,
                CustomTabMenu.Item.DesktopSite(checked = false)
            ),
            page
        )
        // The default keeps the row, as every tab on a launcher that pins has it.
        assertTrue(CustomTabMenu.groups(emptyList(), share = true).first().contains(CustomTabMenu.Item.AddToHomeScreen))
    }

    @Test
    fun reloadReadsStopWhileThePageLoads() {
        val still = CustomTabMenu.iconRow(CustomTabMenu.PageState(loading = false), bookmarks = true, download = true)
        val loading = CustomTabMenu.iconRow(CustomTabMenu.PageState(loading = true), bookmarks = true, download = true)
        assertFalse(still.last().stop)
        assertTrue(loading.last().stop)
        assertEquals(CustomTabMenu.Icon.Reload, loading.last().icon)
    }

    @Test
    fun theCallerCanTakeTheStarAndDownloadOutOfTheRow() {
        // EXTRA_DISABLE_BOOKMARKS_BUTTON / EXTRA_DISABLE_DOWNLOAD_BUTTON: the button leaves; the rest respread.
        val noStar = CustomTabMenu.iconRow(CustomTabMenu.PageState(), bookmarks = false, download = true)
        assertEquals(
            listOf(CustomTabMenu.Icon.Forward, CustomTabMenu.Icon.Download, CustomTabMenu.Icon.Info, CustomTabMenu.Icon.Reload),
            noStar.map { it.icon }
        )
        val neither = CustomTabMenu.iconRow(CustomTabMenu.PageState(), bookmarks = false, download = false)
        assertEquals(listOf(CustomTabMenu.Icon.Forward, CustomTabMenu.Icon.Info, CustomTabMenu.Icon.Reload), neither.map { it.icon })
    }

    @Test
    fun aWebAppsOverflowIsThePageActionsAndTheWayOut() {
        assertEquals(
            listOf(
                listOf(CustomTabMenu.Item.Share, CustomTabMenu.Item.CopyLink, CustomTabMenu.Item.Reload),
                listOf(CustomTabMenu.Item.OpenInZenium)
            ),
            CustomTabMenu.webAppGroups()
        )
    }
}
