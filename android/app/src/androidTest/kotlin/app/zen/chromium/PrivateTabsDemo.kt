package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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
import java.util.concurrent.CopyOnWriteArrayList
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
 * with a fresh cookie is neither restored nor is its cookie); the launcher's static shortcut,
 * fired as the launcher fires it, from a cold start (the task removed: one MainActivity, the core
 * booted, exactly one private tab on the private new tab page) and warm (Zenium in the background
 * on a regular tab: the running activity takes it through onNewIntent, one new private tab), the
 * trampoline gone each time per `dumpsys`; Close Private Tabs ends the session from the menu; the
 * private new tab page's Block third-party cookies switch flipped on and off under a finger, the
 * core's status, the setting and the engine's flags read back; back at the shortcut tab's root
 * returns to the launcher with the tab closed on the way out (#117's caller rule), and Zenium
 * resumes the tab it left; a sheet over a private page with the guard up for real stands on a
 * cover of the page, not black; the private session's notification ([PrivateSession], #223)
 * beside the guard: the card is posted with the first private tab and counts the second, a
 * finger on it in the shade closes every private tab with the overview on its Private pane – the
 * card goes, the guard comes off, the chrome blends back, the overview returns to the Tabs pane,
 * the profile is wiped once and nothing of the private pages is in Recently Closed or the
 * history – and a card standing while no host is up is taken down as the next host starts.
 *
 * Driven by the `android-private-demo` workflow. See [DemoHarness] for the plumbing. Every sheet
 * flow puts a finger on a control and asserts what it did (the rule in DemoHarness): the menu's
 * New Private Tab and Close Private Tabs, the quick menu's New Private Tab; the pages' Bake
 * button, the overview's segment, the card's close, the cookie switch and the session's card in
 * the shade are fingers too. Findings land in `private-findings.txt` next to the screenshots; a
 * check that fails there fails the run.
 *
 * The recorder sees the private surface only because `PrivateBrowsing.captureForRecording` is on
 * for the run (a debug-build override): FLAG_SECURE would black the recording out, as it does
 * Recents. The guard's own steps drop the override for one look each and put it back.
 *
 * The seeded profile has the default-browser campaign over (`defaultBrowserPromo.done`): the run
 * starts the app three times (the launch, the relaunch, the cold shortcut), and the third session
 * is the one the "Make Zenium your default browser" sheet is due in (`shared/defaultBrowser.ts`),
 * which would stand over the shortcut's private new tab page and take the fingers meant for it.
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
        "/notes.html" to DemoServer.page("Notes", "<p>A second regular tab, so the Tabs pane has two cards.</p>"),
        "/secret.html" to DemoServer.page(
            "Secret",
            "<p>A page only a private tab visits: nothing of it may reach the history or Recently Closed.</p>"
        )
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
        // The private markers on a page (9.19): the private theme on the whole chrome (dark scheme,
        // the private window background) and the mask glyph in the pill's leading slot, which is
        // the site-information chip; no "Private" badge.
        expect("the chrome stays on the private theme on the private page (9.19)", host.themeDark && chromeScheme() == "dark")
        expect("the pill's leading slot is the mask glyph on the private page (9.19)", awaitPillMask())
        expect("the pill carries no Private badge (9.19)", findByLabel("Private") == null && jsString("(function(){return document.querySelector('.zen-v2-badge')?'badge':''})()") == "")
        shot("05-private-no-cookie")
        finding(
            "private tab on the site: document.cookie '$privateBefore', private jar '${privateJar()}', default jar '${defaultJar()}'; " +
                "chrome scheme ${chromeScheme()}, window background ${windowBackground()}, pill mask ${pillMaskShown()}"
        )

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

        // 7. The last private card's close ends the session: the profile is wiped (INC-04) and the
        //    overview returns to the Tabs pane (as Chrome's switcher does when the last incognito
        //    tab goes); the empty Private pane's explainer is a pick away (TAB-03); the regular
        //    tab comes back with its cookie.
        val close = chromeRect(closeButton(private1))
        expect("the private card has its close button", close != null)
        close?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
        expect("a finger on the card's close closes the last private tab", awaitNoPrivateTabs())
        val wiped = awaitPrivateWiped()
        expect("the private profile is wiped when the last private tab closes (INC-04)", wiped)
        expect("the last private tab closing returns the overview to the Tabs pane", awaitPane("tabs"))
        SystemClock.sleep(1_500)
        shot("10-overview-back-on-tabs")
        finding("\nafter the last close: pane '${pane()}', cards ${cards()}, private profile ${privateProfileState()}, default jar '${defaultJar()}'")
        tapSegment("private")
        expect("the empty Private pane explains itself (TAB-03)", awaitPane("private") && waitFor(EMPTY_TITLE, 6_000) != null)
        SystemClock.sleep(1_200)
        shot("11-private-empty-explainer")
        finding("after picking Private with none open: pane '${pane()}', cards ${cards()}")
        tapSegment("tabs")
        awaitPane("tabs")
        SystemClock.sleep(1_000)
        chromeRect(card(REGULAR_TAB))?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
        expect("picking the regular card closes the overview on it", awaitActiveTab(REGULAR_TAB) && awaitOverviewGone())
        settle()
        expect("the chrome is back on the space theme", !host.themeDark && !host.privateSurface)
        expect("the regular tab keeps its cookie across the private session", cookieOf(REGULAR_TAB) == regular)
        shot("12-regular-restored")
        finding("back on the regular tab: chrome dark ${host.themeDark}, private surface ${host.privateSurface}, document.cookie '${cookieOf(REGULAR_TAB)}'")

        // 8. The Tabs button's quick menu (INC-01): a finger on New Private Tab; the next private
        //    tab finds the jar empty, which is the wipe of step 7 seen from a page.
        holdTabsButton()
        expect("a hold on Tabs opens its quick menu", waitFor(MENU_NEW_PRIVATE, 5_000) != null)
        shot("13-tabs-quick-menu")
        touchTapLabelExpecting(MENU_NEW_PRIVATE, "a private tab is active", timeoutMs = 10_000) { privateActive() }
        expect("the quick menu's New Private Tab opens a private tab", privateActive())
        val private2 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        navigateByTyping(private2, "$ORIGIN/")
        SystemClock.sleep(1_500)
        val next = cookieOf(private2)
        expect("the next private tab finds no cookie: the last close wiped the jar", next.isEmpty())
        shot("14-next-private-no-cookie")
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
        shot("15-relaunched")
        finding("after the relaunch (a new activity and host, the core booted anew): private profile ${privateProfileState()}, private tabs restored ${anyPrivateTab()}")

        // 10. The launcher's static shortcut from a COLD start (INC-01). The browser's task is
        //     removed and the shortcut's intent fired as the launcher fires it – the system stamps
        //     every manifest shortcut's intent with CLEAR_TASK and TASK_ON_HOME (ShortcutParser) –
        //     so it lands on the trampoline in a task of its own, which relays the action into a
        //     MainActivity the system creates for the browser's task: one activity, a host and
        //     the core booted anew, and once the core is up exactly one private tab, on the
        //     private new tab page, on the private theme. The trampoline is gone by then
        //     (noHistory, finished as it started the browser). On the site the jar is empty: the
        //     boot wipe ran before the tab existed.
        val shortcuts = manifestShortcuts()
        finding("\nmanifest shortcuts of ${app.packageName}: ${shortcuts.map { "${it.id} -> ${it.intent?.action} @ ${it.intent?.component?.className} flags 0x${Integer.toHexString(it.intent?.flags ?: 0)}" }}")
        val shortcut = shortcuts.firstOrNull { it.id == PrivateBrowsing.SHORTCUT_ID }
        expect(
            "the New private tab shortcut is installed from the manifest with its intent",
            shortcut?.intent?.action == PrivateBrowsing.ACTION_NEW_TAB
        )
        // The system server reads targetPackage as a plain string: only the id spelt out by the
        // build lands here (a resource reference would install as "@<id>", which nothing starts).
        expect(
            "the shortcut's intent targets this build's package (${app.packageName}), suffix included, at the trampoline",
            shortcut?.intent?.component == android.content.ComponentName(app.packageName, LauncherIconActivity::class.java.name)
        )
        val intent = shortcut?.intent?.let { Intent(it) }
            ?: Intent(PrivateBrowsing.ACTION_NEW_TAB).setClassName(app.packageName, LauncherIconActivity::class.java.name)
        val hostBeforeCold = host
        val activityBeforeCold = activity
        onMain { activity.finishAndRemoveTask() }
        awaitDestroyed()
        finding("\nthe browser's task removed for the cold start: activity destroyed ${onMain { activity.isDestroyed }}; firing the shortcut as the launcher does")
        SystemClock.sleep(1_500)
        val cold = fireShortcut(intent, awaitMainMs = 20_000)
        expect("the shortcut's intent lands on the trampoline", cold.trampoline != null)
        expect(
            "a cold start through the shortcut creates one MainActivity, and it is the one in front",
            cold.created is MainActivity && cold.created !== activityBeforeCold && (cold.fronted == null || cold.fronted === cold.created)
        )
        (cold.created as? MainActivity)?.let { activity = it }
        expect("the new activity brings a host of its own: the core boots anew", host !== hostBeforeCold)
        expect("the chrome comes up in the new activity", awaitChromeUp())
        expect("the shortcut's tab opens once the core is up: a private tab is active", awaitPrivateActive(20_000))
        val private3 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        val privateAfterCold = privateTabIds()
        val coldTab = activeCoreTab()
        expect("exactly one private tab after the cold start, the shortcut's", privateAfterCold == listOf(private3))
        expect("the shortcut's tab is on the private new tab page", waitFor(PRIVATE_TITLE, 8_000) != null && emptyTabUrl(coldTab?.optString("url")))
        expect("the chrome is on the private theme", host.themeDark && host.privateSurface)
        expect("the shortcut's tab is a tab another app sent (fromIntent)", coldTab?.optBoolean("fromIntent") == true)
        val coldRecords = awaitActivityRecords()
        expect(
            "dumpsys after the cold start: one MainActivity and no LauncherIconActivity",
            coldRecords["MainActivity"] == 1 && (coldRecords["LauncherIconActivity"] ?: 0) == 0
        )
        shot("16-shortcut-cold-start")
        finding(
            "after the cold start through the shortcut: trampoline created ${cold.trampoline != null} (destroyed ${cold.trampoline?.let { onMain { it.isDestroyed } }}), " +
                "MainActivity created ${cold.created != null} and in front ${cold.fronted === cold.created} (${cold.mainStarts} start(s) relayed), new host ${host !== hostBeforeCold}, private tabs $privateAfterCold, " +
                "active '$private3' url '${coldTab?.optString("url")}' fromIntent ${coldTab?.optBoolean("fromIntent")}, chrome dark ${host.themeDark}, " +
                "private surface ${host.privateSurface}, activity records $coldRecords"
        )
        navigateByTyping(private3, "$ORIGIN/")
        SystemClock.sleep(1_500)
        val afterBoot = cookieOf(private3)
        expect("the private tab after the boot wipe finds no cookie", afterBoot.isEmpty())
        shot("17-boot-wiped")
        finding("shortcut's private tab $private3: profile '${profileName(private3)}', document.cookie '$afterBoot', default jar '${defaultJar()}'")

        // 11. Close Private Tabs from the menu ends the session; the chrome blends back.
        val went = openMenuItem(MENU_CLOSE_PRIVATE)
        val ended = awaitNoPrivateTabs()
        if (went && !ended) touchFault("a touch on '$MENU_CLOSE_PRIVATE' did not take: private tabs remain")
        expect("the menu's Close Private Tabs ends the session", went && ended)
        settle()
        expect("the chrome is back on the space theme after the session", !host.themeDark && !host.privateSurface)
        expect("the private profile is wiped after the session", awaitPrivateWiped())
        shot("18-session-ended")
        finding("\nafter Close Private Tabs: private tabs ${anyPrivateTab()}, chrome dark ${host.themeDark}, private profile ${privateProfileState()}, default jar '${defaultJar()}'")

        // 12. The shortcut WARM: Zenium in the background on a regular tab (Home), then the
        //     shortcut. The trampoline relays the action into the running activity's onNewIntent
        //     (singleTask): the same activity and host, no relaunch, one new private tab on the
        //     private new tab page, and Zenium back in front.
        val regularBefore = activeCoreTab()?.optString("id").orEmpty()
        val activityBefore = activity
        val hostBefore = host
        val intentBefore = onMain { activity.intent }
        home()
        expect("Home puts Zenium in the background", awaitFront(ours = false))
        finding("\nZenium in the background on '$regularBefore': in front '${frontPackage()}', window focus ${onMain { activity.hasWindowFocus() }}")
        SystemClock.sleep(1_500)
        val warm = fireShortcut(intent, awaitMainMs = 6_000)
        val warmOpened = awaitPrivateActive(15_000)
        expect("the shortcut's intent lands on the trampoline", warm.trampoline != null)
        expect(
            "the warm shortcut creates no MainActivity: the running one comes to the front for the action",
            warm.created == null && (warm.fronted == null || warm.fronted === activityBefore)
        )
        expect(
            "the same activity and host, neither destroyed (no relaunch)",
            activity === activityBefore && host === hostBefore && !onMain { activity.isDestroyed }
        )
        expect("the action arrived through onNewIntent: the activity carries a new intent", onMain { activity.intent } !== intentBefore)
        expect("Zenium comes to the front", awaitFront(ours = true))
        expect("the warm shortcut opens a private tab", warmOpened)
        val private4 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        val privateAfterWarm = privateTabIds()
        val warmTab = activeCoreTab()
        expect("exactly one private tab after the warm shortcut, the shortcut's", privateAfterWarm == listOf(private4))
        expect(
            "the shortcut's tab is on the private new tab page, on the private theme",
            waitFor(PRIVATE_TITLE, 8_000) != null && emptyTabUrl(warmTab?.optString("url")) && host.themeDark && host.privateSurface
        )
        val warmRecords = awaitActivityRecords()
        expect(
            "dumpsys after the warm shortcut: one MainActivity and no LauncherIconActivity",
            warmRecords["MainActivity"] == 1 && (warmRecords["LauncherIconActivity"] ?: 0) == 0
        )
        shot("19-shortcut-warm")
        finding(
            "after the warm shortcut: trampoline created ${warm.trampoline != null} (destroyed ${warm.trampoline?.let { onMain { it.isDestroyed } }}), " +
                "MainActivity created ${warm.created != null}, the running one resumed for it ${warm.fronted === activityBefore} (${warm.mainStarts} start(s) relayed), " +
                "same activity ${activity === activityBefore}, same host ${host === hostBefore}, " +
                "new intent ${onMain { activity.intent } !== intentBefore}, in front '${frontPackage()}', private tabs $privateAfterWarm, active '$private4' url '${warmTab?.optString("url")}' " +
                "fromIntent ${warmTab?.optBoolean("fromIntent")}, activity records $warmRecords"
        )

        // 13. The private new tab page's Block third-party cookies switch (NTP-31) under a real
        //     touch, on then off. The private choice is set to allow first (through the command,
        //     off camera) so the switch reads off and the first touch turns it on. Each touch is
        //     read back three ways: the core's status the row shows (privateThirdPartyCookies),
        //     the setting the command wrote (thirdPartyCookiesPrivate: block, then allow), and the
        //     engine's flags the core pushed (PrivacyFlags.blocksThirdPartyCookiesIn(private)).
        coreInvoke("privacy.setThirdPartyCookiesPrivate", json("mode" to "allow").toString())
        expect("set-up: the private choice allows third-party cookies, the switch reads off", awaitCookieSwitch(blocked = false, mode = "allow"))
        SystemClock.sleep(1_000)
        finding("\ncookie switch before the touches: ${cookieSwitchState(private4)}")
        expect("a finger on the switch turns it on: blocked, the setting block", touchCookieSwitch() && awaitCookieSwitch(blocked = true, mode = "block"))
        expect("the engine's flags block third-party cookies in private tabs", awaitEngineBlocks(true))
        expect("the regular tabs keep the global mode: not blocked there", !host.privacy.flags.blocksThirdPartyCookiesIn(false))
        SystemClock.sleep(1_200)
        shot("20-cookie-switch-on")
        finding("after the first touch: ${cookieSwitchState(private4)}")
        expect("a second finger turns it off: allowed, the setting allow", touchCookieSwitch() && awaitCookieSwitch(blocked = false, mode = "allow"))
        expect("the engine's flags allow them in private tabs again", awaitEngineBlocks(false))
        SystemClock.sleep(1_200)
        shot("21-cookie-switch-off")
        finding("after the second touch: ${cookieSwitchState(private4)}")

        // 14. Back at the shortcut tab's root: a tab another app sent (fromIntent) returns the user
        //     to that app – the launcher – and closes on the way out once Zenium is out of sight
        //     (#117's caller rule, Chrome's CLOSE_TAB_ON_MINIMIZE_DELAY_MS); the session ends with
        //     it. Zenium resumes the tab the user was on when it is next in front.
        expect("the shortcut's tab is at its root", activeCoreTab()?.optBoolean("canGoBack") == false)
        back()
        val toLauncher = awaitFront(ours = false)
        val closedOnTheWayOut = awaitNoPrivateTabs()
        expect("back at the shortcut tab's root returns to the launcher (the caller)", toLauncher)
        expect("the shortcut's tab closes on the way out", closedOnTheWayOut)
        expect("Zenium went to the background, not away: the activity lives", !onMain { activity.isDestroyed })
        expect("the tab the user was on before the shortcut is active again", awaitActiveTab(regularBefore))
        expect("the session ends with the tab: the private profile is wiped", awaitPrivateWiped())
        SystemClock.sleep(1_000)
        shot("22-back-to-launcher")
        finding(
            "\nafter back at the shortcut tab's root: in front '${frontPackage()}', private tabs ${anyPrivateTab()}, active tab '${activeCoreTab()?.optString("id")}', " +
                "activity destroyed ${onMain { activity.isDestroyed }}, private profile ${privateProfileState()}"
        )
        app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        expect("Zenium comes back in front on the same activity", awaitFront(ours = true) && activity === activityBefore && !onMain { activity.isDestroyed })
        ensureForeground()
        settle()
        expect(
            "the chrome is back on the space theme, on the tab it left",
            !host.themeDark && !host.privateSurface && activeCoreTab()?.optString("id") == regularBefore
        )
        shot("23-resumed-regular")
        finding("Zenium back in front: same activity ${activity === activityBefore}, active tab '${activeCoreTab()?.optString("id")}', chrome dark ${host.themeDark}")

        // 15. A sheet over a private page with the guard up for real (the recording override off):
        //     the menu's recede takes a PixelCopy of the page for its cover (view.snapshot), and
        //     FLAG_SECURE does not gate an app's own copy of its window, so the cover the sheet
        //     stands on is the page, not black. Read off the chrome's cover image (decoded here,
        //     its black share measured) and kept as a still of its own, since the recording and
        //     the screen still are black for this stretch, as Recents is.
        coreInvoke("tab.newPrivate", "{}")
        expect("a private tab for the sheet", awaitPrivateActive())
        val private5 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        navigateByTyping(private5, "$ORIGIN/")
        SystemClock.sleep(1_500)
        PrivateBrowsing.captureForRecording = false
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(800)
        val guardedForSheet = onMain { PrivateBrowsing.guarded(activity.window) }
        expect("FLAG_SECURE is on the window before the sheet opens", guardedForSheet)
        // The snapshot path itself, under the guard: the engine's copy of the page, asked for the
        // way the chrome asks before a sheet (a cover the chrome shows could otherwise be the
        // card's remembered picture standing in for a copy that failed).
        val direct = directSnapshot(private5)
        val directSize = direct?.let { "${it.width}x${it.height}" }
        val directBlack = direct?.let { blackFraction(it) }
        expect("view.snapshot answers under the guard: an app's copy of its own window is not gated by FLAG_SECURE", direct != null)
        expect("the engine's copy is the page, not black", directBlack != null && directBlack < 0.5f)
        tapMenuButton()
        expect("a finger on Menu opens the sheet over the private page under the guard", waitFor(MENU_HANDLE_LABEL, 8_000) != null)
        SystemClock.sleep(1_500)
        val cover = coverImage()
        val recede = recedeValue()
        val coverSize = cover?.let { "${it.width}x${it.height}" }
        cover?.let { saveStill("24-sheet-cover-under-guard", it) }
        val coverBlack = cover?.let { blackFraction(it) }
        expect("the sheet stands on a cover of the page", cover != null)
        expect("the cover is the page, not black", coverBlack != null && coverBlack < 0.5f)
        expect("the recede runs under the guard", recede > 0.5f)
        finding(
            "\nsheet over a private page under FLAG_SECURE (guard ${verdict(guardedForSheet)}): view.snapshot " +
                (if (directSize != null) "$directSize, ${((directBlack ?: 0f) * 100).toInt()}% black" else "none") +
                "; the sheet's cover " +
                (if (coverSize != null) "$coverSize, ${((coverBlack ?: 0f) * 100).toInt()}% black (private-24-sheet-cover-under-guard.png is the cover itself)" else "none") +
                ", --zen-recede $recede"
        )
        PrivateBrowsing.captureForRecording = true
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(1_000)
        shot("25-sheet-over-private-page")
        back()
        waitForGone(MENU_HANDLE_LABEL)
        SystemClock.sleep(1_000)
        coreInvoke("tab.closePrivate")
        expect("the session ends", awaitNoPrivateTabs())
        settle()

        // 16. The private session's notification (#223's PrivateSession) beside the guard. From a
        //     regular tab, the menu's New Private Tab: the card is posted with the tab (the
        //     `zenium.private` channel, "Close all private tabs", ongoing, off the lock screen)
        //     while FLAG_SECURE is on the window; a second private tab from the quick menu, and
        //     the card counts two; the overview on its Private pane keeps the guard up. Then the
        //     shade, and a real finger on the card (its press is the card's one action: the
        //     content intent reaches PrivateSessionReceiver, which asks the core for
        //     `private.closeAll`): every private tab closes, the card comes down with the count,
        //     the guard comes off, the chrome blends back, the overview returns to the Tabs pane
        //     (as in step 7), the private profile is wiped once – one `profile.clear` leaves the
        //     chrome, counted at the bridge – and neither Recently Closed nor the history has
        //     anything of the private pages. The next private tab finds the jar empty and the
        //     card back for it.
        hookProfileClears()
        val cardBefore = privateCard()
        expect("no private card while no private tab is open", cardBefore == null)
        finding(
            "\nprivate session card (#223) before: ${describeCard(cardBefore)}; notifications enabled for the app: " +
                "${notifications.areNotificationsEnabled()}; profile.clear calls counted from here"
        )
        val regularBeforeCard = activeCoreTab()?.optString("id").orEmpty()
        expect("set-up: a regular tab is in view", !privateActive() && regularBeforeCard.isNotEmpty())
        val wentToMenu = openMenuItem(MENU_NEW_PRIVATE)
        val wentPrivate = wentToMenu && awaitPrivateActive(10_000)
        if (wentToMenu && !wentPrivate) touchFault("a touch on '$MENU_NEW_PRIVATE' did not take: no private tab is active")
        expect("the menu's New Private Tab opens a private tab from a regular one", wentPrivate)
        val g1 = activeCoreTab()?.optString("id").orEmpty()
        settle()
        val card1 = awaitCard(8_000)
        expect(
            "the session's card is posted with the first private tab, on the zenium.private channel",
            card1 != null && card1.notification.channelId == PrivateSession.CHANNEL_ID
        )
        expect(
            "the card reads Close all private tabs, ongoing, with a press to act on and no buttons",
            card1 != null && cardTitle(card1) == PrivateSession.TITLE && cardOngoing(card1) &&
                card1.notification.contentIntent != null && card1.notification.actions.isNullOrEmpty()
        )
        expect("the card counts one private tab", cardText(card1) == "1 private tab is open")
        expect("the card stays off the lock screen (VISIBILITY_SECRET)", card1?.notification?.visibility == Notification.VISIBILITY_SECRET)
        val guardWithCard = guardNow()
        expect("FLAG_SECURE is on the window with the private tab in view, beside the card", guardWithCard && host.privateSurface)
        shot("26-private-tab-card-up")
        finding("card with the first private tab $g1: ${describeCard(card1)}; FLAG_SECURE ${onOff(guardWithCard)}, private surface ${host.privateSurface}")
        navigateByTyping(g1, "$ORIGIN/")
        SystemClock.sleep(1_200)
        tapPage(g1, "#bake")
        val cookieForTheWipe = awaitCookie(g1) { it.isNotEmpty() }
        expect("a finger on Bake sets a cookie in the private jar for the card's close to wipe", cookieForTheWipe.isNotEmpty())
        holdTabsButton()
        expect("a hold on Tabs opens its quick menu", waitFor(MENU_NEW_PRIVATE, 5_000) != null)
        touchTapLabelExpecting(MENU_NEW_PRIVATE, "a second private tab is active", timeoutMs = 10_000) {
            privateActive() && activeCoreTab()?.optString("id") != g1
        }
        val g2 = activeCoreTab()?.optString("id").orEmpty()
        expect("the quick menu's New Private Tab opens a second private tab", g2.isNotEmpty() && g2 != g1 && privateTabIds() == listOf(g1, g2).sorted())
        settle()
        navigateByTyping(g2, "$ORIGIN/secret.html")
        SystemClock.sleep(1_000)
        val card2 = awaitCard(8_000) { cardText(it) == "2 private tabs are open" }
        expect("the card counts two private tabs", card2 != null)
        finding("card with the second private tab $g2 (on ${activeCoreTab()?.optString("url")}): ${describeCard(card2 ?: privateCard())}")
        expect("the overview opens", openOverview())
        SystemClock.sleep(1_500)
        expect("the overview opens on the Private pane with both private cards", awaitPane("private") && cards().toSet() == setOf(g1, g2))
        val guardOnPane = guardNow()
        expect("FLAG_SECURE stays on with the overview on the Private pane", guardOnPane && host.privateSurface)
        shot("27-overview-private-two-cards")
        val clearsBefore = profileClears().size
        finding("overview on '${pane()}', cards ${cards()}; FLAG_SECURE ${onOff(guardOnPane)}; profile.clear calls so far $clearsBefore")

        val cardNode = openShade { it == PrivateSession.TITLE }
        expect("the shade shows the Close all private tabs card", cardNode != null)
        var pressed = false
        if (cardNode != null) {
            SystemClock.sleep(1_500)
            shot("28-shade-private-card")
            val bounds = steadyBounds(cardNode) ?: Rect().also { cardNode.getBoundsInScreen(it) }
            Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
            finding("finger on the card at ${bounds.centerX()},${bounds.centerY()} (bounds $bounds)")
            pressed = awaitNoPrivateTabs(12_000)
            if (!pressed) touchFault("a touch on the private session's card did not take: private tabs remain")
        }
        expect("a finger on the card closes every private tab", pressed)
        val cardGone = awaitCardGone(8_000)
        expect("the card comes down with the last private tab", cardGone)
        if (frontPackage() != app.packageName) closeShade()
        ensureForeground()
        expect("the overview returns to the Tabs pane once the private tabs are gone", awaitPane("tabs") && overviewOpen())
        val guardAfterCard = guardNow()
        expect("FLAG_SECURE comes off with the session", !guardAfterCard && !host.privateSurface)
        settle()
        expect("the chrome blends back to the space theme", !host.themeDark && chromeScheme() != "dark")
        shot("29-overview-tabs-after-card")
        expect("the private profile is wiped when the card ends the session (INC-04)", awaitPrivateWiped())
        val clears = profileClears()
        expect(
            "the session ends once: one profile.clear for the private container left the chrome",
            clears.size - clearsBefore == 1 && clears.last() == Profiles.PRIVATE_CONTAINER
        )
        val recentlyClosed = coreInvoke("session.recentlyClosed")
        val historyOfSecret = coreInvoke("history.search", json("query" to "secret", "limit" to 20).toString())
        expect(
            "Recently Closed keeps nothing of the private tabs",
            !recentlyClosed.contains("secret.html") && !recentlyClosed.contains(g1) && !recentlyClosed.contains(g2)
        )
        expect("the history has nothing of the private page", runCatching { JSONArray(historyOfSecret).length() }.getOrDefault(-1) == 0)
        finding(
            "after the card: private tabs ${anyPrivateTab()}, card ${describeCard(privateCard())}, FLAG_SECURE ${onOff(guardAfterCard)}, " +
                "private surface ${host.privateSurface}, pane '${pane()}', cards ${cards()}, chrome dark ${host.themeDark}, " +
                "private profile ${privateProfileState()}, profile.clear calls $clears, recently closed $recentlyClosed, " +
                "history for 'secret' $historyOfSecret"
        )
        chromeRect(card(regularBeforeCard))?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
        expect("picking the regular card closes the overview on the tab in view before the session", awaitActiveTab(regularBeforeCard) && awaitOverviewGone())
        SystemClock.sleep(1_000)
        holdTabsButton()
        expect("a hold on Tabs opens its quick menu again", waitFor(MENU_NEW_PRIVATE, 5_000) != null)
        touchTapLabelExpecting(MENU_NEW_PRIVATE, "a private tab is active", timeoutMs = 10_000) { privateActive() }
        val g3 = activeCoreTab()?.optString("id").orEmpty()
        expect("the quick menu's New Private Tab opens the next private tab", g3.isNotEmpty() && privateActive())
        settle()
        navigateByTyping(g3, "$ORIGIN/")
        SystemClock.sleep(1_500)
        val afterTheCard = cookieOf(g3)
        expect("the next private tab finds no cookie: the card's close wiped the jar", afterTheCard.isEmpty())
        expect("the card is back for the next private tab", awaitCard(8_000) { cardText(it) == "1 private tab is open" } != null)
        shot("30-next-private-after-card")
        finding("next private tab $g3: document.cookie '$afterTheCard', private jar '${privateJar()}', card ${describeCard(privateCard())}")
        coreInvoke("tab.closePrivate")
        expect("the session ends, and the card with it", awaitNoPrivateTabs() && awaitCardGone(8_000))
        settle()

        // 17. A card standing while no host is up is taken down as the next host starts (#223's
        //     rule for the card a process that died with private tabs open leaves behind; the
        //     core never restores them). The card here is a stand-in with the session's identity
        //     (the id and the channel), posted after the activity's destroy and before the
        //     launch: this driver runs in the app's process, so a force-stop would take it too.
        val hostBeforeStale = host
        onMain { activity.finishAndRemoveTask() }
        awaitDestroyed()
        postStandInCard()
        val standIn = awaitCard(4_000)
        expect("set-up: a card with the session's identity stands while no host is up", standIn != null)
        finding("\nthe browser's task removed; a stand-in for a stale card posted: ${describeCard(standIn)}; launching again")
        SystemClock.sleep(1_000)
        launch()
        ensureForeground()
        refindPill()
        expect("the next host takes the stale card down as it starts", awaitCardGone(10_000))
        val guardAfterStart = guardNow()
        expect("a new host, no private tab restored, no guard left on", host !== hostBeforeStale && !anyPrivateTab() && !guardAfterStart && !host.privateSurface)
        shot("31-relaunched-stale-card-gone")
        finding(
            "after the start: new host ${host !== hostBeforeStale}, card ${describeCard(privateCard())}, private tabs ${anyPrivateTab()}, " +
                "FLAG_SECURE ${onOff(guardAfterStart)}, private surface ${host.privateSurface}, private profile ${privateProfileState()}"
        )
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

    /** The colour scheme the chrome's root carries (`data-theme`): `dark` on the private theme. */
    private fun chromeScheme(): String = jsString("document.documentElement.dataset.theme||''")

    /** Whether the pill's leading slot is the mask glyph (the private marker on a private tab, 9.19). */
    private fun pillMaskShown(): Boolean =
        jsString("(function(){return document.querySelector('[data-site-info][data-private-mark] svg.lucide-venetian-mask')?'mask':''})()") == "mask"

    private fun awaitPillMask(timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pillMaskShown()) return true
            SystemClock.sleep(200)
        }
        return pillMaskShown()
    }

    private fun manifestShortcuts() =
        runCatching { app.getSystemService(ShortcutManager::class.java)?.manifestShortcuts }.getOrNull().orEmpty()

    /** A tab with no page: the core's blank URL (`zen://blank`), which the phone draws as the new tab page. */
    private fun emptyTabUrl(url: String?): Boolean = url.isNullOrEmpty() || url == "zen://blank"

    /** The private tabs the core has, by id, across the spaces. */
    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence()
            .filter { tabs.optJSONObject(it)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }
            .sorted()
            .toList()
    }

    // --- the shortcut, fired as the launcher fires it --------------------------------------------

    /**
     * What one firing of the shortcut started: `trampoline` is the LauncherIconActivity the
     * intent landed on; `created` the MainActivity the system made for the relayed action (a cold
     * start), null when the running one took it through onNewIntent (warm); `fronted` the
     * MainActivity that came to the front for it, the created one or the running one; and
     * `mainStarts` how many times something in this process asked to start MainActivity (the
     * trampoline's relay, in either case).
     */
    private class ShortcutLaunch(val trampoline: Activity?, val created: Activity?, val fronted: Activity?, val mainStarts: Int)

    /**
     * Fire `template` as the launcher fires a manifest shortcut – the system stamps its intent
     * with CLEAR_TASK and TASK_ON_HOME (ShortcutParser) – and watch what it starts. Creations are
     * read off the application's lifecycle callbacks (`onActivityCreated` fires for a creation and
     * nothing else): a MainActivity created is the sign of a cold start, none within `awaitMainMs`
     * of a warm one. An activity monitor tells the rest – `Instrumentation` matches monitors on an
     * activity's creation and on each of its resumes alike, so what it hands back is the
     * MainActivity that came to the front for the action, new or running, and its hits count the
     * starts this process asked for.
     */
    private fun fireShortcut(template: Intent, awaitMainMs: Long): ShortcutLaunch {
        val mains = instrumentation.addMonitor(MainActivity::class.java.name, null, false)
        val created = CopyOnWriteArrayList<Activity>()
        val trampolines = CopyOnWriteArrayList<Activity>()
        val creations = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(a: Activity, savedInstanceState: Bundle?) {
                when (a) {
                    is MainActivity -> created += a
                    is LauncherIconActivity -> trampolines += a
                }
            }
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityResumed(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        }
        val application = app.applicationContext as Application
        application.registerActivityLifecycleCallbacks(creations)
        try {
            app.startActivity(
                Intent(template).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_TASK_ON_HOME)
            )
            val trampolineBy = SystemClock.uptimeMillis() + 10_000
            while (trampolines.isEmpty() && SystemClock.uptimeMillis() < trampolineBy) SystemClock.sleep(100)
            // The callback runs in onCreate, before the monitor's match of the creation: a created
            // MainActivity is in `created` by the time the monitor hands it back.
            val fronted = mains.waitForActivityWithTimeout(awaitMainMs)
            return ShortcutLaunch(trampolines.firstOrNull(), created.firstOrNull(), fronted, mains.hits)
        } finally {
            application.unregisterActivityLifecycleCallbacks(creations)
            instrumentation.removeMonitor(mains)
        }
    }

    /** The browser's activity has been destroyed (after `finishAndRemoveTask`), or 10 s passed. */
    private fun awaitDestroyed() {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!onMain { activity.isDestroyed } && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
    }

    /**
     * A freshly created activity's chrome booting: the pill shows within 30 s (the core boots
     * first) – reading an address, or the empty tab's prompt when the shortcut's private new tab
     * page is what comes up – and the pill is measured again for the fingers that follow.
     */
    private fun awaitChromeUp(): Boolean {
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (pillShown() == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(500)
        val up = pillShown() != null
        SystemClock.sleep(3_000)
        ensureForeground()
        refindPill()
        return up
    }

    /**
     * The pill's bounds by either of its labels (an address, or the empty tab's prompt), in the
     * bar's band at the bottom of the window – the private new tab page's own field reads the
     * same words higher up; null when the pill is not on screen.
     */
    private fun pillShown(): Rect? =
        findNodes { it == PILL_LABEL || it.startsWith("$PILL_LABEL,") || it == EMPTY_PILL_LABEL }
            .map { node -> Rect().also { node.getBoundsInScreen(it) } }
            .firstOrNull { it.top > height * 0.6 }

    private fun refindPill() {
        pillShown()?.takeIf { it.width() > 100 * density }?.let { found ->
            pill = found
            pillY = pill.exactCenterY()
            pillCenterX = pill.exactCenterX()
        }
    }

    /** The system's Home, through UiAutomation: Zenium goes to the background, the launcher comes up. */
    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    /** The package whose window is in front, per the accessibility tree (the launcher's, or ours). */
    private fun frontPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    /** Poll until Zenium is (`ours`) or is not in front; false when it does not come to that in time. */
    private fun awaitFront(ours: Boolean, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val front = frontPackage()
            if (front != null && (front == app.packageName) == ours) return true
            SystemClock.sleep(250)
        }
        return (frontPackage() == app.packageName) == ours
    }

    /**
     * The app's activities per `dumpsys activity activities`: class name → distinct records in
     * the tasks' history (`* Hist #n: ActivityRecord{…}`, each record's identity hash counted
     * once), which is the live stack; the dump's other mentions (`mLastPausedActivity`) can name
     * a record that has left it. Every mention counts on an image whose dump has no history lines.
     */
    private fun activityRecords(): Map<String, Int> {
        val dump = shell("dumpsys activity activities")
        val history = recordsIn(HISTORY_RECORD.findAll(dump))
        return (if (history.isEmpty()) recordsIn(ACTIVITY_RECORD.findAll(dump)) else history).toSortedMap()
    }

    private fun recordsIn(matches: Sequence<MatchResult>): Map<String, Int> {
        val byClass = HashMap<String, MutableSet<String>>()
        for (match in matches) {
            val component = match.groupValues[2]
            if (!component.startsWith("${app.packageName}/")) continue
            byClass.getOrPut(component.substringAfterLast('.')) { HashSet() }.add(match.groupValues[1])
        }
        return byClass.mapValues { it.value.size }
    }

    /** [activityRecords] once the trampoline has left them (noHistory; it finishes as it starts the browser), for up to 6 s. */
    private fun awaitActivityRecords(): Map<String, Int> {
        val deadline = SystemClock.uptimeMillis() + 6_000
        var records = activityRecords()
        while ((records["LauncherIconActivity"] ?: 0) > 0 && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
            records = activityRecords()
        }
        return records
    }

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand(command)).use { it.bufferedReader().readText() }

    // --- the private new tab page's cookie switch ------------------------------------------------

    /** A real touch on the middle of the Block third-party cookies row (the whole row is the switch), scrolled into view first. */
    private fun touchCookieSwitch(): Boolean {
        chromeJs("(function(){var e=document.querySelector('$COOKIES_ROW');if(e)e.scrollIntoView({block:'center'})})()")
        SystemClock.sleep(800)
        val row = chromeRect(COOKIES_ROW) ?: run {
            finding("no Block third-party cookies row on the private new tab page")
            return false
        }
        val point = touchPoint(row) ?: run {
            finding("the Block third-party cookies row is outside the touchable window: $row")
            return false
        }
        Log.i(tag, "touch at ${point.x},${point.y} on the cookie switch row $row")
        Finger().tap(point.x, point.y)
        return true
    }

    /** The row's `aria-checked` ("true" / "false"; "" without the row). */
    private fun cookieRowChecked(): String =
        jsString("(function(){var e=document.querySelector('$COOKIES_ROW');return e?(e.getAttribute('aria-checked')||''):''})()")

    /**
     * Poll until the core's status reads `blocked`, the private setting `mode` and the row's
     * `aria-checked` follows – what a touch on the switch must bring about, all three.
     */
    private fun awaitCookieSwitch(blocked: Boolean, mode: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val state = coreState()
            val status = state.optJSONObject("privacy")?.optJSONObject("privateThirdPartyCookies")
            val setting = state.optJSONObject("settings")?.optJSONObject("privacy")?.optString("thirdPartyCookiesPrivate")
            if (status?.optBoolean("blocked") == blocked && setting == mode && cookieRowChecked() == blocked.toString()) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** Poll until the engine's flags (the policy the core pushed, `privacy.apply`) block, or not, third-party cookies in private tabs. */
    private fun awaitEngineBlocks(blocks: Boolean, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (host.privacy.flags.blocksThirdPartyCookiesIn(true) == blocks) return true
            SystemClock.sleep(200)
        }
        return host.privacy.flags.blocksThirdPartyCookiesIn(true) == blocks
    }

    /** The switch's state read every way: the core's status, the setting, the row, the engine's flags, the private tab's own view. */
    private fun cookieSwitchState(tabId: String): String {
        val state = coreState()
        val status = state.optJSONObject("privacy")?.optJSONObject("privateThirdPartyCookies")
        val setting = state.optJSONObject("settings")?.optJSONObject("privacy")
        val flags = host.privacy.flags
        val viewAccepts = host.tabs.get(tabId)?.let { view ->
            onMain { runCatching { Profiles.cookieManager(Profiles.PRIVATE_CONTAINER).acceptThirdPartyCookies(view) }.getOrNull() }
        }
        return "status blocked ${status?.optBoolean("blocked")} locked ${status?.optBoolean("locked")}; " +
            "settings thirdPartyCookies '${setting?.optString("thirdPartyCookies")}' thirdPartyCookiesPrivate '${setting?.optString("thirdPartyCookiesPrivate")}'; " +
            "row aria-checked '${cookieRowChecked()}'; engine flags private '${flags.thirdPartyCookiesPrivate}', blocks in private ${flags.blocksThirdPartyCookiesIn(true)}, " +
            "in regular ${flags.blocksThirdPartyCookiesIn(false)}; the private tab's view accepts third-party cookies: $viewAccepts"
    }

    // --- the sheet's cover ------------------------------------------------------------------------

    /** The chrome's page cover – the `<img decoding="sync">` a sheet stands on – decoded; null when there is none. */
    private fun coverImage(): Bitmap? =
        decodeDataUrl(jsString("(function(){var i=document.querySelector('img[decoding=\"sync\"]');return i?(i.getAttribute('src')||''):''})()"))

    /**
     * The engine's own copy of a tab's page (`view.snapshot`, the PixelCopy the sheet's cover
     * comes from), asked for directly and decoded; null when it answered none within 10 s. Asked
     * with the page in view: the sheet, once up, has the page swapped for its cover.
     */
    private fun directSnapshot(tabId: String): Bitmap? {
        val view = host.tabs.get(tabId) ?: return null
        var data: String? = null
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view.snapshot { result ->
                data = result
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return data?.let(::decodeDataUrl)
    }

    /** A `data:image/…;base64,…` URL as a bitmap; null for anything else. */
    private fun decodeDataUrl(src: String): Bitmap? {
        val comma = src.indexOf(',')
        if (!src.startsWith("data:image/") || comma < 0) return null
        val bytes = runCatching { Base64.decode(src.substring(comma + 1), Base64.DEFAULT) }.getOrNull() ?: return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    /** The chrome's `--zen-recede` as computed on its root: 0 with no sheet, 1 with one fully up. */
    private fun recedeValue(): Float =
        jsString("String(+getComputedStyle(document.documentElement).getPropertyValue('--zen-recede')||0)").toFloatOrNull() ?: 0f

    /** A bitmap of the driver's own (the cover), filed as a still next to the screenshots. */
    private fun saveStill(name: String, bitmap: Bitmap) {
        File(out, "private-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    // --- the private session's card (#223), the shade, the guard as a release build has it ---------

    private val notifications: NotificationManager by lazy { app.getSystemService(NotificationManager::class.java) }

    /** The session's card as the system holds it (the app's own notifications), null when none is posted. */
    private fun privateCard(): StatusBarNotification? =
        runCatching { notifications.activeNotifications.firstOrNull { it.id == PrivateSession.NOTIFICATION_ID } }.getOrNull()

    /** Poll up to `timeoutMs` for the card, one `accept`s; null when none came. */
    private fun awaitCard(timeoutMs: Long, accept: (StatusBarNotification) -> Boolean = { true }): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            privateCard()?.takeIf(accept)?.let { return it }
            SystemClock.sleep(250)
        }
        return privateCard()?.takeIf(accept)
    }

    private fun awaitCardGone(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateCard() == null) return true
            SystemClock.sleep(250)
        }
        return privateCard() == null
    }

    private fun cardTitle(sbn: StatusBarNotification?): String? =
        sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()

    private fun cardText(sbn: StatusBarNotification?): String? =
        sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun cardOngoing(sbn: StatusBarNotification?): Boolean =
        sbn != null && sbn.notification.flags and Notification.FLAG_ONGOING_EVENT != 0

    private fun describeCard(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        val actions = n.actions?.map { it.title?.toString() ?: "?" } ?: emptyList()
        return "id=${sbn.id} channel=${n.channelId} title=\"${cardTitle(sbn)}\" text=\"${cardText(sbn)}\" ongoing=${cardOngoing(sbn)} " +
            "press=${n.contentIntent != null} buttons=$actions visibility=${n.visibility} " +
            "(secret ${n.visibility == Notification.VISIBILITY_SECRET}) localOnly=${n.flags and Notification.FLAG_LOCAL_ONLY != 0}"
    }

    /**
     * A card with the session's identity – the id and the channel – posted by the driver while
     * no host is up: the stand-in for the card a process that died with private tabs open leaves
     * behind. What the next host does with it (`PrivateSession` cancels it as it starts) is the
     * rule under test; the card's own looks are not, so its glyph is the platform's.
     */
    private fun postStandInCard() {
        PrivateSession.ensureChannel(app)
        val card = NotificationCompat.Builder(app, PrivateSession.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle(PrivateSession.TITLE)
            .setContentText("1 private tab is open")
            .setOngoing(true)
            .setSilent(true)
            .setLocalOnly(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build()
        runCatching { NotificationManagerCompat.from(app).notify(PrivateSession.NOTIFICATION_ID, card) }
            .onFailure { finding("posting the stand-in card failed: $it") }
    }

    /**
     * Whether FLAG_SECURE is on the window for the surface in view, read as a release build has
     * it: the recording override is dropped for the look and put back after (the recording goes
     * black for the second it takes, as Recents would).
     */
    private fun guardNow(): Boolean {
        PrivateBrowsing.captureForRecording = false
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(600)
        val guarded = onMain { PrivateBrowsing.guarded(activity.window) }
        PrivateBrowsing.captureForRecording = true
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(600)
        return guarded
    }

    /**
     * Count the `profile.clear` calls the chrome sends the host from here on. The bridge encodes
     * every call with `JSON.stringify` (`Bridge.call`), so the driver wraps it in the chrome and
     * notes the container of each `profile.clear` – the core's `sessions.clearPrivate`, which
     * `endPrivateSessionIfOver` makes once the last private tab is gone. Nothing of the product
     * is touched for it; the hook goes with the chrome's document (a relaunch drops it).
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
        val raw = jsString("JSON.stringify(window.__zenClears||[])")
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getString(it) }
    }

    /** Pull the shade down and wait for a node of the system UI whose label `matches`; the windows go to the findings when none does. */
    private fun openShade(timeoutMs: Long = 10_000, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(SYSTEM_UI, matches)?.let { return it }
            SystemClock.sleep(250)
        }
        finding("the shade showed nothing that was looked for within $timeoutMs ms")
        dumpWindows("shade")
        return null
    }

    private fun closeShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        } else {
            back()
        }
        SystemClock.sleep(1_500)
    }

    /** The labels on screen, window by window, into the findings (what the tree really says when a label is not found). */
    private fun dumpWindows(why: String) {
        val lines = ArrayList<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            val labels = ArrayList<String>()
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 1_500 && labels.size < 40) {
                val node = queue.removeFirst()
                visited++
                val text = (node.contentDescription ?: node.text)?.toString()?.trim()
                if (!text.isNullOrEmpty()) labels += text.take(60)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            lines += "    window type=${window.type} pkg=${root.packageName} labels=$labels"
        }
        finding("  windows ($why):\n${lines.joinToString("\n")}")
    }

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
        val target = pillShown() ?: pill
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
            dismissUrlbar()
            coreInvoke("tab.navigate", json("tabId" to tabId, "input" to url).toString())
            awaitLoaded(tabId, url)
        }
        dismissUrlbar()
    }

    /**
     * Back out of the URL bar if it is up, by the shared close (DemoHarness.closeUrlField): a back
     * only against the chrome's own word that the bar is up, never a look for the address pill.
     * On a tab with no page the pill has no address to read, and a back sent with no URL bar up
     * reaches the tab's root – at a shortcut tab's root, back returns to the launcher and closes
     * the tab (#117's caller rule). A page the close moved all the same goes on the failures by name.
     */
    private fun dismissUrlbar() {
        val close = closeUrlField()
        if (!close.ok) {
            finding("the URL bar's close: ${close.describe()} ${verdict(false)}")
            failures += "the URL bar's close: ${close.describe()}"
        }
    }

    // --- the overview, through the chrome's DOM --------------------------------------------------

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"
    private fun closeButton(tabId: String) = closeButtonOf(card(tabId))

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

    /**
     * The pane the overview shows: the `data-pane` of its grid, or of its empty explainer, inside
     * the live slot (`.zen-overview-pane`; the still of a pane on its way out is not in it).
     */
    private fun pane(): String =
        jsString("(function(){var p=document.querySelector('.zen-overview-pane [data-pane]');return p?(p.getAttribute('data-pane')||''):''})()")

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
        awaitDestroyed()
        finding("the browser's task removed: activity destroyed ${onMain { activity.isDestroyed }}; launching again")
        SystemClock.sleep(1_500)
        launch()
        ensureForeground()
        finding("relaunched: new activity ${activity !== before.activity}, new host ${host !== before}")
        refindPill()
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

    /** A state's word in the findings, where PASS and FAIL are the checks' alone: the guard read off is "off", not a failure. */
    private fun onOff(on: Boolean) = if (on) "on" else "off"

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
        /** The pill's label on a tab with no page (`PhoneShell`), where the address would be. */
        private const val EMPTY_PILL_LABEL = "Search or enter address"
        /** The private new tab page's Block third-party cookies row: the whole row is the switch (NTP-31). */
        private const val COOKIES_ROW = "[data-testid=\"private-ntp-cookies\"]"
        /** The shade's package: the session's card is looked for in its windows alone (the app's tree runs to thousands of nodes). */
        private const val SYSTEM_UI = "com.android.systemui"
        /** An activity record in `dumpsys activity activities`: `ActivityRecord{<hash> u<user> <package>/<class> t<task>}`. */
        private val ACTIVITY_RECORD = Regex("ActivityRecord\\{([0-9a-f]+) u\\d+ ([^ }]+)")
        /**
         * A record in a task's history, the live stack: `Hist #n: ActivityRecord{…}` (`* Hist #n:`
         * on older images, `Hist  #n:` in the brief dump of newer ones), with the same groups.
         */
        private val HISTORY_RECORD = Regex("Hist\\s+#\\d+: ActivityRecord\\{([0-9a-f]+) u\\d+ ([^ }]+)")
    }
}
