package app.zen.chromium

import android.graphics.PointF
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The tab hover card on the TABLET chrome (TABLET-05; Chrome's tablet strip hover card,
 * `TabHoverCardView.java`): on a `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp
 * (`DEMO_DISPLAY=1280x800@160`), a mouse rests on a sidebar row and the HOST draws the card –
 * the desktop card's form (§9.20's panel at §9.31's numbers: 320 wide at r8 on the squircle, the
 * page's picture in the 286 x 179 box above the title, the title at 15/400 on two lines at most,
 * the host line at 13/400 de-emphasised; no memory line on this chassis) above the live page, where
 * lib/hoverCard.ts's `placeHoverCard` puts it: flush against the sidebar's inner edge, its top on
 * the row's. Every claim is read off the chrome's own stores (`window.__zenStores`), the host's
 * layer (`Host.tabHoverCard`) and the DOM's geometry; a claim that does not hold fails the run at
 * the end, the sequence running on so the recording shows the rest.
 *
 * The sequence, in the seeded Work space (Home in front; Gamma and Delta loose; Research holds
 * Alpha and Beta), every page from the driver's own [DemoServer]:
 *  1. the pointer crosses from the page onto Gamma's row and rests: nothing before Chrome's
 *     ~800 ms, then the host's card for Gamma – title, host line and the page's picture (the
 *     host's own JPEG of the tab, taken when Gamma left the front in the warm-up) – the chrome's
 *     UI state holding no card (nothing over the content frame), Home's page shown and live;
 *  2. the pointer moves on to Delta: the card moves there without a second wait; on to Home's
 *     row (the active tab): the card carries no picture, its page is under the card;
 *  3. the pointer leaves the rows for the page: the card goes after the grace; resting on Gamma
 *     again raises it again; a click on the row takes it down with the press and brings Gamma to
 *     the front.
 *
 * The hover acts run with UiAutomation detached ([DemoHarness.withoutAccessibility], as the desktop
 * windowing demo's: a WebView hands a hover to accessibility exploration while any service is
 * enabled, and Blink never sees the mousemove); the stills are window copies then. Same handshake
 * as the other demos, under `files/tablet-hover-card-demo/`; stills land there as
 * `tablet-hover-card-<theme>-NN-<state>.png`, the claims as `findings-<theme>.txt`.
 */
@RunWith(AndroidJUnit4::class)
class TabletHoverCardDemo : GroupsDemoBase("tablet-hover-card-$THEME", "tablet-hover-card-demo") {
    override val tag = "TabletHoverCardDemo"
    override val findingsFile = "findings-$THEME.txt"
    override val title = "Zenium Android tablet: the tab hover card the host draws (TABLET-05, $THEME)"

    private val main get() = activity as MainActivity
    private val host get() = main.host
    private val mouse by lazy { Mouse() }

    @Test
    fun record() {
        recordDemo(pages = mapOf("/gamma.html" to GAMMA_PAGE), run = ::runMouseDemo)
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    override fun warmUp() {
        shellCommand("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
        head()
        check(
            "the chrome laid the 1280 x 800 window out as the tablet",
            awaitJs("$FORM_FACTOR==='tablet'", true, 10_000),
            "form factor ${jsText(FORM_FACTOR)}, viewport ${jsNumber("window.innerWidth").roundToInt()} x ${jsNumber("window.innerHeight").roundToInt()} CSS px at dpr ${jsNumber("window.devicePixelRatio")}"
        )
        check(
            "the sidebar is docked expanded",
            awaitJs("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar==='expanded'", true, 8_000),
            "data-sidebar '${attrOf(CHROME_ROOT, "data-sidebar")}'"
        )
        awaitLoaded(HOME, "$ORIGIN/")
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        check(
            "before the first hover the host holds no card layer (nothing made at boot, the cold-start rule)",
            onMain { host.tabHoverCard } == null,
            "layer ${onMain { host.tabHoverCard }}"
        )
        // Gamma to the front and Home back: the host takes a tab's picture when its page leaves
        // the front, and the card for a background tab shows that picture (tabs-19).
        coreInvoke("tab.activate", JSONObject().put("tabId", GAMMA).toString())
        awaitUntil(PAGE_SWAP_MS) { activeTabId() == GAMMA && pageCenter(GAMMA) != null }
        awaitLoaded(GAMMA, GAMMA_URL)
        SystemClock.sleep(1_500)
        coreInvoke("tab.activate", JSONObject().put("tabId", HOME).toString())
        awaitUntil(PAGE_SWAP_MS) { activeTabId() == HOME && pageCenter(HOME) != null }
        // The picture is encoded and written on the pictures' own thread once the hide is asked.
        val pictured = awaitUntil(10_000) { onMain { host.thumbnails.loadPicture(GAMMA, GAMMA_URL) != null } }
        check("Gamma's picture is on disk under its document once its page left the front (the card's inner box)", pictured, "loadPicture($GAMMA, $GAMMA_URL) ${onMain { host.thumbnails.loadPicture(GAMMA, GAMMA_URL) }}")
        SystemClock.sleep(1_000)
        finding("warm-up done: active ${activeTabId()}")
    }

    override fun demo() {
        section("1. The pointer rests on Gamma's row: the host's card, with the page's picture, over the live page")
        val page = pageCenter(HOME)
        val gamma = at(row(GAMMA))
        val delta = at(row(DELTA))
        val homeRow = at(row(HOME))
        check("the page and the rows are on screen for the mouse", page != null && gamma != null && delta != null && homeRow != null, "page $page, Gamma $gamma, Delta $delta, Home $homeRow")
        if (page == null || gamma == null || delta == null || homeRow == null) {
            tail()
            return
        }
        withoutAccessibility {
            awaitUntil(6_000) { !accessibilityEnabled() }
            SystemClock.sleep(400)
            restAct(page, gamma)
            section("2. Moving on: to Delta without the wait, to the active row without a picture")
            moveAct(delta, homeRow)
            section("3. Dismissals: the pointer leaving the rows, a click on the row")
            dismissAct(page, gamma)
        }
        check(
            "every mouse event the demo injected was accepted by the input dispatcher",
            mouse.refused.isEmpty(),
            mouse.refused.joinToString("; ")
        )
        tail()
    }

    private fun restAct(page: PointF, gamma: PointF) {
        mouse.moveTo(page.x, page.y)
        SystemClock.sleep(300)
        mouse.moveTo(gamma.x, gamma.y, 400)
        // Read on arrival, off the main thread's own state (a JS round trip on the emulator can
        // take a good part of the delay): the pointer has been on the row for a few frames.
        val onArrival = cardShown()
        check(
            "the Gamma row is :hover under the pointer",
            awaitJs("(function(){var e=document.querySelector('${row(GAMMA)}');return !!e&&e.matches(':hover')})()", true, 2_000),
            ""
        )
        check(
            "no card as the pointer arrives on the row: it shows after Chrome's ~800 ms, not on entry",
            !onArrival,
            "host card on arrival $onArrival, chrome's native slice now ${jsText(NATIVE_CARD)}"
        )
        val up = awaitUntil(3_000) { shownTabId() == GAMMA }
        check("the pointer resting on the row raises the host's card for Gamma", up, "host card ${shownTabId()} after the wait")
        check(
            "the chrome's UI state holds no card – nothing over the content frame – while its native slice names Gamma: the card is the host's",
            jsText(UI_CARD) == "null" && jsText(NATIVE_CARD) == "\"$GAMMA\"",
            "ui.hoverCard.tabId ${jsText(UI_CARD)}, nativeHoverCard.card.tabId ${jsText(NATIVE_CARD)}"
        )
        check(
            "the page keeps playing under the card: Home's page view is shown, no capture stands in for it",
            pageCenter(HOME) != null && jsText("window.__zenStores.ui.get().snapshotTabId") == "null",
            "Home shown ${pageCenter(HOME) != null}, snapshotTabId ${jsText("window.__zenStores.ui.get().snapshotTabId")}"
        )
        val card = onMain { host.tabHoverCard }
        val placement = onMain { card?.placement }
        val rowBox = domRect(row(GAMMA))
        val aside = domRect("$SIDEBAR aside")
        finding("  placement $placement (device px, density $density); Gamma row $rowBox, sidebar aside $aside (CSS px)")
        if (placement != null && rowBox != null && aside != null) {
            val left = placement.left / density
            val top = placement.top / density
            check(
                "the card hangs flush against the sidebar's inner edge, its top on the row's (placeHoverCard's rule, below)",
                placement.side == TabHoverCardPlacement.Side.BELOW && abs(left - aside.right) <= 1.5f && abs(top - rowBox.top) <= 1.5f,
                "card left $left vs sidebar right ${aside.right}; card top $top vs row top ${rowBox.top}"
            )
            check(
                "the card is 320 wide, the desktop card's width",
                abs(placement.width / density - 320f) <= 1f,
                "width ${placement.width / density} CSS px"
            )
        }
        check(
            "the card pictures Gamma's page above the title (tabs-19): the host's own JPEG of the tab, no capture",
            onMain { card?.previewShown } == true,
            "preview shown ${onMain { card?.previewShown }}"
        )
        check(
            "the title and the host line are the desktop card's: Gamma's title and its site as the pill shows it",
            onMain { card?.titleText } == GAMMA_TITLE && onMain { card?.hostText } == "127.0.0.1:$PORT",
            "title '${onMain { card?.titleText }}', host '${onMain { card?.hostText }}'"
        )
        SystemClock.sleep(500)
        still("card-gamma")
    }

    private fun moveAct(delta: PointF, homeRow: PointF) {
        mouse.moveTo(delta.x, delta.y, 200)
        check(
            "the card moves to Delta at once – no second wait – while one is up",
            awaitUntil(500) { shownTabId() == DELTA },
            "host card ${shownTabId()} within 500 ms"
        )
        mouse.moveTo(homeRow.x, homeRow.y, 200)
        val onHome = awaitUntil(500) { shownTabId() == HOME }
        SystemClock.sleep(200)
        check(
            "the active tab's card carries no picture: its page is under the card",
            onHome && onMain { host.tabHoverCard?.previewShown } == false,
            "host card ${shownTabId()}, preview shown ${onMain { host.tabHoverCard?.previewShown }}"
        )
        SystemClock.sleep(400)
        still("card-home-active")
    }

    private fun dismissAct(page: PointF, gamma: PointF) {
        mouse.moveTo(page.x, page.y, 300)
        check(
            "the pointer leaving the rows takes the card down after the grace",
            awaitUntil(2_000) { !cardShown() },
            "host card ${shownTabId()}, native slice ${jsText(NATIVE_CARD)}"
        )
        check("the chrome's native slice is down with it", awaitUntil(1_000) { jsText(NATIVE_CARD) == "null" }, "nativeHoverCard.card.tabId ${jsText(NATIVE_CARD)}")
        mouse.moveTo(gamma.x, gamma.y, 300)
        check(
            "resting on Gamma again raises the card again, after the wait",
            awaitUntil(3_000) { shownTabId() == GAMMA },
            "host card ${shownTabId()}"
        )
        SystemClock.sleep(300)
        mouse.click(gamma.x, gamma.y)
        check(
            "a click on the row takes the card down with the press and brings Gamma to the front",
            awaitUntil(2_000) { !cardShown() } && awaitUntil(PAGE_SWAP_MS) { activeTabId() == GAMMA },
            "host card ${shownTabId()}, active ${activeTabId()}"
        )
        SystemClock.sleep(600)
        still("after-click")
    }

    // --- probes ----------------------------------------------------------------------------------

    private fun cardShown(): Boolean = onMain { host.tabHoverCard?.shown == true }

    private fun shownTabId(): String? = onMain { host.tabHoverCard?.shownTabId }

    private fun at(selector: String): PointF? {
        val box = screen(domRect(selector)) ?: run {
            finding("  ($selector is not on screen)")
            return null
        }
        return PointF(box.exactCenterX(), box.exactCenterY())
    }

    /** The centre of the tab's page WebView on the screen; null when it is not shown. */
    private fun pageCenter(tabId: String): PointF? = onMain {
        val view = host.tabs.get(tabId)
        if (view == null || !view.isShown) {
            null
        } else {
            val origin = IntArray(2)
            view.getLocationOnScreen(origin)
            PointF(origin[0] + view.width / 2f, origin[1] + view.height / 2f)
        }
    }

    private fun accessibilityEnabled(): Boolean =
        (app.getSystemService(android.content.Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager).isEnabled

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    companion object {
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        private const val PAGE_SWAP_MS = 15_000L
        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val TOOLBAR = ".zen-tablet-toolbar"
        private const val ADDRESS_PILL = "$TOOLBAR [data-address-pill]"
        private const val FORM_FACTOR = "document.documentElement.dataset.formFactor"
        private const val UI_CARD = "window.__zenStores.ui.get().hoverCard.tabId"
        private const val NATIVE_CARD = "window.__zenStores.nativeHoverCard.get().card.tabId"
        private const val GAMMA_URL = "$ORIGIN/gamma.html"
        private const val GAMMA_TITLE = "Gamma – the third page of the Work space"
        /** Gamma's page with some structure, so its picture in the card reads as a page. */
        private val GAMMA_PAGE = DemoServer.page(
            GAMMA_TITLE,
            "<p>Gamma, loose in the Work space.</p>" +
                "<div style=\"margin:16px 24px;height:96px;border-radius:12px;background:#1b4332\"></div>" +
                "<p>The tab hover card shows this page's picture above its title while the pointer rests on its row.</p>" +
                "<div style=\"margin:16px 24px;display:flex;gap:12px\">" +
                "<div style=\"flex:1;height:64px;border-radius:8px;background:#d8e2dc\"></div>" +
                "<div style=\"flex:1;height:64px;border-radius:8px;background:#ffe5d9\"></div>" +
                "<div style=\"flex:1;height:64px;border-radius:8px;background:#ffcad4\"></div></div>"
        )

        private fun row(tabId: String) = "$SIDEBAR [data-tab-id=\"$tabId\"]"
    }
}
