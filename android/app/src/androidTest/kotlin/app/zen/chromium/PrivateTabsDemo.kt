package app.zen.chromium

import android.content.Intent
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.view.WindowInsetsControllerCompat
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
 * Records private tabs on the phone (INC-01, INC-02, INC-04, INC-08's entry points aside, MOT-14,
 * NTP-31, TAB-02, TAB-03): a regular tab bakes a cookie on a loopback site; New Private Tab from
 * the app menu blends the chrome onto the private theme (the blend sampled from the chrome as it
 * runs) and shows the private new tab page; the private tab visits the same site on its own
 * WebView profile and finds no cookie, bakes one of its own that never reaches the default jar;
 * the window's screenshot guard stands while the surface is private; the overview opens on its
 * Private pane and the segment switches panes, each showing its own cards alone; the last
 * private card's close wipes the private profile (the next private tab, from the Tabs button's
 * quick menu, finds the jar empty); a relaunch wipes it again at boot (a private tab left open
 * with a fresh cookie is neither restored nor is its cookie); the launcher's static shortcut
 * fires its own intent into the browser and gets a private tab; Close Private Tabs ends the
 * session from the menu.
 *
 * Driven by the `android-private-demo` workflow. See [DemoHarness] for the plumbing. Every sheet
 * flow puts a finger on a control and asserts what it did (the rule in DemoHarness): the menu's
 * New Private Tab and Close Private Tabs, the quick menu's New Private Tab; the pages' Bake
 * button, the overview's segment and the card's close are fingers too. Findings land in
 * `private-findings.txt` next to the screenshots; a check that fails there fails the run.
 *
 * The recorder sees the private surface only because `PrivateBrowsing.captureForRecording` is on
 * for the run (a debug-build override): FLAG_SECURE would black the recording out, as it does
 * Recents. The guard's own step drops the override for one look and puts it back.
 */
@RunWith(AndroidJUnit4::class)
class PrivateTabsDemo : DemoHarness("private-demo-state.json", "private", "private-demo") {
    override val tag = "PrivateTabsDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host

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
            PrivateBrowsing.captureForRecording = false
        }
        if (failures.isNotEmpty() || fault != null) {
            throw AssertionError(
                "${failures.size} check(s) failed: ${failures.joinToString("; ")}" +
                    (fault?.let { "; and: ${it.message}" } ?: "")
            )
        }
    }

    /** The recording must show the private surface; see the class comment. */
    override fun beforeLaunch() {
        PrivateBrowsing.captureForRecording = true
    }

    // --- the pages -------------------------------------------------------------------------------

    /**
     * The cookie jar page: says whether the site has a `jar` cookie and bakes one under a button
     * (a random value, so a regular and a private bake can be told apart). Re-reads the jar every
     * half second, so the page on screen is the jar's truth whatever set or wiped it.
     */
    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Cookie jar</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}main{padding:36px 24px}" +
                "h1{font-size:28px;margin:0 0 20px}#jar{font-size:21px;line-height:1.4;padding:22px;border-radius:16px;" +
                "background:#f2f1f5;min-height:64px;word-break:break-all}#jar[data-has]{background:#e6f4ea;color:#1b4332}" +
                "#bake{margin-top:24px;font-size:20px;padding:18px 24px;border-radius:14px;border:0;background:#1b4332;" +
                "color:#fff;width:100%}p{margin-top:28px;color:#5b5a63;font-size:16px;line-height:1.5}</style></head>" +
                "<body><main><h1>Cookie jar</h1><div id=jar></div>" +
                "<button id=bake type=button>Bake a cookie</button>" +
                "<p>The cookie lives in this tab's jar: a private tab has a jar of its own, and loses it when the last private tab closes.</p>" +
                "</main><script>" +
                "function read(){var m=document.cookie.split(';').map(function(s){return s.trim()}).filter(function(s){return s.indexOf('jar=')===0})[0];return m?m.slice(4):''}" +
                "function show(){var v=read();var el=document.getElementById('jar');" +
                "if(v){el.textContent='This site has a cookie: '+v;el.setAttribute('data-has','')}" +
                "else{el.textContent='This site has no cookie';el.removeAttribute('data-has')}}" +
                "document.getElementById('bake').addEventListener('click',function(){" +
                "var v=Math.random().toString(36).slice(2,8);document.cookie='jar='+v+'; path=/; max-age=86400';show()});" +
                "show();setInterval(show,500);" +
                "</script></body></html>"
            ).toByteArray()),
        "/notes.html" to DemoServer.page("Notes", "<p>A second regular tab, so the Tabs pane has two cards.</p>")
    )

    // --- sequence --------------------------------------------------------------------------------

    /**
     * Both regular tabs get their pages (thumbnails for their cards), and the overview and the
     * menu come up once each off camera: the first of each pays for layout and compilation.
     */
    override fun warmUp() {
        findings = File(out, "private-findings.txt")
        findings.writeText(
            "Zenium Android private tabs (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "WebView ${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"})\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding(
            "multi-profile WebView: ${onMain { Profiles.supported }}; capabilities.privateTabs per the core: ${privateTabsCapability()}; " +
                "private profile at start: ${privateProfileState()}"
        )
        awaitLoaded(REGULAR_TAB, "$ORIGIN/")
        coreInvoke("tab.activate", json("tabId" to NOTES_TAB).toString())
        awaitLoaded(NOTES_TAB, "$ORIGIN/notes.html")
        SystemClock.sleep(1_000)
        coreInvoke("tab.activate", json("tabId" to REGULAR_TAB).toString())
        awaitLoaded(REGULAR_TAB, "$ORIGIN/")
        SystemClock.sleep(1_000)
        if (openOverview()) {
            SystemClock.sleep(1_500)
            back()
            awaitOverviewGone()
        }
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_000)
            back()
            waitForGone(MENU_HANDLE_LABEL)
        }
        SystemClock.sleep(1_500)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        ensureForeground()

        // 1. The regular tab bakes a cookie on the loopback site.
        shot("01-regular-no-cookie")
        expect("the regular tab runs on the default profile", profileName(REGULAR_TAB) == DEFAULT_PROFILE)
        tapPage(REGULAR_TAB, "#bake")
        val regular = awaitCookie(REGULAR_TAB) { it.isNotEmpty() }
        expect("a finger on Bake sets the regular tab's cookie", regular.isNotEmpty())
        SystemClock.sleep(1_500)
        shot("02-regular-cookie")
        finding("regular tab: profile '${profileName(REGULAR_TAB)}', document.cookie '$regular', default jar '${defaultJar()}'")

        // 2. New Private Tab from the app menu (INC-01): a finger on the row, the blend to the
        //    private theme sampled from the chrome from the moment of the touch (MOT-14).
        val fromMenu = newPrivateTabFromMenu()
        expect("the menu's New Private Tab opens a private tab", fromMenu && privateActive())
        val private1 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        shot("04-private-newtab")
        finding("\n" + blendSummary())
        expect("the private new tab page explains itself (NTP-31)", waitFor(PRIVATE_TITLE, 8_000) != null)
        expect("the chrome is on the private (dark) theme", host.themeDark)
        expect("the status bar follows the private theme", !lightStatusBars())
        expect("the host knows the private surface is up", host.privateSurface)
        expect("the private tab runs on its own WebView profile (INC-02)", profileName(private1) == PRIVATE_PROFILE)
        finding(
            "private tab $private1: profile '${profileName(private1)}', chrome dark ${host.themeDark}, " +
                "light status bar icons ${lightStatusBars()}, window background ${windowBackground()}"
        )

        // 3. The private tab visits the site: the regular cookie is not there.
        navigateByTyping(private1, "$ORIGIN/")
        SystemClock.sleep(1_500)
        val privateBefore = cookieOf(private1)
        expect("the regular tab's cookie is invisible in the private tab", privateBefore.isEmpty())
        expect("the pill says Private on the private page (9.19)", waitFor("Private", 6_000) != null)
        shot("05-private-no-cookie")
        finding("private tab on the site: document.cookie '$privateBefore', private jar '${privateJar()}', default jar '${defaultJar()}'")

        // 4. A cookie baked in the private tab stays in the private jar.
        tapPage(private1, "#bake")
        val privateCookie = awaitCookie(private1) { it.isNotEmpty() }
        expect("a finger on Bake sets a cookie in the private jar", privateCookie.isNotEmpty() && privateCookie != regular)
        SystemClock.sleep(1_200)
        shot("06-private-cookie")
        expect("the private cookie never reaches the default jar", defaultJar() == regular)
        expect("the regular tab still reads its own cookie", cookieOf(REGULAR_TAB) == regular)
        finding("after the private bake: private jar '${privateJar()}', default jar '${defaultJar()}'")

        // 5. The window's screenshot guard (FLAG_SECURE) stands while the surface is private. The
        //    recording override is dropped for this one look, so the guard is the real one.
        PrivateBrowsing.captureForRecording = false
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(1_000)
        val guarded = onMain { PrivateBrowsing.guarded(activity.window) }
        val black = blackFraction(shotBitmap("07-recents-guard"))
        SystemClock.sleep(600)
        PrivateBrowsing.captureForRecording = true
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(1_000)
        expect("FLAG_SECURE is on the window while a private tab is in view", guarded)
        expect("the guard stands down again for the debug recording", !onMain { PrivateBrowsing.guarded(activity.window) })
        finding(
            "\nscreenshot guard: FLAG_SECURE ${verdict(guarded)}; a capture under it is ${(black * 100).toInt()}% black " +
                if (black > 0.9) "(the private page is hidden from captures, as it is from Recents)"
                else "(this capture path ignores FLAG_SECURE; Recents and screenrecord honour the flag)"
        )

        // 6. The overview from the private tab: its Private pane, the segment to Tabs and back
        //    (TAB-02, TAB-03); each pane shows its own cards alone.
        expect("the overview opens", openOverview())
        SystemClock.sleep(1_500)
        val paneAtOpen = pane()
        val privateCards = cards()
        expect("the overview opens on the Private pane from a private tab", paneAtOpen == "private")
        expect("the Private pane shows the private card alone", privateCards == listOf(private1))
        shot("08-overview-private-pane")
        finding("\noverview from the private tab: pane '$paneAtOpen', cards $privateCards")
        tapSegment("tabs")
        expect("a finger on Tabs shows the regular pane", awaitPane("tabs"))
        SystemClock.sleep(1_500)
        val regularCards = cards()
        expect("the Tabs pane shows the regular cards and no private one", regularCards.toSet() == setOf(REGULAR_TAB, NOTES_TAB))
        shot("09-overview-tabs-pane")
        finding("after the Tabs segment: pane '${pane()}', cards $regularCards")
        tapSegment("private")
        expect("a finger on Private shows the private pane again", awaitPane("private"))
        SystemClock.sleep(1_200)
        finding("after the Private segment: pane '${pane()}', cards ${cards()}")

        // 7. The last private card's close ends the session: the profile is wiped (INC-04), the
        //    pane shows its explainer, and the regular tab comes back with its cookie.
        val close = chromeRect(closeButton(private1))
        expect("the private card has its close button", close != null)
        close?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
        expect("a finger on the card's close closes the last private tab", awaitNoPrivateTabs())
        val wiped = awaitPrivateWiped()
        expect("the private profile is wiped when the last private tab closes (INC-04)", wiped)
        finding("\nafter the last close: private profile ${privateProfileState()}, default jar '${defaultJar()}'")
        SystemClock.sleep(1_500)
        shot("10-private-empty-explainer")
        expect("the empty Private pane explains itself (TAB-03)", waitFor(EMPTY_TITLE, 6_000) != null)
        tapSegment("tabs")
        awaitPane("tabs")
        SystemClock.sleep(1_000)
        chromeRect(card(REGULAR_TAB))?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
        expect("picking the regular card closes the overview on it", awaitActiveTab(REGULAR_TAB) && awaitOverviewGone())
        settle()
        expect("the chrome is back on the space theme", !host.themeDark && !host.privateSurface)
        expect("the regular tab keeps its cookie across the private session", cookieOf(REGULAR_TAB) == regular)
        shot("11-regular-restored")
        finding("back on the regular tab: chrome dark ${host.themeDark}, private surface ${host.privateSurface}, document.cookie '${cookieOf(REGULAR_TAB)}'")

        // 8. The Tabs button's quick menu (INC-01): a finger on New Private Tab; the next private
        //    tab finds the jar empty, which is the wipe of step 7 seen from a page.
        holdTabsButton()
        expect("a hold on Tabs opens its quick menu", waitFor(MENU_NEW_PRIVATE, 5_000) != null)
        shot("12-tabs-quick-menu")
        touchTapLabelExpecting(MENU_NEW_PRIVATE, "a private tab is active", timeoutMs = 10_000) { privateActive() }
        expect("the quick menu's New Private Tab opens a private tab", privateActive())
        val private2 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        navigateByTyping(private2, "$ORIGIN/")
        SystemClock.sleep(1_500)
        val next = cookieOf(private2)
        expect("the next private tab finds no cookie: the last close wiped the jar", next.isEmpty())
        shot("13-next-private-no-cookie")
        finding("\nnext private tab $private2: profile '${profileName(private2)}', document.cookie '$next', private jar '${privateJar()}'")
        tapPage(private2, "#bake")
        val privateCookie2 = awaitCookie(private2) { it.isNotEmpty() }
        expect("the next private tab bakes a cookie of its own", privateCookie2.isNotEmpty())
        SystemClock.sleep(1_000)

        // 9. A relaunch with the private tab still open: the wipe at boot. The private tab is not
        //    restored and its cookie is gone before any tab exists.
        val before = privateProfileState()
        expect("a private profile with a cookie exists before the relaunch", privateProfileExists() && privateJar().isNotEmpty())
        finding("\nbefore the relaunch: private profile $before")
        relaunch()
        expect("the wipe at boot leaves no private cookie", awaitPrivateWiped())
        expect("no private tab is restored after the relaunch", !anyPrivateTab())
        shot("14-relaunched")
        finding("after the relaunch (a new activity and host, the core booted anew): private profile ${privateProfileState()}, private tabs restored ${anyPrivateTab()}")

        // 10. The launcher's static shortcut: its own intent (as the launcher would fire it) lands on
        //     MainActivity and the chrome opens a private tab; on the site the jar is empty.
        val shortcuts = manifestShortcuts()
        finding("\nmanifest shortcuts of ${app.packageName}: ${shortcuts.map { "${it.id} -> ${it.intent?.action} @ ${it.intent?.component?.className}" }}")
        val shortcut = shortcuts.firstOrNull { it.id == PrivateBrowsing.SHORTCUT_ID }
        expect(
            "the New private tab shortcut is installed from the manifest with its intent",
            shortcut?.intent?.action == PrivateBrowsing.ACTION_NEW_TAB
        )
        // The system server reads targetPackage as a plain string: only the id spelt out by the
        // build lands here (a resource reference would install as "@<id>", which nothing starts).
        expect(
            "the shortcut's intent targets this build's package (${app.packageName}), suffix included",
            shortcut?.intent?.component == android.content.ComponentName(app.packageName, MainActivity::class.java.name)
        )
        val intent = shortcut?.intent?.let { Intent(it) }
            ?: Intent(PrivateBrowsing.ACTION_NEW_TAB).setClassName(app.packageName, MainActivity::class.java.name)
        app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        expect("the launcher shortcut opens a private tab", awaitPrivateActive(15_000))
        val private3 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        shot("15-shortcut-private-tab")
        navigateByTyping(private3, "$ORIGIN/")
        SystemClock.sleep(1_500)
        val afterBoot = cookieOf(private3)
        expect("the private tab after the boot wipe finds no cookie", afterBoot.isEmpty())
        shot("16-boot-wiped")
        finding("shortcut's private tab $private3: profile '${profileName(private3)}', document.cookie '$afterBoot', default jar '${defaultJar()}'")

        // 11. Close Private Tabs from the menu ends the session; the chrome blends back.
        val went = openMenuItem(MENU_CLOSE_PRIVATE)
        val ended = awaitNoPrivateTabs()
        if (went && !ended) touchFault("a touch on '$MENU_CLOSE_PRIVATE' did not take: private tabs remain")
        expect("the menu's Close Private Tabs ends the session", went && ended)
        settle()
        expect("the chrome is back on the space theme after the session", !host.themeDark && !host.privateSurface)
        expect("the private profile is wiped after the session", awaitPrivateWiped())
        shot("17-session-ended")
        finding("\nafter Close Private Tabs: private tabs ${anyPrivateTab()}, chrome dark ${host.themeDark}, private profile ${privateProfileState()}, default jar '${defaultJar()}'")
        finding("\nchecks failed: ${failures.size}${if (failures.isEmpty()) "" else " – " + failures.joinToString("; ")}")
    }

    // --- the menu's New Private Tab, with the blend sampled --------------------------------------

    /**
     * The app menu's New Private Tab under a finger ([DemoHarness.openMenuItem]'s steps, with the
     * blend sampler started once the row is in reach). True when the touch went in and a private
     * tab became active; a touch that went in without one is a touch fault.
     */
    private fun newPrivateTabFromMenu(): Boolean {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            finding("the menu never opened")
            return false
        }
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        if (reveal(MENU_NEW_PRIVATE) == null) {
            finding("no $MENU_NEW_PRIVATE in the menu")
            return false
        }
        shot("03-menu-new-private-tab")
        startBlendSampler()
        return touchTapLabelExpecting(MENU_NEW_PRIVATE, "a private tab is active", timeoutMs = 10_000) { privateActive() }
    }

    /**
     * Sample the chrome's painted theme every frame for a while: the solid background token and
     * the colour scheme the root carries. What `useTheme` paints as the blend runs.
     */
    private fun startBlendSampler() {
        chromeJs(
            "(function(){window.__blend=[];var t0=performance.now();var r=document.documentElement;" +
                "function tick(){var s=getComputedStyle(r);window.__blend.push([Math.round(performance.now()-t0)," +
                "s.getPropertyValue('--zen-bg-solid').trim(),r.dataset.theme||'']);" +
                "if(performance.now()-t0<12000)requestAnimationFrame(tick)}tick()})()"
        )
    }

    /** The sampled blend, read: how many colours it ran through and how long it took. */
    private fun blendSummary(): String {
        val raw = jsString("JSON.stringify(window.__blend||[])")
        val samples = runCatching { JSONArray(raw) }.getOrNull() ?: return "blend: no samples"
        if (samples.length() < 2) return "blend: ${samples.length()} sample(s)"
        val colours = ArrayList<String>()
        var firstChange = -1
        var lastChange = -1
        var flip = -1
        val start = samples.getJSONArray(0).getString(1)
        val end = samples.getJSONArray(samples.length() - 1).getString(1)
        var previous = start
        var previousScheme = samples.getJSONArray(0).getString(2)
        for (i in 0 until samples.length()) {
            val sample = samples.getJSONArray(i)
            val colour = sample.getString(1)
            val scheme = sample.getString(2)
            if (colour !in colours) colours += colour
            if (colour != previous) {
                if (firstChange < 0) firstChange = sample.getInt(0)
                lastChange = sample.getInt(0)
            }
            if (scheme != previousScheme && flip < 0) flip = sample.getInt(0)
            previous = colour
            previousScheme = scheme
        }
        val distinct = colours.size
        val motion = if (firstChange >= 0) lastChange - firstChange else 0
        // The spring advances at most 64 ms a frame, so even on the emulator's handful of frames
        // a second the ~240 ms blend paints intermediate colours between the two themes.
        val blended = distinct >= 3 && start != end
        expect("the theme blend runs through intermediate colours (MOT-14)", blended)
        return "theme blend (MOT-14): ${samples.length()} frames sampled, $distinct distinct --zen-bg-solid values from $start to $end, " +
            "first change at ${firstChange} ms, last at ${lastChange} ms (${motion} ms of motion), colour scheme flipped at ${flip} ms ${verdict(blended)}"
    }

    // --- the private surface, read from the host and the engine ----------------------------------

    private fun privateTabsCapability(): Boolean =
        coreState().optJSONObject("capabilities")?.optBoolean("privateTabs") ?: false

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun awaitPrivateActive(timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateActive()) return true
            SystemClock.sleep(200)
        }
        return privateActive()
    }

    private fun anyPrivateTab(state: JSONObject = coreState()): Boolean {
        val tabs = state.optJSONObject("tabs") ?: return false
        for (key in tabs.keys()) {
            if (tabs.optJSONObject(key)?.optString("containerId") == Profiles.PRIVATE_CONTAINER) return true
        }
        return false
    }

    private fun awaitNoPrivateTabs(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (!anyPrivateTab()) return true
            SystemClock.sleep(200)
        }
        return !anyPrivateTab()
    }

    private fun awaitActiveTab(tabId: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeCoreTab()?.optString("id") == tabId) return true
            SystemClock.sleep(200)
        }
        return activeCoreTab()?.optString("id") == tabId
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
    private fun awaitPrivateWiped(timeoutMs: Long = 15_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (!privateProfileExists() || privateJar().isEmpty()) return true
            SystemClock.sleep(300)
        }
        return !privateProfileExists() || privateJar().isEmpty()
    }

    private fun lightStatusBars(): Boolean = onMain {
        WindowInsetsControllerCompat(activity.window, activity.window.decorView).isAppearanceLightStatusBars
    }

    private fun windowBackground(): String = onMain {
        val drawable = activity.window.decorView.background
        if (drawable is android.graphics.drawable.ColorDrawable) String.format("#%06x", drawable.color and 0xffffff) else drawable?.toString() ?: "none"
    }

    private fun manifestShortcuts() =
        runCatching { app.getSystemService(ShortcutManager::class.java)?.manifestShortcuts }.getOrNull().orEmpty()

    // --- the pages: cookies and a finger on Bake -------------------------------------------------

    private fun cookieOf(tabId: String): String {
        val view = host.tabs.get(tabId) ?: return ""
        return jsonString(pageJs(view, "document.cookie"))
    }

    private fun awaitCookie(tabId: String, timeoutMs: Long = 8_000, accept: (String) -> Boolean): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            last = cookieOf(tabId)
            if (accept(last)) return last
            SystemClock.sleep(250)
        }
        return last
    }

    /** A real touch on the middle of the page element `selector` matches, in the tab's view. */
    private fun tapPage(tabId: String, selector: String): Boolean {
        val view = host.tabs.get(tabId) ?: run {
            finding("no page view for $tabId to touch $selector in")
            return false
        }
        val raw = pageJs(
            view,
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();" +
                "return JSON.stringify([r.left+r.width/2,r.top+r.height/2])})()"
        )
        val point = runCatching { JSONArray(jsonString(raw)) }.getOrNull()?.takeIf { it.length() == 2 } ?: run {
            finding("nothing matches $selector on the page of $tabId")
            return false
        }
        val (origin, scale) = onMain {
            @Suppress("DEPRECATION")
            IntArray(2).also(view::getLocationOnScreen) to (view.scale.takeIf { it > 0f } ?: density)
        }
        val x = origin[0] + point.getDouble(0).toFloat() * scale
        val y = origin[1] + point.getDouble(1).toFloat() * scale
        Log.i(tag, "touch at $x,$y on $selector of $tabId")
        Finger().tap(x, y)
        return true
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

    /**
     * Type `url` into the URL bar from the pill (the private new tab page has no address) and
     * Go; the core's navigate command stands in when the page never arrives that way.
     */
    private fun navigateByTyping(tabId: String, url: String) {
        val target = findByLabelPrefix(PILL_LABEL) ?: pill
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (findNode { it.startsWith("Search engine:") } == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        SystemClock.sleep(2_000)
        instrumentation.sendStringSync(url)
        SystemClock.sleep(600)
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        if (!awaitLoaded(tabId, url, 15_000)) {
            finding("typing $url did not land in $tabId; navigating through the core instead")
            closeUrlbar()
            coreInvoke("tab.navigate", json("tabId" to tabId, "input" to url).toString())
            awaitLoaded(tabId, url)
        }
        closeUrlbar()
    }

    // --- the overview, through the chrome's DOM --------------------------------------------------

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"
    private fun closeButton(tabId: String) = "${card(tabId)} [aria-label=\"Close tab\"]"

    /**
     * Open the overview from the bar's Tabs button. The emulator's input pipeline can hand the
     * release over late, so the bar reads a hold and opens the quick menu instead: dismissed and
     * tried again.
     */
    private fun openOverview(): Boolean {
        if (overviewOpen()) return true
        repeat(3) {
            val tabs = tabsButton()
            if (tabs != null) {
                Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            } else {
                val f = Finger()
                f.down(pillCenterX, pillY)
                f.settleIn(0f, -NUDGE)
                f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
                f.up()
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (overviewOpen()) {
                    SystemClock.sleep(1_500)
                    return true
                }
                if (heldInstead()) {
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

    private fun tabsButton(): Rect? =
        findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
            ?: chromeRect("[aria-label^=\"Tabs (\"]")

    /** Hold the bar's Tabs button past the 400 ms hold: its quick menu (the release after a long press is not a tap). */
    private fun holdTabsButton() {
        val r = tabsButton() ?: error("no Tabs button on the bar")
        val f = Finger()
        f.press(r.exactCenterX(), r.exactCenterY())
        f.up()
    }

    private fun heldInstead(): Boolean =
        jsString("(function(){return document.querySelector('.zen-quick-menu, .zen-sheet') ? 'held' : ''})()") == "held"

    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    private fun awaitOverviewGone(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (jsString("document.querySelector('.zen-overview')?'up':''") == "") return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** The pane the overview shows: its grid's, or its empty explainer's, `data-pane`. */
    private fun pane(): String =
        jsString("(function(){var p=document.querySelector('.zen-overview-pane');return p?(p.getAttribute('data-pane')||''):''})()")

    private fun awaitPane(pane: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pane() == pane) return true
            SystemClock.sleep(150)
        }
        return pane() == pane
    }

    /** The tab ids of the cards on the pane shown, in grid order. */
    private fun cards(): List<String> {
        val raw = jsString(
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-overview-pane [data-tab-id]')," +
                "function(e){return e.getAttribute('data-tab-id')}))"
        )
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getString(it) }
    }

    /** A real touch on the segment's tab `id` (`tabs` or `private`). */
    private fun tapSegment(id: String) {
        val r = chromeRect("[data-testid=\"overview-pane-$id\"]") ?: run {
            finding("no segment tab for $id on screen")
            return
        }
        Finger().tap(r.exactCenterX(), r.exactCenterY())
    }

    /** The on-screen box of the first chrome element `selector` matches (device px); null when none does. */
    private fun chromeRect(selector: String): Rect? {
        val raw = jsString(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" +
                "var r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
        )
        val box = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 4 } ?: return null
        val origin = onMain { IntArray(2).also(host.chrome::getLocationOnScreen) }
        return Rect(
            (origin[0] + box.getDouble(0) * density).toInt(),
            (origin[1] + box.getDouble(1) * density).toInt(),
            (origin[0] + box.getDouble(2) * density).toInt(),
            (origin[1] + box.getDouble(3) * density).toInt()
        )
    }

    // --- relaunch --------------------------------------------------------------------------------

    /**
     * A fresh activity and host (the core boots anew, as after the system killed the app or the
     * user swiped it away): the browser's task is finished and removed – the activity's destroy
     * tears its host and its WebViews down, the private one among them – and then the app is
     * launched as at the start; the new host wipes the private profile as it comes up. The pill
     * is found again afterwards.
     */
    private fun relaunch() {
        val before = host
        onMain { activity.finishAndRemoveTask() }
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!onMain { activity.isDestroyed } && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
        finding("the browser's task removed: activity destroyed ${onMain { activity.isDestroyed }}; launching again")
        SystemClock.sleep(1_500)
        launch()
        ensureForeground()
        finding("relaunched: new activity ${activity !== before.activity}, new host ${host !== before}")
        findByLabelPrefix(PILL_LABEL)?.takeIf { it.width() > 100 * density }?.let { found ->
            pill = found
            pillY = pill.exactCenterY()
            pillCenterX = pill.exactCenterX()
        }
    }

    // --- plumbing --------------------------------------------------------------------------------

    /** A JS expression's string result in the chrome ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = jsonString(chromeJs(code))

    private fun jsonString(raw: String): String =
        runCatching { JSONTokener(raw).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** A core command's arguments as JSON text. */
    private fun json(vararg pairs: Pair<String, Any?>): JSONObject =
        JSONObject().also { for ((key, value) in pairs) it.put(key, value ?: JSONObject.NULL) }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /** [shot], answering the bitmap (the caller recycles it). */
    private fun shotBitmap(name: String): Bitmap? {
        val bitmap = ui.takeScreenshot() ?: return null
        File(out, "private-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    /** The share of near-black pixels in a capture (sampled), 0 when there is none. */
    private fun blackFraction(bitmap: Bitmap?): Float {
        if (bitmap == null) return 0f
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

    private fun expect(name: String, ok: Boolean) {
        Log.i(tag, "check \"$name\": ${if (ok) "ok" else "FAILED"}")
        finding("  $name ${verdict(ok)}")
        if (!ok) failures.add(name)
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18141
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /** The seeded regular tabs (`private-demo-state.json`). */
        private const val REGULAR_TAB = "tab_demo"
        private const val NOTES_TAB = "tab_notes"
        /** The profile names the engine reports (`Profiles.nameFor`). */
        private val DEFAULT_PROFILE = Profiles.nameFor(Profiles.DEFAULT_CONTAINER)
        private val PRIVATE_PROFILE = Profiles.nameFor(Profiles.PRIVATE_CONTAINER)
        // The chrome's labels: the menus' rows, the private new tab page's title, the empty pane's.
        private const val MENU_NEW_PRIVATE = "New Private Tab"
        private const val MENU_CLOSE_PRIVATE = "Close Private Tabs"
        private const val PRIVATE_TITLE = "You're browsing privately"
        private const val EMPTY_TITLE = "No private tabs"
    }
}
