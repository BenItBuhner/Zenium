package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives the KEYBOARD-SHORTCUT HELPER (TABLET-20, #591) and the `chrome://` ADDRESSES Chrome
 * Android serves (SET-66) on a `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp
 * (`DEMO_DISPLAY=1280x800@160`, the tablet layout demo's display), the runner's AVD with
 * `hw.keyboard=yes`.
 *
 * The helper. The system opens its keyboard-shortcut dialog on META + / – `PhoneWindowManager`
 * routes the chord to `StatusBarManagerInternal.toggleKeyboardShortcutsMenu` on Android 14 and 15
 * (a Meta press released on its own is the launcher's all-apps, so a `--longpress KEYCODE_META_LEFT`
 * would put the launcher in front, not the helper) – and SystemUI fills it from the focused
 * activity's `onProvideKeyboardShortcuts`. On a large screen (600 dp+, this AVD) Android 14's
 * SystemUI shows `KeyboardShortcutListSearch` (`Flags.SHORTCUT_LIST_SEARCH_LAYOUT`, released): a
 * "Shortcuts" sheet with a search field and four category buttons – System, Input, Open apps,
 * Current app – System selected first and the browser's groups under "Current app" (the sheet
 * Chrome's helper gets on a tablet); under 600 dp it is the classic `KeyboardShortcuts` dialog,
 * the app's groups first, then the system's "System" and "Applications". The driver sends the
 * chord the way `adb shell input keycombination KEYCODE_META_LEFT KEYCODE_SLASH` does (the
 * shell's own async injection, so the policy sees it), puts a finger on "Current app" when the
 * sheet is up, reads the listing's TEXT off the accessibility tree of SystemUI's window in tree
 * order, and claims: the browser's groups are there in Chrome's order, "Tab and window shortcuts"
 * first (and before "System" on the classic dialog); every row `ShortcutHelper.groups(rows,
 * "tablet")` lists is there under its group; Chrome's rows carry Chrome's words (a sample read
 * literally, not through the object under test: "Open a new tab" drawn with Ctrl + T, "Close
 * current tab", "Reload the current page", "Jump to address bar", "Zoom in"); a `layouts:
 * ['desktop']` row of the core's table (Name Window…, Screenshot…, Task Manager; #588's Report an
 * issue…) is NOT listed; META + / again closes it (the system's toggle). Once in each colour
 * scheme – light, then dark by the core's setting and the system's night mode, which the system
 * dialog follows – so the stills show both.
 *
 * The addresses, on the PHONE chrome (`wm size 1280x590`, the window under the 600 dp line; the
 * page-class seam demo's resize): `chrome://version` typed into the URL field lands the tab on
 * `zen://version`, the About Version document with Chrome's rows – the product row, OS
 * (`Android <release>; <model> Build/<id>; <sdk>; <codename>`), `APK versionCode`, `APK
 * targetSdkVersion`, User Agent, Executable Path, Profile Path – read off the page's DOM;
 * `chrome://flags` stays as typed and the tab stays where it was (the flip: no flags page);
 * `chrome://settings` opens the Settings tab (`zen://settings`, the landing). Then the tablet again.
 *
 * Every claim is read off the core's state (`app.getState`), the chrome's DOM, the page's DOM or
 * the system dialog's accessibility tree; a claim that does not hold fails the run at the end, the
 * sequence running on so the recording shows the rest. Same handshake as the other demos, under
 * `files/shortcut-helper-demo/`; stills land there as `shortcut-helper-<name>.png`, the claims and
 * the dialog's text as `findings.txt`.
 */
@RunWith(AndroidJUnit4::class)
class ShortcutHelperDemo : DemoHarness("shortcut-helper-demo-state.json", "shortcut-helper", "shortcut-helper-demo") {
    override val tag = "ShortcutHelperDemo"

    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        server = DemoServer(PORT, PAGES.mapValues { (_, page) -> DemoServer.page(page.first, page.second) }).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
        assertTrue("claims that did not hold:\n" + failures.joinToString("\n"), failures.isEmpty())
    }

    override fun warmUp() {
        shellCommand("cmd uimode night no")
        SystemClock.sleep(2_000)
        ensureForeground()
        finding("Zenium Android keyboard-shortcut helper and chrome:// aliases (window ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        // The runner's AVD carries `hw.keyboard=yes`: the configuration says KEYBOARD_QWERTY (2).
        finding("configuration keyboard ${activity.resources.configuration.keyboard}, smallest width ${activity.resources.configuration.smallestScreenWidthDp} dp")
        check("the chrome laid the window out as the tablet", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        awaitLoaded(HOME_TAB, "$ORIGIN/")
        check("the core's shortcut table has crossed to Kotlin (keys.setShortcuts)", awaitTrue(10_000) { helperRows().isNotEmpty() }, "${helperRows().size} rows, ${helperRows().count { it.chord != null }} bound")
        // Pay for the dialog's first layout off camera: SystemUI inflates the helper slowly the
        // first time on the emulator.
        openHelper()
        if (awaitTrue(15_000) { helperUp() }) {
            SystemClock.sleep(600)
            closeHelper()
            awaitTrue(8_000) { !helperUp() }
        } else {
            finding("warm-up: the helper did not come up within 15 s (${frontWindows()})")
            back()
        }
        ensureForeground()
        SystemClock.sleep(1_000)
        finding("warm-up done: form factor ${formFactor()}, active ${activeTabId()}, tabs ${tabUrls()}")
    }

    override fun demo() {
        helperScene("light")
        // The dark scheme: the core's setting (the chrome re-inks) and the system's night mode
        // (the system dialog follows the system's scheme), then the same reading.
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        shellCommand("cmd uimode night yes")
        SystemClock.sleep(2_500)
        ensureForeground()
        check("the chrome is still the tablet after the scheme change", awaitFormFactor("tablet", 10_000), "form factor ${formFactor()}")
        helperScene("dark")
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        shellCommand("cmd uimode night no")
        SystemClock.sleep(2_500)
        ensureForeground()

        // --- the addresses, on the phone chrome ---------------------------------------------------
        resize("1280x590")
        check("at 1280 x 590 the chrome swaps to the phone layout", awaitFormFactor("phone", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        SystemClock.sleep(1_500)
        aliasesScene()
        resize("1280x800")
        check("widened back, the chrome is the tablet again", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}")
        SystemClock.sleep(1_500)
    }

    // --- the helper -------------------------------------------------------------------------------

    /**
     * One reading of the helper in `scheme`. On a large screen Android 14's SystemUI shows
     * `KeyboardShortcutListSearch` (`Flags.SHORTCUT_LIST_SEARCH_LAYOUT`, released): a "Shortcuts"
     * sheet with a search field and four category buttons – System, Input, Open apps, Current app
     * – System selected first, the browser's groups under "Current app" (the same sheet Chrome's
     * helper gets on a tablet). Under 600 dp it is the classic `KeyboardShortcuts` dialog: the
     * app's groups first, then "System" and "Applications". The driver reads either.
     */
    private fun helperScene(scheme: String) {
        finding("--- the helper, $scheme ---")
        val expected = ShortcutHelper.groups(helperRows(), "tablet")
        finding("the activity provides ${expected.size} groups, ${expected.sumOf { it.items.size }} rows: ${expected.map { "${it.title} (${it.items.size})" }}")
        openHelper()
        val up = awaitTrue(15_000) { helperUp() }
        check("[$scheme] META + / opens the system's keyboard-shortcut helper", up, "windows ${frontWindows()}")
        SystemClock.sleep(1_200)
        var texts = helperTexts()
        val largeScreenList = CURRENT_APP in texts
        finding("the helper is ${if (largeScreenList) "the large-screen list (\"$SHORTCUTS_TITLE\": System, Input, Open apps, Current app)" else "the classic dialog"}; its text (${texts.size} nodes): ${texts.joinToString(" | ")}")
        if (largeScreenList) {
            // The browser's groups stand under "Current app": a finger on the button.
            val button = findInWindows(SYSTEM_UI) { it == CURRENT_APP }
            val bounds = button?.let { android.graphics.Rect().also { r -> it.getBoundsInScreen(r) } }
            check("[$scheme] the sheet offers the browser under \"$CURRENT_APP\" (KeyboardShortcutListSearch, the large-screen layout)", bounds != null && !bounds.isEmpty, "button ${describeNode(button)}")
            if (bounds != null && !bounds.isEmpty) Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
            var listed = awaitTrue(8_000) { ShortcutHelper.TABS in helperTexts() }
            if (!listed && button != null) {
                finding("the finger on Current app did not bring the browser's groups; the button's click action instead")
                button.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                listed = awaitTrue(8_000) { ShortcutHelper.TABS in helperTexts() }
            }
            check("[$scheme] \"$CURRENT_APP\" lists the browser's groups", listed, "windows ${frontWindows()}")
            SystemClock.sleep(1_200)
            texts = helperTexts()
            finding("Current app's text (${texts.size} nodes): ${texts.joinToString(" | ")}")
        }
        // The listing: after the category buttons on the large-screen sheet (the scroll view
        // follows them in keyboard_shortcuts_search_view.xml); the whole dialog on the classic one,
        // whose "System" group follows the app's.
        val body = if (largeScreenList) texts.drop(texts.lastIndexOf(CURRENT_APP) + 1) else texts
        val systemGroup = if (largeScreenList) -1 else body.indexOf(SYSTEM_GROUP)
        val end = if (systemGroup >= 0) systemGroup else body.size

        // The groups: every one the activity provides, in Chrome's order, the browser's first.
        val titles = expected.map { it.title }
        val positions = titles.map { body.indexOf(it) }
        check("[$scheme] every group the activity provides is in the listing, in Chrome's order: $titles", positions.all { it >= 0 } && positions == positions.sorted(), "positions $positions")
        check("[$scheme] the first group is Chrome's first, \"${ShortcutHelper.TABS}\"", body.firstOrNull { it in titles || it == SYSTEM_GROUP } == ShortcutHelper.TABS, "first title ${body.firstOrNull { it in titles || it == SYSTEM_GROUP }}")
        if (!largeScreenList) check("[$scheme] the browser's groups stand before the system's own \"$SYSTEM_GROUP\" group", systemGroup >= 0 && positions.all { it in 0 until systemGroup }, "System at $systemGroup")

        // The rows: each listed row's label under its group (after its title, before the next).
        val missing = ArrayList<String>()
        val misplaced = ArrayList<String>()
        for ((i, group) in expected.withIndex()) {
            val start = positions[i]
            val next = if (i + 1 < positions.size) positions[i + 1] else end
            if (start < 0) {
                missing += group.items.map { "${group.title}: ${it.label}" }
                continue
            }
            // Looked for within the group's span: a row's label can be a chord chip's text
            // elsewhere first ("Home" is Move Tab to Start's key under the tabs group, 100 nodes
            // before it is the Home row's label under the feature group – run 36287819321).
            val span = body.subList(minOf(start + 1, next), next)
            for (item in group.items) {
                if (item.label in span) continue
                val elsewhere = body.indexOf(item.label)
                if (elsewhere < 0) missing += "${group.title}: ${item.label}"
                else misplaced += "${group.title}: ${item.label} at $elsewhere (group $start..$next)"
            }
        }
        check("[$scheme] every row the activity lists is in the listing under its group (${expected.sumOf { it.items.size }} rows)", missing.isEmpty() && misplaced.isEmpty(), "missing $missing, misplaced $misplaced")

        // Chrome's words on Chrome's rows, read literally (android_chrome_strings.grd), and the
        // chord the system draws after the label: the modifiers' names, then the key's display
        // label (`getHumanReadableShortcutKeys`), a "+" between them on the large-screen sheet.
        val chromeWords = listOf("Open a new tab", "Close current tab", "Reload the current page", "Jump to address bar", "Zoom in")
        check("[$scheme] Chrome's words on Chrome's rows: $chromeWords", chromeWords.all { it in body }, "absent ${chromeWords.filter { it !in body }}")
        val newTab = body.indexOf("Open a new tab")
        val chord = if (newTab >= 0) body.drop(newTab + 1).take(3).filter { it != "+" && it != "|" }.take(2) else emptyList()
        check("[$scheme] \"Open a new tab\" is drawn with its chord, Ctrl then T", chord == listOf("Ctrl", "T"), "after the label: $chord")

        // The layouts: a desktop-only row of the core's table never reaches this listing (by its
        // label, so a label a listed row happens to share is left out of the claim).
        val listedLabels = expected.flatMap { group -> group.items.map { it.label } }.toSet()
        val desktopOnly = helperRows().filter { it.layouts != null && "tablet" !in it.layouts }.map { it.label }.filter { it !in listedLabels }
        check("[$scheme] the desktop-only rows are not listed (${desktopOnly.size}: $desktopOnly)", desktopOnly.isNotEmpty() && desktopOnly.none { it in body }, "listed ${desktopOnly.filter { it in body }}")
        val hiddenOrUnbound = helperRows().filter { it.chord == null || it.hidden }.map { it.label }.filter { it !in listedLabels }
        check("[$scheme] the unbound and hidden rows are not listed (${hiddenOrUnbound.size})", hiddenOrUnbound.none { it in body }, "listed ${hiddenOrUnbound.filter { it in body }}")

        SystemClock.sleep(800)
        shot("$scheme-tablet")
        SystemClock.sleep(600)
        closeHelper()
        val closed = awaitTrue(8_000) { !helperUp() }
        check("[$scheme] META + / again closes the helper (the system's toggle)", closed, "windows ${frontWindows()}")
        if (!closed) {
            back()
            awaitTrue(5_000) { !helperUp() }
        }
        ensureForeground()
        SystemClock.sleep(800)
    }

    /**
     * META + / as `adb shell input keycombination KEYCODE_META_LEFT KEYCODE_SLASH` sends it: the
     * Meta down, the slash down with the Meta state, the ups – injected asynchronously by the
     * shell so `PhoneWindowManager.interceptKeyBeforeDispatching` handles the chord
     * (`toggleKeyboardShortcutsMenu`).
     */
    private fun openHelper() {
        finding("input keycombination KEYCODE_META_LEFT KEYCODE_SLASH")
        shellCommand("input keycombination ${KeyEvent.KEYCODE_META_LEFT} ${KeyEvent.KEYCODE_SLASH}")
    }

    private fun closeHelper() = openHelper()

    /**
     * SystemUI's helper is up: a window of SystemUI's carries the large-screen sheet's "Current
     * app" button (there from the sheet's first frame, System selected) or the classic dialog's
     * first group of the browser's.
     */
    private fun helperUp(): Boolean = findInWindows(SYSTEM_UI) { it == CURRENT_APP || it == ShortcutHelper.TABS } != null

    /**
     * The helper's text, in tree order (depth first, so a group's title precedes its rows and a
     * row's label precedes its chord): every text or content description of SystemUI's window
     * that is the helper (see [helperUp]). A key chip is a TextView whose text is the key's name
     * ("Ctrl", "T"; its content description the same in lower case, `ShortcutKeyAccessibilityDelegate`),
     * the "+" and "|" between chips TextViews of their own. The listing is a ScrollView; its rows
     * below the fold are in the tree all the same (laid out, clipped), so nothing is scrolled.
     */
    private fun helperTexts(): List<String> {
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != SYSTEM_UI) continue
            val texts = ArrayList<String>()
            walk(root, texts)
            if (CURRENT_APP in texts || ShortcutHelper.TABS in texts) return texts
        }
        return emptyList()
    }

    private fun walk(node: AccessibilityNodeInfo, out: MutableList<String>) {
        val text = node.text?.toString()?.trim()
        val description = node.contentDescription?.toString()?.trim()
        when {
            !text.isNullOrEmpty() -> out += text
            !description.isNullOrEmpty() -> out += description
        }
        for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, out) }
    }

    private fun frontWindows(): String = ui.windows.joinToString { w -> "${w.root?.packageName ?: "?"}/${w.type}" }

    private fun helperRows(): List<ShortcutHelper.Row> {
        var rows: List<ShortcutHelper.Row> = emptyList()
        instrumentation.runOnMainSync { rows = host.keys.helperRows }
        return rows
    }

    // --- the addresses ----------------------------------------------------------------------------

    private fun aliasesScene() {
        finding("--- the chrome:// addresses, phone ---")
        val siteTab = activeTabId()
        check("the phone leg starts on a site tab", siteTab != null && tabUrl(siteTab)?.startsWith(ORIGIN) == true, "active $siteTab at ${activeUrl()}")

        // --- chrome://version: the About Version document in the tab -----------------------------
        typeAddress("chrome://version")
        check("chrome://version typed into the URL field lands the tab on zen://version (the alias table's route)", awaitActiveUrl(VERSION_URL, 10_000), "active ${activeTabId()} at ${activeUrl()}")
        check("the page opened in the tab it was typed into", activeTabId() == siteTab, "active ${activeTabId()} (typed in $siteTab)")
        val page = awaitVersionPage(10_000)
        finding("the version page: $page")
        val title = page?.optString("title")
        val labels = page?.optJSONArray("labels")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList()
        val values = page?.optJSONObject("values")
        check("the document is titled \"About Version\" (Chrome's IDS_VERSION_UI_TITLE)", title == "About Version", "title '$title'")
        check("the rows stand in Chrome's order: the product, OS, APK versionCode, APK targetSdkVersion, User Agent, Executable Path, Profile Path", labels == ANDROID_ROWS, "labels $labels")
        val os = values?.optString("OS") ?: ""
        check("the OS row reads Android's `<release>; <model> Build/<id>; <sdk>; <codename>` (AndroidAboutAppInfo::GetOsInfo + the SDK and codename)", OS_ROW.matches(os), "OS '$os'")
        val product = values?.optString("Zenium") ?: ""
        check("the product row carries the build kind and the processor variation, as Chrome's does", PRODUCT_ROW.matches(product), "Zenium '$product'")
        check("APK versionCode and APK targetSdkVersion are numbers", (values?.optString("APK versionCode") ?: "").matches(Regex("\\d+")) && (values?.optString("APK targetSdkVersion") ?: "").matches(Regex("\\d+")), "versionCode '${values?.optString("APK versionCode")}', targetSdk '${values?.optString("APK targetSdkVersion")}'")
        check("the User Agent row is the WebView's default user agent", (values?.optString("User Agent") ?: "").contains("Mozilla/5.0"), "UA '${values?.optString("User Agent")}'")
        check("Executable Path is the APK and Profile Path the profile's directory", (values?.optString("Executable Path") ?: "").endsWith(".apk") && (values?.optString("Profile Path") ?: "").endsWith("/zen"), "exe '${values?.optString("Executable Path")}', profile '${values?.optString("Profile Path")}'")
        SystemClock.sleep(1_500)
        shot("light-phone-version")

        // --- chrome://flags: stays as typed, the tab stays -----------------------------------------
        val before = activeUrl()
        val tabsBefore = tabUrls()
        typeAddress("chrome://flags")
        SystemClock.sleep(3_000)
        check("chrome://flags typed leaves the tab where it was (no flags page: inputToUrl leaves it as typed, isNavigableUrl refuses the scheme)", activeUrl() == before && tabUrls() == tabsBefore, "active ${activeUrl()} (was $before), tabs ${tabUrls()} (were $tabsBefore)")
        finding("the URL field: ${closeUrlField()}")
        SystemClock.sleep(800)

        // --- chrome://settings: the Settings tab ---------------------------------------------------
        typeAddress("chrome://settings")
        check("chrome://settings typed opens the Settings tab (zenium://settings, the page's tab on the phone)", awaitActiveUrl(SETTINGS_URL, 10_000), "active ${activeTabId()} at ${activeUrl()}, tabs ${tabUrls()}")
        // The page's own layout goes by its width (PageFrame's TWO_PANE_MIN_WIDTH, 720 px): at
        // 1280 px the phone chrome holds the two panes with the first section open (§10.5: "a
        // phone in landscape reaches the two panes inside the phone shell" – run 36287819321 read
        // the two-pane root here); a narrower window would show the phone layout's landing.
        check(
            "the Settings page is drawn: the two-pane layout with a section open at 720 px and over, the phone layout's landing under it",
            awaitTrue(8_000) { settingsLayoutAndSection().let { (layout, section) -> (layout == "two-pane" && section.isNotEmpty()) || (layout == "phone" && section == "landing") } },
            "layout and section ${settingsLayoutAndSection()}"
        )
        check("the version tab stays where it was", VERSION_URL in tabUrls() && tabUrls().size == tabsBefore.size + 1, "tabs ${tabUrls()} (were $tabsBefore)")
        SystemClock.sleep(1_500)
        shot("light-phone-settings")
        finding("the URL field: ${closeUrlField()}")
        SystemClock.sleep(800)
    }

    /**
     * Type into the URL field once it is open – a finger on the pill where the chrome lays it out
     * ([pillBounds]: the document first, the tree after it; the window was just resized, so the
     * harness's measured pill is the old window's), the field proven open by the chrome's store
     * and the focused input ([awaitOmniboxOpen]) – and Go (the navbar demo's way).
     */
    private fun typeAddress(text: String) {
        ensureForeground()
        val box = pillBounds()?.takeIf { it.width() > 100 * density }
        val point = if (box != null) android.graphics.PointF(box.exactCenterX(), box.exactCenterY()) else pillPoint()
        finding("a finger on the pill at ${point.x}x${point.y} (${if (box != null) "the chrome's box $box" else "the harness's pill"})")
        Finger().tap(point.x, point.y)
        val open = awaitOmniboxOpen(8_000)
        if (!open.ok) finding("typing '$text' into a field not proven open: ${open.describe()}")
        SystemClock.sleep(1_500)
        instrumentation.sendStringSync(text)
        SystemClock.sleep(600)
        finding("typed '$text' (field '${awaitOmniboxOpen(1_000).value}'), Enter")
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
    }

    /** The About Version document in the shown tab: its title, its row labels in order and its values by label; null until the tab shows it. */
    private fun awaitVersionPage(timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = pageJs(VERSION_PAGE_JS)
            val json = runCatching { JSONObject(JSONTokener(raw).nextValue().toString()) }.getOrNull()
            if (json != null && json.optString("title") == "About Version" && (json.optJSONArray("labels")?.length() ?: 0) > 0) return json
            SystemClock.sleep(300)
        }
        return null
    }

    /** Evaluate in the shown tab's WebView (the page's document); the raw JSON-encoded result, "" when it never answered. */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.all().firstOrNull { it.isShown }
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    // --- the display ------------------------------------------------------------------------------

    /** `wm size` to `size` (`WxH`, px at the run's density) and a moment for the window to re-lay out. */
    private fun resize(size: String) {
        finding("wm size $size")
        shellCommand("wm size $size")
        SystemClock.sleep(3_000)
        ensureForeground()
        val insets = windowInsets()
        width = insets.windowWidth
        height = insets.windowHeight
        finding("window now ${width}x$height, insets ${insets.top}/${insets.bottom}, form factor ${formFactor()}, viewport ${viewportText()}")
    }

    // --- the chrome's state -----------------------------------------------------------------------

    private fun formFactor(): String = jsText("document.documentElement.dataset.formFactor")
    private fun viewportText(): String = jsText("(function(){var v=window.__zenStores.viewport.get();return v.width+'x'+v.height+' '+v.formFactor+(v.coarse?' coarse':'')})()")

    private fun awaitFormFactor(expected: String, timeoutMs: Long = 10_000): Boolean = awaitTrue(timeoutMs) { formFactor() == expected }

    /** The value `code` evaluates to, as text (a string unquoted; anything else as its JSON). */
    private fun jsText(code: String): String {
        val raw = chromeJs("(function(){var v=($code);return v===undefined?'undefined':(typeof v==='string'?v:JSON.stringify(v))})()")
        if (raw.isEmpty()) return ""
        return runCatching { (JSONTokener(raw).nextValue() as? String) ?: raw }.getOrDefault(raw)
    }

    // --- the core's state -------------------------------------------------------------------------

    private fun activeTabId(): String? = activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() }
    private fun activeUrl(): String? = activeCoreTab()?.optString("url")?.takeIf { it.isNotEmpty() }
    private fun tabUrl(tabId: String): String? = coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("url")

    private fun awaitActiveUrl(url: String, timeoutMs: Long = 5_000): Boolean = awaitTrue(timeoutMs) { activeUrl() == url }

    /**
     * The Settings page's layout and section by its document: `.zen-settings-page`'s `data-layout`
     * (`two-pane` from 720 px of width, `phone` under it) and the shown root's `data-section` (the
     * two-pane root's open section; the phone root's, `landing` at the top). Empty strings while
     * the page is not drawn.
     */
    private fun settingsLayoutAndSection(): Pair<String, String> {
        val read = chromeJsString(
            "(function(){var p=document.querySelector('.zen-settings-page');if(!p)return '|';" +
                "var r=p.querySelector('.zen-settings-two-pane,.zen-settings-phone');" +
                "return String(p.dataset.layout||'')+'|'+String((r&&r.dataset.section)||'')})()"
        ) ?: "|"
        val cut = read.indexOf('|')
        return if (cut < 0) read to "" else read.substring(0, cut) to read.substring(cut + 1)
    }

    /** The Browse space's tabs' URLs in the core's order. */
    private fun tabUrls(): List<String> {
        val state = coreState()
        val spaces = state.getJSONArray("spaces")
        val tabs = state.getJSONObject("tabs")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") != SPACE) continue
            val ids = space.getJSONArray("tabIds")
            return (0 until ids.length()).map { tabs.optJSONObject(ids.getString(it))?.optString("url") ?: "?" }
        }
        return emptyList()
    }

    // --- the pages --------------------------------------------------------------------------------

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(tabId)
                loaded = view != null && view.url == url && view.progress == 100
            }
            if (loaded) return
            SystemClock.sleep(250)
        }
        finding("gave up waiting for $url in $tabId")
    }

    // --- the record -------------------------------------------------------------------------------

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.append(line).append('\n')
    }

    /** A claim of the sequence: written down either way; one that did not hold fails the run at the end. */
    private fun check(claim: String, held: Boolean, detail: String) {
        if (held) {
            finding("OK   $claim${if (detail.isNotEmpty()) " ($detail)" else ""}")
            return
        }
        finding("FAIL $claim ($detail)")
        Log.e(tag, "CLAIM FAILED: $claim ($detail)")
        failures += "$claim ($detail)"
    }

    companion object {
        private const val PORT = 18167
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val SPACE = "space_browse"
        private const val HOME_TAB = "tab_home"
        private const val VERSION_URL = "zen://version"
        private const val SETTINGS_URL = "zen://settings"
        private const val SYSTEM_UI = "com.android.systemui"
        /** SystemUI's own group after the app's on the classic dialog (`R.string.keyboard_shortcut_group_system`). */
        private const val SYSTEM_GROUP = "System"
        /** The large-screen sheet's title (`R.string.keyboard_shortcut_search_list_title`). */
        private const val SHORTCUTS_TITLE = "Shortcuts"
        /** The large-screen sheet's fourth category button, the focused app's own groups (`R.string.keyboard_shortcut_search_category_current_app`). */
        private const val CURRENT_APP = "Current app"

        /** The About Version rows an Android host fills, in Chrome's order (`about_version.html`; no JavaScript row: the WebView has no V8 version to give, no Command Line row). */
        private val ANDROID_ROWS = listOf("Zenium", "Engine", "OS", "APK versionCode", "APK targetSdkVersion", "User Agent", "Executable Path", "Profile Path")
        /** `Android <release>; <model> Build/<id>; <sdk>; <codename>` – `AndroidAboutAppInfo::GetOsInfo()` (`GetAndroidOSInfo`'s `; <model> Build/<id>`) with the SDK and the codename after it. */
        private val OS_ROW = Regex("Android [^;]+; [^;]* Build/[^;]+; \\d+; \\S+")
        /** `<version> (Official Build|Developer Build) (64-bit|32-bit)` – `IDS_VERSION_UI_OFFICIAL` / `_UNOFFICIAL`, `IDS_VERSION_UI_64BIT` / `_32BIT`. */
        private val PRODUCT_ROW = Regex(".+ \\((Official|Developer) Build\\) \\((64|32)-bit\\)")

        /** The page's title, its `<th scope=row>` labels in order and each row's value by its label. */
        private const val VERSION_PAGE_JS =
            "(function(){var labels=[],values={};document.querySelectorAll('tr').forEach(function(tr){var th=tr.querySelector('th[scope=\"row\"]');var td=tr.querySelector('td');" +
                "if(th&&td){labels.push(th.textContent.trim());values[th.textContent.trim()]=td.textContent.trim()}});" +
                "return JSON.stringify({title:document.title,labels:labels,values:values})})()"

        /** The pages the seeded tabs point at, path to title and body. */
        private val PAGES: Map<String, Pair<String, String>> = mapOf(
            "/" to ("Helper demo" to prose("The keyboard-shortcut helper demo's home page.", 12)),
            "/web.html" to ("World Wide Web" to prose("The World Wide Web is an information system of interlinked documents.", 20)),
            "/tablets.html" to ("Tablet computer" to prose("A tablet is a mobile device with a touchscreen display.", 20))
        )

        private fun prose(lead: String, paragraphs: Int): String =
            (1..paragraphs).joinToString("") { "<p>$lead Paragraph $it of $paragraphs.</p>" }
    }
}
