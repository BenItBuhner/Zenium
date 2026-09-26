package app.zen.chromium

/**
 * The rows of a custom tab's menu, as data: the icon row first, then the caller's own entries
 * (Chrome's order), then Zenium's page actions, then the way out into the full browser, each
 * group under a hairline. Pure, so the caps, the share toggle, the caller's two button switches
 * and the page's state have a JVM test; [CustomTabMenuSheet] draws it.
 */
object CustomTabMenu {
    sealed class Item {
        /** One of the caller's `EXTRA_MENU_ITEMS`, by its position in the intent. */
        data class Caller(val index: Int, val title: String) : Item()
        data object Share : Item()
        data object CopyLink : Item()
        /** The web app's text row; a custom tab reloads from its icon row, so the row reads once (§9.13). */
        data object Reload : Item()
        data object FindInPage : Item()
        data object AddToHomeScreen : Item()
        /** Chrome's check row: on while the page is asked for as a desktop site. */
        data class DesktopSite(val checked: Boolean) : Item()
        data object OpenInZenium : Item()
    }

    /** The icon row's glyphs in Chrome's order. The two the caller may switch off leave the row rather than grey out. */
    enum class Icon { Forward, Bookmark, Download, Info, Reload }

    /**
     * One button of the icon row. [filled] is the star's bookmarked state; [stop] is Reload read as
     * Stop while the page loads (read once at open, as the phone's row does).
     */
    data class IconButton(val icon: Icon, val enabled: Boolean = true, val filled: Boolean = false, val stop: Boolean = false)

    /** What the page is doing when the menu opens, read once. */
    data class PageState(
        val canGoForward: Boolean = false,
        val bookmarked: Boolean = false,
        val loading: Boolean = false,
        val desktopSite: Boolean = false
    )

    /**
     * The icon row: Forward (enabled only with a forward entry), Bookmark (filled when the page is
     * bookmarked; absent when the caller sent `EXTRA_DISABLE_BOOKMARKS_BUTTON`), Download (absent
     * under `EXTRA_DISABLE_DOWNLOAD_BUTTON`), Info, Reload or Stop.
     */
    fun iconRow(state: PageState, bookmarks: Boolean, download: Boolean): List<IconButton> {
        val row = ArrayList<IconButton>(5)
        row.add(IconButton(Icon.Forward, enabled = state.canGoForward))
        if (bookmarks) row.add(IconButton(Icon.Bookmark, filled = state.bookmarked))
        if (download) row.add(IconButton(Icon.Download))
        row.add(IconButton(Icon.Info))
        row.add(IconButton(Icon.Reload, stop = state.loading))
        return row
    }

    /**
     * `callerTitles` in intent order (blank ones are skipped, at most [CustomTabConfig.MAX_MENU_ITEMS]
     * kept); [desktopSite] is the check row's state.
     */
    fun groups(callerTitles: List<String>, share: Boolean, desktopSite: Boolean = false): List<List<Item>> {
        val groups = ArrayList<List<Item>>()
        val caller = callerTitles.withIndex()
            .filter { it.value.isNotBlank() }
            .take(CustomTabConfig.MAX_MENU_ITEMS)
            .map { Item.Caller(it.index, it.value.trim()) }
        if (caller.isNotEmpty()) groups.add(caller)
        val page = ArrayList<Item>()
        if (share) page.add(Item.Share)
        page.add(Item.CopyLink)
        page.add(Item.FindInPage)
        page.add(Item.AddToHomeScreen)
        page.add(Item.DesktopSite(desktopSite))
        groups.add(page)
        groups.add(listOf(Item.OpenInZenium))
        return groups
    }

    /**
     * An installed web app's overflow (PWA-08, [WebAppActivity]): no caller and no icon row, so the
     * page actions alone – Share, Copy link, Reload – and the way out into the browser as a tab.
     * Find in page is the custom tab's (its bar hosts the find field; the app's window has no bar
     * in scope).
     */
    fun webAppGroups(): List<List<Item>> = listOf(
        listOf(Item.Share, Item.CopyLink, Item.Reload),
        listOf(Item.OpenInZenium)
    )
}
