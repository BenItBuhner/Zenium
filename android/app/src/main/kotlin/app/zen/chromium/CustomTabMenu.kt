package app.zen.chromium

/**
 * The rows of a custom tab's menu, as data: the caller's own entries first (Chrome's order), then
 * Zenium's page actions, then the way out into the full browser, each group under a hairline.
 * Pure, so the caps and the share toggle have a JVM test; [CustomTabMenuSheet] draws it.
 */
object CustomTabMenu {
    sealed class Item {
        /** One of the caller's `EXTRA_MENU_ITEMS`, by its position in the intent. */
        data class Caller(val index: Int, val title: String) : Item()
        data object Share : Item()
        data object CopyLink : Item()
        data object Reload : Item()
        data object FindInPage : Item()
        data object OpenInZenium : Item()
    }

    /** `callerTitles` in intent order (blank ones are skipped, at most [CustomTabConfig.MAX_MENU_ITEMS] kept). */
    fun groups(callerTitles: List<String>, share: Boolean): List<List<Item>> {
        val groups = ArrayList<List<Item>>()
        val caller = callerTitles.withIndex()
            .filter { it.value.isNotBlank() }
            .take(CustomTabConfig.MAX_MENU_ITEMS)
            .map { Item.Caller(it.index, it.value.trim()) }
        if (caller.isNotEmpty()) groups.add(caller)
        val page = ArrayList<Item>()
        if (share) page.add(Item.Share)
        page.add(Item.CopyLink)
        page.add(Item.Reload)
        page.add(Item.FindInPage)
        groups.add(page)
        groups.add(listOf(Item.OpenInZenium))
        return groups
    }
}
