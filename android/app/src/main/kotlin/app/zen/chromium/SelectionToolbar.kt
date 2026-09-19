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
 * their own (which Chromium leaves alone) and take the `order` of Copy – or of Paste, in an
 * editable field, where Paste follows Copy (Cut, Copy, Paste) and is the item one wants over a
 * field's text – so they insert right after the last of the two whatever spacing the WebView's
 * version gives its items, and come before Select all and Web search: the system items are the
 * ones the width pushes into the overflow, as in Chrome's own bar. Only Copy and Paste are
 * identified for certain – their titles are the framework's public `android.R.string.copy` and
 * `android.R.string.paste`, the ones Chromium uses; without Copy (a password field, an insertion
 * handle's Paste toolbar) nothing is added. The WebView's Share is told by its menu item id,
 * Chromium's `select_action_menu_share` resolved in the WebView's own package, or – failing that
 * (a WebView that renamed it) – as the item of Copy's group titled like Zenium's Share or like
 * the framework's own Share string; it is hidden so one Share shows, Zenium's, through the system
 * sheet with Zenium's own actions in it (`app.share`).
 */
object SelectionToolbar {
    /** One item as the core lists it: the id handed back on a touch and the title shown (and read out). */
    data class Item(val id: String, val title: String)

    /**
     * One of the system's items in the action mode's menu, as the plan sees it: its group, its
     * order, its title and its menu item id (0 for an item that has none, a text-processing app's).
     */
    data class SystemItem(val groupId: Int, val order: Int, val title: String, val itemId: Int = 0)

    /**
     * What the system's items are told by: the framework's public strings for Copy and Paste
     * (`android.R.string.copy`, `android.R.string.paste`), its Share string when the build has one
     * (not public; null without), and the WebView package's `select_action_menu_share` id (0 when
     * it cannot be resolved), the surest sign of the WebView's Share.
     */
    data class Strings(val copy: String, val share: String?, val paste: String? = null, val shareItemId: Int = 0)

    /** The name of the WebView's Share menu item id, in its own package (Chromium's `R.id`). */
    const val SHARE_ITEM_ID_NAME = "select_action_menu_share"

    /**
     * What to do to the menu: whether it has the system's Copy to anchor on (`anchored`: a text
     * selection, not a Paste toolbar or a password field), Zenium's `items` in order, each added
     * with `order` (Copy's, or Paste's when Paste follows Copy, so they follow the last of the
     * two), and the indexes into the system list of the items to hide (the WebView's own Share,
     * when Zenium's replaces it). Not anchored: nothing to do.
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
     * Where Zenium's `items` go among the `system` items on the menu: after Copy – after Paste
     * when Paste follows Copy in Copy's group (an editable field: Cut, Copy, Paste stay together
     * ahead of ours, as in Chrome's bar) – with that item's order, and with the WebView's Share
     * hidden when Zenium's is among them: the item with the WebView's Share id when it is known
     * and present, else the item of Copy's group titled like Zenium's Share or the framework's.
     * No Copy, no plan.
     */
    fun plan(system: List<SystemItem>, items: List<Item>, strings: Strings): Plan {
        val copy = system.firstOrNull { it.title == strings.copy } ?: return Plan(false, 0, emptyList(), emptyList())
        val paste = strings.paste?.let { title ->
            system.firstOrNull { it.groupId == copy.groupId && it.title == title && it.order > copy.order }
        }
        val anchor = paste ?: copy
        val share = items.firstOrNull { it.id == SHARE_ID }
        val hidden = if (share == null) {
            emptyList()
        } else {
            val byId = if (strings.shareItemId != 0) {
                system.withIndex().filter { (_, item) -> item.itemId == strings.shareItemId && item !== copy }.map { it.index }
            } else {
                emptyList()
            }
            byId.ifEmpty {
                system.withIndex()
                    .filter { (_, item) -> item.groupId == copy.groupId && item !== copy && (item.title == share.title || item.title == strings.share) }
                    .map { it.index }
            }
        }
        return Plan(true, anchor.order, items, hidden)
    }

    /** The item a touched menu item id names, or null for an id the list does not have. */
    fun itemAt(items: List<Item>, menuItemId: Int): Item? = items.getOrNull(menuItemId - FIRST_ITEM_ID)

    /**
     * The core's items for one action mode, kept current with the selection. The WebView keeps
     * one mode across selection changes – a handle drag's end and Select all both `invalidate()`
     * the mode it has (Chromium's `showActionModeOrClearOnFailure`), so `onPrepareActionMode` runs
     * again over the same menu – and an address dragged onto plain text (or the reverse) needs
     * other items. So every anchored prepare asks again: the page for its selection
     * (`readSelection`), the core for the items (`listItems`, the bridge's JSON answer). One ask
     * at a time; a prepare during one is remembered and asked after it. An answer that differs
     * from `items` is applied and the mode invalidated, whose prepare asks once more and gets the
     * same answer: the guard on equality ends the cycle. Answers after `finish()` are dropped.
     */
    class Listing(
        private val readSelection: (onText: (String) -> Unit) -> Unit,
        private val listItems: (text: String, onJson: (String?) -> Unit) -> Unit,
        private val invalidate: () -> Unit
    ) {
        /** The core's items as last answered, the ones the menu shows. */
        var items: List<Item> = emptyList()
            private set

        /** The selection as last read, the fallback should a touch find none. */
        var text: String = ""
            private set

        /** Asks made so far (the tests count the round trips). */
        var asks: Int = 0
            private set

        private var asking = false
        private var again = false
        private var finished = false

        /** A prepare of a menu with Copy in it (a text selection): ask, or after the ask in flight. */
        fun onPrepare() {
            if (finished) return
            if (asking) {
                again = true
                return
            }
            asking = true
            again = false
            asks++
            readSelection { selected ->
                if (finished) return@readSelection
                text = selected
                if (selected.isBlank()) {
                    settle(emptyList())
                    return@readSelection
                }
                listItems(selected) { json ->
                    if (finished) return@listItems
                    settle(parseItems(json))
                }
            }
        }

        /** The mode is gone: whatever comes back now is for no one. */
        fun finish() {
            finished = true
        }

        private fun settle(fresh: List<Item>) {
            asking = false
            if (fresh != items) {
                items = fresh
                invalidate()
            } else if (again) {
                onPrepare()
            }
        }
    }

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
