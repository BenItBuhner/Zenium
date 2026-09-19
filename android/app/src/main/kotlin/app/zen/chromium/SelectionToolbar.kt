package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Zenium's items in the floating toolbar over selected page text (the WebView's text-selection
 * action mode), the parts that need no view: the items as the core lists them, where they go
 * among the system's, and what a touch on one sends back. `TabWebView` wraps the WebView's
 * `ActionMode.Callback2` with `SelectionActionMode` and does the menu work through these.
 *
 * The WebView's own callback (Chromium's `SelectionPopupControllerImpl`) adds its items – Cut,
 * Copy, Paste, Share, Select all, Web search – on every `onPrepareActionMode`, removing its own
 * groups first and sorting by `order`; the framework's toolbar lays them out in menu order until
 * the width runs out and puts the rest behind the overflow. Zenium's items sit in a group of
 * their own (which Chromium leaves alone) and take Copy's `order`, so they insert right after
 * Copy whatever spacing the WebView's version gives its items, and come before Select all and
 * Web search: the system items are the ones the width pushes into the overflow. Only Copy is
 * identified for certain – its title is the framework's public `android.R.string.copy`, the one
 * Chromium uses; without it (a password field, an insertion handle's Paste toolbar) nothing is
 * added. The WebView's Share is the item of Copy's group titled like Zenium's Share or like the
 * framework's own Share string; it is hidden so one Share shows, Zenium's, through the system
 * sheet with Zenium's own actions in it (`app.share`).
 */
object SelectionToolbar {
    /** One item as the core lists it: the id handed back on a touch and the title shown (and read out). */
    data class Item(val id: String, val title: String)

    /** One of the system's items in the action mode's menu, as the plan sees it. */
    data class SystemItem(val groupId: Int, val order: Int, val title: String)

    /** The framework strings the system's items are told by (`copy` is `android.R.string.copy`). */
    data class Strings(val copy: String, val share: String?)

    /**
     * What to do to the menu: whether it has the system's Copy to anchor on (`anchored`: a text
     * selection, not a Paste toolbar or a password field), Zenium's `items` in order, each added
     * with `order` (Copy's, so they follow it), and the indexes into the system list of the items
     * to hide (the WebView's own Share, when Zenium's replaces it). Not anchored: nothing to do.
     */
    data class Plan(val anchored: Boolean, val order: Int, val items: List<Item>, val hidden: List<Int>) {
        val isEmpty: Boolean get() = items.isEmpty()
    }

    /** The action our items go into; Chromium removes only its own groups when it rebuilds the menu. */
    val GROUP: Int get() = R.id.zen_selection_group

    /** Menu item ids of our items: [FIRST_ITEM_ID] + the item's index; small ints no resource id shares. */
    const val FIRST_ITEM_ID = 1

    /** The id the core gives its Share action (see `Menus.selectionActions`). */
    const val SHARE_ID = "share"

    /** Selections longer than this are cut for the bridge; a search query or a share needs no more. */
    const val SELECTION_MAX_CHARS = 10_000

    /**
     * The page's selected text, as `evaluateJavascript` answers it (a JSON string): the frame's
     * own selection, or the first same-origin child frame's, since a selection inside an iframe
     * is not the top document's. Cross-origin frames cannot be read and answer "".
     */
    val SELECTION_SCRIPT: String =
        "(function(){function s(w){var t='';try{t=String(w.getSelection())}catch(e){}if(t)return t;" +
            "try{for(var i=0;i<w.frames.length;i++){t=s(w.frames[i]);if(t)return t}}catch(e){}return ''}" +
            "return s(window).slice(0,$SELECTION_MAX_CHARS)})()"

    /** The selected text out of the script's answer (the JSON text of a string; "" for anything else). */
    fun selectionText(raw: String?): String =
        runCatching { JSONTokener(raw ?: "").nextValue() as? String }.getOrNull() ?: ""

    /**
     * The core's list out of the bridge's answer: the JSON text of `[{ id, title }]`, in order.
     * Anything else – null (no core, a custom tab), "null", a malformed answer – is no items;
     * entries without an id or a title, and a second entry with an id already seen, are dropped.
     */
    fun parseItems(json: String?): List<Item> {
        val array = runCatching { JSONTokener(json ?: "").nextValue() as? JSONArray }.getOrNull() ?: return emptyList()
        val items = ArrayList<Item>()
        val seen = HashSet<String>()
        for (i in 0 until array.length()) {
            val entry = array.optJSONObject(i) ?: continue
            val id = entry.str("id").trim()
            val title = entry.str("title").trim()
            if (id.isEmpty() || title.isEmpty() || !seen.add(id)) continue
            items += Item(id, title)
        }
        return items
    }

    /**
     * Where Zenium's `items` go among the `system` items on the menu: after Copy, with Copy's
     * order, and with the WebView's Share hidden when Zenium's is among them. No Copy, no plan.
     */
    fun plan(system: List<SystemItem>, items: List<Item>, strings: Strings): Plan {
        val copy = system.firstOrNull { it.title == strings.copy } ?: return Plan(false, 0, emptyList(), emptyList())
        val share = items.firstOrNull { it.id == SHARE_ID }
        val hidden = if (share == null) {
            emptyList()
        } else {
            system.withIndex()
                .filter { (_, item) -> item.groupId == copy.groupId && item !== copy && (item.title == share.title || item.title == strings.share) }
                .map { it.index }
        }
        return Plan(true, copy.order, items, hidden)
    }

    /** The item a touched menu item id names, or null for an id the list does not have. */
    fun itemAt(items: List<Item>, menuItemId: Int): Item? = items.getOrNull(menuItemId - FIRST_ITEM_ID)

    /** Where `center` sits along a view of `size` px, 0…1 (the middle when the size is not known). */
    fun fraction(center: Float, size: Int): Double =
        if (size <= 0 || center.isNaN()) 0.5 else (center / size).toDouble().coerceIn(0.0, 1.0)

    /**
     * The `selection.action` host event for a touch on item `id` with `text` selected: the tab,
     * the action, the text and where the selection sits in the page (0…1 of its width and
     * height, for a glance to grow out of).
     */
    fun action(tabId: String, id: String, text: String, originX: Double, originY: Double): JSONObject =
        json("tabId" to tabId, "id" to id, "text" to text, "originX" to originX, "originY" to originY)
}
