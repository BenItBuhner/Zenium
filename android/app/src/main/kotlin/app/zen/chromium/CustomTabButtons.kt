package app.zen.chromium

import androidx.browser.customtabs.CustomTabsIntent

/**
 * Where a caller's custom buttons go, and what a click on its RemoteViews reports. A
 * `CustomTabsIntent` may carry one button as `EXTRA_ACTION_BUTTON_BUNDLE` and a list of them as
 * `EXTRA_TOOLBAR_ITEMS`; each list entry names an id (`KEY_ID`, default [TOP_BAR_ID]). Chrome's
 * rule, kept here: the id [TOP_BAR_ID] means the top toolbar's action slot, any other id means the
 * bottom toolbar; duplicate ids are dropped, the bottom bar holds at most [MAX_BOTTOM]
 * (`CustomTabsIntent.getMaxToolbarItems()`). Pure (the library's names are constants), so the
 * placement and the click's extra have JVM tests; the bitmaps and intents are read by
 * `CustomTabConfig`.
 */
object CustomTabButtons {
    /** `CustomTabsIntent.TOOLBAR_ACTION_BUTTON_ID`. */
    const val TOP_BAR_ID = 0

    /** `CustomTabsIntent.getMaxToolbarItems()`. */
    const val MAX_BOTTOM = 5

    /**
     * Indices into the list of ids, in the caller's order: `top` is the list entry that becomes the
     * top bar's action button (null when the caller's own action bundle already fills that slot or
     * no entry asks for it), `bottom` the entries that make up the bottom toolbar.
     */
    data class Placement(val top: Int?, val bottom: List<Int>)

    /**
     * `actionBundle`: whether `EXTRA_ACTION_BUTTON_BUNDLE` supplied a usable button (it owns the top
     * slot then). `ids`: the `KEY_ID` of each usable `EXTRA_TOOLBAR_ITEMS` entry, in order.
     */
    fun place(actionBundle: Boolean, ids: List<Int>): Placement {
        val seen = HashSet<Int>()
        if (actionBundle) seen.add(TOP_BAR_ID)
        var top: Int? = null
        val bottom = ArrayList<Int>()
        ids.forEachIndexed { index, id ->
            if (!seen.add(id)) return@forEachIndexed
            if (id == TOP_BAR_ID) {
                top = index
            } else if (bottom.size < MAX_BOTTOM) {
                bottom.add(index)
            }
        }
        return Placement(top, bottom)
    }

    /**
     * The RemoteViews ids that take a click (`EXTRA_REMOTEVIEWS_VIEW_IDS`): each once, and never
     * `View.NO_ID` (-1) or 0, which name no view.
     */
    fun clickTargets(ids: IntArray?): List<Int> {
        if (ids == null) return emptyList()
        val out = ArrayList<Int>()
        for (id in ids) if (id > 0 && id !in out) out.add(id)
        return out
    }

    /**
     * What a click on one of the [clickTargets] tells the caller: the extra
     * `EXTRA_REMOTEVIEWS_CLICKED_ID` carrying the clicked view's id, on the caller's
     * `EXTRA_REMOTEVIEWS_PENDINGINTENT` with the page's URL as its data, as Chrome's
     * `CustomTabBottomBarDelegate` sends it. The extra's name and its value, for the activity to
     * put on the intent.
     */
    fun remoteViewClick(id: Int): Pair<String, Int> = CustomTabsIntent.EXTRA_REMOTEVIEWS_CLICKED_ID to id
}
