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
 * words where the action is Chrome's, the table's sentence-form `helperLabel` where it is
 * Zenium's own (its Settings label where the table gives none), fed from the same rows [Keys]
 * routes – every listed chord routes and every routed primary is listed or has a reason not to be
 * (hidden, unsupported in this build, folded into a Chrome row, another layout's).
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
        layouts: List<String>? = null,
        helperLabel: String? = null,
        unsupported: Boolean = false
    ) = ShortcutHelper.Row(action, group, label, chord, hidden, layouts, helperLabel, unsupported)

    // A slice of the Android table in the table's (settings page's) order: Zenium's groups first,
    // then Chrome's, as src/shared/shortcuts.ts lists them – with the table's flags as it carries
    // them: Compact Mode and the bookmarks bar the desktop layout's (`layouts`), the DevTools rows
    // and View Page Source unsupported on Android, Zenium's own rows with their helper words.
    private val table = listOf(
        row("compact.toggle", "zen-compact-mode", "Toggle Compact Mode", chord("s", ctrl = true, alt = true), layouts = listOf("desktop")),
        row("space.next", "zen-workspace", "Next Space", chord("ArrowRight", ctrl = true, alt = true), helperLabel = "Next space"),
        row("space.new", "zen-workspace", "Create New Space", null, helperLabel = "Create new space"),
        row("split.grid", "zen-split-view", "Toggle Split View Grid", chord("g", ctrl = true, alt = true), helperLabel = "Toggle Split View grid"),
        row("tab.copyUrl", "zen-other", "Copy Current URL", chord("c", ctrl = true, alt = true), helperLabel = "Copy current URL"),
        row("tab.new", "windowAndTabManagement", "New Tab", chord("t", ctrl = true)),
        row("tab.close", "windowAndTabManagement", "Close Tab", chord("w", ctrl = true)),
        row("tab.duplicate", "windowAndTabManagement", "Duplicate Tab", chord("k", ctrl = true, shift = true), helperLabel = "Duplicate tab"),
        row("window.new", "windowAndTabManagement", "New Window", chord("n", ctrl = true)),
        row("window.newPrivate", "windowAndTabManagement", "New Private Window", chord("n", ctrl = true, shift = true)),
        row("window.name", "windowAndTabManagement", "Name Window…", null, layouts = listOf("desktop"), helperLabel = "Name window…"),
        row("tab.next", "windowAndTabManagement", "Next Tab", chord("Tab", ctrl = true)),
        row("tab.select1", "windowAndTabManagement", "Select Tab 1", chord("1", ctrl = true)),
        row("tab.select2", "windowAndTabManagement", "Select Tab 2", chord("2", ctrl = true)),
        row("tab.select8", "windowAndTabManagement", "Select Tab 8", chord("8", ctrl = true)),
        row("tab.selectLast", "windowAndTabManagement", "Select Last Tab", chord("9", ctrl = true)),
        row("tab.moveToEnd", "windowAndTabManagement", "Move Tab to End", chord("End", ctrl = true, shift = true), helperLabel = "Move tab to end"),
        row("nav.reload", "navigation", "Reload", chord("r", ctrl = true)),
        row("nav.home", "navigation", "Home", chord("Home", alt = true)),
        row("find.open", "searchAndFind", "Find in Page", chord("f", ctrl = true)),
        row("find.next", "searchAndFind", "Find Next", chord("g", ctrl = true), helperLabel = "Find next"),
        row("page.viewSource", "pageOperations", "View Page Source", chord("u", ctrl = true), unsupported = true),
        row("page.fullscreen", "pageOperations", "Toggle Fullscreen", chord("F11"), helperLabel = "Toggle fullscreen"),
        row("capture.start", "pageOperations", "Screenshot…", chord("s", ctrl = true, shift = true), layouts = listOf("desktop")),
        row("zoom.in", "mediaAndDisplay", "Zoom In", chord("=", ctrl = true)),
        row("bookmark.add", "historyAndBookmarks", "Bookmark This Page", chord("d", ctrl = true)),
        row("bookmark.toggleBar", "historyAndBookmarks", "Show / Hide Bookmarks Bar", chord("b", ctrl = true, shift = true), layouts = listOf("desktop")),
        row("devtools.toggle", "devTools", "Toggle Developer Tools", chord("i", ctrl = true, shift = true), unsupported = true),
        row("tasks.open", "devTools", "Task Manager", chord("Escape", shift = true), layouts = listOf("desktop")),
        row("boost.new", "zen-other", "New Boost", chord("b", ctrl = true, alt = true), hidden = true)
    )

    private fun listed(layout: String, rows: List<ShortcutHelper.Row> = table): List<String> =
        ShortcutHelper.groups(rows, layout).flatMap { it.items }.map { it.action }

    @Test
    fun theGroupsAreChromesInChromesOrderThenZeniums() {
        // The tablet's sheet: Chrome's groups that have a row here, then Zenium's own. Developer
        // shortcuts is absent – its rows are unsupported on Android or the desktop layout's (Task
        // Manager) – as Compact Mode shortcuts is (§9.36: the desktop layout's rows).
        assertEquals(
            listOf(
                ShortcutHelper.TABS, ShortcutHelper.TAB_NAVIGATION, ShortcutHelper.FEATURES, ShortcutHelper.WEBPAGE,
                ShortcutHelper.SPACES, ShortcutHelper.SPLIT_VIEW
            ),
            ShortcutHelper.groups(table, "tablet").map { it.title }
        )
        // The desktop layout (a DeX desktop) lists every group in the helper's order.
        assertEquals(
            listOf(
                ShortcutHelper.TABS, ShortcutHelper.TAB_NAVIGATION, ShortcutHelper.FEATURES, ShortcutHelper.WEBPAGE,
                ShortcutHelper.DEVELOPER, ShortcutHelper.COMPACT_MODE, ShortcutHelper.SPACES, ShortcutHelper.SPLIT_VIEW
            ),
            ShortcutHelper.groups(table, "desktop").map { it.title }
        )
        assertEquals(
            "Chrome's five in Chrome's order, then Zenium's own",
            listOf("Tab and window shortcuts", "Tab navigation shortcuts", "Zenium feature shortcuts", "Webpage shortcuts", "Developer shortcuts"),
            ShortcutHelper.GROUP_ORDER.take(5)
        )
    }

    @Test
    fun chromesRowsComeFirstInChromesOrderUnderChromesWordsThenZeniumsUnderTheTablesHelperWords() {
        val tabs = ShortcutHelper.groups(table, "tablet").first { it.title == ShortcutHelper.TABS }
        assertEquals(
            listOf(
                "Open a new window" to "window.new",
                "Open a new tab" to "tab.new",
                // Chrome's "Open a new tab in Incognito mode", with Zenium's noun.
                "Open a new private tab" to "window.newPrivate",
                "Reload the current page" to "nav.reload",
                "Close current tab" to "tab.close",
                // Zenium's own, in the table's order, in the same sentence form as Chrome's rows –
                // the table's `helperLabel`, not the Settings page's Title Case.
                "Duplicate tab" to "tab.duplicate",
                "Move tab to end" to "tab.moveToEnd"
            ),
            tabs.items.map { it.label to it.action }
        )
        val features = ShortcutHelper.groups(table, "tablet").first { it.title == ShortcutHelper.FEATURES }
        assertEquals(
            listOf("Open Find Bar", "Bookmark the current page", "Copy current URL", "Home", "Find next"),
            features.items.map { it.label }
        )
        // A product's name keeps its capitals in the sentence form.
        val split = ShortcutHelper.groups(table, "tablet").first { it.title == ShortcutHelper.SPLIT_VIEW }
        assertEquals(listOf("Toggle Split View grid"), split.items.map { it.label })
    }

    @Test
    fun theHelperWordsAreChromesThenTheTablesHelperLabelThenTheSettingsLabel() {
        // Chrome's row prints Chrome's words whatever the table sends beside them.
        val chromeRow = row("tab.new", "windowAndTabManagement", "New Tab", chord("t", ctrl = true), helperLabel = "Open a tab")
        // Zenium's own row prints the table's helper words; without them, its Settings label as is.
        val withWords = row("tab.duplicate", "windowAndTabManagement", "Duplicate Tab", chord("k", ctrl = true, shift = true), helperLabel = "Duplicate tab")
        val withoutWords = row("nav.home", "navigation", "Home", chord("Home", alt = true))
        val items = ShortcutHelper.groups(listOf(chromeRow, withWords, withoutWords), "tablet").flatMap { it.items }
        assertEquals(listOf("Open a new tab", "Duplicate tab", "Home"), items.map { it.label })
        assertEquals("Duplicate tab", ShortcutHelper.helperWords(withWords))
        assertEquals("Home", ShortcutHelper.helperWords(withoutWords))
        // Never a case transform: the sheet's words are the table's field, the Settings label untouched.
        assertEquals("Duplicate Tab", withWords.label)
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
    fun unboundHiddenUnsupportedAndOtherLayoutsRowsAreNotListed() {
        val tablet = listed("tablet")
        assertFalse("unbound", "space.new" in tablet)
        assertFalse("unbound, another layout's", "window.name" in tablet)
        assertFalse("hidden (reserved)", "boost.new" in tablet)
        assertFalse("unsupported in this build", "page.viewSource" in tablet)
        assertFalse("unsupported in this build", "devtools.toggle" in tablet)
        assertFalse("the desktop layout's row", "capture.start" in tablet)
        assertFalse("the desktop layout's row", "tasks.open" in tablet)
        assertFalse("the desktop layout's row", "compact.toggle" in tablet)
        assertFalse("the desktop layout's row", "bookmark.toggleBar" in tablet)
        assertTrue("F11 lists on every layout", "page.fullscreen" in tablet)
        val phone = listed("phone")
        assertEquals("no layout-bound row in this slice differs between phone and tablet", tablet, phone)
        val desktopRow = listOf(row("capture.start", "pageOperations", "Screenshot…", chord("s", ctrl = true, shift = true), layouts = listOf("tablet")))
        assertEquals(listOf("capture.start"), listed("tablet", desktopRow))
        assertTrue(ShortcutHelper.groups(desktopRow, "phone").isEmpty())
    }

    @Test
    fun aDesktopOnlyRowIsListedOnNoTouchLayout() {
        // A `layouts: ['desktop']` entry of the core's table (Name Window…, Screenshot…, Task
        // Manager, Show / Hide Bookmarks Bar, the two Compact Mode rows; #588's Report an issue…,
        // Alt+Shift+I) travels with its layouts (`helperShortcuts`) and the helper lists it on the
        // desktop's layout alone: the tablet's and the phone's helper never show it, whatever its
        // group and however bound – so the Compact Mode group leaves both touch layouts' sheets.
        val reportIssue = row("help.reportIssue", "windowAndTabManagement", "Report an issue…", chord("i", alt = true, shift = true), layouts = listOf("desktop"))
        val rows = table + reportIssue
        val desktopOnly = setOf("help.reportIssue", "window.name", "capture.start", "tasks.open", "compact.toggle", "bookmark.toggleBar")
        for (layout in listOf("tablet", "phone")) {
            val groups = ShortcutHelper.groups(rows, layout)
            assertFalse("$layout lists no desktop-only row", groups.flatMap { it.items }.any { it.action in desktopOnly })
            assertFalse("$layout has no Compact Mode group", groups.any { it.title == ShortcutHelper.COMPACT_MODE })
        }
        val desktop = listed("desktop", rows)
        assertTrue("the desktop's own layout lists it", "help.reportIssue" in desktop)
        assertTrue("the desktop's own layout lists Compact Mode", "compact.toggle" in desktop)
        assertTrue("the desktop's own layout lists the bookmarks bar", "bookmark.toggleBar" in desktop)
        // The key itself is untouched by the listing: a layout that hides the row keeps the chord routed.
        val keys = Keys()
        keys.setShortcuts(JSONArray().put(chordJson(reportIssue.chord!!)), JSONArray().put(rowJson(reportIssue)))
        assertTrue(keys.routes(reportIssue.chord!!))
        assertTrue(keys.helperRows.single().layouts == listOf("desktop"))
    }

    @Test
    fun anUnsupportedRowRoutesUnlistedOnEveryLayout() {
        // The table's `unsupported` (the DevTools rows and View Page Source on Android, which has
        // no DevTools surface and no source view): the row is on no layout's sheet – the desktop
        // layout's included, since the build cannot perform it anywhere – while its chord routes,
        // for the core to say so (`Keys.handle`'s "not available in this build yet" toast).
        val unsupported = table.filter { it.unsupported }.map { it.action }
        assertEquals(listOf("page.viewSource", "devtools.toggle"), unsupported)
        for (layout in listOf("tablet", "phone", "desktop")) {
            val groups = ShortcutHelper.groups(table, layout)
            assertFalse("$layout lists no unsupported row", groups.flatMap { it.items }.any { it.action in unsupported })
        }
        assertFalse("the tablet has no Developer group left", ShortcutHelper.groups(table, "tablet").any { it.title == ShortcutHelper.DEVELOPER })
        val viewSource = table.first { it.action == "page.viewSource" }
        val keys = Keys()
        keys.setShortcuts(JSONArray().put(chordJson(viewSource.chord!!)), JSONArray().put(rowJson(viewSource)))
        assertTrue("the chord routes, for the core's word", keys.routes(viewSource.chord!!))
        assertTrue("the flag crosses the bridge", keys.helperRows.single().unsupported)
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
        assertEquals(ShortcutHelper.SPACES, groupOf("space.next"))
        assertEquals(ShortcutHelper.SPLIT_VIEW, groupOf("split.grid"))
        // The rows the tablet's sheet leaves out keep their homes for the layouts and builds that list them.
        assertEquals(ShortcutHelper.DEVELOPER, ShortcutHelper.GROUP_OF["devTools"])
        assertEquals(ShortcutHelper.COMPACT_MODE, ShortcutHelper.GROUP_OF["zen-compact-mode"])
        val desktop = ShortcutHelper.groups(table, "desktop")
        assertEquals(ShortcutHelper.COMPACT_MODE, desktop.first { g -> g.items.any { it.action == "compact.toggle" } }.title)
        assertEquals(ShortcutHelper.DEVELOPER, desktop.first { g -> g.items.any { it.action == "tasks.open" } }.title)
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
            val reason = r.hidden || r.unsupported || r.action in ShortcutHelper.FOLDED_INTO || (r.layouts != null && "tablet" !in r.layouts)
            assertEquals("${r.action} is listed unless hidden, unsupported, folded or another layout's", !reason, r.action in listedActions)
        }
        for (extra in extras.values.flatten()) assertTrue("an extra binding routes, unlisted", keys.routes(extra))
        assertFalse(keys.routes(chord("q", ctrl = true, alt = true, shift = true)))
    }

    @Test
    fun theRowsCrossTheBridgeAsTheCoreSendsThem() {
        val rows = ShortcutHelper.parseRows(
            JSONArray().put(
                JSONObject()
                    .put("action", "tab.new").put("group", "windowAndTabManagement").put("label", "New Tab").put("helperLabel", JSONObject.NULL)
                    .put("binding", JSONObject().put("ctrl", true).put("alt", false).put("shift", false).put("meta", false).put("key", "T"))
                    .put("unsupported", false).put("hidden", false).put("layouts", JSONObject.NULL)
            ).put(
                JSONObject()
                    .put("action", "window.name").put("group", "windowAndTabManagement").put("label", "Name Window…").put("helperLabel", "Name window…")
                    .put("binding", JSONObject.NULL).put("unsupported", false).put("hidden", false).put("layouts", JSONArray().put("desktop"))
            ).put(
                JSONObject()
                    .put("action", "devtools.toggle").put("group", "devTools").put("label", "Toggle Developer Tools").put("helperLabel", JSONObject.NULL)
                    .put("binding", JSONObject().put("ctrl", true).put("alt", false).put("shift", true).put("meta", false).put("key", "I"))
                    .put("unsupported", true).put("hidden", false).put("layouts", JSONObject.NULL)
            )
        )
        assertEquals(3, rows.size)
        assertEquals("the key is normalised as the router normalises it", chord("t", ctrl = true), rows[0].chord)
        assertNull(rows[0].layouts)
        assertNull("no helper words: the label stands", rows[0].helperLabel)
        assertFalse(rows[0].unsupported)
        assertNull(rows[1].chord)
        assertEquals(listOf("desktop"), rows[1].layouts)
        assertEquals("Name window…", rows[1].helperLabel)
        assertTrue(rows[2].unsupported)
        assertEquals(chord("i", ctrl = true, shift = true), rows[2].chord)
        // A payload from before the two fields parses as it did: no words, supported.
        val old = ShortcutHelper.parseRows(
            JSONArray().put(
                JSONObject().put("action", "tab.close").put("group", "windowAndTabManagement").put("label", "Close Tab")
                    .put("binding", JSONObject.NULL).put("hidden", false).put("layouts", JSONObject.NULL)
            )
        ).single()
        assertNull(old.helperLabel)
        assertFalse(old.unsupported)
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
        // The words the helper reads are the table's own fields, carried by the bridge's rows.
        assertTrue("the table carries the helper's words", shortcuts.contains("helperLabel?: string"))
        assertTrue("the table flags a platform's unsupported rows", shortcuts.contains("unsupportedOn?: Platform[]"))

        val types = File(repoRoot(), "src/shared/types.ts").readText()
        assertTrue("the shared row type carries the helper's words", types.contains("helperLabel?: string"))
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
        .put("helperLabel", r.helperLabel ?: JSONObject.NULL)
        .put("binding", r.chord?.let { chordJson(it) } ?: JSONObject.NULL)
        .put("unsupported", r.unsupported)
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
