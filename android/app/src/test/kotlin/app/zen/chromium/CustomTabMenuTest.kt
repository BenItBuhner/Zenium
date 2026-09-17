package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

class CustomTabMenuTest {
    @Test
    fun zeniumRowsWithoutCallerItems() {
        val groups = CustomTabMenu.groups(emptyList(), share = true)
        assertEquals(
            listOf(
                listOf(CustomTabMenu.Item.Share, CustomTabMenu.Item.CopyLink, CustomTabMenu.Item.Reload, CustomTabMenu.Item.FindInPage),
                listOf(CustomTabMenu.Item.OpenInZenium)
            ),
            groups
        )
    }

    @Test
    fun shareCanBeTurnedOffByTheCaller() {
        val page = CustomTabMenu.groups(emptyList(), share = false).first()
        assertEquals(listOf(CustomTabMenu.Item.CopyLink, CustomTabMenu.Item.Reload, CustomTabMenu.Item.FindInPage), page)
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
}
