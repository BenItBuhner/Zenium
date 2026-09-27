package app.zen.chromium

import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject

/**
 * The keyboard-shortcut helper: the system dialog Meta + / opens (`PhoneWindowManager` routes the
 * chord to `StatusBarManagerInternal.toggleKeyboardShortcutsMenu` on Android 14 and 15; a Meta
 * press on its own is the launcher's all-apps) and fills from `Activity.onProvideKeyboardShortcuts`
 * lists the browser's shortcuts by group, as Chrome's does
 * (`KeyboardShortcuts.createShortcutGroup`, Chrome 152 – any device with a keyboard, no tablet
 * gate). The rows are the core's shortcut table, the one [Keys] routes, sent with the bindings over
 * `keys.setShortcuts`; this object puts them in Chrome's groups, in Chrome's order, under Chrome's
 * words where the action is Chrome's and, where it is Zenium's own, the table's `helperLabel` –
 * the same sentence form as Chrome's rows ('Duplicate tab'; a product's name keeps its capitals,
 * 'Toggle Split View grid') – or its Settings label where the table gives none. One register on
 * the sheet, never a case transform of the Settings page's Title Case. Only the primary chord is
 * listed, as in Chrome (the alternates route, unlisted); a row the build cannot perform
 * (`unsupported`) or one reserved for a feature that has not shipped (`hidden`) routes unlisted.
 * Pure – no Android calls – so the JVM tests pin it.
 */
object ShortcutHelper {
    /** A chord as the core normalises it (`KeyBinding`): a lowercase character or a `KeyboardEvent.key` name. */
    data class Chord(val ctrl: Boolean, val alt: Boolean, val shift: Boolean, val meta: Boolean, val key: String)

    /** One row of the core's table (`HelperShortcut`, `src/android/shortcutHelper.ts`). */
    data class Row(
        val action: String,
        val group: String,
        /** The Settings page's Title Case words; listed where the table gives no [helperLabel]. */
        val label: String,
        /** The primary chord; null when unbound. */
        val chord: Chord?,
        /** Reserved for a feature that has not shipped: routed, never listed. */
        val hidden: Boolean,
        /** The chrome layouts whose listings show the row; null when every layout does. */
        val layouts: List<String>?,
        /** The helper's sentence-form words for a row Zenium alone has; null where the table gives none. */
        val helperLabel: String? = null,
        /** An action this build cannot perform: the chord routes (and says so), the row is never listed. */
        val unsupported: Boolean = false
    )

    data class Item(val action: String, val label: String, val chord: Chord)
    data class Group(val title: String, val items: List<Item>)

    // Chrome's group titles (android_chrome_strings.grd, IDS_KEYBOARD_SHORTCUT_*_GROUP_HEADER);
    // the browser's name stands where Chrome's does ("Google Chrome feature shortcuts").
    const val TABS = "Tab and window shortcuts"
    const val TAB_NAVIGATION = "Tab navigation shortcuts"
    const val FEATURES = "Zenium feature shortcuts"
    const val WEBPAGE = "Webpage shortcuts"
    const val DEVELOPER = "Developer shortcuts"
    // Zenium's own groups follow Chrome's, titled from the desktop's group labels
    // (SHORTCUT_GROUP_LABELS in src/shared/shortcuts.ts) in Chrome's form.
    const val COMPACT_MODE = "Compact Mode shortcuts"
    const val SPACES = "Spaces shortcuts"
    const val SPLIT_VIEW = "Split View shortcuts"

    /** Chrome's five in Chrome's order, then Zenium's. A group with no listed row is left out, as Chrome leaves out "Developer shortcuts" without its flag. */
    val GROUP_ORDER: List<String> = listOf(TABS, TAB_NAVIGATION, FEATURES, WEBPAGE, DEVELOPER, COMPACT_MODE, SPACES, SPLIT_VIEW)

    /** A row Chrome lists too: Chrome's group and Chrome's words (IDS_KEYBOARD_SHORTCUT_*). */
    data class ChromeRow(val action: String, val group: String, val label: String)

    /**
     * Chrome's rows in Chrome's order (`KeyboardShortcuts.java` definition order, which its
     * `LinkedHashMap` keeps), keyed by the Zenium action that does the same thing. Chrome rows
     * Zenium has no action for (Open Chrome menu, Toggle tab selection, Scroll to top / bottom,
     * Send feedback, Help Center) are not listed: the helper lists what routes.
     */
    val CHROME_ROWS: List<ChromeRow> = listOf(
        ChromeRow("window.new", TABS, "Open a new window"),
        ChromeRow("window.close", TABS, "Close current window"),
        ChromeRow("tab.new", TABS, "Open a new tab"),
        ChromeRow("tab.reopenClosed", TABS, "Reopen closed tab"),
        // Chrome: "Open a new tab in Incognito mode"; Zenium's noun is a private tab.
        ChromeRow("window.newPrivate", TABS, "Open a new private tab"),
        ChromeRow("nav.reload", TABS, "Reload the current page"),
        ChromeRow("nav.reloadSkipCache", TABS, "Reload the current page, ignoring cached content"),
        ChromeRow("tab.close", TABS, "Close current tab"),
        ChromeRow("tab.search", TABS, "Search tabs"),
        ChromeRow("tab.next", TAB_NAVIGATION, "Jump to the next tab"),
        ChromeRow("tab.prev", TAB_NAVIGATION, "Jump to the previous tab"),
        ChromeRow("tab.select1", TAB_NAVIGATION, "Jump to a specific tab (1\u20138)"),
        ChromeRow("tab.selectLast", TAB_NAVIGATION, "Jump to the last tab"),
        ChromeRow("urlbar.focus", FEATURES, "Jump to address bar"),
        ChromeRow("urlbar.search", FEATURES, "Start new search"),
        ChromeRow("find.open", FEATURES, "Open Find Bar"),
        ChromeRow("downloads.open", FEATURES, "Open Downloads"),
        ChromeRow("page.caretBrowsing", FEATURES, "Toggle caret browsing"),
        ChromeRow("history.sidebar", FEATURES, "Open History"),
        ChromeRow("nav.back", FEATURES, "Go to previous page"),
        ChromeRow("nav.forward", FEATURES, "Go to next page"),
        ChromeRow("privacy.clearBrowsingData", FEATURES, "Delete browsing data"),
        ChromeRow("bookmark.add", FEATURES, "Bookmark the current page"),
        ChromeRow("bookmark.library", FEATURES, "Open Bookmarks Manager"),
        ChromeRow("bookmark.toggleBar", FEATURES, "Show or hide Bookmarks bar"),
        ChromeRow("page.printPreview", WEBPAGE, "Open options to print"),
        ChromeRow("page.savePage", WEBPAGE, "Open options to save"),
        ChromeRow("zoom.in", WEBPAGE, "Zoom in"),
        ChromeRow("zoom.out", WEBPAGE, "Zoom out"),
        ChromeRow("zoom.reset", WEBPAGE, "Reset zoom"),
        ChromeRow("page.viewSource", DEVELOPER, "View page source"),
        ChromeRow("devtools.toggle", DEVELOPER, "Open Developer Tools"),
        ChromeRow("tasks.open", DEVELOPER, "Open Task Manager")
    )

    /**
     * Rows Chrome folds into one: Chrome lists Ctrl+1 as "Jump to a specific tab (1–8)" and routes
     * Ctrl+2…8 unlisted; Zenium's table has a row per tab.
     */
    val FOLDED_INTO: Map<String, String> = (2..8).associate { "tab.select$it" to "tab.select1" }

    /** Zenium's own rows (no Chrome row) go to Chrome's nearest group by the table's group. */
    val GROUP_OF: Map<String, String> = mapOf(
        "windowAndTabManagement" to TABS,
        "navigation" to FEATURES,
        "searchAndFind" to FEATURES,
        "historyAndBookmarks" to FEATURES,
        "zen-other" to FEATURES,
        "pageOperations" to WEBPAGE,
        "mediaAndDisplay" to WEBPAGE,
        "devTools" to DEVELOPER,
        "zen-compact-mode" to COMPACT_MODE,
        "zen-workspace" to SPACES,
        "zen-split-view" to SPLIT_VIEW
    )

    private val chromeRowByAction: Map<String, ChromeRow> = CHROME_ROWS.associateBy { it.action }

    /**
     * The helper's groups for `layout` (`phone` or `tablet` – the chrome's `FormFactor` on Android).
     * A row is listed when it has a primary chord, is not hidden, is not unsupported in this build,
     * is not folded into another row, and its `layouts` (if any) name the layout. Chrome's rows
     * come first within a group in Chrome's order, under Chrome's words; Zenium's own follow in the
     * table's order, under the table's `helperLabel` (its Settings label where there is none).
     */
    fun groups(rows: List<Row>, layout: String): List<Group> {
        val listed = rows.filter { row ->
            row.chord != null && !row.hidden && !row.unsupported && row.action !in FOLDED_INTO &&
                (row.layouts == null || layout in row.layouts)
        }
        val byAction = listed.associateBy { it.action }
        val items = LinkedHashMap<String, MutableList<Item>>()
        fun add(group: String, item: Item) {
            items.getOrPut(group) { ArrayList() }.add(item)
        }
        for (chrome in CHROME_ROWS) {
            val row = byAction[chrome.action] ?: continue
            add(chrome.group, Item(row.action, chrome.label, row.chord!!))
        }
        for (row in listed) {
            if (row.action in chromeRowByAction) continue
            add(GROUP_OF[row.group] ?: FEATURES, Item(row.action, helperWords(row), row.chord!!))
        }
        return GROUP_ORDER.mapNotNull { title -> items[title]?.let { Group(title, it) } }
    }

    /** The words the helper prints for a row of Zenium's own: the table's `helperLabel`, else its label. */
    fun helperWords(row: Row): String = row.helperLabel ?: row.label

    /** Parse the `shortcuts` array of `keys.setShortcuts`. */
    fun parseRows(list: JSONArray): List<Row> {
        val out = ArrayList<Row>(list.length())
        for (i in 0 until list.length()) {
            val s = list.optJSONObject(i) ?: continue
            val layouts = s.optJSONArray("layouts")?.let { arr -> List(arr.length()) { arr.optString(it) } }
            out.add(
                Row(
                    action = s.str("action"),
                    group = s.str("group"),
                    label = s.str("label"),
                    chord = s.optJSONObject("binding")?.let { parseChord(it) },
                    hidden = s.bool("hidden"),
                    layouts = layouts,
                    helperLabel = if (s.isNull("helperLabel")) null else s.optString("helperLabel"),
                    unsupported = s.bool("unsupported")
                )
            )
        }
        return out
    }

    /** Parse one `KeyBinding` document; the key is normalised as [Keys] normalises it. */
    fun parseChord(b: JSONObject): Chord = Chord(
        b.bool("ctrl"), b.bool("alt"), b.bool("shift"), b.bool("meta"), normaliseKey(b.str("key"))
    )

    fun normaliseKey(key: String): String = if (key.length == 1) key.lowercase() else key

    /** The `KeyEvent.META_*` state the system draws for a chord. */
    fun metaState(chord: Chord): Int {
        var state = 0
        if (chord.ctrl) state = state or KeyEvent.META_CTRL_ON
        if (chord.alt) state = state or KeyEvent.META_ALT_ON
        if (chord.shift) state = state or KeyEvent.META_SHIFT_ON
        if (chord.meta) state = state or KeyEvent.META_META_ON
        return state
    }

    /**
     * The Android key code for a normalised key, or null when the key is a printable character
     * without a code of its own (the helper then lists it by its character – `*`, `+`).
     */
    fun keyCode(key: String): Int? {
        KEY_CODES[key]?.let { return it }
        if (key.length != 1) return null
        val c = key[0]
        return when (c) {
            in 'a'..'z' -> KeyEvent.KEYCODE_A + (c - 'a')
            in '0'..'9' -> KeyEvent.KEYCODE_0 + (c - '0')
            else -> null
        }
    }

    private val KEY_CODES = mapOf(
        "Escape" to KeyEvent.KEYCODE_ESCAPE,
        "Tab" to KeyEvent.KEYCODE_TAB,
        "Enter" to KeyEvent.KEYCODE_ENTER,
        "Backspace" to KeyEvent.KEYCODE_DEL,
        "Delete" to KeyEvent.KEYCODE_FORWARD_DEL,
        " " to KeyEvent.KEYCODE_SPACE,
        "ArrowLeft" to KeyEvent.KEYCODE_DPAD_LEFT,
        "ArrowRight" to KeyEvent.KEYCODE_DPAD_RIGHT,
        "ArrowUp" to KeyEvent.KEYCODE_DPAD_UP,
        "ArrowDown" to KeyEvent.KEYCODE_DPAD_DOWN,
        "PageUp" to KeyEvent.KEYCODE_PAGE_UP,
        "PageDown" to KeyEvent.KEYCODE_PAGE_DOWN,
        "Home" to KeyEvent.KEYCODE_MOVE_HOME,
        "End" to KeyEvent.KEYCODE_MOVE_END,
        "Insert" to KeyEvent.KEYCODE_INSERT,
        "F1" to KeyEvent.KEYCODE_F1, "F2" to KeyEvent.KEYCODE_F2, "F3" to KeyEvent.KEYCODE_F3,
        "F4" to KeyEvent.KEYCODE_F4, "F5" to KeyEvent.KEYCODE_F5, "F6" to KeyEvent.KEYCODE_F6,
        "F7" to KeyEvent.KEYCODE_F7, "F8" to KeyEvent.KEYCODE_F8, "F9" to KeyEvent.KEYCODE_F9,
        "F10" to KeyEvent.KEYCODE_F10, "F11" to KeyEvent.KEYCODE_F11, "F12" to KeyEvent.KEYCODE_F12,
        "=" to KeyEvent.KEYCODE_EQUALS,
        "-" to KeyEvent.KEYCODE_MINUS,
        "[" to KeyEvent.KEYCODE_LEFT_BRACKET,
        "]" to KeyEvent.KEYCODE_RIGHT_BRACKET,
        ";" to KeyEvent.KEYCODE_SEMICOLON,
        "'" to KeyEvent.KEYCODE_APOSTROPHE,
        "," to KeyEvent.KEYCODE_COMMA,
        "." to KeyEvent.KEYCODE_PERIOD,
        "/" to KeyEvent.KEYCODE_SLASH,
        "\\" to KeyEvent.KEYCODE_BACKSLASH,
        "`" to KeyEvent.KEYCODE_GRAVE
    )
}
