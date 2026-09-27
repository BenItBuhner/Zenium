package app.zen.chromium

import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The keyboard-shortcut helper (TABLET-20): Chrome's groups in Chrome's order under Chrome's
 * words where the action is Chrome's, the desktop's label where it is Zenium's own, fed from the
 * same rows [Keys] routes – every listed chord routes and every routed primary is listed or has a
 * reason not to be (hidden, folded into a Chrome row, another layout's).
 */
class ShortcutHelperTest {
    private fun chord(key: String, ctrl: Boolean = false, alt: Boolean = false, shift: Boolean = false, meta: Boolean = false) =
        ShortcutHelper.Chord(ctrl, alt, shift, meta, key)

    private fun row(
        action: String,
        group: String,
        label: String,
        chord: ShortcutHelper.Chord?,
        hidden: Boolean = false,
        layouts: List<String>? = null
    ) = ShortcutHelper.Row(action, group, label, chord, hidden, layouts)

    // A slice of the Android table in the table's (settings page's) order: Zenium's groups first,
    // then Chrome's, as src/shared/shortcuts.ts lists them.
    private val table = listOf(
        row("compact.toggle", "zen-compact-mode", "Toggle Compact Mode", chord("s", ctrl = true, alt = true)),
        row("space.next", "zen-workspace", "Next Space", chord("ArrowRight", ctrl = true, alt = true)),
        row("space.new", "zen-workspace", "Create New Space", null),
        row("split.grid", "zen-split-view", "Toggle Split View Grid", chord("g", ctrl = true, alt = true)),
        row("tab.copyUrl", "zen-other", "Copy Current URL", chord("c", ctrl = true, alt = true)),
        row("tab.new", "windowAndTabManagement", "New Tab", chord("t", ctrl = true)),
        row("tab.close", "windowAndTabManagement", "Close Tab", chord("w", ctrl = true)),
        row("tab.duplicate", "windowAndTabManagement", "Duplicate Tab", chord("k", ctrl = true, shift = true)),
        row("window.new", "windowAndTabManagement", "New Window", chord("n", ctrl = true)),
        row("window.name", "windowAndTabManagement", "Name Window…", null, layouts = listOf("desktop")),
        row("tab.next", "windowAndTabManagement", "Next Tab", chord("Tab", ctrl = true)),
        row("tab.select1", "windowAndTabManagement", "Select Tab 1", chord("1", ctrl = true)),
        row("tab.select2", "windowAndTabManagement", "Select Tab 2", chord("2", ctrl = true)),
        row("tab.select8", "windowAndTabManagement", "Select Tab 8", chord("8", ctrl = true)),
        row("tab.selectLast", "windowAndTabManagement", "Select Last Tab", chord("9", ctrl = true)),
        row("tab.moveToEnd", "windowAndTabManagement", "Move Tab to End", chord("End", ctrl = true, shift = true)),
        row("nav.reload", "navigation", "Reload", chord("r", ctrl = true)),
        row("nav.home", "navigation", "Home", chord("Home", alt = true)),
        row("find.open", "searchAndFind", "Find in Page", chord("f", ctrl = true)),
        row("find.next", "searchAndFind", "Find Next", chord("g", ctrl = true)),
        row("page.viewSource", "pageOperations", "View Page Source", chord("u", ctrl = true)),
        row("page.fullscreen", "pageOperations", "Toggle Fullscreen", chord("F11")),
        row("capture.start", "pageOperations", "Screenshot…", chord("s", ctrl = true, shift = true), layouts = listOf("desktop")),
        row("zoom.in", "mediaAndDisplay", "Zoom In", chord("=", ctrl = true)),
        row("bookmark.add", "historyAndBookmarks", "Bookmark This Page", chord("d", ctrl = true)),
        row("devtools.toggle", "devTools", "Toggle Developer Tools", chord("i", ctrl = true, shift = true)),
        row("tasks.open", "devTools", "Task Manager", chord("Escape", shift = true), layouts = listOf("desktop")),
        row("boost.new", "zen-other", "New Boost", chord("b", ctrl = true, alt = true), hidden = true)
    )

    @Test
    fun theGroupsAreChromesInChromesOrderThenZeniums() {
        val groups = ShortcutHelper.groups(table, "tablet")
        assertEquals(
            listOf(
                ShortcutHelper.TABS, ShortcutHelper.TAB_NAVIGATION, ShortcutHelper.FEATURES, ShortcutHelper.WEBPAGE,
                ShortcutHelper.DEVELOPER, ShortcutHelper.COMPACT_MODE, ShortcutHelper.SPACES, ShortcutHelper.SPLIT_VIEW
            ),
            groups.map { it.title }
        )
        assertEquals(
            "Chrome's five in Chrome's order, then Zenium's own",
            listOf("Tab and window shortcuts", "Tab navigation shortcuts", "Zenium feature shortcuts", "Webpage shortcuts", "Developer shortcuts"),
            ShortcutHelper.GROUP_ORDER.take(5)
        )
    }

    @Test
    fun chromesRowsComeFirstInChromesOrderUnderChromesWordsThenZeniumsUnderTheDesktops() {
        val tabs = ShortcutHelper.groups(table, "tablet").first { it.title == ShortcutHelper.TABS }
        assertEquals(
            listOf(
                "Open a new window" to "window.new",
                "Open a new tab" to "tab.new",
                "Reload the current page" to "nav.reload",
                "Close current tab" to "tab.close",
                // Zenium's own, in the table's order, under the desktop's menu label.
                "Duplicate Tab" to "tab.duplicate",
                "Move Tab to End" to "tab.moveToEnd"
            ),
            tabs.items.map { it.label to it.action }
        )
        val features = ShortcutHelper.groups(table, "tablet").first { it.title == ShortcutHelper.FEATURES }
        assertEquals(
            listOf("Open Find Bar", "Bookmark the current page", "Copy Current URL", "Home", "Find Next"),
            features.items.map { it.label }
        )
    }

    @Test
    fun theTabNumbersFoldIntoChromesOneRow() {
        val nav = ShortcutHelper.groups(table, "tablet").first { it.title == ShortcutHelper.TAB_NAVIGATION }
        assertEquals(
            listOf("Jump to the next tab", "Jump to a specific tab (1\u20138)", "Jump to the last tab"),
            nav.items.map { it.label }
        )
        assertEquals("the folded row keeps Ctrl+1", chord("1", ctrl = true), nav.items[1].chord)
        for (n in 2..8) assertEquals("tab.select1", ShortcutHelper.FOLDED_INTO["tab.select$n"])
    }

    @Test
    fun unboundHiddenAndOtherLayoutsRowsAreNotListed() {
        val tablet = ShortcutHelper.groups(table, "tablet").flatMap { it.items }.map { it.action }
        assertFalse("unbound", "space.new" in tablet)
        assertFalse("unbound, another layout's", "window.name" in tablet)
        assertFalse("hidden (reserved)", "boost.new" in tablet)
        assertFalse("the desktop's row", "capture.start" in tablet)
        assertFalse("the desktop's row", "tasks.open" in tablet)
        assertTrue("F11 lists on every layout", "page.fullscreen" in tablet)
        val phone = ShortcutHelper.groups(table, "phone").flatMap { it.items }.map { it.action }
        assertEquals("no layout-bound row in this slice differs between phone and tablet", tablet, phone)
        val desktopRow = listOf(row("capture.start", "pageOperations", "Screenshot…", chord("s", ctrl = true, shift = true), layouts = listOf("tablet")))
        assertEquals(listOf("capture.start"), ShortcutHelper.groups(desktopRow, "tablet").flatMap { it.items }.map { it.action })
        assertTrue(ShortcutHelper.groups(desktopRow, "phone").isEmpty())
    }

    @Test
    fun aDesktopOnlyRowIsListedOnNoTouchLayout() {
        // A `layouts: ['desktop']` entry of the core's table (Name Window…, Screenshot…, Task
        // Manager; #588's Report an issue…, Alt+Shift+I) travels with its layouts
        // (`helperShortcuts`) and the helper lists it on the desktop's layout alone: the tablet's
        // and the phone's helper never show it, whatever its group and however bound.
        val reportIssue = row("help.reportIssue", "windowAndTabManagement", "Report an issue…", chord("i", alt = true, shift = true), layouts = listOf("desktop"))
        val rows = table + reportIssue
        for (layout in listOf("tablet", "phone")) {
            val listed = ShortcutHelper.groups(rows, layout).flatMap { it.items }.map { it.action }
            assertFalse("$layout lists no desktop-only row", listed.any { it in setOf("help.reportIssue", "window.name", "capture.start", "tasks.open") })
        }
        val desktop = ShortcutHelper.groups(rows, "desktop").flatMap { it.items }.map { it.action }
        assertTrue("the desktop's own layout lists it", "help.reportIssue" in desktop)
        // The key itself is untouched by the listing: a layout that hides the row keeps the chord routed.
        val keys = Keys()
        keys.setShortcuts(JSONArray().put(chordJson(reportIssue.chord!!)), JSONArray().put(rowJson(reportIssue)))
        assertTrue(keys.routes(reportIssue.chord!!))
        assertTrue(keys.helperRows.single().layouts == listOf("desktop"))
    }

    @Test
    fun zeniumsOwnRowsGoToChromesNearestGroupByTheTablesGroup() {
        val groups = ShortcutHelper.groups(table, "tablet")
        fun groupOf(action: String) = groups.first { g -> g.items.any { it.action == action } }.title
        assertEquals(ShortcutHelper.TABS, groupOf("tab.duplicate"))
        assertEquals(ShortcutHelper.FEATURES, groupOf("nav.home"))
        assertEquals(ShortcutHelper.FEATURES, groupOf("find.next"))
        assertEquals(ShortcutHelper.FEATURES, groupOf("tab.copyUrl"))
        assertEquals(ShortcutHelper.WEBPAGE, groupOf("page.fullscreen"))
        assertEquals(ShortcutHelper.DEVELOPER, groupOf("page.viewSource"))
        assertEquals(ShortcutHelper.COMPACT_MODE, groupOf("compact.toggle"))
        assertEquals(ShortcutHelper.SPACES, groupOf("space.next"))
        assertEquals(ShortcutHelper.SPLIT_VIEW, groupOf("split.grid"))
    }

    @Test
    fun everyListedChordRoutesAndEveryRoutedPrimaryIsListedOrHasItsReason() {
        // The bridge's payload: the flat bindings (primaries and extras) and the rows.
        val bindings = JSONArray()
        val extras = mapOf("nav.reload" to listOf(chord("F5")), "find.next" to listOf(chord("F3")))
        for (r in table) {
            r.chord?.let { bindings.put(chordJson(it)) }
            extras[r.action]?.forEach { bindings.put(chordJson(it)) }
        }
        val shortcuts = JSONArray()
        for (r in table) shortcuts.put(rowJson(r))
        val keys = Keys()
        keys.setShortcuts(bindings, shortcuts)

        val listed = ShortcutHelper.groups(keys.helperRows, "tablet").flatMap { it.items }
        assertTrue(listed.isNotEmpty())
        for (item in listed) assertTrue("${item.action} lists a chord that does not route", keys.routes(item.chord))

        val listedActions = listed.map { it.action }.toSet()
        for (r in table) {
            val primary = r.chord ?: continue
            assertTrue("${r.action}'s primary routes", keys.routes(primary))
            val reason = r.hidden || r.action in ShortcutHelper.FOLDED_INTO || (r.layouts != null && "tablet" !in r.layouts)
            assertEquals("${r.action} is listed unless hidden, folded or another layout's", !reason, r.action in listedActions)
        }
        for (extra in extras.values.flatten()) assertTrue("an extra binding routes, unlisted", keys.routes(extra))
        assertFalse(keys.routes(chord("q", ctrl = true, alt = true, shift = true)))
    }

    @Test
    fun theRowsCrossTheBridgeAsTheCoreSendsThem() {
        val rows = ShortcutHelper.parseRows(
            JSONArray().put(
                JSONObject()
                    .put("action", "tab.new").put("group", "windowAndTabManagement").put("label", "New Tab")
                    .put("binding", JSONObject().put("ctrl", true).put("alt", false).put("shift", false).put("meta", false).put("key", "T"))
                    .put("hidden", false).put("layouts", JSONObject.NULL)
            ).put(
                JSONObject()
                    .put("action", "window.name").put("group", "windowAndTabManagement").put("label", "Name Window…")
                    .put("binding", JSONObject.NULL).put("hidden", false).put("layouts", JSONArray().put("desktop"))
            )
        )
        assertEquals(2, rows.size)
        assertEquals("the key is normalised as the router normalises it", chord("t", ctrl = true), rows[0].chord)
        assertNull(rows[0].layouts)
        assertNull(rows[1].chord)
        assertEquals(listOf("desktop"), rows[1].layouts)
    }

    @Test
    fun theKeyCodesMirrorTheRoutersDomKeys() {
        assertEquals(KeyEvent.KEYCODE_A, ShortcutHelper.keyCode("a"))
        assertEquals(KeyEvent.KEYCODE_Z, ShortcutHelper.keyCode("z"))
        assertEquals(KeyEvent.KEYCODE_0, ShortcutHelper.keyCode("0"))
        assertEquals(KeyEvent.KEYCODE_9, ShortcutHelper.keyCode("9"))
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, ShortcutHelper.keyCode("ArrowLeft"))
        assertEquals(KeyEvent.KEYCODE_PAGE_DOWN, ShortcutHelper.keyCode("PageDown"))
        assertEquals(KeyEvent.KEYCODE_ESCAPE, ShortcutHelper.keyCode("Escape"))
        assertEquals(KeyEvent.KEYCODE_F11, ShortcutHelper.keyCode("F11"))
        assertEquals(KeyEvent.KEYCODE_EQUALS, ShortcutHelper.keyCode("="))
        assertEquals(KeyEvent.KEYCODE_MINUS, ShortcutHelper.keyCode("-"))
        assertEquals(KeyEvent.KEYCODE_RIGHT_BRACKET, ShortcutHelper.keyCode("]"))
        assertNull("a shifted character lists by its glyph", ShortcutHelper.keyCode("*"))
        assertEquals(KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON, ShortcutHelper.metaState(chord("t", ctrl = true, shift = true)))
        assertEquals(KeyEvent.META_ALT_ON or KeyEvent.META_META_ON, ShortcutHelper.metaState(chord("t", alt = true, meta = true)))
    }

    @Test
    fun chromesRowsNameActionsTheCoreDefinesAndEveryGroupHasAHome() {
        val shortcuts = File(repoRoot(), "src/shared/shortcuts.ts").readText()
        val actions = Regex("""action: '([a-zA-Z0-9.]+)'""").findAll(shortcuts).map { it.groupValues[1] }.toMutableSet()
        // The eight Select Tab rows are generated (`tab.select${n}` over 1..8): Chrome's one folded row spans them.
        assertTrue(shortcuts.contains("Array.from({ length: 8 }, (_, i) => i + 1).map((n): Def => ({"))
        assertTrue(shortcuts.contains("action: `tab.select\${n}` as ShortcutAction"))
        for (n in 1..8) actions.add("tab.select$n")
        assertTrue("the table defines actions", actions.size > 50)
        for (row in ShortcutHelper.CHROME_ROWS) assertTrue("${row.action} is a core action", row.action in actions)
        for (action in ShortcutHelper.FOLDED_INTO.keys + ShortcutHelper.FOLDED_INTO.values) assertTrue("$action is a core action", action in actions)
        assertEquals("one Chrome row per action", ShortcutHelper.CHROME_ROWS.size, ShortcutHelper.CHROME_ROWS.map { it.action }.toSet().size)
        for (row in ShortcutHelper.CHROME_ROWS) assertTrue("${row.group} is a listed group", row.group in ShortcutHelper.GROUP_ORDER)

        val types = File(repoRoot(), "src/shared/types.ts").readText()
        val union = Regex("""export type ShortcutGroup =\s*((?:\s*\|\s*'[a-zA-Z-]+')+)""").find(types)?.groupValues?.get(1)
            ?: error("types.ts declares no ShortcutGroup")
        val groups = Regex("'([a-zA-Z-]+)'").findAll(union).map { it.groupValues[1] }.toSet()
        assertTrue(groups.size >= 11)
        assertEquals("every core group maps to a helper group", groups, ShortcutHelper.GROUP_OF.keys)
        for (title in ShortcutHelper.GROUP_OF.values) assertTrue(title in ShortcutHelper.GROUP_ORDER)
    }

    private fun chordJson(c: ShortcutHelper.Chord): JSONObject =
        JSONObject().put("ctrl", c.ctrl).put("alt", c.alt).put("shift", c.shift).put("meta", c.meta).put("key", c.key)

    private fun rowJson(r: ShortcutHelper.Row): JSONObject = JSONObject()
        .put("action", r.action).put("group", r.group).put("label", r.label)
        .put("binding", r.chord?.let { chordJson(it) } ?: JSONObject.NULL)
        .put("hidden", r.hidden)
        .put("layouts", r.layouts?.let { l -> JSONArray().also { arr -> l.forEach { arr.put(it) } } } ?: JSONObject.NULL)

    private companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
