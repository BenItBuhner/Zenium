package app.zen.chromium

import android.graphics.PointF
import android.graphics.RectF
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Drives the TABLET chrome (TABLET-01, TABLET-02, TABLET-06, GN-27) on a `pixel_tablet` AVD laid
 * out at 1280 x 800 dp, one px per dp (`DEMO_DISPLAY=1280x800@160`), so the
 * `android-tablet-demo` workflow can record it with real touches and put the tablet's rows in the
 * jank table. Every claim is read off the chrome's own state (its stores on `window.__zenStores`,
 * the root's `data-form-factor` and `data-sidebar`, the DOM's geometry) or the core's
 * (`app.getState`), never off the accessibility tree, which trails the screen by seconds on the
 * emulator's software GPU; a claim that does not hold fails the run at the end, the sequence
 * running on so the recording shows the rest.
 *
 * The sequence, in one Browse space of six loose tabs and a folder of two, every page served by
 * the driver's own [DemoServer] (nothing from the network):
 *  1. the expanded sidebar beside the page under the tablet toolbar: 44 px rows, the close quiet
 *     on inactive rows and full on the active one, the toolbar's 40 px buttons on a 44 pitch, no
 *     Home button;
 *  2. a tap on a sidebar row activates its tab;
 *  3. a hold on a row and a release in place: the tab's menu as a §9.20 popover at the finger;
 *  4. a hold and a drag down the list: the row lifted, the neighbours sliding open (the jank
 *     record's `tablet-sidebar-reorder` scene, traced), dropped two rows down – the order kept by
 *     the core, no window torn off;
 *  5. the toolbar's toggle collapses the sidebar to the 56 px rail; a sideways swipe on the rail
 *     expands it again;
 *  6. the toolbar: Reload fetches the page again, Back and Forward walk the tab's history; a
 *     scroll down the page leaves the toolbar where it is (no bar hide on a tablet);
 *  7. the star bookmarks the page and opens its bubble; the system back closes the bubble and
 *     the bookmark stays;
 *  8. the address pill opens the URL bar with its suggestions in a popup as wide as the pill;
 *     typing brings rows; the shared close takes it down by the chrome's state;
 *  9. the ⋯ opens the app menu as a 332 px popover under it (the `tablet-app-menu-open` scene);
 *     back closes it;
 * 10. a pull down the toolbar opens the tab overview (the `tablet-overview-pull` scene, traced);
 *     its More button opens a sheet that docks centred at 480; back closes the sheet, back the
 *     overview;
 * 11. live resize through `wm size`: 1280 x 590 is the phone chrome (the short side under 600
 *     dp) with the same tab at the same scroll; 600 x 1000 (a split-screen width) is the tablet
 *     with the rail docked and the expanded sidebar as a drawer over the page (the
 *     `tablet-drawer-open` spring scene, traced), closed by back; 800 x 1280 the portrait tablet
 *     with the sidebar docked; 1280 x 800 again.
 *
 * Same handshake as the other demos, under `files/tablet-demo/`; stills land there as
 * `tablet-<theme>-<step>.png`, the claims as `findings.txt`, the scenes as `frames.jsonl`.
 */
@RunWith(AndroidJUnit4::class)
class TabletLayoutDemo : DemoHarness("tablet-demo-state.json", "tablet-$THEME", "tablet-demo") {
    override val tag = "TabletLayoutDemo"

    private lateinit var server: DemoServer
    private val host get() = (activity as MainActivity).host
    private val findings = StringBuilder()
    private val failures = ArrayList<String>()

    /** CSS px of the chrome to screen px: `screen = offset + css * density`, read off the pill ([calibrate]). */
    private var offsetX = 0f
    private var offsetY = 0f

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

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    override fun warmUp() {
        shellCommand("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
        finding("Zenium Android tablet layout ($THEME, window ${width}x$height, density $density)")
        finding("demo server: ${server.selfCheck()}")
        check("the chrome laid the window out as the tablet", awaitFormFactor("tablet"), "form factor ${formFactor()}, viewport ${viewportText()}")
        awaitLoaded(HOME_TAB, "$ORIGIN/")
        calibrate()
        // Pay for the first layout of the menu, the URL bar and the overview off camera (the
        // emulator compiles and lays each out slowly the first time).
        tapDom(MENU_BUTTON, last = true)
        if (awaitJs(MENU_OPEN, true)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(800)
        tapDom(ADDRESS_PILL)
        if (awaitUrlbar(true)) {
            SystemClock.sleep(800)
            closeUrlField()
        }
        SystemClock.sleep(1_500)
        finding("warm-up done: form factor ${formFactor()}, sidebar ${sidebarMode()}")
    }

    override fun demo() {
        expandedSidebar()
        sidebarTap()
        sidebarHoldMenu()
        sidebarReorder()
        railAndSwipe()
        toolbar()
        star()
        omnibox()
        appMenu()
        overviewAndSheet()
        liveResize()
    }

    // --- 1. the expanded sidebar -----------------------------------------------------------------

    private fun expandedSidebar() {
        check("the sidebar is docked expanded at 1280 wide", sidebarMode() == "expanded", "data-sidebar ${sidebarMode()}")
        val toolbar = domRect(TOOLBAR)
        check("the toolbar row is 56 px tall under the top inset", toolbar != null && abs(toolbar.height() - 56 - insetTop()) <= 1, "toolbar $toolbar, inset ${insetTop()}")
        val rows = jsArray("[...document.querySelectorAll('$SIDEBAR [data-tab-id]')].map(function(e){return e.getBoundingClientRect().height})")
        check("the sidebar's tab rows are 44 px tall", rows.length() >= 6 && (0 until rows.length()).all { abs(rows.getDouble(it) - 44) <= 1 }, "heights ${rows.joinToString(",")}")
        val closes = jsArray(
            "[...document.querySelectorAll('$SIDEBAR [data-tab-id]')].map(function(e){var c=e.querySelector('.zen-tab-close');" +
                "return [e.dataset.active==='true', c?Number(getComputedStyle(c).opacity):-1, c?c.getBoundingClientRect().width:0]})"
        )
        var activeOpacity = -1.0
        var quiet = true
        var boxes = true
        for (i in 0 until closes.length()) {
            val row = closes.getJSONArray(i)
            val active = row.getBoolean(0)
            val opacity = row.getDouble(1)
            if (active) activeOpacity = opacity else if (opacity >= 0 && abs(opacity - 0.69) > 0.02) quiet = false
            if (abs(row.getDouble(2) - 44) > 1) boxes = false
        }
        check("the active row's close is full, the inactive rows' close quiet at 69 percent", abs(activeOpacity - 1.0) <= 0.02 && quiet, "closes ${closes.joinToString(",")}")
        check("every close is a 44 px box", boxes, "closes ${closes.joinToString(",")}")
        val centres = jsArray("[...document.querySelectorAll('$TOOLBAR_BUTTONS')].map(function(b){var r=b.getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.width)]})")
        var pitch = true
        var size = true
        for (i in 0 until centres.length()) {
            if (abs(centres.getJSONArray(i).getDouble(1) - 40) > 1) size = false
            if (i > 0 && abs(centres.getJSONArray(i).getDouble(0) - centres.getJSONArray(i - 1).getDouble(0) - 44) > 1) pitch = false
        }
        check("the toolbar's leading buttons are 40 px in flow on a 44 pitch", centres.length() >= 4 && size && pitch, "centres ${centres.joinToString(",")}")
        check("the toolbar has no Home button", jsNumber("document.querySelectorAll('$TOOLBAR button[title^=\"Home\"]').length") == 0.0, "")
        check("no sleep glyph trails a sidebar row", jsNumber("[...document.querySelectorAll('$SIDEBAR .zen-tab-sleeping')].filter(function(e){return getComputedStyle(e).display!=='none'}).length") == 0.0, "")
        shot("01-sidebar-expanded")
    }

    // --- 2. a tap on a row ----------------------------------------------------------------------

    private fun sidebarTap() {
        check("the tap starts on the home tab", activeTabId() == HOME_TAB, "active ${activeTabId()}")
        tapDom(row(WEB_TAB))
        check("a tap on a sidebar row activates its tab", awaitActive(WEB_TAB), "active ${activeTabId()}")
        awaitLoaded(WEB_TAB, "$ORIGIN/web.html")
        SystemClock.sleep(1_500)
        shot("02-sidebar-tap")
    }

    // --- 3. a hold released in place --------------------------------------------------------------

    private fun sidebarHoldMenu() {
        val target = screen(domRect(row(RFC_TAB))) ?: run {
            check("the RFC row is in the sidebar for the hold", false, "no row")
            return
        }
        val x = target.centerX()
        val y = target.centerY()
        Finger().apply {
            press(x, y)
            check("the hold lifts the row (a drag session is up while the finger rests)", awaitJs(DRAG_UP, true, 2_000), "drag ${jsText(DRAG_UP)}")
            up()
        }
        check("released in place, the tab's menu comes up as a popover", awaitJs(MENU_OPEN, true, 3_000) && awaitDom(TABLET_MENU, 3_000), "menu ${jsText(MENU_OPEN)}, popover ${domRect(TABLET_MENU)}")
        val menu = domRect(TABLET_MENU)
        val touchCss = css(x, y)
        check(
            "the tab menu is 332 wide with 44 px rows",
            menu != null && abs(menu.width() - 332) <= 1 && menuRowsAre44(),
            "menu $menu, rows ${jsText(MENU_ROW_HEIGHTS)}"
        )
        check(
            "the tab menu hangs from the touch point",
            menu != null && abs(menu.left - touchCss.x) <= 24 && menu.top >= touchCss.y - 24 && menu.top <= touchCss.y + 24,
            "menu $menu, touch $touchCss, anchor ${jsText("(document.querySelector('$TABLET_MENU')||{}).dataset&&document.querySelector('$TABLET_MENU').dataset.anchor")}"
        )
        SystemClock.sleep(1_200)
        shot("03-tab-menu")
        back()
        check("the system back closes the tab menu", awaitJs(MENU_OPEN, false), "menu ${jsText(MENU_OPEN)}")
        check("the tab stayed where it was after the hold", tabOrder() == SEEDED_ORDER, "order ${tabOrder()}")
        SystemClock.sleep(1_000)
    }

    // --- 4. a hold and a drag: the reorder --------------------------------------------------------

    private fun sidebarReorder() {
        val from = screen(domRect(row(RFC_TAB)))
        val over = screen(domRect(row(TABLETS_TAB)))
        if (from == null || over == null) {
            check("the RFC and Tablet rows are in the sidebar for the reorder", false, "rfc $from, tablets $over")
            return
        }
        val tabsBefore = coreState().getJSONObject("tabs").length()
        val f = Finger()
        f.press(from.centerX(), from.centerY())
        check("the hold lifts the RFC row", awaitJs(DRAG_UP, true, 2_000), "drag ${jsText(DRAG_UP)}")
        // Past the Tablet row's midpoint, short of the one under it: the slot after Tablet. The
        // drag under the finger is the jank record's gesture scene, with the chrome WebView's
        // trace around it; the still and the reads come after the block.
        val dy = over.centerY() + 30 * density - from.centerY()
        traceFrames("tablet-sidebar-reorder", JankBudget.Kind.GESTURE) {
            f.moveBy(0f, dy, 900)
        }
        f.hold(700)
        shot("04-reorder-lifted")
        awaitShots()
        f.up()
        check("the release ends the drag session", awaitJs(DRAG_UP, false, 3_000), "drag ${jsText(DRAG_UP)}")
        SystemClock.sleep(1_500)
        val order = tabOrder()
        check(
            "the RFC tab lands after Tablet computer, the rest in their order",
            order == listOf(HOME_TAB, WEB_TAB, NEWS_TAB, TABLETS_TAB, RFC_TAB, ZENIUM_TAB, TEA_TAB, COFFEE_TAB),
            "order $order"
        )
        check("no tab was torn off (the finger's drop past the list is nothing)", coreState().getJSONObject("tabs").length() == tabsBefore && RFC_TAB in order, "tabs ${coreState().getJSONObject("tabs").length()} (were $tabsBefore)")
        check("the active tab did not change under the reorder", activeTabId() == WEB_TAB, "active ${activeTabId()}")
        shot("05-reorder-dropped")
    }

    // --- 5. the rail ------------------------------------------------------------------------------

    private fun railAndSwipe() {
        tapDom(SIDEBAR_TOGGLE)
        check("the toolbar's toggle collapses the sidebar to the rail", awaitSidebar("rail"), "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(1_500)
        val column = domRect(SIDEBAR_COLUMN)
        check("the rail is 56 px wide", column != null && abs(column.width() - 56) <= 1, "column $column")
        val items = jsArray("[...document.querySelectorAll('$SIDEBAR [data-tab-id]')].map(function(e){var r=e.getBoundingClientRect();return [Math.round(r.left),Math.round(r.width),Math.round(r.height)]})")
        var sized = items.length() >= 6
        for (i in 0 until items.length()) {
            val item = items.getJSONArray(i)
            if (abs(item.getDouble(1) - 44) > 1 || abs(item.getDouble(2) - 44) > 1) sized = false
        }
        check("the rail's items are 44 px squares", sized, "items ${items.joinToString(",")}")
        check("the toggle reads Show sidebar on the rail", jsText("(document.querySelector('$SIDEBAR_TOGGLE')||{}).getAttribute&&document.querySelector('$SIDEBAR_TOGGLE').getAttribute('aria-label')") == "Show sidebar", "")
        shot("06-rail")
        // A sideways swipe on the rail, away from the edge: the sidebar expands.
        val rail = screen(column) ?: return
        Finger().apply {
            down(rail.centerX(), rail.centerY())
            moveBy(140f * density, 0f, 320)
            up()
        }
        check("a swipe away from the edge on the rail expands the sidebar", awaitSidebar("expanded"), "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(1_500)
        shot("07-rail-swiped-open")
        // And back towards the edge: the rail again; the toggle then expands it for the rest.
        val expanded = screen(domRect(SIDEBAR_COLUMN)) ?: return
        Finger().apply {
            down(expanded.centerX(), expanded.bottom - 60 * density)
            moveBy(-140f * density, 0f, 320)
            up()
        }
        check("a swipe towards the edge collapses it", awaitSidebar("rail"), "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(1_000)
        tapDom(SIDEBAR_TOGGLE)
        check("the toggle expands the sidebar again", awaitSidebar("expanded"), "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(1_500)
    }

    // --- 6. the toolbar ---------------------------------------------------------------------------

    private fun toolbar() {
        val hitsBefore = server.hits("/web.html")
        tapDom(TOOLBAR_RELOAD)
        check("Reload fetches the page again", awaitHits("/web.html", hitsBefore + 1), "hits ${server.hits("/web.html")} (was $hitsBefore)")
        awaitLoaded(WEB_TAB, "$ORIGIN/web.html")
        SystemClock.sleep(1_000)
        // A second page in the tab's history, from the page itself.
        pageJs(WEB_TAB, "location.href='/news.html'")
        awaitLoaded(WEB_TAB, "$ORIGIN/news.html")
        check("the page navigated for the history walk", tabUrl(WEB_TAB) == "$ORIGIN/news.html", "url ${tabUrl(WEB_TAB)}")
        SystemClock.sleep(1_000)
        tapDom(TOOLBAR_BACK)
        check("Back returns to the first page", awaitTabUrl(WEB_TAB, "$ORIGIN/web.html"), "url ${tabUrl(WEB_TAB)}")
        SystemClock.sleep(1_000)
        shot("08-toolbar-back")
        tapDom(TOOLBAR_FORWARD)
        check("Forward goes on to the second", awaitTabUrl(WEB_TAB, "$ORIGIN/news.html"), "url ${tabUrl(WEB_TAB)}")
        awaitLoaded(WEB_TAB, "$ORIGIN/news.html")
        SystemClock.sleep(1_000)
        // GN-27: no bar hide on a tablet. A drag up the page scrolls it; the toolbar stays.
        val toolbarBefore = domRect(TOOLBAR)
        val page = screen(domRect(CONTENT)) ?: return
        Finger().apply {
            down(page.centerX(), page.centerY() + 100 * density)
            moveBy(0f, -260 * density, 600)
            up()
        }
        SystemClock.sleep(1_200)
        val scrolled = pageJs(WEB_TAB, "window.scrollY").toDoubleOrNull() ?: 0.0
        check("the drag scrolled the page", scrolled > 100, "scrollY $scrolled")
        check("the toolbar stays through a scroll (no bar hide on a tablet)", domRect(TOOLBAR) == toolbarBefore && jsText("document.documentElement.dataset.barHidden") != "true", "toolbar ${domRect(TOOLBAR)} (was $toolbarBefore)")
        shot("09-toolbar-after-scroll")
    }

    // --- 7. the star ------------------------------------------------------------------------------

    private fun star() {
        check("the page is not bookmarked yet", jsText("(document.querySelector('$STAR')||{}).getAttribute&&document.querySelector('$STAR').getAttribute('data-filled')") != "true", "")
        tapDom(STAR)
        check("the star bookmarks the page and opens its bubble", awaitJs(STAR_DIALOG, true, 4_000), "starDialog ${jsText(STAR_DIALOG)}")
        check("the bubble is a popover, not a sheet", awaitDom(STAR_POPOVER, 2_000) && domRect(".zen-sheet") == null, "popover ${domRect(STAR_POPOVER)}")
        check("the star fills", awaitJs("document.querySelector('$STAR').getAttribute('data-filled')==='true'", true, 2_000), "")
        SystemClock.sleep(1_200)
        shot("10-star-bubble")
        check("the host hands the back to the chrome while the bubble is up", chromeSurfaceUp(), "")
        back()
        check("the system back closes the bubble (its light dismiss), not the page's history", awaitJs(STAR_DIALOG, false) && tabUrl(WEB_TAB) == "$ORIGIN/news.html", "starDialog ${jsText(STAR_DIALOG)}, url ${tabUrl(WEB_TAB)}")
        check("the bookmark stays", jsText("document.querySelector('$STAR').getAttribute('data-filled')") == "true", "")
        SystemClock.sleep(1_000)
    }

    // --- 8. the URL bar ---------------------------------------------------------------------------

    private fun omnibox() {
        val pill = domRect(ADDRESS_PILL)
        tapDom(ADDRESS_PILL)
        check("the address pill opens the URL bar", awaitUrlbar(true), "open ${urlbarOpen()}")
        check("the URL bar's popup is as wide as the pill and hangs from it", awaitDom(OMNIBOX_POPUP, 4_000) && popupHangsFrom(pill), "popup ${domRect(OMNIBOX_POPUP)}, pill $pill")
        awaitIme(true)
        SystemClock.sleep(800)
        instrumentation.sendStringSync("tea")
        check("typing brings suggestion rows", awaitJs("document.querySelectorAll('$OMNIBOX_ROW').length>0", true, 5_000), "rows ${jsText("document.querySelectorAll('$OMNIBOX_ROW').length")}")
        check("the rows are 44 px tall", jsBoolean("[...document.querySelectorAll('$OMNIBOX_ROW')].every(function(r){return Math.abs(r.getBoundingClientRect().height-44)<=1})"), "heights ${jsText("[...document.querySelectorAll('$OMNIBOX_ROW')].map(function(r){return r.getBoundingClientRect().height})")}")
        SystemClock.sleep(1_200)
        shot("11-omnibox-popup")
        val close = closeUrlField()
        check("the URL field closes by the chrome's state and the page is kept", close.ok, close.describe())
        awaitIme(false)
        SystemClock.sleep(1_000)
    }

    // --- 9. the app menu --------------------------------------------------------------------------

    private fun appMenu() {
        val button = domRect(MENU_BUTTON, last = true)
        val target = screen(button) ?: run {
            check("the ⋯ is in the toolbar", false, "no menu button")
            return
        }
        framesSettled()
        // The open is the jank record's `open` scene: the tap and the popover's pop, nothing
        // else in the block (a read of the chrome there would be work of the driver's).
        traceFrames("tablet-app-menu-open", JankBudget.Kind.OPEN) {
            Finger().tap(target.centerX(), target.centerY())
            SystemClock.sleep(1_000)
        }
        check("the ⋯ opens the app menu as a popover", awaitJs(MENU_OPEN, true) && awaitDom(TABLET_MENU, 2_000), "menu ${jsText(MENU_OPEN)}, popover ${domRect(TABLET_MENU)}")
        val menu = domRect(TABLET_MENU)
        check("the app menu is 332 wide with 44 px rows", menu != null && abs(menu.width() - 332) <= 1 && menuRowsAre44(), "menu $menu, rows ${jsText(MENU_ROW_HEIGHTS)}")
        check("it hangs under the ⋯, right edges together", menu != null && button != null && abs(menu.right - button.right) <= 8 && menu.top >= button.bottom && menu.top <= button.bottom + 12, "menu $menu, button $button")
        check("no sheet came with it", domRect(".zen-sheet") == null, "")
        SystemClock.sleep(1_200)
        shot("12-app-menu")
        back()
        check("the system back closes the app menu", awaitJs(MENU_OPEN, false), "menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(1_000)
    }

    // --- 10. the overview and a centred sheet -----------------------------------------------------

    private fun overviewAndSheet() {
        val pill = screen(domRect(ADDRESS_PILL)) ?: return
        framesSettled()
        val f = Finger()
        // The pull is the jank record's gesture scene; the release and its spring come after.
        traceFrames("tablet-overview-pull", JankBudget.Kind.GESTURE) {
            f.down(pill.centerX(), pill.centerY())
            f.moveBy(0f, 0.55f * height, 700)
        }
        f.up()
        check("a pull down the toolbar opens the tab overview", awaitJs(OVERVIEW_PHASE + "==='open'", true, 5_000), "phase ${jsText(OVERVIEW_PHASE)}")
        SystemClock.sleep(1_500)
        shot("13-overview")
        tapDom(OVERVIEW_MORE)
        check("the overview's More opens a sheet", awaitDom(".zen-sheet", 4_000), "sheet ${domRect(".zen-sheet")}")
        SystemClock.sleep(1_500)
        val sheet = domRect(".zen-sheet")
        val window = domRect(CHROME_ROOT)
        check(
            "the sheet docks centred at 480 on a tablet",
            sheet != null && window != null && abs(sheet.width() - 480) <= 1 && abs(sheet.centerX() - window.centerX()) <= 2,
            "sheet $sheet, window $window"
        )
        shot("14-sheet-centred")
        back()
        check("the system back closes the sheet", awaitDomGone(".zen-sheet", 4_000), "sheet ${domRect(".zen-sheet")}")
        check("the overview stays under it", jsText(OVERVIEW_PHASE) == "open", "phase ${jsText(OVERVIEW_PHASE)}")
        SystemClock.sleep(800)
        back()
        check("the next back closes the overview", awaitJs(OVERVIEW_PHASE + "==='closed'", true, 5_000), "phase ${jsText(OVERVIEW_PHASE)}")
        SystemClock.sleep(1_500)
        check("the sidebar is back once the overview is gone", sidebarMode() == "expanded", "data-sidebar ${sidebarMode()}")
    }

    // --- 11. live resize --------------------------------------------------------------------------

    private fun liveResize() {
        val tabBefore = activeTabId()
        pageJs(WEB_TAB, "window.scrollTo(0, 240)")
        SystemClock.sleep(600)
        val scrollBefore = pageJs(WEB_TAB, "window.scrollY").toDoubleOrNull() ?: 0.0
        finding("before the resize: active $tabBefore at scroll $scrollBefore")

        // A 1280 x 590 window: the short side under 600 dp is the phone chrome, its bar below.
        resize("1280x590")
        check("at 1280 x 590 the chrome swaps to the phone layout", awaitFormFactor("phone", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        SystemClock.sleep(2_500)
        val phonePill = findByLabelPrefix(PILL_LABEL)
        val insets = windowInsets()
        check("the phone's pill sits at the bottom of the window", phonePill != null && phonePill.top > insets.windowHeight * 0.6, "pill $phonePill in ${insets.windowWidth}x${insets.windowHeight}")
        check("the swap keeps the active tab", activeTabId() == tabBefore, "active ${activeTabId()}")
        check("the swap keeps the page's scroll", abs((pageJs(WEB_TAB, "window.scrollY").toDoubleOrNull() ?: -1.0) - scrollBefore) <= 2, "scrollY ${pageJs(WEB_TAB, "window.scrollY")} (was $scrollBefore)")
        check("nothing transient came along (no menu, URL bar or drag)", !urlbarOpen() && jsText(MENU_OPEN) == "false" && jsText(DRAG_UP) == "false", "")
        shot("15-phone-1280x590")

        // A 600 dp split-screen width: the tablet again, the rail docked, the sidebar a drawer.
        resize("600x1000")
        check("at 600 x 1000 the chrome is the tablet again", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        check("under 720 dp wide the rail stays docked", awaitSidebar("rail", 8_000), "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(2_000)
        calibrate()
        check("the swap back keeps the active tab", activeTabId() == tabBefore, "active ${activeTabId()}")
        shot("16-split-600-rail")
        val toggle = screen(domRect(SIDEBAR_TOGGLE)) ?: run {
            check("the sidebar toggle is in the toolbar at 600 wide", false, "no toggle")
            return
        }
        framesSettled()
        // The toggle opens the expanded sidebar as a drawer over the page's picture, on the
        // gentle spring: the jank record's spring scene, the tap and the settle in the block.
        traceFrames("tablet-drawer-open", JankBudget.Kind.SPRING) {
            Finger().tap(toggle.centerX(), toggle.centerY())
            SystemClock.sleep(DRAWER_MS)
        }
        check("the toggle opens the sidebar as a drawer", awaitJs(DRAWER_PHASE + "==='open'", true, 4_000), "phase ${jsText(DRAWER_PHASE)}")
        val panel = domRect(DRAWER_PANEL)
        check("the drawer's rows are 44 px tall", panel != null && jsBoolean("[...document.querySelectorAll('$DRAWER_PANEL [data-tab-id]')].every(function(e){return Math.abs(e.getBoundingClientRect().height-44)<=1})"), "panel $panel")
        SystemClock.sleep(1_200)
        shot("17-split-600-drawer")
        back()
        check("the system back closes the drawer", awaitJs(DRAWER_PHASE + "==='closed'", true, 5_000), "phase ${jsText(DRAWER_PHASE)}")
        SystemClock.sleep(1_200)

        // Portrait, 800 x 1280: the tablet with the sidebar docked expanded.
        resize("800x1280")
        check("at 800 x 1280 the chrome is the portrait tablet", awaitFormFactor("tablet", 15_000), "form factor ${formFactor()}, viewport ${viewportText()}")
        check("the sidebar docks expanded in portrait", awaitSidebar("expanded", 8_000), "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(2_500)
        shot("18-portrait-800x1280")

        // And landscape again.
        resize("1280x800")
        check("back at 1280 x 800 the tablet is laid out as at the start", awaitFormFactor("tablet", 15_000) && awaitSidebar("expanded", 8_000), "form factor ${formFactor()}, viewport ${viewportText()}, data-sidebar ${sidebarMode()}")
        SystemClock.sleep(2_500)
        calibrate()
        check("the active tab rode through every swap", activeTabId() == tabBefore, "active ${activeTabId()}")
        check("and its scroll", abs((pageJs(WEB_TAB, "window.scrollY").toDoubleOrNull() ?: -1.0) - scrollBefore) <= 2, "scrollY ${pageJs(WEB_TAB, "window.scrollY")} (was $scrollBefore)")
        shot("19-landscape-again")
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

    // --- the chrome's geometry --------------------------------------------------------------------

    /**
     * Where the chrome's CSS px land on the screen: the toolbar's address pill read from the DOM
     * and from the accessibility tree, the difference the offset. The scale is the display's
     * density (one at `wm density 160`); the pill's width says whether that holds.
     */
    private fun calibrate() {
        val dom = domRect(ADDRESS_PILL)
        val tree = findByLabelPrefix(PILL_LABEL)
        if (dom == null || tree == null) {
            finding("calibration: pill DOM $dom, tree $tree; keeping offsets $offsetX/$offsetY")
            return
        }
        offsetX = tree.left - dom.left * density
        offsetY = tree.top - dom.top * density
        finding("calibration: pill DOM $dom x$density -> tree $tree; offsets ${offsetX.roundToInt()}/${offsetY.roundToInt()}, width ratio ${tree.width() / (dom.width() * density)}")
    }

    /** A CSS rect of the chrome as screen px. */
    private fun screen(r: RectF?): RectF? = r?.let {
        RectF(offsetX + it.left * density, offsetY + it.top * density, offsetX + it.right * density, offsetY + it.bottom * density)
    }

    /** A screen point as the chrome's CSS px. */
    private fun css(x: Float, y: Float) = PointF((x - offsetX) / density, (y - offsetY) / density)

    /** The bounding rect (CSS px) of the first – or with `last`, the last – element `selector` matches; null when none. */
    private fun domRect(selector: String, last: Boolean = false): RectF? {
        val raw = chromeJs(
            "(function(){var a=document.querySelectorAll(${JSONObject.quote(selector)});if(!a.length)return null;" +
                "var e=a[${if (last) "a.length-1" else "0"}];var b=e.getBoundingClientRect();return [b.left,b.top,b.width,b.height]})()"
        )
        if (raw.isEmpty() || raw == "null") return null
        val a = JSONArray(raw)
        val l = a.getDouble(0).toFloat()
        val t = a.getDouble(1).toFloat()
        return RectF(l, t, l + a.getDouble(2).toFloat(), t + a.getDouble(3).toFloat())
    }

    /** A real touch on the middle of the element `selector` matches; false (and a note) when there is none. */
    private fun tapDom(selector: String, last: Boolean = false): Boolean {
        val target = screen(domRect(selector, last)) ?: run {
            finding("no element for $selector to tap")
            return false
        }
        Finger().tap(target.centerX(), target.centerY())
        return true
    }

    private fun awaitDom(selector: String, timeoutMs: Long = 4_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (domRect(selector) != null) return true
            SystemClock.sleep(150)
        }
        return domRect(selector) != null
    }

    private fun awaitDomGone(selector: String, timeoutMs: Long = 4_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (domRect(selector) == null) return true
            SystemClock.sleep(150)
        }
        return domRect(selector) == null
    }

    private fun insetTop(): Double = jsNumber("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zen-inset-top'))||0")

    /** The URL bar's popup shares the pill's left edge and width (TB-21), within a px. */
    private fun popupHangsFrom(pill: RectF?): Boolean {
        val popup = domRect(OMNIBOX_POPUP) ?: return false
        if (pill == null) return false
        return abs(popup.left - pill.left) <= 2 && abs(popup.width() - pill.width()) <= 2 && popup.top >= pill.top - 2
    }

    private fun menuRowsAre44(): Boolean = jsBoolean("[...document.querySelectorAll('$TABLET_MENU_ITEM')].every(function(r){return Math.abs(r.getBoundingClientRect().height-44)<=1})")

    // --- the chrome's state -----------------------------------------------------------------------

    private fun formFactor(): String = jsText("document.documentElement.dataset.formFactor")
    private fun sidebarMode(): String = jsText("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar")
    private fun viewportText(): String = jsText("(function(){var v=window.__zenStores.viewport.get();return v.width+'x'+v.height+' '+v.formFactor+(v.coarse?' coarse':'')})()")

    private fun awaitFormFactor(expected: String, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (formFactor() == expected) return true
            SystemClock.sleep(200)
        }
        return formFactor() == expected
    }

    private fun awaitSidebar(expected: String, timeoutMs: Long = 4_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (sidebarMode() == expected) return true
            SystemClock.sleep(150)
        }
        return sidebarMode() == expected
    }

    private fun awaitUrlbar(open: Boolean, timeoutMs: Long = 5_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (urlbarOpen() == open) return true
            SystemClock.sleep(150)
        }
        return urlbarOpen() == open
    }

    /** Poll the boolean `code` evaluates to in the chrome until it is `expected`. */
    private fun awaitJs(code: String, expected: Boolean, timeoutMs: Long = 4_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (jsBoolean(code) == expected) return true
            SystemClock.sleep(150)
        }
        return jsBoolean(code) == expected
    }

    private fun jsBoolean(code: String): Boolean = chromeJs("!!($code)") == "true"

    private fun jsNumber(code: String): Double = chromeJs("Number($code)").toDoubleOrNull() ?: Double.NaN

    /** The value `code` evaluates to, as text (a string unquoted; anything else as its JSON). */
    private fun jsText(code: String): String {
        val raw = chromeJs("(function(){var v=($code);return v===undefined?'undefined':(typeof v==='string'?v:JSON.stringify(v))})()")
        if (raw.isEmpty()) return ""
        return runCatching { (JSONTokener(raw).nextValue() as? String) ?: raw }.getOrDefault(raw)
    }

    private fun jsArray(code: String): JSONArray {
        val raw = chromeJs("JSON.stringify($code)")
        if (raw.isEmpty() || raw == "null") return JSONArray()
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return JSONArray()
        return runCatching { JSONArray(text) }.getOrDefault(JSONArray())
    }

    private fun JSONArray.joinToString(separator: String): String = (0 until length()).joinToString(separator) { get(it).toString() }

    // --- the core's state -------------------------------------------------------------------------

    private fun activeTabId(): String? = activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() }

    private fun awaitActive(tabId: String, timeoutMs: Long = 5_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeTabId() == tabId) return true
            SystemClock.sleep(200)
        }
        return activeTabId() == tabId
    }

    /** The Browse space's tabs in the core's order (the loose rows, then the folder's). */
    private fun tabOrder(): List<String> {
        val spaces = coreState().getJSONArray("spaces")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") != SPACE) continue
            val ids = space.getJSONArray("tabIds")
            return (0 until ids.length()).map { ids.getString(it) }
        }
        return emptyList()
    }

    private fun tabUrl(tabId: String): String? = coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("url")

    private fun awaitTabUrl(tabId: String, url: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (tabUrl(tabId) == url) return true
            SystemClock.sleep(200)
        }
        return tabUrl(tabId) == url
    }

    private fun awaitHits(path: String, atLeast: Int, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (server.hits(path) >= atLeast) return true
            SystemClock.sleep(200)
        }
        return server.hits(path) >= atLeast
    }

    // --- the pages --------------------------------------------------------------------------------

    /** Evaluate in the tab's own WebView (the page, not the chrome); "" when it never answered. */
    private fun pageJs(tabId: String, code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

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

    private fun framesSettled() {
        awaitShots()
        SystemClock.sleep(1_200)
    }

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
        private const val PORT = 18165
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val SPACE = "space_browse"
        private const val HOME_TAB = "tab_home"
        private const val WEB_TAB = "tab_web"
        private const val RFC_TAB = "tab_rfc"
        private const val NEWS_TAB = "tab_news"
        private const val TABLETS_TAB = "tab_tablets"
        private const val ZENIUM_TAB = "tab_zenium"
        private const val TEA_TAB = "tab_tea"
        private const val COFFEE_TAB = "tab_coffee"
        private val SEEDED_ORDER = listOf(HOME_TAB, WEB_TAB, RFC_TAB, NEWS_TAB, TABLETS_TAB, ZENIUM_TAB, TEA_TAB, COFFEE_TAB)

        /** The chrome's roots and controls, by the attributes the components carry. */
        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val TOOLBAR = ".zen-tablet-toolbar"
        /** The toolbar's leading buttons: the sidebar toggle, Back, Forward, Reload (in flow on the 44 pitch). */
        private const val TOOLBAR_BUTTONS = ".zen-tablet-toolbar [data-tablet-sidebar-toggle], .zen-tablet-toolbar [data-zen-nav-row] > button[title^=\"Back\"], .zen-tablet-toolbar [data-zen-nav-row] > button[title^=\"Forward\"], .zen-tablet-toolbar [data-zen-nav-row] > button[title^=\"Reload\"]"
        private const val TOOLBAR_BACK = ".zen-tablet-toolbar [data-zen-nav-row] > button[title^=\"Back\"]"
        private const val TOOLBAR_FORWARD = ".zen-tablet-toolbar [data-zen-nav-row] > button[title^=\"Forward\"]"
        private const val TOOLBAR_RELOAD = ".zen-tablet-toolbar [data-zen-nav-row] > button[title^=\"Reload\"]"
        private const val SIDEBAR_TOGGLE = ".zen-tablet-toolbar [data-tablet-sidebar-toggle]"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val STAR = ".zen-tablet-toolbar .zen-bm-star"
        private const val STAR_POPOVER = ".zen-bm-popover"
        /** The ⋯: the nav row's last own button with a menu (the pill's chips are inside the pill). */
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val SIDEBAR_COLUMN = ".zen-tablet-sidebar"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val DRAWER_PANEL = ".zen-tablet-drawer-panel"
        private const val CONTENT = ".zen-content-frame"
        private const val TABLET_MENU = ".zen-tablet-menu"
        private const val TABLET_MENU_ITEM = ".zen-tablet-menu-item"
        private const val OMNIBOX_POPUP = ".zen-omnibox-sheet"
        private const val OMNIBOX_ROW = ".zen-omnibox-row"
        private const val OVERVIEW_MORE = ".zen-overview button[aria-label=\"More\"]"

        private fun row(tabId: String) = ".zen-tablet-sidebar [data-tab-id=\"$tabId\"]"

        /** Reads off the chrome's stores (`lib/store.ts` registers them on `window.__zenStores`). */
        private const val MENU_OPEN = "window.__zenStores.ui.get().menu!==null"
        private const val DRAG_UP = "window.__zenStores.ui.get().drag!==null"
        private const val STAR_DIALOG = "window.__zenStores.ui.get().starDialog!==null"
        private const val MENU_ROW_HEIGHTS = "[...document.querySelectorAll('.zen-tablet-menu-item')].map(function(r){return r.getBoundingClientRect().height})"
        private const val OVERVIEW_PHASE = "window.__zenStores.stage.get().overview.phase"
        private const val DRAWER_PHASE = "window.__zenStores['tablet-drawer'].get().phase"

        /** How long the drawer's gentle spring is given inside its measured block (it lands well within). */
        private const val DRAWER_MS = 1_600L

        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        /** The pages the seeded tabs point at, path to title and body: long enough to scroll. */
        private val PAGES: Map<String, Pair<String, String>> = mapOf(
            "/" to ("Tablet demo" to prose("The tablet layout demo's home page.", 24)),
            "/web.html" to ("World Wide Web" to prose("The World Wide Web is an information system of interlinked documents.", 40)),
            "/rfc2324.html" to ("RFC 2324: HTCPCP/1.0" to prose("Hyper Text Coffee Pot Control Protocol.", 30)),
            "/news.html" to ("Morning news" to prose("Nothing much happened, which is news in itself.", 40)),
            "/tablets.html" to ("Tablet computer" to prose("A tablet is a mobile device with a touchscreen display.", 30)),
            "/zenium.html" to ("Zenium" to prose("A browser for phones, tablets and desktops.", 30)),
            "/tea.html" to ("RFC 7168: HTCPCP-TEA" to prose("The Hyper Text Coffee Pot Control Protocol for Tea Efflux Appliances.", 30)),
            "/coffee.html" to ("Coffee" to prose("Coffee is a beverage brewed from roasted coffee beans.", 30))
        )

        private fun prose(lead: String, paragraphs: Int): String =
            (1..paragraphs).joinToString("") { "<p>$lead Paragraph $it of $paragraphs, so the page runs past one screen and a scroll has somewhere to go.</p>" }
    }
}
