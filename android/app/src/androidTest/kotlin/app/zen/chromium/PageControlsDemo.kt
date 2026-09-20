package app.zen.chromium

import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max

/**
 * Drives the page controls so the `android-pagecontrols-demo` workflow can record them on an
 * emulator: Desktop Site on Wikipedia (the mobile layout first, the desktop layout after the
 * toggle, still the desktop layout after a pull-to-refresh, the checkbox remembered in the
 * menu), the dark theme for sites on a light-only page (the chrome's colour scheme switched to
 * light and back in Look and Feel: the same document sees `prefers-color-scheme` flip and the
 * darkening go and return, no reload; then Dark Theme for This Site off, the exception listed
 * under Look and Feel), Force enable zoom on a page that forbids pinching (the pinch does
 * nothing, then Settings > Accessibility turns force zoom on and the same pinch scales the
 * page), the Accessibility default zoom (two steps up in Settings, the page's text following)
 * and Include system font size (the system's font scale raised to 130 percent, then multiplied
 * into the page zoom by the switch).
 *
 * The seeded profile is dark with dark sites on (Wikipedia excepted, so its layouts read
 * plainly). The page that forbids pinching is the test's own, served from a loopback socket:
 * its `user-scalable=no` has to be in the HTML, since Blink only takes a viewport meta's scale
 * limits over at a layout, and a public page cannot be relied on to carry one. The test runs in
 * the app's process, so it can ask the page what it sees (its host, layout width, user agent,
 * visual scale) and logs those as `probe:` lines for the logcat artifact, and it reads the host's
 * own word on whether the chrome has a surface up, which the accessibility tree lags behind on
 * the emulator. Only asserts that it could run; the recording and the screenshots
 * (`pagecontrols-NN-*.png`, numbered in the order they are taken) are the evidence.
 *
 * Open, with its sequence cut into sections and its moves protected, so that [ZoomSheetDemo]
 * (the zoom sheet on a page of its own, then the sections here that were never recorded) is
 * composed from the same pieces rather than a copy of them.
 */
@RunWith(AndroidJUnit4::class)
open class PageControlsDemo protected constructor(
    stateAsset: String,
    shotPrefix: String,
    handshakeDir: String
) : DemoHarness(stateAsset, shotPrefix, handshakeDir) {
    /**
     * JUnit's constructor: the demo on its own profile. The composing constructor above is
     * protected, and the parameters carry no defaults, so the class has exactly one public
     * constructor – JUnit 4 refuses a test class with more ("Test class can only have one
     * constructor"), and defaulted parameters would have the compiler add a public no-argument
     * one beside the three-argument one.
     */
    constructor() : this("pagecontrols-demo-state.json", "pagecontrols", "pagecontrols-demo")

    override val tag = "PageControlsDemo"

    /** Serves the page that forbids pinching; starts when the seeded profile asks for its address. */
    private val lockedPage by lazy { LockedPageServer().also { it.start() } }

    /** Screenshots count up in the order they are taken, whatever sections a demo is made of. */
    private var shots = 0

    @Test
    fun record() = runDemo()

    override fun patchState(json: String): String =
        patchTheme(json).replace(LOCKED_PAGE_PLACEHOLDER, lockedPage.url)

    /** The seeded profile's colour scheme from the `theme` argument. */
    protected fun patchTheme(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    override fun warmUp() {
        warmUpChrome()
        awaitWikipedia("mobile", 30_000)
        SystemClock.sleep(1_500)
    }

    /** The system's night mode after the seeded scheme, and the first menu paid for off camera. */
    protected fun warmUpChrome() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        // The first menu pays for layout and compilation: open it once off camera.
        if (openMenu()) SystemClock.sleep(800)
        ensureChromeClear()
    }

    override fun demo() {
        desktopSiteSection()
        if (switchToTab(CERN_HOST)) darkThemeSection()
        if (switchToTab(LOCKED_HOST)) {
            forceZoomSection()
            defaultZoomSection()
            fontSizeSection()
        }
    }

    // --- the sections ----------------------------------------------------------------------------

    /** A numbered screenshot: `NN-name`, counting up through the demo. */
    protected fun snap(name: String) = shot("%02d-%s".format(++shots, name))

    /**
     * Desktop Site on Wikipedia: the mobile layout, the desktop layout after the toggle, still
     * the desktop layout after a pull-to-refresh, the checkbox remembered in the menu.
     */
    protected fun desktopSiteSection() {
        // 1. Wikipedia as the mobile browser gets it: the mobile (Minerva) layout.
        probe("wikipedia mobile")
        snap("wikipedia-mobile")
        beat()

        // 2. App menu -> Desktop Site: the user agent switches and the page is asked again from
        //    the URL the tab was opened with, so the desktop site answers.
        if (!pickMenuItem("Desktop Site", "menu-desktop-site")) return
        // What the touched item does, asserted (the rule in DemoHarness): the desktop site answers.
        if (awaitWikipedia("desktop", 40_000)) SystemClock.sleep(2_500) else touchFault("Desktop Site under a finger brought no desktop Wikipedia in 40 s")
        probe("wikipedia desktop")
        snap("wikipedia-desktop")
        beat()

        // 3. Pull to refresh: the site is remembered, the reload stays on the desktop layout.
        pullToRefreshOrReload()
        awaitWikipedia("desktop", 30_000)
        SystemClock.sleep(2_500)
        probe("wikipedia desktop after reload")
        snap("wikipedia-desktop-after-reload")
        if (openMenu() && reveal("Desktop Site") != null) {
            SystemClock.sleep(1_000)
            snap("menu-desktop-site-checked")
        }
        ensureChromeClear()
        SystemClock.sleep(1_200)
    }

    /**
     * On a light-only page: darkened by the dark theme for sites; Look and Feel's colour scheme
     * switched to the other one and back with no reload, the same document seeing
     * prefers-color-scheme flip; Dark Theme for This Site off, and the exception listed under
     * Look and Feel.
     */
    protected fun darkThemeSection() {
        // 4. A light-only page, darkened by the dark theme for sites.
        SystemClock.sleep(1_500)
        Log.i(tag, "scheme: the page sees ${schemeSeen()} under the $THEME chrome")
        snap("light-page-darkened")
        beat()

        // 4b. Settings > Look and Feel > Colour scheme to the other one, no reload: the same
        //     document sees prefers-color-scheme flip with the chrome, and the darkening goes
        //     with a light chrome though its switch stays on (it follows the app theme, as in
        //     Chrome). Then back, and both return.
        val document = probeValue("performance.timeOrigin")
        val own = if (THEME == "dark") "Dark" else "Light"
        val other = if (THEME == "dark") "Light" else "Dark"
        if (openSettings("Look and Feel") && chooseOption(COLOR_SCHEME_ROW, own, other)) {
            SystemClock.sleep(1_200)
            snap("look-and-feel-colour-scheme-${other.lowercase()}")
            ensureChromeClear()
            SystemClock.sleep(2_500)
            Log.i(tag, "scheme: the page sees ${schemeSeen()} under the ${other.lowercase()} chrome, " +
                "same document: ${probeValue("performance.timeOrigin") == document}")
            snap("light-page-${other.lowercase()}-chrome")
            beat()
            if (openSettings("Look and Feel") && chooseOption(COLOR_SCHEME_ROW, other, own)) {
                ensureChromeClear()
                SystemClock.sleep(2_500)
                Log.i(tag, "scheme: the page sees ${schemeSeen()} under the $THEME chrome again, " +
                    "same document: ${probeValue("performance.timeOrigin") == document}")
                snap("light-page-${THEME}-chrome-again")
                beat()
            } else {
                ensureChromeClear()
            }
        } else {
            ensureChromeClear()
        }

        // 5. App menu -> Dark Theme for This Site off: the page's own light look, and the
        //    exception listed under Look and Feel > Site exceptions (by the site it is for).
        if (!pickMenuItem("Dark Theme for This Site", "menu-dark-theme-for-site")) return
        SystemClock.sleep(2_000)
        snap("light-page-not-darkened")
        beat()
        if (openSettings("Look and Feel")) {
            if (revealRow(CERN_SITE) != null) {
                SystemClock.sleep(800)
                snap("look-and-feel-site-exceptions")
            } else {
                // What the touched item does, asserted: the site's exception is listed.
                touchFault("Dark Theme for This Site under a finger left no $CERN_SITE exception in Look and Feel")
            }
            ensureChromeClear()
            SystemClock.sleep(1_500)
        }
    }

    /**
     * On the page that forbids pinching: the pinch does nothing; Settings > Accessibility >
     * Force enable zoom, and the same pinch scales the page.
     */
    protected fun forceZoomSection() {
        // 6. The pinch does nothing on a user-scalable=no page.
        SystemClock.sleep(1_000)
        probe("locked page")
        snap("locked-page")
        pinchOut()
        SystemClock.sleep(1_500)
        probe("pinch on a user-scalable=no page")
        snap("pinch-locked")
        beat()
        if (openSettings("Accessibility")) {
            if (toggleSwitch(FORCE_ZOOM_ROW, "accessibility")) {
                SystemClock.sleep(1_200)
                snap("accessibility-force-zoom-on")
            }
            ensureChromeClear()
            SystemClock.sleep(2_000)
        }
        probe("locked page with force zoom")
        pinchOut()
        SystemClock.sleep(1_500)
        probe("pinch with force zoom")
        snap("pinch-forced")
        beat()
    }

    /**
     * A fresh copy of the page on screen (a pinch goes with the old one), then Settings >
     * Accessibility > Default zoom two steps up: the preview grows in Settings and the page's
     * text follows once Settings closes.
     */
    protected fun defaultZoomSection() {
        // 7. Default zoom, two steps up.
        val hostname = probeValue("location.hostname") ?: LOCKED_HOST
        reloadPage()
        awaitPage(hostname, 20_000)
        SystemClock.sleep(1_000)
        probe("default zoom 100")
        if (openSettings("Accessibility")) {
            if (reveal(DEFAULT_ZOOM_ROW) != null) {
                SystemClock.sleep(800)
                clickByLabel("Zoom in")
                SystemClock.sleep(900)
                clickByLabel("Zoom in")
                SystemClock.sleep(1_200)
                snap("accessibility-default-zoom")
            } else {
                Log.w(tag, "no $DEFAULT_ZOOM_ROW row in Accessibility")
            }
            ensureChromeClear()
            SystemClock.sleep(2_500)
        }
        probe("default zoom stepped twice")
        snap("locked-page-default-zoom")
        beat()
    }

    /**
     * The system's font size to 130 percent (the app keeps its own text; the page waits for the
     * switch), then Include system font size multiplies it into the zoom. Leaves the system as
     * it was found.
     */
    protected fun fontSizeSection() {
        // 8. Include system font size.
        shell("settings put system font_scale 1.3")
        SystemClock.sleep(2_500)
        probe("system font size 130, not included")
        snap("locked-page-system-font-size-off")
        if (openSettings("Accessibility")) {
            if (toggleSwitch(FONT_SIZE_ROW, "accessibility-font-size")) {
                SystemClock.sleep(1_200)
                snap("accessibility-font-size-on")
            }
            ensureChromeClear()
            SystemClock.sleep(2_500)
        }
        probe("system font size 130, included")
        snap("locked-page-system-font-size-on")
        beat()
        shell("settings put system font_scale 1.0")
        SystemClock.sleep(2_000)
    }

    // --- the chrome ------------------------------------------------------------------------------

    /**
     * Nothing of the chrome's is up: no menu, no Settings, nothing a step left behind. Back is
     * only sent while the host reports a surface (without one it would navigate the page, or
     * leave the app); a handle the accessibility tree still shows after that is the tree lagging.
     * Should back not take, the sheet's scrim and the overlay's close button are tapped instead.
     *
     * The host is asked after the tree (a tree read can take most of a second) and again right
     * before each back, and a back is then waited out on the host's own word rather than a fixed
     * pause: the first recording lost its second half when Settings, closing under a colour
     * scheme change on the software GPU, reported its surface down 1.7 s after the back – past
     * the pause – and the next back went to the system, which put the app away.
     *
     * With every surface down, the Settings tab may still be in front (a back at a section only
     * pops it to the landing): [leaveSettingsTab] on every way out, not just the last – the
     * audit's second run left it in front from here, and the menu's page items did nothing.
     */
    protected fun ensureChromeClear(): Boolean {
        for (attempt in 1..4) {
            val handle = findByLabel(HANDLE_LABEL)
            val surface = chromeSurfaceUp()
            if (!surface && handle == null) return leaveSettingsTab()
            Log.i(tag, "chrome surface up (host=$surface, handle=${handle != null}); clearing, attempt $attempt")
            when {
                surface && attempt <= 2 -> backWhileSurfaceUp()
                surface && handle != null -> Finger().tap(width / 2f, max(handle.top - 40 * density, 60 * density))
                surface -> if (!clickByLabel(CLOSE_OVERLAY_LABEL)) backWhileSurfaceUp()
                else -> Unit // The tree is behind the host; give it a moment.
            }
            if (surface && !awaitSurface(up = false, timeoutMs = 6_000)) Log.w(tag, "the chrome surface did not go in 6 s")
            SystemClock.sleep(600)
        }
        val clear = !chromeSurfaceUp()
        if (!clear) Log.w(tag, "a chrome surface stayed up")
        return clear && leaveSettingsTab()
    }

    /** Back, unless the host has meanwhile dropped its surface (the back would then leave the app). */
    private fun backWhileSurfaceUp() {
        if (chromeSurfaceUp()) back() else Log.i(tag, "the chrome surface went on its own; no back")
    }

    /**
     * Settings is a tab since #134: a back at its section pops it to the landing (the host's
     * surface goes down) and the tab stays in front, where the menu's page items (Zoom…, Dark
     * Theme for This Site) take no press. A back at the landing closes the tab to the one that
     * opened it (`rootBackAction`'s opener rule), waited out on the core's word of which tab is
     * active. True once no Settings tab is in front.
     */
    private fun leaveSettingsTab(): Boolean {
        if (!settingsTabActive()) return true
        for (attempt in 1..2) {
            Log.i(tag, "the Settings tab is in front; back to its opener, attempt $attempt")
            back()
            val deadline = SystemClock.uptimeMillis() + 6_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (!settingsTabActive()) {
                    SystemClock.sleep(1_000)
                    return true
                }
                SystemClock.sleep(200)
            }
        }
        Log.w(tag, "the Settings tab stayed in front")
        return false
    }

    /** Whether the core's active tab is the Settings page (`zen://settings`, any section). */
    private fun settingsTabActive(): Boolean =
        runCatching { activeCoreTab()?.optString("url").orEmpty().startsWith(SETTINGS_URL) }.getOrDefault(false)

    /**
     * Scroll the Settings row whose text starts with `label` into view and return where it is;
     * null when there is none. A phone Settings row is one button whose label and value (or
     * description) run together in the tree ("Colour scheme Light"), so [reveal]'s exact label
     * finds nothing.
     */
    protected fun revealRow(label: String): Rect? {
        val node = findNode { it.startsWith(label) } ?: return null
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
        return findNode { it.startsWith(label) }?.let { row -> Rect().also { row.getBoundsInScreen(it) } }
    }

    /** Open the app menu from a clear chrome; true once the host and the tree both show it. */
    protected fun openMenu(): Boolean {
        ensureForeground()
        if (!ensureChromeClear()) return false
        val button = findByLabel(MENU_LABEL) ?: computedMenuButton()
        Finger().tap(button.exactCenterX(), button.exactCenterY())
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeSurfaceUp() && findByLabel(HANDLE_LABEL) != null) {
                SystemClock.sleep(1_200)
                return true
            }
            SystemClock.sleep(200)
        }
        Log.w(tag, "the app menu did not open")
        return false
    }

    /** Where the menu button is when the accessibility tree does not say: rightmost in the bar. */
    private fun computedMenuButton() = Rect(
        (width - 52 * density).toInt(), (pill.centerY() - 22 * density).toInt(),
        (width - 8 * density).toInt(), (pill.centerY() + 22 * density).toInt()
    )

    /**
     * Open the app menu, scroll `label` into view, take `shotName` if asked, and pick the item
     * through the tree. False (menu closed again) when the menu or the item never showed up.
     *
     * Not `openMenuItem`: the harness has `openMenuItem(vararg path: String)` (a finger down a
     * submenu path), and with two strings Kotlin resolves to that one over a `(String, String?)`
     * of this name – it would tap the item and then hunt the menu for the screenshot's name.
     */
    protected fun pickMenuItem(label: String, shotName: String?, took: () -> Boolean = { findByLabel(HANDLE_LABEL) == null }): Boolean {
        if (!openMenu()) return false
        if (reveal(label) == null) {
            Log.w(tag, "no $label in the app menu")
            ensureChromeClear()
            return false
        }
        if (shotName != null) snap(shotName)
        // The menu flow's injected touch (the rule in DemoHarness), its result `took` asserted –
        // by default the menu leaving on the item, a caller passing what the item does. A row
        // without bounds on screen to touch goes through the tree. The wait is long: the menu's
        // leave takes three seconds on the software GPU and the tree reports it seconds later.
        if (!touchTapLabelExpecting(label, "the menu's $label did what it does", timeoutMs = 12_000, took = took) && !took()) {
            if (findByLabel(HANDLE_LABEL) != null && clickByLabel(label)) {
                SystemClock.sleep(1_500)
                return true
            }
            Log.w(tag, "$label could not be pressed")
            ensureChromeClear()
            return false
        }
        SystemClock.sleep(1_500)
        return true
    }

    /**
     * Settings from the app menu (the Settings tab up on its landing, `section` among its rows),
     * then the section over the landing. [ensureChromeClear] leaves the tab again afterwards.
     */
    protected fun openSettings(section: String): Boolean {
        if (!pickMenuItem("Settings", null) { findByLabel(section) != null }) return false
        if (waitFor(section, 6_000) == null || !clickByLabel(section)) {
            Log.w(tag, "no $section section in Settings")
            return false
        }
        SystemClock.sleep(1_200)
        return true
    }

    /**
     * Scroll a Settings row with a switch into view, take `shotName` if asked, and flip the
     * switch. The row's label and the switch (labelled after the row) both answer to `row`; the
     * switch is the checkable one, and it is clicked through the tree first, then with a finger
     * at its bounds should the tree's click not have flipped it. False when the row is not there.
     */
    protected fun toggleSwitch(row: String, shotName: String?): Boolean {
        val bounds = revealRow(row)
        if (bounds == null) {
            Log.w(tag, "no $row row in Settings")
            return false
        }
        SystemClock.sleep(800)
        if (shotName != null) snap(shotName)
        val switch = findSwitch(row)
        if (switch == null) {
            Log.w(tag, "no switch labelled $row; tapping the row's trailing edge")
            Finger().tap(width - 62 * density, bounds.exactCenterY())
            return true
        }
        val was = switch.isChecked
        switch.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        SystemClock.sleep(900)
        if (findSwitch(row)?.isChecked == was) {
            Log.w(tag, "$row did not flip through the tree; tapping it")
            val rect = Rect().also { switch.getBoundsInScreen(it) }
            Finger().tap(rect.exactCenterX(), rect.exactCenterY())
            SystemClock.sleep(900)
        }
        Log.i(tag, "$row: ${if (was) "on" else "off"} -> ${findSwitch(row)?.isChecked?.let { if (it) "on" else "off" } ?: "?"}")
        return true
    }

    /**
     * The checkable node for the row `label`: a `role=switch` with that `aria-label`, or the phone
     * Settings row itself (a `role=switch` button whose text runs the label and its description).
     */
    private fun findSwitch(label: String): AccessibilityNodeInfo? = findNodeWhere { node ->
        node.isCheckable && (node.contentDescription?.toString()?.startsWith(label) == true || node.text?.toString()?.startsWith(label) == true)
    }

    /**
     * Pick `next` in the picker of a Settings row that reads `current`. The trigger is clicked
     * through the tree (the picker opens on a click from anything but a mouse), with a finger at
     * its bounds should the tree's click not have taken; the option is then under a finger – the
     * picker's injected touch (the rule in DemoHarness): the picker must close on it with the
     * row reading `next` (a touch through to the host's scrim, #192, closes it with `current`),
     * else the run fails at its end and the tree's click sets the value for the rest of the
     * recording. False when the row, the trigger or the option is not there; true once the row
     * reads `next`.
     */
    protected fun chooseOption(row: String, current: String, next: String): Boolean {
        if (revealRow(row) == null) {
            Log.w(tag, "no $row row in Settings")
            return false
        }
        SystemClock.sleep(600)
        val trigger = findByLabel(current) ?: findNode { it.startsWith(row) && it.endsWith(current) }?.let { node ->
            Rect().also { node.getBoundsInScreen(it) }
        }
        if (trigger == null || !clickByLabel(current) && !rowClicked(row, current)) {
            Log.w(tag, "no $row menulist reading $current")
            return false
        }
        if (waitFor(next, 3_000) == null) {
            Log.w(tag, "$row did not open through the tree; tapping it")
            Finger().tap(trigger.exactCenterX(), trigger.exactCenterY())
            if (waitFor(next, 3_000) == null) {
                Log.w(tag, "no $next option under $row")
                return false
            }
        }
        val reads = { rowReads(row, next) && findByLabel(current) == null }
        if (!touchTapLabelExpecting(next, "the picker closed with the $row row reading $next", timeoutMs = 6_000, took = reads) && !reads()) {
            clickByLabel(next)
            SystemClock.sleep(900)
        }
        val took = reads()
        Log.i(tag, "$row: $current -> ${if (took) next else "still $current"}")
        return took
    }

    /** Click the Settings row that reads `label` and `value` as one text (the picker's trigger on a phone). */
    private fun rowClicked(label: String, value: String): Boolean {
        var node: AccessibilityNodeInfo? = findNode { it.startsWith(label) && it.endsWith(value) } ?: return false
        while (node != null && !node.isClickable) node = node.parent
        return node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: false
    }

    /** The colour scheme the page sees (`prefers-color-scheme`), or null without a page. */
    protected fun schemeSeen(): String? =
        probeValue("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'")

    /**
     * Fling the pill to the next tab until the page at `hostname` (and `path`, when two pages
     * share a host) is on screen; false after three tries.
     */
    protected fun switchToTab(hostname: String, path: String? = null): Boolean {
        ensureChromeClear()
        for (attempt in 1..3) {
            flingLeft()
            settle()
            if (awaitPage(hostname, 15_000, path)) return true
            Log.w(tag, "fling $attempt did not land on $hostname${path.orEmpty()}")
        }
        return false
    }

    /** Reload the page on screen the way the tab would (its scale starts over). */
    protected fun reloadPage() {
        val web = pageWebView() ?: return
        val before = probeValue("performance.timeOrigin")
        instrumentation.runOnMainSync { web.reload() }
        awaitReload(before, 15_000)
    }

    /** Pull to refresh, and reload through the view should the pull not have taken. */
    protected fun pullToRefreshOrReload() {
        val before = probeValue("performance.timeOrigin")
        pullToRefresh()
        if (!awaitReload(before, 12_000)) {
            Log.w(tag, "the pull did not reload; reloading through the view")
            pageWebView()?.let { web -> instrumentation.runOnMainSync { web.reload() } }
            awaitReload(before, 12_000)
        }
    }

    /** A pull past the refresh threshold from the page's top (`lib/pull.ts`: 120 CSS px + slop). */
    protected fun pullToRefresh() {
        Finger().apply {
            down(width * 0.5f, height * 0.4f)
            moveBy(0f, 240 * density, 900)
            hold(500)
            up()
        }
    }

    /** Two fingers moving apart around the middle of the page ([pinch], shared with the PDF viewer demo). */
    protected fun pinchOut() {
        pinch(width * 0.5f, height * 0.4f, 80 * density, 320 * density, 700)
    }

    // --- the page --------------------------------------------------------------------------------

    /** The tab's WebView that is on screen (the test shares the app's process and its views). */
    protected fun pageWebView(): TabWebView? {
        var found: TabWebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: View) {
                if (found != null) return
                if (view is TabWebView && view.isShown) {
                    found = view
                    return
                }
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return found
    }

    /**
     * Wait until the page on screen is at `hostname` (and at `path`, when given) and has finished
     * loading; false on timeout.
     */
    protected fun awaitPage(hostname: String, timeoutMs: Long, path: String? = null): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val web = pageWebView()
            val state = web?.let { evalJs(it, PAGE_STATE_JS) }?.split('|')
            if (state != null && state.size == 3 && state[0] == hostname && state[2] == "complete" &&
                (path == null || state[1] == path)
            ) return true
            SystemClock.sleep(500)
        }
        Log.w(tag, "page $hostname${path.orEmpty()} did not finish loading in ${timeoutMs}ms")
        return false
    }

    /**
     * Wait until Wikipedia is on screen in `layout` (`mobile`, the Minerva skin, or `desktop`,
     * Vector) and has finished loading. Wikipedia serves mobile browsers the mobile layout on its
     * plain domain nowadays, so the skin is what tells the two apart, not the host.
     */
    private fun awaitWikipedia(layout: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val web = pageWebView()
            if (web != null && evalJs(web, WIKI_LAYOUT_JS) == layout) return true
            SystemClock.sleep(500)
        }
        Log.w(tag, "the $layout Wikipedia did not finish loading in ${timeoutMs}ms")
        return false
    }

    /** Wait for a fresh document (its `performance.timeOrigin` differs from `before`). */
    protected fun awaitReload(before: String?, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val now = probeValue("performance.timeOrigin")
            if (now != null && now != before) return true
            SystemClock.sleep(400)
        }
        return false
    }

    /** What the page sees, as a `probe:` line in logcat. */
    protected fun probe(step: String) {
        val web = pageWebView() ?: run {
            Log.i(tag, "probe: $step: no page on screen")
            return
        }
        Log.i(tag, "probe: $step: ${evalJs(web, PROBE_JS)}")
    }

    protected fun probeValue(expression: String): String? =
        pageWebView()?.let { evalJs(it, "String($expression)") }

    /** The string a script evaluates to in the page, or null when it did not answer in time. */
    protected fun evalJs(web: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            web.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        // evaluateJavascript hands the value back as a JSON literal: a quoted string here.
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    protected fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    /**
     * The one page of a site that forbids pinching, served on the loopback interface from a port
     * the system picks: `user-scalable=no` and a pinned `maximum-scale` in the HTML, as many sites
     * ship them. Every request gets the page; the socket closes with the process.
     *
     * Bound to 127.0.0.1 by its bytes, as [DemoServer] is: Android's `getLoopbackAddress()` is
     * `::1`, and a socket there refuses the `127.0.0.1` the address below names – every
     * recording of this driver until the audit had the locked tab on ERR_CONNECTION_REFUSED and
     * skipped its zoom and font sections.
     */
    private class LockedPageServer : Thread("locked-page") {
        private val socket = ServerSocket(0, 8, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        val url: String = "http://127.0.0.1:${socket.localPort}/"

        init {
            isDaemon = true
        }

        override fun run() {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (e: IOException) {
                    return
                }
                try {
                    client.use(::respond)
                } catch (e: IOException) {
                    Log.w("PageControlsDemo", "locked page: $e")
                }
            }
        }

        private fun respond(client: Socket) {
            val input = client.getInputStream().bufferedReader()
            // The request line and headers, up to the blank line; the page is the same for any path.
            while (true) {
                val line = input.readLine() ?: break
                if (line.isEmpty()) break
            }
            val body = LOCKED_PAGE_HTML.toByteArray()
            val head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
                "Content-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            client.getOutputStream().apply {
                write(head.toByteArray())
                write(body)
                flush()
            }
        }
    }

    companion object {
        private const val MENU_LABEL = "Menu"
        internal const val HANDLE_LABEL = "Resize menu"
        /** The overlay's close button carries its title (`Close (Esc)`) as its description. */
        internal const val CLOSE_OVERLAY_LABEL = "Close (Esc)"
        internal const val FORCE_ZOOM_ROW = "Force enable zoom"
        internal const val DEFAULT_ZOOM_ROW = "Default zoom"
        internal const val FONT_SIZE_ROW = "Include system font size"
        internal const val COLOR_SCHEME_ROW = "Colour scheme"
        internal const val CERN_HOST = "info.cern.ch"
        /** The site the CERN page is remembered under (its registrable domain, `siteKey`). */
        internal const val CERN_SITE = "cern.ch"
        internal const val LOCKED_HOST = "127.0.0.1"
        /** Stands for the locked page's address in the seeded profile until the server has a port. */
        private const val LOCKED_PAGE_PLACEHOLDER = "http://locked-page.invalid/"
        /** The Settings tab's page (`zen://settings`, a section under it), since #134. */
        private const val SETTINGS_URL = "zen://settings"

        internal val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "light") "light" else "dark"
        }

        /** Which page is showing (host without the port, path) and whether it has finished loading. */
        private const val PAGE_STATE_JS = "location.hostname + '|' + location.pathname + '|' + document.readyState"

        /** Wikipedia's layout once loaded: `mobile` (Minerva), `desktop` (Vector), else null. */
        private const val WIKI_LAYOUT_JS = """
            (function () {
              if (!/wikipedia\.org$/.test(location.hostname) || document.readyState !== 'complete' || !document.body) return null;
              var c = document.body.className;
              return /\bskin-minerva\b/.test(c) ? 'mobile' : /\bskin-vector/.test(c) ? 'desktop' : 'unknown';
            })()
        """

        /** Host, layout width, visual scale, the viewport meta as the page has it now, user agent. */
        private const val PROBE_JS = """
            (function () {
              var m = document.querySelector('meta[name="viewport"]');
              var vv = window.visualViewport;
              return location.host + ' width=' + document.documentElement.clientWidth +
                ' scale=' + (vv ? vv.scale.toFixed(2) : '?') +
                ' viewport=' + JSON.stringify(m ? m.getAttribute('content') : null) +
                ' ua=' + navigator.userAgent;
            })()
        """

        internal val LOCKED_PAGE_HTML = """
            <!doctype html>
            <html lang="en">
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
            <title>Field notes</title>
            <style>
              body { margin: 0; padding: 28px 22px 48px; font: 17px/1.55 system-ui, sans-serif; color: #1c1b1f; background: #fff; }
              h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; }
              .meta { color: #6b6a71; font-size: 14px; margin: 0 0 22px; }
              p { margin: 0 0 14px; }
              code { background: #f0f0f4; padding: 2px 6px; border-radius: 6px; font-size: 15px; }
              .small { font-size: 12px; color: #4a4950; }
            </style>
            </head>
            <body>
            <h1>Field notes from the shore</h1>
            <p class="meta">A page that says no to pinching</p>
            <p>This page's viewport meta carries <code>user-scalable=no</code> and pins
            <code>maximum-scale=1</code>, so the browser will not let a pinch scale it, however
            small the type.</p>
            <p>Force enable zoom, under Settings &gt; Accessibility, lets you pinch anyway, the way
            Chrome does; Default zoom sets how large pages open, and Include system font size folds
            the size chosen in the system settings into that.</p>
            <p class="small">Small print a reader might want to enlarge: the tide tables for the
            week, the ferry times, and the number to ring when the last boat has gone.</p>
            </body>
            </html>
        """.trimIndent()
    }
}
