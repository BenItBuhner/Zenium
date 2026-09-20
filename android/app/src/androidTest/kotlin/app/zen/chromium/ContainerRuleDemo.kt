package app.zen.chromium

import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.util.Log
import android.view.KeyEvent
import android.view.PixelCopy
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records PR #232's container rule on the phone – an internal page asked from a private tab
 * opens as a REGULAR-container tab that still remembers the private tab as its opener – for the
 * `android-container-rule-demo` workflow, and writes what it measured to
 * `android-container-rule-findings.txt` next to the frames (one `PASS` or `FAIL` per check; a
 * check that fails fails the run once the recording is done):
 *
 *  1. a seeded profile past first run, a regular page in front: no private tab, no session card,
 *     no `FLAG_SECURE`;
 *  2. New Private Tab from the app menu (a finger on the sheet's row): the active tab's
 *     `containerId` is the private container, the private page loads on the private profile and
 *     bakes a cookie that never reaches the default jar, #223's ongoing "Close all private tabs"
 *     card is posted, `FLAG_SECURE` is on the window;
 *  3. Settings from the app menu (a finger) with the private tab in front: the active tab is
 *     the Settings page tab with `containerId === "default"` and `openerTabId` = the private
 *     tab's id; the private tab is still there, container and URL unchanged; exactly one
 *     Settings tab; `privateTabs()` still counts the one private tab and the card still stands;
 *  4. a finger on the system's Back at the Settings landing: the private tab is active again
 *     and the Settings tab is gone (`rootBackAction`'s opener rule for internal-page tabs);
 *  5. Settings from the private tab again, the private tab brought back through the overview
 *     (a finger on its card) with Settings left open, then Close Tab from the Tabs button's quick
 *     menu (a finger): the private session ENDS while Settings is open – `privateTabs()` empty,
 *     the card gone, `profile.clear` sent for the private container and the private profile's
 *     jar wiped, `FLAG_SECURE` off – and the Settings tab is still there in the default container;
 *  6. a fresh private tab (menu, a finger) visits the private page and finds the jar empty; a
 *     finger on the pill and `zenium://settings/privacy` typed: the private tab keeps its page,
 *     the one regular Settings tab moves to Privacy.
 *
 * Every step leaves two stills: `<nn>-<step>.png`, the window as the app drew it (a PixelCopy of
 * the window, which `FLAG_SECURE` does not black out – the same copy the chrome's covers and
 * thumbnails come from), and `<nn>-<step>-screen.png`, the system's capture (UiAutomation), which
 * the guard blacks out while private browsing is on the screen: its share of black pixels is
 * noted with the still, as the guard's evidence. On this head (#223's guard, before #203's) the
 * guard also stands while Settings is in front of a private tab (`PrivateSession.onScreen`: no
 * page showing and a private tab open), so the system's frames of steps 3 and 6 are black too.
 *
 * The pages come from a loopback server in this process ([DemoServer]); the profile is the
 * Settings tab demo's (`settings-tab-demo-state.json`: the demo page active and a second tab; its
 * port is this demo's too). Private tabs need a WebView with profiles, so the workflow runs on an
 * AOSP image with a Chromium snapshot WebView swapped in, as the private tabs demo does. See
 * [DemoHarness] for the plumbing; every sheet flow puts a finger on a control inside the sheet
 * and asserts what it did.
 */
@RunWith(AndroidJUnit4::class)
class ContainerRuleDemo : DemoHarness("settings-tab-demo-state.json", "android-container-rule", "container-rule-demo") {
    override val tag = "ContainerRuleDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host
    private val notifications: NotificationManager by lazy { app.getSystemService(NotificationManager::class.java) }

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        var fault: Throwable? = null
        try {
            runDemo()
        } catch (e: Throwable) {
            fault = e
        } finally {
            server.close()
        }
        if (failures.isNotEmpty() || fault != null) {
            throw AssertionError(
                "${failures.size} check(s) failed: ${failures.joinToString("; ")}" +
                    (fault?.let { "; and: ${it.javaClass.simpleName}: ${it.message}" } ?: "")
            )
        }
    }

    // --- the pages -------------------------------------------------------------------------------

    /**
     * The regular page the profile opens on, the second tab's page, and the private page: it
     * says what the site's cookie jar holds (re-read every half second, so the page on screen is
     * the jar's truth whatever set or wiped it); the driver bakes the cookie through the page's
     * script, so a fresh private tab after the wipe shows the jar empty.
     */
    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to DemoServer.page(
            DEMO_TITLE,
            "<p>A regular page of the demo's own, in the default container. The private tab and the " +
                "Settings tab the demo opens are asked from the app menu.</p>"
        ),
        "/other.html" to DemoServer.page("Second tab", "<p>The tab the demo does not visit.</p>"),
        "/private.html" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$PRIVATE_TITLE</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}main{padding:36px 24px}" +
                "h1{font-size:28px;margin:0 0 20px}#jar{font-size:21px;line-height:1.4;padding:22px;border-radius:16px;" +
                "background:#f2f1f5;min-height:64px;word-break:break-all}#jar[data-has]{background:#e6f4ea;color:#1b4332}" +
                "p{margin-top:28px;color:#5b5a63;font-size:16px;line-height:1.5}</style></head>" +
                "<body><main><h1>$PRIVATE_TITLE</h1><div id=jar></div>" +
                "<p>A page only the private tab visits. Its cookie lives in the private profile's jar, " +
                "which is wiped when the last private tab closes.</p>" +
                "</main><script>" +
                "function read(){var m=document.cookie.split(';').map(function(s){return s.trim()}).filter(function(s){return s.indexOf('jar=')===0})[0];return m?m.slice(4):''}" +
                "function show(){var v=read();var el=document.getElementById('jar');" +
                "if(v){el.textContent='This site has a cookie: '+v;el.setAttribute('data-has','')}" +
                "else{el.textContent='This site has no cookie';el.removeAttribute('data-has')}}" +
                "show();setInterval(show,500);" +
                "</script></body></html>"
            ).toByteArray())
    )

    // --- sequence --------------------------------------------------------------------------------

    override fun warmUp() {
        findings = File(out, "android-container-rule-findings.txt")
        findings.writeText(
            "Zenium Android container rule demo, PR #232 (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "WebView ${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"})\n" +
                "Stills: <nn>-<step>.png is the window as the app drew it (PixelCopy); <nn>-<step>-screen.png is the system's capture, " +
                "black while FLAG_SECURE is on.\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding(
            "multi-profile WebView: ${onMain { Profiles.supported }}; capabilities.privateTabs per the core: ${privateTabsCapability()}; " +
                "private profile at start: ${privateProfileState()}"
        )
        awaitLoaded(DEMO_TAB, "$ORIGIN/")
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded (the warm tab closed, the demo page active).
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        val painted = awaitChrome("!!document.querySelector('$SEARCH_FIELD')", 12_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(800)
        ensureActive(DEMO_TAB)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_500)
        finding("warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; ${describeActive()}")
    }

    override fun demo() {
        ensureForeground()
        if (!privateTabsCapability()) {
            expect("the core offers private tabs on this WebView (the image needs a multi-profile WebView)", false)
            still("00-no-private-tabs")
            return
        }
        val before = tabCount()
        var privId = ""
        var settingsId = ""

        // 1. The seeded profile: a regular page in front, no private tab, no card, no guard.
        step("1. A regular page, no private session") {
            val tab = activeCoreTab()
            still("01-regular-page")
            finding("  ${describeActive()}; card ${describeCard(privateCard())}; FLAG_SECURE ${secureNow()}")
            expect(
                "the regular page is active in the default container",
                tab?.optString("id") == DEMO_TAB && tab?.optString("containerId") == Profiles.DEFAULT_CONTAINER
            )
            expect("no private tab, no session card, FLAG_SECURE off", privateTabIds().isEmpty() && privateCard() == null && !secureNow())
        }

        // 2. New Private Tab from the app menu, its page on the private profile, the card, the guard.
        step("2. New Private Tab from the app menu") {
            if (!openMenuItem(MENU_NEW_PRIVATE)) {
                finding("  the menu had no $MENU_NEW_PRIVATE row")
                closeSurfaces()
                expect("the app menu offers New Private Tab", false)
                return@step
            }
            val opened = awaitPrivateActive(10_000)
            if (!opened) touchFault("the touch on '$MENU_NEW_PRIVATE' left no private tab active")
            privId = activeTabId()
            val tab = activeCoreTab()
            finding("  after the row: ${describeActive()}, containerId '${tab?.optString("containerId")}'")
            expect("the active tab's containerId is the private container", opened && tab?.optString("containerId") == Profiles.PRIVATE_CONTAINER)
            // The private page, typed into the pill (an empty tab has no address to edit).
            navigateByTyping(privId, "$ORIGIN/private.html")
            val profile = profileName(privId)
            val baked = bakeCookie(privId)
            SystemClock.sleep(600)
            finding(
                "  private tab $privId on ${tabUrl(privId)} (profile $profile); baked '$baked'; " +
                    "private jar '${privateJar()}', default jar '${defaultJar()}'"
            )
            expect("the private tab runs on the private profile and its cookie stays out of the default jar",
                profile == PRIVATE_PROFILE && baked.contains("jar=") && privateJar().contains("jar=") && !defaultJar().contains("jar="))
            val card = awaitCard(8_000)
            val secure = awaitSecure(true, 6_000)
            still("02-private-tab")
            finding("  card ${describeCard(card)}; FLAG_SECURE $secure")
            expect("#223's ongoing card is posted with the private tab", card != null && cardOngoing(card) && cardText(card) == "1 private tab is open")
            expect("FLAG_SECURE is on with the private page in front", secure)
        }

        // 3. Settings from the private tab: a regular-container tab that remembers the private opener.
        step("3. Settings from the app menu, asked from the private tab") {
            if (privId.isEmpty()) {
                finding("  no private tab to ask from")
                return@step
            }
            ensureActive(privId)
            val picked = pickMenuRow("Settings")
            finding("  Settings row: $picked")
            if (!picked.startsWith("a finger")) {
                still("03x-menu-without-settings")
                closeSurfaces()
                expect("the app menu offers Settings", false)
                return@step
            }
            val tab = awaitPage(SETTINGS_URL, 10_000)
            if (tab?.optString("url") != SETTINGS_URL) touchFault("the touch on the menu's Settings did not open the Settings tab")
            settingsId = tab?.optString("id").orEmpty()
            SystemClock.sleep(1_500)
            still("03-settings-from-private")
            val priv = coreTab(privId)
            val settingsTabs = settingsTabIds()
            finding(
                "  active $settingsId ${tab?.optString("url")}, containerId '${tab?.optString("containerId")}', openerTabId '${tab?.optString("openerTabId")}'; " +
                    "private tab ${priv?.optString("id")} ${priv?.optString("url")} containerId '${priv?.optString("containerId")}'; " +
                    "Settings tabs $settingsTabs; privateTabs ${privateTabIds()}; tabs ${tabCount()} (were $before); " +
                    "card ${describeCard(privateCard())}; FLAG_SECURE ${secureNow()} (this head's guard keys on the pages' visibility, not the active tab)"
            )
            expect("the Settings tab is the active tab, in the DEFAULT container", tab?.optString("url") == SETTINGS_URL && tab?.optString("containerId") == Profiles.DEFAULT_CONTAINER)
            expect("the Settings tab remembers the private tab as its opener", tab?.optString("openerTabId") == privId)
            expect(
                "the private tab is still there, container and URL unchanged",
                priv != null && priv.optString("containerId") == Profiles.PRIVATE_CONTAINER && priv.optString("url") == "$ORIGIN/private.html"
            )
            expect("exactly one Settings tab", settingsTabs.size == 1)
            expect("privateTabs() counts the one private tab, not Settings; the card stands", privateTabIds() == listOf(privId) && privateCard() != null)
        }

        // 4. Back at the landing: rootBackAction's opener rule returns to the private tab and closes Settings.
        step("4. Back at the Settings landing") {
            if (settingsId.isEmpty()) {
                finding("  no Settings tab to go back from")
                return@step
            }
            ensureActive(settingsId)
            if (chromeSurfaceUp()) {
                back()
                awaitSurface(up = false, timeoutMs = 5_000)
            }
            val how = systemBack()
            val returned = awaitActive(privId, 8_000)
            SystemClock.sleep(1_500)
            if (!appInFront()) {
                finding("  the back LEFT THE APP (the launcher is in front): bringing it back")
                recoverApp()
            }
            still("04-back-to-private")
            val closed = coreTab(settingsId) == null
            finding("  back by $how: active ${activeTabId()} ${activeUrl()}; Settings tab $settingsId ${if (closed) "closed" else "STILL OPEN"}; tabs ${tabCount()} (were ${before + 1})")
            expect("back at the landing returns to the private tab", returned)
            expect("the Settings tab is gone", closed)
        }

        // 5. Settings again, the private tab brought back through the overview, then closed: the session ends under Settings.
        step("5. The private session ends while Settings stays open") {
            if (privId.isEmpty() || coreTab(privId) == null) {
                finding("  no private tab left")
                return@step
            }
            ensureActive(privId)
            val picked = pickMenuRow("Settings")
            finding("  Settings row: $picked")
            if (!picked.startsWith("a finger")) {
                still("05x-menu-without-settings")
                closeSurfaces()
                expect("the app menu offers Settings (again)", false)
                return@step
            }
            val tab = awaitPage(SETTINGS_URL, 10_000)
            settingsId = tab?.optString("id").orEmpty()
            SystemClock.sleep(1_000)
            finding("  Settings again: active $settingsId ${tab?.optString("url")}, containerId '${tab?.optString("containerId")}', openerTabId '${tab?.optString("openerTabId")}'")
            expect("Settings opens again as a default-container tab with the private opener",
                tab?.optString("url") == SETTINGS_URL && tab?.optString("containerId") == Profiles.DEFAULT_CONTAINER && tab?.optString("openerTabId") == privId)
            // The private tab back through the overview, Settings left open.
            val overview = openOverview()
            SystemClock.sleep(1_200)
            still("05a-overview")
            var switched = false
            if (overview) {
                val card = chromeRect("[data-tab-id=\"$privId\"]")
                if (card != null) {
                    Finger().tap(card.exactCenterX(), card.exactCenterY())
                    switched = awaitActive(privId, 8_000)
                    if (!switched) touchFault("the touch on the private tab's card did not activate it")
                } else finding("  no card for $privId in the overview")
            }
            if (!switched) {
                finding("  the overview did not bring the private tab back; activating it through the core (the claim of this step is the close)")
                closeSurfaces()
                ensureActive(privId)
            }
            awaitOverviewGone()
            SystemClock.sleep(1_000)
            expect("the private tab is back in front with Settings still open", activeTabId() == privId && coreTab(settingsId) != null)
            // The close: Close Tab from the Tabs button's quick menu, a finger on the row.
            hookProfileClears()
            val jarBefore = privateJar()
            holdTabsButton()
            val menu = awaitQuickMenu(6_000)
            SystemClock.sleep(800)
            still("05b-quick-menu")
            var closed = false
            if (menu) {
                closed = touchTapLabelExpecting("Close Tab", "the private tab is closed", timeoutMs = 8_000) { coreTab(privId) == null }
            } else finding("  the quick menu never opened")
            if (!closed) {
                finding("  Close Tab did not close the private tab from the quick menu; closing through the overview's card")
                closeSurfaces()
                if (openOverview()) {
                    val close = chromeRect("[data-tab-id=\"$privId\"] [aria-label=\"Close tab\"]")
                    if (close != null) {
                        Finger().tap(close.exactCenterX(), close.exactCenterY())
                        closed = awaitGone(privId, 8_000)
                    }
                    closeSurfaces()
                    awaitOverviewGone()
                }
            }
            val cardGone = awaitCardGone(8_000)
            val secureOff = awaitSecure(false, 6_000)
            val wiped = awaitPrivateWiped(15_000)
            val clears = profileClears()
            SystemClock.sleep(1_200)
            still("05-session-ended")
            val settings = coreTab(settingsId)
            finding(
                "  private tab closed $closed; privateTabs ${privateTabIds()}; card ${describeCard(privateCard())} (gone $cardGone); " +
                    "profile.clear calls $clears; private jar '$jarBefore' -> '${privateJar()}' (profile ${privateProfileState()}, wiped $wiped); " +
                    "FLAG_SECURE ${secureNow()} (off $secureOff); Settings tab ${settings?.optString("id")} ${settings?.optString("url")} " +
                    "containerId '${settings?.optString("containerId")}'; active ${activeTabId()}; tabs ${tabCount()}"
            )
            expect("closing the private tab leaves privateTabs() empty", closed && privateTabIds().isEmpty())
            expect("the session card is gone", cardGone)
            expect("the private profile is wiped (profile.clear for the private container; the jar empty)", wiped && clears.contains(Profiles.PRIVATE_CONTAINER))
            expect("FLAG_SECURE is off", secureOff)
            expect("the Settings tab is still open, in the default container",
                settings != null && settings.optString("url").startsWith(SETTINGS_URL) && settings.optString("containerId") == Profiles.DEFAULT_CONTAINER)
        }

        // 6. A fresh private tab finds the jar empty; zenium://settings/privacy typed into its pill moves the one regular Settings tab.
        step("6. zenium://settings/privacy typed from a fresh private tab") {
            if (settingsId.isEmpty() || coreTab(settingsId) == null) {
                finding("  no Settings tab to reuse")
                return@step
            }
            ensureActive(settingsId)
            if (!openMenuItem(MENU_NEW_PRIVATE)) {
                finding("  the menu had no $MENU_NEW_PRIVATE row")
                closeSurfaces()
                expect("the app menu offers New Private Tab (again)", false)
                return@step
            }
            val opened = awaitPrivateActive(10_000)
            if (!opened) touchFault("the touch on '$MENU_NEW_PRIVATE' left no private tab active (second time)")
            val priv2 = activeTabId()
            expect("a fresh private tab opens in the private container", opened && priv2 != privId && coreTab(priv2)?.optString("containerId") == Profiles.PRIVATE_CONTAINER)
            navigateByTyping(priv2, "$ORIGIN/private.html")
            SystemClock.sleep(1_000)
            val jarText = jarText(priv2)
            val cookie = cookieOf(priv2)
            still("06a-fresh-private-tab")
            finding("  fresh private tab $priv2 on ${tabUrl(priv2)}: page says '$jarText', document.cookie '$cookie'; card ${describeCard(privateCard())}")
            expect("the next private tab finds the jar empty (the wipe took)", jarText == "This site has no cookie" && cookie.isEmpty())
            // The pill under a finger, the address typed, Enter.
            val typed = typeIntoPill("zenium://settings/privacy")
            val moved = awaitPage("$SETTINGS_URL/privacy", 12_000)
            SystemClock.sleep(1_500)
            still("06-settings-privacy")
            val priv = coreTab(priv2)
            val settingsTabs = settingsTabIds()
            finding(
                "  typed $typed; active ${moved?.optString("id")} ${moved?.optString("url")}, containerId '${moved?.optString("containerId")}'; " +
                    "private tab ${priv?.optString("id")} ${priv?.optString("url")} containerId '${priv?.optString("containerId")}'; " +
                    "Settings tabs $settingsTabs; privateTabs ${privateTabIds()}; tabs ${tabCount()}"
            )
            expect("the one regular Settings tab moves to Privacy and comes to the front",
                moved?.optString("id") == settingsId && moved?.optString("url") == "$SETTINGS_URL/privacy" && moved?.optString("containerId") == Profiles.DEFAULT_CONTAINER)
            expect("the private tab keeps its page", priv != null && priv.optString("url") == "$ORIGIN/private.html" && priv.optString("containerId") == Profiles.PRIVATE_CONTAINER)
            expect("still exactly one Settings tab", settingsTabs.size == 1)
            if (chromeSurfaceUp()) {
                back()
                awaitSurface(up = false, timeoutMs = 5_000)
            }
        }

        finding("\nend: ${describeActive()}; privateTabs ${privateTabIds()}; card ${describeCard(privateCard())}; FLAG_SECURE ${secureNow()}")
        finding("checks failed: ${failures.size}${if (failures.isEmpty()) "" else " – " + failures.joinToString("; ")}")
    }

    // --- steps and findings ----------------------------------------------------------------------

    /** Run one step of the sequence; a failure inside it is a finding, not the end of the recording. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
            failures.add("$name: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun expect(name: String, ok: Boolean) {
        Log.i(tag, "check \"$name\": ${if (ok) "ok" else "FAILED"}")
        finding("  $name ${if (ok) "PASS" else "FAIL"}")
        if (!ok) failures.add(name)
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- stills ----------------------------------------------------------------------------------

    /**
     * Two stills of the moment: the window as the app drew it (a PixelCopy of the window, which
     * FLAG_SECURE leaves alone) as `<name>.png`, and the system's capture as `<name>-screen.png`,
     * with its share of black pixels noted – the guard's evidence while private browsing is on
     * the screen.
     */
    private fun still(name: String) {
        val window = windowStill(name)
        val black = screenStill("$name-screen")
        finding("  still $name: window copy $window; system capture ${"%.0f".format(black * 100)}% black")
    }

    /** A PixelCopy of the window into `<prefix>-<name>.png`; how it went. */
    private fun windowStill(name: String): String {
        val (w, h) = onMain { activity.window.decorView.let { it.width to it.height } }
        if (w <= 0 || h <= 0) return "no window"
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val latch = CountDownLatch(1)
        var status = Int.MIN_VALUE
        instrumentation.runOnMainSync {
            runCatching {
                PixelCopy.request(
                    activity.window,
                    bitmap,
                    { result ->
                        status = result
                        latch.countDown()
                    },
                    Handler(Looper.getMainLooper())
                )
            }.onFailure {
                Log.w(tag, "PixelCopy.request threw", it)
                status = -99
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        if (status != PixelCopy.SUCCESS) {
            bitmap.recycle()
            return "PixelCopy failed ($status)"
        }
        File(out, "android-container-rule-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        return "ok"
    }

    /** The system's capture into `<prefix>-<name>.png`; the share of near-black pixels in it (sampled). */
    private fun screenStill(name: String): Float {
        val bitmap = ui.takeScreenshot() ?: return -1f
        File(out, "android-container-rule-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        var black = 0
        var total = 0
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val c = bitmap.getPixel(x, y)
                if (Color.red(c) < 12 && Color.green(c) < 12 && Color.blue(c) < 12) black++
                total++
                x += 8
            }
            y += 8
        }
        bitmap.recycle()
        return if (total == 0) 0f else black.toFloat() / total
    }

    // --- the core's state ------------------------------------------------------------------------

    private fun privateTabsCapability(): Boolean =
        coreState().optJSONObject("capabilities")?.optBoolean("privateTabs") ?: false

    private fun coreTab(tabId: String, state: JSONObject = coreState()): JSONObject? =
        if (tabId.isEmpty()) null else state.getJSONObject("tabs").optJSONObject(tabId)

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabUrl(tabId: String): String = coreTab(tabId)?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    /** The ids of the tabs in the private container, sorted (`tabs.privateTabs()` as the state shows it). */
    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.getJSONObject("tabs")
        return tabs.keys().asSequence().filter { tabs.getJSONObject(it).optString("containerId") == Profiles.PRIVATE_CONTAINER }.sorted().toList()
    }

    /** The ids of the tabs showing the Settings page, sorted. */
    private fun settingsTabIds(): List<String> {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().filter { tabs.getJSONObject(it).optString("url").startsWith(SETTINGS_URL) }.sorted().toList()
    }

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun awaitPrivateActive(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateActive()) return true
            SystemClock.sleep(200)
        }
        return privateActive()
    }

    /** Poll until `tabId` is the active tab; false when it does not become so in time. */
    private fun awaitActive(tabId: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeTabId() == tabId) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "$tabId did not become the active tab")
        return activeTabId() == tabId
    }

    /** Poll until `tabId` is gone from the core's tabs. */
    private fun awaitGone(tabId: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (coreTab(tabId) == null) return true
            SystemClock.sleep(250)
        }
        return coreTab(tabId) == null
    }

    private fun ensureActive(tabId: String) {
        if (tabId.isEmpty() || activeTabId() == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        awaitActive(tabId, 8_000)
        SystemClock.sleep(1_000)
    }

    /**
     * Poll until the active tab shows `url`; that tab, or the active tab then when it does not
     * come in time.
     */
    private fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return activeCoreTab()
    }

    // --- the private session as the host holds it: the card, the guard, the profile -------------

    /** The session's card as the system holds it (the app's own notifications), null when none is posted. */
    private fun privateCard(): StatusBarNotification? =
        runCatching { notifications.activeNotifications.firstOrNull { it.id == PrivateSession.NOTIFICATION_ID } }.getOrNull()

    private fun awaitCard(timeoutMs: Long): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            privateCard()?.let { return it }
            SystemClock.sleep(250)
        }
        return privateCard()
    }

    private fun awaitCardGone(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateCard() == null) return true
            SystemClock.sleep(250)
        }
        return privateCard() == null
    }

    private fun cardText(sbn: StatusBarNotification?): String? =
        sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun cardOngoing(sbn: StatusBarNotification?): Boolean =
        sbn != null && sbn.notification.flags and Notification.FLAG_ONGOING_EVENT != 0

    private fun describeCard(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        val title = n.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        return "id=${sbn.id} channel=${n.channelId} title=\"$title\" text=\"${cardText(sbn)}\" ongoing=${cardOngoing(sbn)}"
    }

    /** Whether FLAG_SECURE is on the activity's window now. */
    private fun secureNow(): Boolean = onMain {
        activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
    }

    private fun awaitSecure(on: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (secureNow() == on) return true
            SystemClock.sleep(200)
        }
        return secureNow() == on
    }

    /** The name of the profile a tab's WebView runs on, per the engine; "(no profiles)" without the feature. */
    private fun profileName(tabId: String): String {
        val view = host.tabs.get(tabId) ?: return "(no view for $tabId)"
        return onMain {
            if (!Profiles.supported) "(no profiles)"
            else runCatching { WebViewCompat.getProfile(view).name }.getOrElse { "(error: $it)" }
        }
    }

    private fun privateProfileExists(): Boolean = onMain {
        Profiles.supported && runCatching { ProfileStore.getInstance().allProfileNames.contains(PRIVATE_PROFILE) }.getOrDefault(false)
    }

    /** The private profile's cookies for the site; "" without a profile (or a cookie). */
    private fun privateJar(): String = onMain {
        runCatching { Profiles.profile(Profiles.PRIVATE_CONTAINER)?.cookieManager?.getCookie(ORIGIN) }.getOrNull().orEmpty()
    }

    private fun defaultJar(): String = CookieManager.getInstance().getCookie(ORIGIN).orEmpty()

    private fun privateProfileState(): String =
        if (privateProfileExists()) "exists, jar '${privateJar()}'" else "absent"

    /** Wiped: no private profile left, or one without the site's cookie (its deletion waits for a view to go). */
    private fun awaitPrivateWiped(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (!privateProfileExists() || privateJar().isEmpty()) return true
            SystemClock.sleep(300)
        }
        return !privateProfileExists() || privateJar().isEmpty()
    }

    /**
     * Count the `profile.clear` calls the chrome sends the host from here on. The bridge encodes
     * every call with `JSON.stringify` (`Bridge.call`), so the driver wraps it in the chrome and
     * notes the container of each `profile.clear` – the core's `sessions.clearPrivate`, which
     * `endPrivateSessionIfOver` makes once the last private tab is gone. Nothing of the product
     * is touched for it.
     */
    private fun hookProfileClears() {
        chromeJs(
            "(function(){if(window.__zenClears)return;window.__zenClears=[];var s=JSON.stringify;" +
                "JSON.stringify=function(v){if(v&&typeof v==='object'&&v.method==='profile.clear')" +
                "window.__zenClears.push((v.args&&v.args.containerId)||'');return s.apply(this,arguments)}})()"
        )
    }

    /** The containers of the `profile.clear` calls counted since [hookProfileClears], in order. */
    private fun profileClears(): List<String> {
        val raw = chromeValue("JSON.stringify(window.__zenClears||[])")
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getString(it) }
    }

    // --- the pages -------------------------------------------------------------------------------

    /** Bake the site's cookie in the page of `tabId` through its script; `document.cookie` after. */
    private fun bakeCookie(tabId: String): String {
        val view = host.tabs.get(tabId) ?: return ""
        return jsonString(pageJs(view, "(function(){document.cookie='jar=private-${SystemClock.uptimeMillis() % 100_000}; path=/; max-age=86400';return document.cookie})()"))
    }

    private fun cookieOf(tabId: String): String {
        val view = host.tabs.get(tabId) ?: return ""
        return jsonString(pageJs(view, "document.cookie"))
    }

    /** What the private page says of its jar (`#jar`'s text). */
    private fun jarText(tabId: String): String {
        val view = host.tabs.get(tabId) ?: return ""
        return jsonString(pageJs(view, "(document.getElementById('jar')||{}).textContent||''"))
    }

    /** Evaluate in a tab's page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(view: WebView, code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val view = host.tabs.get(tabId)
            val loaded = view != null && onMain { view.url == url && view.progress == 100 }
            if (loaded) return true
            SystemClock.sleep(300)
        }
        Log.w(tag, "$tabId never finished loading $url: ${host.tabs.get(tabId)?.let { onMain { "${it.url} ${it.progress}%" } }}")
        return false
    }

    // --- the pill and the URL bar ----------------------------------------------------------------

    /** The chrome's address editor is up (its field is mounted only while editing). */
    private fun urlbarOpen(): Boolean = chromeValue("String(!!document.querySelector('$URLBAR_FIELD'))") == "true"

    private fun awaitUrlbar(open: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (urlbarOpen() == open) return true
            SystemClock.sleep(200)
        }
        return urlbarOpen() == open
    }

    /** Back out of the URL bar if it is up (the keyboard first, then the field). */
    private fun dismissUrlbar() {
        repeat(3) {
            if (!urlbarOpen()) return
            back()
            SystemClock.sleep(1_200)
        }
        if (urlbarOpen()) Log.w(tag, "the urlbar stayed open")
    }

    /**
     * A finger on the pill (by its label – an address, or "Search or enter address" on a tab with
     * no page – else where the bar has it), `text` typed through the instrumentation once the
     * editor's field is up (everything selected on open, so the text replaces the address), then
     * Enter. How it went, for the findings.
     */
    private fun typeIntoPill(text: String): String {
        ensureForeground()
        val target = findByLabelPrefix(PILL_LABEL) ?: findByLabel(EMPTY_PILL_LABEL) ?: pill
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        val up = awaitUrlbar(true, 6_000)
        if (!up) return "the editor did not open on the pill's tap"
        awaitChrome("document.activeElement===document.querySelector('$URLBAR_FIELD')", 4_000)
        SystemClock.sleep(1_200)
        instrumentation.sendStringSync(text)
        SystemClock.sleep(800)
        val value = chromeValue("(document.querySelector('$URLBAR_FIELD')||{}).value||''")
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        return "'$text' into the pill (field read '$value' before Enter)"
    }

    /**
     * Navigate `tabId` to `url` by typing it into the pill; the core's navigate command stands in
     * when the page never arrives that way (the claim of the steps that use this is elsewhere).
     */
    private fun navigateByTyping(tabId: String, url: String) {
        ensureActive(tabId)
        val typed = typeIntoPill(url)
        finding("  typed $typed")
        if (!awaitLoaded(tabId, url, 15_000)) {
            finding("  typing $url did not land in $tabId; navigating through the core instead")
            dismissUrlbar()
            coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(tabId)},\"input\":${JSONObject.quote(url)}}")
            awaitLoaded(tabId, url)
        }
        dismissUrlbar()
        SystemClock.sleep(800)
    }

    // --- the app menu ----------------------------------------------------------------------------

    /**
     * A finger on the app menu's row `label`, wherever the sheet holds it. The menu is opened from
     * the bar's button and pulled to its full height as the harness's `openMenuItem` does; the
     * row is then looked for with bounds on screen, and while it has none a finger scrolls the
     * sheet's list (`.zen-sheet-scroll`) upwards – the phone menu runs to some twenty rows, and
     * with a private tab open it gains Close Private Tabs, so Settings sits below the fold; the
     * tree's `ACTION_SHOW_ON_SCREEN` (`reveal`) left it there in the first run while the private
     * page's ticker kept the window's tree churning. As the last resort the row is located in the
     * chrome's DOM, scrolled into view there, and the finger lands on its box: the pick is a real
     * touch either way. How it went, for the findings ("a finger …" on success).
     */
    private fun pickMenuRow(label: String): String {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) return "the menu never opened"
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        var swipes = 0
        repeat(4) { attempt ->
            val node = awaitNode(if (attempt == 0) 3_000 else 2_000) { it == label }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                if (touchTap(node)) return "a finger on the '$label' row at $bounds after $swipes scroll(s) of the list"
                Log.w(tag, "the '$label' row at $bounds could not be touched; scrolling on")
            }
            val list = rectFromChrome(
                "(function(){var e=document.querySelector('.zen-sheet-scroll');if(!e)return '';" +
                    "var r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
            ) ?: return "the sheet's list is not in the chrome's DOM (menu closed?)"
            val top = maxOf(list.top, touchable.top) + 24f
            val bottom = minOf(list.bottom, touchable.bottom) - 24f
            if (bottom - top < 120f) return "the sheet's list ($list) leaves no room to scroll"
            val from = top + (bottom - top) * 0.85f
            val to = top + (bottom - top) * 0.15f
            Log.i(tag, "finger scroll of the menu's list from ${list.exactCenterX()},$from to $to")
            Finger().apply {
                down(list.exactCenterX(), from)
                moveBy(0f, to - from, 260)
                up()
            }
            swipes++
            SystemClock.sleep(1_600)
        }
        // The DOM knows where the row is even while the tree lags: scroll it into view there and
        // put the finger on its box.
        val box = rectFromChrome(
            "(function(){var q=" + JSONObject.quote(label) + ";var b=Array.prototype.slice.call(document.querySelectorAll('.zen-sheet-item'))" +
                ".filter(function(e){return (e.textContent||'').trim()===q})[0];if(!b)return '';" +
                "b.scrollIntoView({block:'center'});var r=b.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
        ) ?: return "no '$label' row in the sheet's DOM after $swipes scroll(s)"
        SystemClock.sleep(1_200)
        val again = rectFromChrome(
            "(function(){var q=" + JSONObject.quote(label) + ";var b=Array.prototype.slice.call(document.querySelectorAll('.zen-sheet-item'))" +
                ".filter(function(e){return (e.textContent||'').trim()===q})[0];if(!b)return '';" +
                "var r=b.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
        ) ?: box
        if (again.centerY() !in touchable.top until touchable.bottom) return "the '$label' row's box $again is outside the touchable window"
        Finger().tap(again.exactCenterX(), again.exactCenterY())
        return "a finger on the '$label' row at $again, located through the chrome's DOM after $swipes scroll(s) of the list"
    }

    // --- the system's back, the overview, the quick menu ------------------------------------------

    /**
     * The system's back under a finger: the navigation bar's Back button (three-button navigation,
     * which the workflow's script turns on) touched where SystemUI draws it; the accessibility
     * global action when the bar has no such button on screen. How it was sent.
     */
    private fun systemBack(): String {
        val node = findInWindows(SYSTEM_UI) { it == "Back" }
        if (node != null) {
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            if (!bounds.isEmpty && bounds.centerY() in 0 until height) {
                Log.i(tag, "touch on the navigation bar's Back at $bounds")
                Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
                return "a finger on the navigation bar's Back ($bounds)"
            }
        }
        back()
        return "the accessibility back action (no Back button on screen)"
    }

    /** The browser's own window is the one in front (not the launcher, not a system dialog). */
    private fun appInFront(): Boolean = ui.rootInActiveWindow?.packageName?.toString() == app.packageName

    /** Bring the browser's task back in front of the launcher; the activity is singleTask, so nothing restarts. */
    private fun recoverApp() {
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!appInFront() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        SystemClock.sleep(1_500)
    }

    /** Back out of whatever chrome surface is up, a few at most, each given time to go. */
    private fun closeSurfaces() {
        repeat(3) {
            if (!chromeSurfaceUp()) return
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
            SystemClock.sleep(500)
        }
    }

    private fun tabsButton(): Rect? =
        findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
            ?: chromeRect("[aria-label^=\"Tabs (\"]")

    /**
     * Open the overview from the bar's Tabs button (a finger). The emulator's input pipeline can
     * hand the release over late, so the bar reads a hold and opens the quick menu instead:
     * dismissed and tried again.
     */
    private fun openOverview(): Boolean {
        if (overviewOpen()) return true
        repeat(3) {
            val tabs = tabsButton() ?: run {
                finding("  no Tabs button on the bar")
                return false
            }
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (overviewOpen()) {
                    SystemClock.sleep(1_500)
                    return true
                }
                if (quickMenuOpen()) {
                    Log.w(tag, "the tap on Tabs was read as a hold; dismissing and trying again")
                    back()
                    SystemClock.sleep(1_500)
                    break
                }
                SystemClock.sleep(200)
            }
        }
        return overviewOpen()
    }

    /** The overview fully up: its root at scale 1 (or untransformed under reduced motion). */
    private fun overviewOpen(): Boolean =
        chromeValue("(function(){var e=document.querySelector('.zen-overview');if(!e)return 'none';return e.style.transform||'scale(1)'})()") == "scale(1)"

    private fun awaitOverviewGone(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("document.querySelector('.zen-overview')?'up':''") == "") return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** Hold the bar's Tabs button past the 400 ms hold: its quick menu (the release after a long press is not a tap). */
    private fun holdTabsButton() {
        val r = tabsButton() ?: run {
            finding("  no Tabs button on the bar to hold")
            return
        }
        val f = Finger()
        f.press(r.exactCenterX(), r.exactCenterY())
        f.up()
    }

    private fun quickMenuOpen(): Boolean = chromeValue("String(!!document.querySelector('.zen-quick-menu'))") == "true"

    private fun awaitQuickMenu(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (quickMenuOpen()) return true
            SystemClock.sleep(200)
        }
        return quickMenuOpen()
    }

    /** The on-screen box of the first chrome element `selector` matches (device px); null when none does. */
    private fun chromeRect(selector: String): Rect? = rectFromChrome(
        "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" +
            "var r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
    )

    /**
     * The on-screen box (device px) of the CSS-px `[left, top, right, bottom]` the chrome
     * expression `code` returns as JSON (or '' for none); null when it returns none.
     */
    private fun rectFromChrome(code: String): Rect? {
        val raw = chromeValue(code)
        val box = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 4 } ?: return null
        val origin = onMain { IntArray(2).also(host.chrome::getLocationOnScreen) }
        return Rect(
            (origin[0] + box.getDouble(0) * density).toInt(),
            (origin[1] + box.getDouble(1) * density).toInt(),
            (origin[0] + box.getDouble(2) * density).toInt(),
            (origin[1] + box.getDouble(3) * density).toInt()
        )
    }

    // --- plumbing --------------------------------------------------------------------------------

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String = jsonString(chromeJs(code))

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    private fun jsonString(raw: String): String =
        runCatching { JSONTokener(raw).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    companion object {
        /** The Settings tab demo's profile: its server port, its tabs. */
        private const val PORT = 18134
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val DEMO_TAB = "tab_demo"
        private const val DEMO_TITLE = "Container rule demo"
        private const val PRIVATE_TITLE = "Private page"
        /** The address the core stores the page under; the pill and the deep link carry `zenium://`. */
        private const val SETTINGS_URL = "zen://settings"
        /** The landing's Find in Settings field, in the chrome's DOM (the warm-up's sign the page painted). */
        private const val SEARCH_FIELD = ".zen-settings-search-field"
        private const val URLBAR_FIELD = "input[data-testid=\"urlbar-input\"]"
        /** The pill's label on a tab with no page (`PhoneShell`), where the address would be. */
        private const val EMPTY_PILL_LABEL = "Search or enter address"
        private const val MENU_NEW_PRIVATE = "New Private Tab"
        /** The private profile's name as the engine reports it (`Profiles.nameFor`). */
        private val PRIVATE_PROFILE = Profiles.nameFor(Profiles.PRIVATE_CONTAINER)
        /** The navigation bar's package: the system's Back button is looked for in its windows alone. */
        private const val SYSTEM_UI = "com.android.systemui"
    }
}
