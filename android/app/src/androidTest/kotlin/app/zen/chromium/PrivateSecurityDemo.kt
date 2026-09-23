package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
 * Records the private and security surfaces of W5-7 on the phone (ERR-09, TAB-03, INC-03,
 * NOT-07), in both colour schemes: the pill's one glyph over a plain http page – the open lock
 * in the warn ink, "Not secure", in the lock's own room (Bennett's OMN-02 ruling: the chip room
 * is neither moved nor widened) – and the site-information sheet it opens, whose title block
 * says the same word and whose Connection level explains what "not secure" means and what not
 * to enter (a certificate error's triangle and its sheet as well, when the network lets the
 * expired-certificate page load); the Private pane with nothing in it – §9.17's one sentence, "No
 * private tabs", with New private tab as its one follow-up, never a card (§9.34); the private new
 * tab page's Block third-party cookies switch under a finger, then the engine's answer read per
 * WebView – the private views' switch alone moves, a regular tab's WebView is never asked – and
 * a tracker's cookie kept out of the private jar while the default jar has it; the session's
 * card (its secret visibility, the low channel, the count) and the dark grid of two private
 * cards; the lock cover from the first frame of the pane's own entry (the segment tapped with
 * the lock on, a frame watch in the chrome's document over the whole way in); and the card's
 * press closing every private tab through the core's close-all, the card and the lock going with
 * them and the overview returning to the Tabs pane.
 *
 * The http page is served on the device's own network address (`DemoServer.siteAddress`), which
 * Chromium's rules call insecure where the loopback is as trustworthy as https; nothing of the
 * chip's scene touches the network. The cookies probe is read on the loopback, `127.0.0.1`, with
 * the tracker's frame from `127.0.0.2`, a second server on another loopback host: a different
 * site, so its frame in the page is a third party's, and the frame's own reading of its cookies
 * (up to the page by `postMessage`) is the evidence; the jars are on record beside it.
 *
 * Driven by the `android-private-security-demo` workflow. See [DemoHarness] for the plumbing.
 * The recorder sees the private surface because `PrivateBrowsing.captureForRecording` is on for
 * the run (a debug-build override, as the other private drivers set). A device PIN is set for
 * the run (`locksettings set-pin`, cleared at the end): the private lock arms only on a device
 * with a screen lock. Findings land in `private-security-findings.txt` next to the screenshots;
 * a check that fails there fails the run.
 */
@RunWith(AndroidJUnit4::class)
class PrivateSecurityDemo : DemoHarness("private-security-demo-state.json", "private-security", "private-security-demo") {
    override val tag = "PrivateSecurityDemo"
    private lateinit var site: DemoServer
    private lateinit var tracker: DemoServer
    private lateinit var siteOrigin: String
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host
    private var pinSet = false

    @Test
    fun record() {
        val address = DemoServer.siteAddress()
            ?: error("the device has no network address besides the loopback: no insecure origin to serve the http page from")
        siteOrigin = "http://$address:$SITE_PORT"
        // The site on every interface: it answers on the device's address (the chip's page) and on
        // 127.0.0.1 (the cookies probe). The tracker on 127.0.0.2 alone: the second loopback host
        // is the one address its frame is ever fetched from, so it listens nowhere else.
        site = DemoServer(SITE_PORT, siteRoutes(), address = "0.0.0.0").also { it.start() }
        tracker = DemoServer(TRACKER_PORT, trackerRoutes(), address = "127.0.0.2").also { it.start() }
        var fault: Throwable? = null
        try {
            runDemo()
        } catch (e: Throwable) {
            fault = e
        } finally {
            site.close()
            tracker.close()
            PrivateBrowsing.captureForRecording = false
            if (pinSet) shell("locksettings clear --old $PIN")
        }
        if (failures.isNotEmpty() || fault != null) {
            throw AssertionError(
                "${failures.size} check(s) failed: ${failures.joinToString("; ")}" +
                    (fault?.let { "; and: ${it.message}" } ?: "")
            )
        }
    }

    /** The seeded tabs point at the device's own address (the seed names the emulator's); the boot scheme is the run's. */
    override fun patchState(json: String): String =
        json.replace("http://10.0.2.15:$SITE_PORT", siteOrigin)
            .replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The recording must show the private surface; the PIN is the screen lock the private lock needs. */
    override fun beforeLaunch() {
        PrivateBrowsing.captureForRecording = true
        val info = ui.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        ui.serviceInfo = info
        Log.i(tag, "set-pin: ${shell("locksettings set-pin $PIN").trim()}")
        pinSet = true
        shell("wm dismiss-keyguard")
    }

    // --- the pages -------------------------------------------------------------------------------

    /**
     * The http site: the plain page for the chip (on the device's own address: insecure), a second
     * page for the other regular tab, and the cookies probe – read on the loopback, `127.0.0.1`,
     * where it bakes a first-party cookie of its own and embeds the tracker's frame from another
     * loopback host, `127.0.0.2`: a different site, so the frame is a third party's. The frame
     * reports its own cookies up by `postMessage`; the page keeps the word in `window.__trk`.
     */
    private fun siteRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Plain http site</title>" +
                "<style>$PAGE_STYLE</style></head>" +
                "<body><main><h1>Plain http site</h1>" +
                "<p>This page is served over plain http on the device's own network address, so the address is not secure.</p>" +
                "<p>Anything typed here travels in the open: the pill says so with the open lock.</p>" +
                "</main></body></html>"
            ).toByteArray()),
        "/notes.html" to DemoServer.page("Notes", "<p>A second regular tab, so the Tabs pane has two cards.</p>"),
        "/cookies.html" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Cookies probe</title>" +
                "<style>${PAGE_STYLE}iframe{width:100%;height:96px;border:1px solid #d9d8df;border-radius:12px}</style></head>" +
                "<body><main><h1>Cookies probe</h1>" +
                "<p>This page bakes a cookie of its own and embeds a frame from another site: a third party that tries to bake one in its own jar.</p>" +
                "<p id=r>Waiting for the frame\u2026</p>" +
                "<iframe src=\"$TRACKER_ORIGIN/tracker.html\" title=\"Tracker frame\"></iframe>" +
                "</main><script>document.cookie='first=here; path=/; max-age=86400';window.__trk=null;" +
                "window.addEventListener('message',function(e){if(e.origin!=='$TRACKER_ORIGIN')return;var c=String(e.data);window.__trk=c;" +
                "document.getElementById('r').textContent='The frame says: cookie '+(c?'set ('+c+')':'refused')});</script></body></html>"
            ).toByteArray())
    )

    /**
     * The tracker's frame: bakes a cookie in its own jar from script, the way a third party
     * would – `SameSite=None; Secure`, the only shape a cookie may take in a cross-site frame
     * (the loopback counts as trustworthy for `Secure`) – then tells the page what it reads back.
     */
    private fun trackerRoutes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/tracker.html" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8><style>body{margin:0;padding:16px;font-family:sans-serif;" +
                "font-size:15px;color:#5b5a63;background:#f2f1f5}</style></head><body>" +
                "<div id=t>Tracker frame</div><script>" +
                "document.cookie='trk='+Math.random().toString(36).slice(2,8)+'; path=/; max-age=86400; SameSite=None; Secure';" +
                "var c=document.cookie;document.getElementById('t').textContent='Tracker frame: cookie '+(c?'set':'refused');" +
                "parent.postMessage(c,'*');" +
                "</script></body></html>"
            ).toByteArray())
    )

    // --- sequence --------------------------------------------------------------------------------

    /** Both regular pages loaded (the cards' thumbnails), the overview opened once off camera. */
    override fun warmUp() {
        findings = File(out, "private-security-findings.txt")
        findings.writeText(
            "Zenium Android private and security surfaces (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "WebView ${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"}, boot scheme $THEME)\n\n"
        )
        finding("site server: ${site.selfCheck()} (pages on $siteOrigin, the device's own address: an insecure origin)")
        finding("tracker server: ${tracker.selfCheck()} (frames on $TRACKER_ORIGIN, a third party to the site)")
        finding(
            "multi-profile WebView: ${onMain { Profiles.supported }}; capabilities.privateTabs per the core: ${privateTabsCapability()}; " +
                "device PIN set: $pinSet; screen lock per the host (reauth.available): ${onMain { host.reauth.available() }}"
        )
        awaitLoaded(SITE_TAB, "$siteOrigin/")
        coreInvoke("tab.activate", json("tabId" to NOTES_TAB).toString())
        awaitLoaded(NOTES_TAB, "$siteOrigin/notes.html")
        SystemClock.sleep(800)
        coreInvoke("tab.activate", json("tabId" to SITE_TAB).toString())
        awaitActiveTab(SITE_TAB)
        SystemClock.sleep(1_000)
        if (openOverview()) {
            SystemClock.sleep(1_200)
            back()
            awaitOverviewGone()
        }
        closeSheets()
        SystemClock.sleep(1_200)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        ensureForeground()
        setScheme("light")

        // 1. ERR-09: the open lock in the lock's room over the plain http page, and its words.
        scene("1. The Not secure chip over a plain http page (ERR-09)") {
            expect("set-up: the regular tab shows the http page", awaitLoaded(SITE_TAB, "$siteOrigin/") && awaitActiveTab(SITE_TAB))
            settle()
            val bar = readPill()
            val chip = readChip("not-secure")
            val chips = bar.optJSONArray("chips").toStringList()
            finding("  pill: ${bar.toString().take(600)}")
            finding("  chip: $chip")
            expect("the glyph slot draws the not-secure chip first", chips.firstOrNull() == "not-secure")
            expect("no lock chip stands beside it (one glyph per state)", "lock" !in chips)
            expect("the chip's name is Not secure", chip.optString("label") == "Not secure")
            expect("the chip draws the open lock", chip.optString("glyph").contains("lucide-lock-open"))
            expect("the chip's ink is the warn tone", chip.optString("verdict") == "warn")
            expect("the chip takes the lock's 44 x 44 room, not a text chip's", nearly(chip.optDouble("w"), 44.0) && nearly(chip.optDouble("h"), 44.0))
            expect("the chip opens a dialog (the site-information sheet)", chip.optString("popup") == "dialog")
            val hostBox = bar.optDouble("hostBox", 0.0)
            expect("the host keeps at least its 150 px floor beside the chip", hostBox >= 150.0)
            expect("the address speaks the verdict last", bar.optString("address").endsWith(", Not secure"))
            expect("the chip is in the accessibility tree by its name", findByLabel("Not secure") != null)
            finding("  host box ${fmt(hostBox)} px, address '${bar.optString("address")}', buttons ${bar.optJSONArray("buttons").toStringList()}")
            shot("01-chip-http-light")
            setScheme("dark")
            val dark = readChip("not-secure")
            expect("the chip stands in the dark scheme too", dark.optString("label") == "Not secure" && dark.optString("verdict") == "warn")
            shot("02-chip-http-dark")
            setScheme("light")
        }

        // 2. The sheet the chip opens: the same word on the title block, the Connection row, and
        //    the level that explains what not secure means and what not to enter.
        scene("2. The site-information sheet explains Not secure (ERR-09)") {
            expect("a finger on the chip brings the sheet up", openSheetFromChip("Not secure"))
            val title = readSheetTitle()
            finding("  title block: $title")
            expect("the title block says Not secure", title.optString("text").contains("Not secure"))
            expect("the title block draws the open lock in the warn ink", title.optString("glyph").contains("lucide-lock-open") && title.optString("glyph").contains("--v2-warn"))
            val row = chromeRect(CONNECTION_ROW)
            expect("the Connection row reads Not secure and leads on", row != null)
            finding("  Connection row: ${jsString("(function(){var b=document.querySelector('$CONNECTION_ROW');return b?(b.getAttribute('aria-label')||''):''})()")}")
            shot("03-sheet-http-light")
            setScheme("dark")
            shot("04-sheet-http-dark")
            setScheme("light")
            if (row != null) {
                val point = touchPoint(row)
                if (point != null) Finger().tap(point.x, point.y) else finding("  the Connection row is outside the touchable window: $row")
            }
            expect("a finger on Connection opens the level", awaitChrome(LEVEL_SHOWN_JS, 8_000))
            SystemClock.sleep(1_200)
            val level = readConnectionLevel()
            finding("  Connection level: $level")
            expect("the level's headline is Connection is not secure", level.optString("label") == "Connection is not secure")
            expect("the level says what not secure means and what not to enter", level.optString("description") == NOT_SECURE_DETAIL)
            expect("the level's glyph is in the warn tone", level.optString("tone") == "warn")
            expect("the explanation fits its two lines, nothing cut", level.optInt("lines", 0) in 1..2 && !level.optBoolean("cut", true))
            expect("the level's row is spoken whole by its parts", findNode { it.startsWith("Connection is not secure") } != null || findNode { it == NOT_SECURE_DETAIL } != null)
            shot("05-sheet-connection-light")
            setScheme("dark")
            shot("06-sheet-connection-dark")
            setScheme("light")
            closeSheets()
            expect("back leaves the sheet", awaitChrome("!document.querySelector('.zen-sheet')", 6_000))
        }

        // 3. Best effort, over the network: a certificate that fails verification puts the triangle
        //    in the danger ink in the same room, and the sheet's title block says Not secure with it.
        scene("3. The certificate-error chip (ERR-09, over the network)") {
            coreInvoke("tab.activate", json("tabId" to NOTES_TAB).toString())
            awaitActiveTab(NOTES_TAB)
            coreInvoke("tab.navigate", json("tabId" to NOTES_TAB, "input" to EXPIRED_CERT_URL).toString())
            val reached = poll(20_000) { "certificate-error" in readPill().optJSONArray("chips").toStringList() }
            if (!reached) {
                finding("  skipped: no certificate error reached the pill within 20 s (the network, or the page): the vitest pins the state")
            } else {
                SystemClock.sleep(1_500)
                val chip = readChip("certificate-error")
                finding("  chip: $chip")
                expect("the certificate error draws the triangle in the danger ink", chip.optString("glyph").contains("lucide-triangle-alert") && chip.optString("verdict") == "danger")
                expect("the certificate error's chip is named Not secure", chip.optString("label") == "Not secure")
                expect("the triangle takes the same 44 x 44 room", nearly(chip.optDouble("w"), 44.0) && nearly(chip.optDouble("h"), 44.0))
                shot("07-chip-cert-light")
                setScheme("dark")
                shot("08-chip-cert-dark")
                setScheme("light")
                if (openSheetFromChip("Not secure")) {
                    val title = readSheetTitle()
                    finding("  title block: $title")
                    expect("the sheet's title block draws the triangle in the danger ink with Not secure", title.optString("glyph").contains("lucide-triangle-alert") && title.optString("text").contains("Not secure"))
                    shot("09-sheet-cert-light")
                    setScheme("dark")
                    shot("10-sheet-cert-dark")
                    setScheme("light")
                    closeSheets()
                } else {
                    finding("  the sheet did not open from the certificate-error chip")
                }
            }
            coreInvoke("tab.navigate", json("tabId" to NOTES_TAB, "input" to "$siteOrigin/notes.html").toString())
            awaitLoaded(NOTES_TAB, "$siteOrigin/notes.html", 15_000)
            expect("the seeded regular tabs are both still open", tabExists(SITE_TAB) && tabExists(NOTES_TAB))
            coreInvoke("tab.activate", json("tabId" to SITE_TAB).toString())
            expect("the site tab is in front again", awaitActiveTab(SITE_TAB))
            finding("  active tab ${activeCoreTab()?.optString("id")}; tabs ${coreState().optJSONObject("tabs")?.keys()?.asSequence()?.toList()}")
            closeSheets()
        }

        // 4. TAB-03: the Private pane with nothing in it – §9.17's one sentence on the phone
        //    panels' note, its one follow-up 16 beneath, never a card (§9.34).
        scene("4. The empty Private pane (TAB-03)") {
            expect("set-up: no private tab is open", !anyPrivateTab())
            expect("the overview opens from the regular tab", openOverview())
            expect("the overview opens on the Tabs pane", awaitPane("tabs"))
            tapSegment("private")
            expect("a finger on Private shows the Private pane", awaitPane("private"))
            SystemClock.sleep(1_500)
            val empty = readEmpty()
            finding("  empty pane: $empty")
            expect("the pane is §9.17's sentence on the phone panels' note, never a card", empty.optBoolean("note") && !empty.optBoolean("card", true))
            expect("the sentence is the pane's fact, No private tabs", empty.optString("sentence") == EMPTY_TITLE)
            expect("the sentence stands alone – no title, glyph or description beside it", empty.optInt("paragraphs") == 1 && empty.optInt("headings", 99) == 0 && empty.optInt("glyphs", 99) == 0)
            expect("the sentence is set at §9.17's 15/400", empty.optString("font").startsWith("15px/400/"))
            expect("the sentence is centred in the pane's 32 gutter", empty.optDouble("offCentre", 99.0) <= 2.0 && nearly(empty.optDouble("gutter", 0.0), 32.0))
            expect("the sentence's first line stands 48 under the segment, as the Groups pane's", nearly(empty.optDouble("underSegment", -1.0), 48.0, 1.5))
            expect("the pane's one follow-up is New private tab, a secondary button", empty.optInt("buttons") == 1 && empty.optString("button") == "New private tab" && !empty.optBoolean("primary", true) && empty.optBoolean("secondary"))
            expect("the follow-up stands 16 below the sentence, 40 tall", nearly(empty.optDouble("gap", -1.0), 16.0) && nearly(empty.optDouble("buttonHeight", -1.0), 40.0))
            expect("the sentence and the follow-up are in the accessibility tree", findByLabel(EMPTY_TITLE) != null && findByLabel("New private tab") != null)
            shot("11-pane-empty-light")
            setScheme("dark")
            shot("12-pane-empty-dark")
            setScheme("light")
            tapSegment("tabs")
            awaitPane("tabs")
            back()
            expect("back leaves the overview", awaitOverviewGone())
        }

        // 5. INC-03: the private new tab page's switch under a finger, then the engine's answer per
        //    WebView – the private views alone move, and a tracker's cookie stays out of the private jar.
        var private1 = ""
        scene("5. Block third-party cookies for private tabs only (INC-03)") {
            coreInvoke("tab.newPrivate", "{}")
            expect("a private tab opens on the private new tab page", awaitPrivateActive())
            private1 = activeCoreTab()?.optString("id").orEmpty()
            expect("the private new tab page explains itself", waitFor(PRIVATE_TITLE, 8_000) != null)
            settle()
            finding("  private tab $private1; at rest: ${cookieSwitchState(private1)}")
            expect("the switch is on by default (block-private, Chrome's default)", awaitCookieSwitch(blocked = true, mode = "default"))
            expect("a finger on the row turns the switch off", touchCookieSwitch() && awaitCookieSwitch(blocked = false, mode = "allow"))
            expect("the engine's flags follow: private tabs accept third-party cookies", awaitEngineBlocks(false))
            finding("  after the first finger: ${cookieSwitchState(private1)}")
            SystemClock.sleep(1_000)
            expect("a second finger turns it on again", touchCookieSwitch() && awaitCookieSwitch(blocked = true, mode = "block"))
            expect("the engine's flags follow: private tabs block third-party cookies", awaitEngineBlocks(true))
            finding("  after the second finger: ${cookieSwitchState(private1)}")
            SystemClock.sleep(1_000)
            shot("13-ntp-switch-light")
            setScheme("dark")
            shot("14-ntp-switch-dark")
            setScheme("light")

            // The probe. A regular tab first: its WebView accepts third parties, so the tracker's
            // frame bakes its cookie and says so; the regular views are never asked to change.
            val regularBefore = regularViewsAccept()
            finding("  views before the probe: ${viewsNote()}")
            coreInvoke("tab.activate", json("tabId" to NOTES_TAB).toString())
            expect("set-up: the regular tab comes in front for its visit", awaitActiveTab(NOTES_TAB))
            coreInvoke("tab.navigate", json("tabId" to NOTES_TAB, "input" to COOKIES_URL).toString())
            expect("a regular tab loads the cookies page", awaitLoaded(NOTES_TAB, COOKIES_URL))
            val regularReport = awaitTrackerReport(NOTES_TAB)
            finding("  the frame in the regular tab: '$regularReport'; default jar: tracker '${jarOf(Profiles.DEFAULT_CONTAINER, TRACKER_ORIGIN)}', site '${jarOf(Profiles.DEFAULT_CONTAINER, COOKIES_ORIGIN)}'")
            expect("in a regular tab the tracker's cookie is set (third parties allowed there, as before)", regularReport.contains("trk="))
            SystemClock.sleep(1_200)

            // Then the private tab, the switch on: the frame is refused its cookie, the page's own
            // is kept, and the regular views answer as before.
            coreInvoke("tab.activate", json("tabId" to private1).toString())
            expect("set-up: the private tab is in front again", awaitActiveTab(private1))
            coreInvoke("tab.navigate", json("tabId" to private1, "input" to COOKIES_URL).toString())
            expect("the private tab loads the cookies page", awaitLoaded(private1, COOKIES_URL))
            val blockedReport = awaitTrackerReport(private1)
            SystemClock.sleep(1_000)
            expect("the private view refuses third-party cookies", viewAccepts(private1) == false)
            expect("the regular views accept them, unchanged", regularBefore == true && regularViewsAccept() == true)
            val privateTracker = jarOf(Profiles.PRIVATE_CONTAINER, TRACKER_ORIGIN)
            val privateSite = jarOf(Profiles.PRIVATE_CONTAINER, COOKIES_ORIGIN)
            finding("  the frame in the private tab, switch on: '$blockedReport'; private jar: tracker '$privateTracker', site '$privateSite'; views: ${viewsNote()}")
            expect("the tracker's cookie is refused in the private tab (the frame's own reading)", blockedReport == "")
            expect("the site's own cookie is in the private jar (first party is not blocked)", privateSite.contains("first="))
            expect("nothing of the tracker's reaches the private jar", !privateTracker.contains("trk="))
            finding("  pill on the private page: ${readPill().toString().take(400)}")
            shot("15-private-page-blocked")

            // The switch off through the core (the page is in front, not the new tab page): the
            // private view's answer moves alone, and a reload lets the tracker's cookie in.
            coreInvoke("privacy.setThirdPartyCookiesPrivate", """{"mode":"allow"}""")
            expect("the private view accepts third-party cookies once the switch is off", poll(8_000) { viewAccepts(private1) == true })
            expect("the regular views are untouched by the private switch", regularViewsAccept() == true)
            coreInvoke("tab.navigate", json("tabId" to private1, "input" to "$COOKIES_URL?again").toString())
            expect("the private tab reloads the page", awaitLoaded(private1, "$COOKIES_URL?again"))
            val allowedReport = awaitTrackerReport(private1)
            finding("  the frame in the private tab, switch off: '$allowedReport'; private jar: tracker '${jarOf(Profiles.PRIVATE_CONTAINER, TRACKER_ORIGIN)}'; default jar: tracker '${jarOf(Profiles.DEFAULT_CONTAINER, TRACKER_ORIGIN)}'")
            expect("with the switch off the tracker's cookie is set in the private tab", allowedReport.contains("trk="))
            coreInvoke("privacy.setThirdPartyCookiesPrivate", """{"mode":"block"}""")
            expect("the switch on again: the private view refuses, the regular views still accept", poll(8_000) { viewAccepts(private1) == false } && regularViewsAccept() == true)
            finding("  switch on again: ${cookieSwitchState(private1)}")

            // The regular tab back on its own page, for the Tabs pane's card; the private tab in front again.
            coreInvoke("tab.activate", json("tabId" to NOTES_TAB).toString())
            awaitActiveTab(NOTES_TAB)
            coreInvoke("tab.navigate", json("tabId" to NOTES_TAB, "input" to "$siteOrigin/notes.html").toString())
            awaitLoaded(NOTES_TAB, "$siteOrigin/notes.html", 15_000)
            coreInvoke("tab.activate", json("tabId" to private1).toString())
            awaitActiveTab(private1)
        }

        // 6. NOT-07: the session's card while private tabs are open.
        var private2 = ""
        scene("6. The Close all private tabs card (NOT-07)") {
            val card = awaitCard(8_000)
            finding("  card with one private tab: ${describeCard(card)}")
            expect("the card is posted while a private tab is open", card != null)
            expect("the card is Close all private tabs, counting one tab", cardTitle(card) == PrivateSession.TITLE && cardText(card) == "1 private tab is open")
            expect("the card is secret: nothing of it on the lock screen", card?.notification?.visibility == Notification.VISIBILITY_SECRET)
            expect("the card is ongoing and this device's alone", cardOngoing(card) && (card?.notification?.flags ?: 0) and Notification.FLAG_LOCAL_ONLY != 0)
            expect("the card is on the private channel", card?.notification?.channelId == PrivateSession.CHANNEL_ID)
            val channel = notifications.getNotificationChannel(PrivateSession.CHANNEL_ID)
            finding("  channel: id ${channel?.id} name '${channel?.name}' importance ${channel?.importance} badge ${channel?.canShowBadge()}")
            expect("the channel is named and low-importance", channel != null && channel.name?.toString() == PrivateSession.CHANNEL_NAME && channel.importance == NotificationManager.IMPORTANCE_LOW)
            expect("the card's press is wired", card?.notification?.contentIntent != null)

            coreInvoke("tab.newPrivate", json("url" to "$siteOrigin/notes.html").toString())
            expect("a second private tab opens", poll(8_000) { privateTabIds().size == 2 })
            private2 = privateTabIds().firstOrNull { it != private1 }.orEmpty()
            awaitLoaded(private2, "$siteOrigin/notes.html", 15_000)
            val two = awaitCard(8_000) { cardText(it) == "2 private tabs are open" }
            expect("the card counts the second private tab", two != null)
            finding("  card with two: ${describeCard(two)}")
            expect("the card stays secret with the count", two?.notification?.visibility == Notification.VISIBILITY_SECRET)

            // The shade, for the record: the card among the system's.
            val inShade = openShade(10_000) { it == PrivateSession.TITLE || it.startsWith(PrivateSession.TITLE) }
            finding("  the card in the shade: ${if (inShade != null) "shown" else "not found by its title"}")
            SystemClock.sleep(1_200)
            shot("16-card-shade")
            closeShade()
            ensureForeground()
        }

        // 7. TAB-03: the dark grid of two private cards.
        scene("7. The Private pane's grid (TAB-03)") {
            expect("set-up: two private tabs", privateTabIds().size == 2)
            coreInvoke("tab.activate", json("tabId" to private1).toString())
            awaitActiveTab(private1)
            expect("the overview opens from the private tab", openOverview())
            expect("the overview opens on the Private pane", awaitPane("private"))
            SystemClock.sleep(1_500)
            val shown = cards()
            expect("the pane shows the two private cards and no regular one", shown.containsAll(setOf(private1, private2)) && SITE_TAB !in shown && NOTES_TAB !in shown)
            expect("the chrome is on the private (dark) theme", host.themeDark && chromeScheme() == "dark")
            expect("no cover stands without the lock", !paneCoverUp())
            finding("  cards $shown; chrome scheme ${chromeScheme()}; private surface ${host.privateSurface}")
            shot("17-pane-grid-light")
            setScheme("dark")
            shot("18-pane-grid-dark")
            setScheme("light")
            tapSegment("tabs")
            expect("a finger on Tabs shows the regular cards", awaitPane("tabs") && poll(3_000) { cards().containsAll(setOf(SITE_TAB, NOTES_TAB)) })
            back()
            expect("back leaves the overview", awaitOverviewGone())
        }

        // 8. TAB-03 / #250: the lock on, Home and back from a regular tab, then the pane's own
        //    entry – the segment tapped – shows the cover from its first frame, never the cards.
        //    The covered pane is left standing for scene 9's press.
        scene("8. The lock cover on the pane's own entry (TAB-03, #250)", keepOverview = true) {
            coreInvoke("private.setLockOnLeave", """{"enabled":true}""")
            expect("set-up: the lock-on-leave switch is on", poll(6_000) { lockOnLeave() && host.privateLock.enabled })
            expect("set-up: the seeded site tab is still open", tabExists(SITE_TAB))
            coreInvoke("tab.activate", json("tabId" to SITE_TAB).toString())
            expect("set-up: a regular tab is in front", awaitActiveTab(SITE_TAB))
            finding("  active tab ${activeCoreTab()?.optString("id")}; views ${viewsNote()}")
            SystemClock.sleep(1_000)
            home()
            expect("Home puts Zenium in the background", awaitFront(ours = false))
            val lockedAway = awaitLocked(4_000)
            SystemClock.sleep(1_500)
            returnToApp()
            expect("Zenium is back in front", awaitFront(ours = true))
            ensureForeground()
            SystemClock.sleep(1_500)
            expect("the lock armed as the window left, and holds on return", lockedAway && host.privateLock.locked && storeLocked())
            expect("no cover over the regular tab", !coverUp())
            expect("the overview opens from the regular tab", openOverview())
            expect("the overview opens on the Tabs pane", awaitPane("tabs"))
            SystemClock.sleep(800)
            expect("the frame watch is armed in the chrome's document", jsString(PANE_WATCH_JS) == "armed")
            tapSegment("private")
            expect("a finger on Private shows the Private pane", awaitPane("private"))
            expect("the cover is over the pane", poll(4_000) { paneCoverUp() })
            SystemClock.sleep(1_500)
            val watch = readPaneWatch()
            finding("  frame watch over the way in: $watch")
            val leaks = watch.optInt("bare", 99) + watch.optInt("unmasked", 99) + watch.optInt("live", 99)
            expect("the pane was covered on every frame of its entry, its grid inert, every card masked", watch.optInt("frames", 0) > 0 && watch.optInt("panes", 0) > 0 && leaks == 0)
            expect("the covered grid is inert and hidden from accessibility", gridInert())
            // The covered grid is aria-hidden: no card (a masked one reads "Private tab, tab 1 of 2",
            // its close "Close Private tab") and nothing of the pages reaches the tree. The pill's
            // own "Private tab locked" is the cover's word, not a card's.
            val labels = a11yLabels()
            expect("no card and no card control reaches the accessibility tree under the cover", labels.none { it.startsWith("Private tab, ") || it == "Close Private tab" || it == "Cookies probe" })
            finding("  a11y labels (${labels.size}): ${labels.take(30)}")
            shot("19-pane-locked-light")
            setScheme("dark")
            shot("20-pane-locked-dark")
            setScheme("light")
            jsString("(function(){if(window.__paneWatch)window.__paneWatch.stopped=true;return 'stopped'})()")
        }

        // 9. NOT-07 / INC-07: the card's press closes every private tab through the core's
        //    close-all; the card and the lock go with them, the private surface too. The overview
        //    scene 8 left standing on the covered Private pane is the premise: the last private tab
        //    closing has one rule in the product, the chrome's pane pick (TabOverview: a Private
        //    pane picked with its count gone to nothing picks Tabs – INC-07's "returns to the Tabs
        //    pane"); nothing in the chrome, the core or the host dismisses the overview for it. Run
        //    2's dismissal onto the regular tab was this driver's own: `recover()` pressed back
        //    after scene 8 (logcat 10:54:40.907, ZenBack's commit to the chrome) 2.3 s before the
        //    press, and the premise then read the card alone.
        scene("9. The card's press closes every private tab (NOT-07, INC-07)") {
            expect("set-up: the overview stands on the covered Private pane", overviewOpen() && pane() == "private" && paneCoverUp())
            val card = awaitCard(4_000)
            expect("the card stands for the two private tabs", card != null && cardText(card) == "2 private tabs are open")
            val sent = runCatching { card?.notification?.contentIntent?.send() }.isSuccess && card?.notification?.contentIntent != null
            expect("the card's press is sent (its PendingIntent, as the shade sends it)", sent)
            expect("every private tab closes", awaitNoPrivateTabs(10_000))
            expect("the card comes down with the last private tab", awaitCardGone(8_000))
            expect("the lock is released with the count", awaitUnlocked(6_000) && host.privateLock.openTabs == 0)
            expect("the overview returns to the Tabs pane, no cover left (INC-07)", awaitPane("tabs") && overviewOpen() && poll(3_000) { !coverUp() })
            expect("the chrome blends back off the private theme", poll(6_000) { !host.themeDark })
            finding(
                "  after the press: private tabs ${privateTabIds()}, card ${describeCard(privateCard())}, lock ${host.privateLock.locked}, " +
                    "overview ${if (overviewOpen()) "open on '${pane()}'" else "dismissed"}, active tab ${activeCoreTab()?.optString("id")}, chrome dark ${host.themeDark}"
            )
            SystemClock.sleep(1_200)
            shot("21-after-close-all")
            if (overviewOpen()) {
                back()
                awaitOverviewGone()
            }
            coreInvoke("private.setLockOnLeave", """{"enabled":false}""")
        }

        finding("\n${failures.size} check(s) failed${if (failures.isEmpty()) "" else ": " + failures.joinToString("; ")}")
    }

    // --- scenes ----------------------------------------------------------------------------------

    private fun scene(title: String, keepOverview: Boolean = false, block: () -> Unit) {
        finding("\n$title")
        try {
            block()
        } catch (e: Throwable) {
            Log.e(tag, "$title threw", e)
            expect("$title ran through (${e.javaClass.simpleName}: ${e.message})", false)
        }
        recover(keepOverview)
    }

    /**
     * Whatever a scene left standing goes: the shade, a chrome surface, an overview a scene left
     * open, the light scheme back. A scene that hands the next one its overview says so with
     * `keepOverview` (scene 8 leaves the covered Private pane standing for scene 9's press; run 2's
     * back here, a key the host commits to the chrome, is what dismissed it before the press).
     */
    private fun recover(keepOverview: Boolean) {
        if (frontPackage() == SYSTEM_UI) closeShade()
        closeSheets()
        if (!keepOverview && overviewOpen()) {
            back()
            awaitOverviewGone()
        }
        if (chromeSchemeSetting() != "light") setScheme("light")
    }

    // --- the pill and the sheet, through the chrome's document ---------------------------------

    /** The pill as the chrome's document has it (the fold demo's reading): the chips in the run, the host box, the address's label. */
    private fun readPill(): JSONObject {
        val raw = chromeJs(READ_PILL_JS)
        val text = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String) ?: return JSONObject()
        return runCatching { JSONObject(text) }.getOrElse { JSONObject() }
    }

    /** The chip `id` in the live pill's run: its box in CSS px, its name, its verdict ink, its glyph's classes. */
    private fun readChip(id: String): JSONObject {
        val raw = jsString(
            "(function(){var c=document.querySelector('.zen-phone-pill:not(.zen-pill-ghost) [data-chip=\"$id\"] button[data-site-info]');" +
                "if(!c)return '';var r=c.getBoundingClientRect();var s=c.querySelector('svg');" +
                "return JSON.stringify({w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10,verdict:c.getAttribute('data-verdict')||''," +
                "label:c.getAttribute('aria-label')||'',glyph:s?(s.getAttribute('class')||''):'',popup:c.getAttribute('aria-haspopup')||''," +
                "expanded:c.getAttribute('aria-expanded')||''})})()"
        )
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** The sheet's title block: its second line's text and the classes of the glyph ahead of it. */
    private fun readSheetTitle(): JSONObject {
        val raw = jsString(
            "(function(){var p=document.querySelector('.zen-sheet-title-block p');if(!p)return '';var s=p.querySelector('svg');" +
                "return JSON.stringify({text:p.textContent.trim(),glyph:s?(s.getAttribute('class')||''):''})})()"
        )
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** The Connection level's status row: headline, description, tone, and whether the description fits its lines whole. */
    private fun readConnectionLevel(): JSONObject {
        val raw = jsString(
            "(function(){var row=document.querySelector('$LEVEL_ROW');if(!row)return '';" +
                "var g=row.querySelector('.zen-sheet-item-glyph');var d=row.querySelector('.zen-sheet-item-secondary');" +
                "var spans=row.querySelectorAll('span.block');var label='';for(var i=0;i<spans.length;i++){if(!spans[i].classList.contains('zen-sheet-item-secondary')){label=spans[i].textContent.trim();break}}" +
                "var lines=0;var cut=false;if(d){var lh=parseFloat(getComputedStyle(d).lineHeight)||1;lines=Math.round(d.getBoundingClientRect().height/lh);cut=d.scrollHeight>d.clientHeight+1}" +
                "return JSON.stringify({label:label,description:d?d.textContent.trim():'',tone:g?(g.getAttribute('data-tone')||''):'',lines:lines,cut:cut})})()"
        )
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /**
     * A finger on the pill's chip named `label` (the site-information glyph), then the sheet
     * up: the host's word on a surface and the sheet's rows group in the chrome's document.
     * The chip is read in the pill's row ([pillControl]): a page reading the same words – the
     * certificate interstitial says "not secure" too – answers before the pill in the tree.
     */
    private fun openSheetFromChip(label: String): Boolean {
        val chip = pillControl(label, 8_000)
        if (chip == null) {
            finding("  (no '$label' chip in the pill's row of the accessibility tree)")
            return false
        }
        if (!touchTap(chip)) return false
        val up = poll(10_000) { sheetUp() }
        if (!up) touchFault("a finger on '$label' did not bring the site-information sheet up")
        SystemClock.sleep(1_500)
        return up
    }

    /** A sheet with a title block stands on the chrome's dialog host, and is not on its way down. */
    private fun sheetUp(): Boolean =
        dialogHostState() == "up" && jsString("(function(){return document.querySelector('.zen-sheet')&&document.querySelector('.zen-sheet-title-block')?'yes':''})()") == "yes"

    /**
     * What the chrome's dialog host shows: `up` (a sheet or the quick menu on top), `leaving`
     * (the last one on its way down), "" (clear). Read in the chrome's document, not from the
     * host's word on it: `chromeSurfaceUp` follows the chrome's `back.update` and lags a close.
     */
    private fun dialogHostState(): String = jsString(
        "(function(){var h=document.querySelector('.zen-frame-dialogs');" +
            "if(h&&h.getAttribute('data-leaving')==='true')return 'leaving';" +
            "if(h&&h.getAttribute('data-open')==='true')return 'up';" +
            "var s=document.querySelector('.zen-sheet, .zen-quick-menu');if(!s)return '';" +
            "return s.closest('[data-leaving]')?'leaving':'up'})()"
    )

    /** The surface on top, for telling one back's effect from the next: the sheet's header and the host's slot count. */
    private fun surfaceSignature(): String =
        jsString("(function(){var h=document.querySelector('.zen-sheet-title');return (h?h.textContent.trim():'')+'|'+document.querySelectorAll('.zen-frame-dialogs-slot > *').length})()")

    /**
     * Back once per surface the chrome's document shows, waiting each time for the host to clear
     * (or to show the surface beneath) before the next press. Never a back while the host is
     * leaving or clear: a back the chrome has nothing for goes to the page, and with no history
     * to ROOT, which closes the tab (run 1 lost the seeded site tab this way).
     */
    private fun closeSheets() {
        var presses = 0
        while (presses < 4) {
            poll(4_000) { dialogHostState() != "leaving" }
            if (dialogHostState() != "up") return
            val before = surfaceSignature()
            back()
            presses++
            poll(5_000) { dialogHostState() != "up" || surfaceSignature() != before }
            SystemClock.sleep(500)
        }
        poll(4_000) { dialogHostState() == "" }
    }

    // --- the overview, through the chrome's DOM --------------------------------------------------

    /**
     * The empty Private pane as §9.17 has it: the phone panels' note (`.zen-phone-empty`, the
     * pane's own child) with its one sentence – its type, its centring in the note's gutter, its
     * first line's distance under the segment – and the pane's one button, its kind and its
     * distance below the sentence. Whether a card still stands in the pane is read as well.
     */
    private fun readEmpty(): JSONObject {
        val raw = jsString(
            "(function(){var pane=document.querySelector('.zen-overview-pane [data-testid=\"overview-private-empty\"]');if(!pane)return '';" +
                "var n=pane.querySelector(':scope > .zen-phone-empty');var p=n&&n.querySelector(':scope > p');" +
                "var bs=pane.querySelectorAll('button');var b=bs[0];" +
                "var seg=document.querySelector('.zen-overview .zen-v2-segment[role=\"tablist\"]');" +
                "var pr=pane.getBoundingClientRect();var tr=p?p.getBoundingClientRect():null;var br=b?b.getBoundingClientRect():null;var sr=seg?seg.getBoundingClientRect():null;" +
                "var cs=n?getComputedStyle(n):null;var ps=p?getComputedStyle(p):null;" +
                "return JSON.stringify({note:!!n,card:!!pane.querySelector('.zen-private-explainer,[data-surface=\"page\"]')," +
                "sentence:p?p.textContent.trim():'',paragraphs:n?n.querySelectorAll('p').length:0," +
                "headings:pane.querySelectorAll('h1,h2,h3').length,glyphs:pane.querySelectorAll('svg').length," +
                "font:ps?ps.fontSize+'/'+ps.fontWeight+'/'+ps.lineHeight:''," +
                "offCentre:tr?Math.round(Math.abs((tr.left-pr.left)-(pr.right-tr.right))*10)/10:99,gutter:cs?parseFloat(cs.paddingLeft):0," +
                "underSegment:tr&&sr?Math.round((tr.top-sr.bottom)*10)/10:-1," +
                "buttons:bs.length,button:b?b.textContent.trim():'',primary:b?b.hasAttribute('data-primary'):false," +
                "secondary:b?b.classList.contains('zen-phone-empty-action')&&b.classList.contains('zen-v2-button'):false," +
                "gap:tr&&br?Math.round((br.top-tr.bottom)*10)/10:-1,buttonHeight:br?Math.round(br.height*10)/10:-1})})()"
        )
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** The frame watch's counts (`PANE_WATCH_JS`), as the chrome's document holds them. */
    private fun readPaneWatch(): JSONObject {
        val raw = jsString("JSON.stringify(window.__paneWatch||{})")
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

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
     * The pane the live overview shows: the `data-pane` of its grid, its empty note or its
     * cover in the live slot. The still a leaving pane is kept as (`pane-still`, ahead of the live
     * slot in the document while the switch plays) and the segment tabs are not read; the selected
     * segment is the fallback with nothing live.
     */
    private fun pane(): String = jsString(
        "(function(){var all=document.querySelectorAll('.zen-overview-pane [data-pane]');" +
            "for(var i=0;i<all.length;i++){var e=all[i];if(e.getAttribute('role')==='tab'||e.closest('[data-testid=\"pane-still\"]'))continue;return e.getAttribute('data-pane')||''}" +
            "var t=document.querySelector('.zen-overview [role=\"tab\"][aria-selected=\"true\"][data-pane]');return t?(t.getAttribute('data-pane')||''):''})()"
    )

    private fun awaitPane(pane: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pane() == pane) return true
            SystemClock.sleep(150)
        }
        return pane() == pane
    }

    /** The tab ids of the cards on the live pane, in grid order (a leaving pane's still is not read). */
    private fun cards(): List<String> {
        val raw = jsString(
            "JSON.stringify(Array.prototype.filter.call(document.querySelectorAll('.zen-overview-pane [data-tab-id]')," +
                "function(e){return !e.closest('[data-testid=\"pane-still\"]')}).map(function(e){return e.getAttribute('data-tab-id')}))"
        )
        return runCatching { JSONArray(raw) }.getOrNull().toStringList()
    }

    /** A real touch on the segment's tab `id` (`tabs` or `private`). */
    private fun tapSegment(id: String) {
        val r = chromeRect("[data-testid=\"overview-pane-$id\"]") ?: run {
            finding("  no segment tab for $id on screen")
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

    /** A lock cover at rest is in the chrome's DOM (the frame's or the pane's), not one on its way out. */
    private fun coverUp(): Boolean =
        jsString("(function(){var e=document.querySelector('$COVER');return e&&!e.hasAttribute('data-leaving')?'up':''})()") == "up"

    private fun paneCoverUp(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview-pane $COVER');return e&&!e.hasAttribute('data-leaving')?'up':''})()") == "up"

    /** The covered Private pane's grid is out of reach: `inert` and `aria-hidden`. */
    private fun gridInert(): Boolean =
        jsString("(function(){var g=document.querySelector('.zen-overview-pane .zen-overview-grid');return g&&g.hasAttribute('inert')&&g.getAttribute('aria-hidden')==='true'?'inert':''})()") == "inert"

    /** Every label and text in the app's own windows, breadth first (capped). */
    private fun a11yLabels(): List<String> {
        val found = ArrayList<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != app.packageName) continue
            val queue = ArrayDeque(listOf(root))
            var visited = 0
            while (queue.isNotEmpty() && visited < 4_000) {
                val node = queue.removeFirst()
                visited++
                node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { found += it }
                node.text?.toString()?.takeIf { it.isNotBlank() }?.let { found += it }
                for (i in 0 until node.childCount) node.getChild(i)?.let { queue.addLast(it) }
            }
        }
        return found
    }

    // --- the private tabs, the lock, the cookies -----------------------------------------------

    private fun privateTabsCapability(): Boolean =
        coreState().optJSONObject("capabilities")?.optBoolean("privateTabs") ?: false

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun awaitPrivateActive(timeoutMs: Long = 10_000): Boolean = poll(timeoutMs) { privateActive() }

    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence()
            .filter { tabs.optJSONObject(it)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }
            .sorted()
            .toList()
    }

    private fun anyPrivateTab(): Boolean = privateTabIds().isNotEmpty()

    private fun tabExists(tabId: String): Boolean = coreState().optJSONObject("tabs")?.has(tabId) == true

    private fun awaitNoPrivateTabs(timeoutMs: Long = 8_000): Boolean = poll(timeoutMs) { !anyPrivateTab() }

    private fun awaitActiveTab(tabId: String, timeoutMs: Long = 8_000): Boolean =
        poll(timeoutMs) { activeCoreTab()?.optString("id") == tabId }

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

    private fun lockOnLeave(): Boolean = coreState().optBoolean("privateLockOnLeave")

    /** A field of the chrome's `privateLockStore` (`window.__zenStores['private-lock']`), as text. */
    private fun storeField(name: String): String =
        jsString("(function(){var s=(window.__zenStores||{})['private-lock'];return s?String(s.get()[${JSONObject.quote(name)}]):'?'})()")

    private fun storeLocked(): Boolean = storeField("locked") == "true"

    private fun awaitLocked(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (host.privateLock.locked) return true
            SystemClock.sleep(50)
        }
        return host.privateLock.locked
    }

    private fun awaitUnlocked(timeoutMs: Long): Boolean = poll(timeoutMs) { !host.privateLock.locked && !storeLocked() }

    /** Whether the tab's WebView accepts third-party cookies, per the engine (`CookieManager.acceptThirdPartyCookies`); null without a view. */
    private fun viewAccepts(tabId: String): Boolean? {
        val view = host.tabs.get(tabId) ?: return null
        return onMain { accepts(view) }
    }

    private fun accepts(view: TabWebView): Boolean? =
        runCatching { Profiles.cookieManager(view.containerId).acceptThirdPartyCookies(view) }.getOrNull()

    /** Every regular (default-container) WebView's answer: true when all accept, false when one refuses, null with no regular view held. */
    private fun regularViewsAccept(): Boolean? {
        val answers = onMain { host.tabs.all().filter { it.containerId == Profiles.DEFAULT_CONTAINER }.map { accepts(it) } }
        return if (answers.isEmpty()) null else answers.all { it == true }
    }

    /** The WebViews the host holds, each with its container and its answer on third-party cookies. */
    private fun viewsNote(): String = onMain {
        host.tabs.all().map { "${it.tabId} (${it.containerId}): accepts ${accepts(it)}" }
    }.joinToString(", ").ifEmpty { "none" }

    /** The cookies a container's jar holds for `origin`; "" without a jar (or a cookie). */
    private fun jarOf(containerId: String, origin: String): String = onMain {
        runCatching { Profiles.cookieManager(containerId).getCookie(origin) }.getOrNull().orEmpty()
    }

    /**
     * The tracker frame's report in the tab's cookies page (`window.__trk`): what the frame read
     * back from `document.cookie` after baking its cookie – "" when refused, "?" before it spoke.
     */
    private fun trackerReport(tabId: String): String {
        val raw = pageJs(tabId, "(function(){var t=window.__trk;return t===null||t===undefined?'?':String(t)})()")
        return (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String) ?: "?"
    }

    private fun awaitTrackerReport(tabId: String, timeoutMs: Long = 10_000): String {
        poll(timeoutMs) { trackerReport(tabId) != "?" }
        return trackerReport(tabId)
    }

    /** Evaluate in the tab's own WebView (the page's world); the raw JSON-encoded result, "" without a view or an answer. */
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

    /** A real touch on the middle of the Block third-party cookies row (the whole row is the switch), scrolled into view first. */
    private fun touchCookieSwitch(): Boolean {
        chromeJs("(function(){var e=document.querySelector('$COOKIES_ROW');if(e)e.scrollIntoView({block:'center'})})()")
        SystemClock.sleep(800)
        val row = chromeRect(COOKIES_ROW) ?: run {
            finding("  no Block third-party cookies row on the private new tab page")
            return false
        }
        val point = touchPoint(row) ?: run {
            finding("  the Block third-party cookies row is outside the touchable window: $row")
            return false
        }
        Log.i(tag, "touch at ${point.x},${point.y} on the cookie switch row $row")
        Finger().tap(point.x, point.y)
        return true
    }

    /** The row's `aria-checked` ("true" / "false"; "" without the row). */
    private fun cookieRowChecked(): String =
        jsString("(function(){var e=document.querySelector('$COOKIES_ROW');return e?(e.getAttribute('aria-checked')||''):''})()")

    /** Poll until the core's status reads `blocked`, the private setting `mode` and the row's `aria-checked` follows – all three. */
    private fun awaitCookieSwitch(blocked: Boolean, mode: String, timeoutMs: Long = 8_000): Boolean = poll(timeoutMs) {
        val state = coreState()
        val status = state.optJSONObject("privacy")?.optJSONObject("privateThirdPartyCookies")
        val setting = state.optJSONObject("settings")?.optJSONObject("privacy")?.optString("thirdPartyCookiesPrivate")
        status?.optBoolean("blocked") == blocked && setting == mode && cookieRowChecked() == blocked.toString()
    }

    /** Poll until the engine's flags (the policy the core pushed, `privacy.apply`) block, or not, third-party cookies in private tabs. */
    private fun awaitEngineBlocks(blocks: Boolean, timeoutMs: Long = 6_000): Boolean =
        poll(timeoutMs) { host.privacy.flags.blocksThirdPartyCookiesIn(true) == blocks }

    /** The switch's state read every way: the core's status, the setting, the row, the engine's flags, the views. */
    private fun cookieSwitchState(privateTab: String): String {
        val state = coreState()
        val status = state.optJSONObject("privacy")?.optJSONObject("privateThirdPartyCookies")
        val setting = state.optJSONObject("settings")?.optJSONObject("privacy")
        val flags = host.privacy.flags
        return "status blocked ${status?.optBoolean("blocked")} locked ${status?.optBoolean("locked")}; " +
            "settings thirdPartyCookies '${setting?.optString("thirdPartyCookies")}' thirdPartyCookiesPrivate '${setting?.optString("thirdPartyCookiesPrivate")}'; " +
            "row aria-checked '${cookieRowChecked()}'; engine flags private '${flags.thirdPartyCookiesPrivate}', blocks in private ${flags.blocksThirdPartyCookiesIn(true)}, " +
            "in regular ${flags.blocksThirdPartyCookiesIn(false)}; views accept third-party cookies: private $privateTab ${viewAccepts(privateTab)}, " +
            "regular $SITE_TAB ${viewAccepts(SITE_TAB)}, $NOTES_TAB ${viewAccepts(NOTES_TAB)}"
    }

    // --- the session's card ----------------------------------------------------------------------

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

    private fun awaitCardGone(timeoutMs: Long): Boolean = poll(timeoutMs) { privateCard() == null }

    private fun cardTitle(sbn: StatusBarNotification?): String? =
        sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()

    private fun cardText(sbn: StatusBarNotification?): String? =
        sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun cardOngoing(sbn: StatusBarNotification?): Boolean =
        sbn != null && sbn.notification.flags and Notification.FLAG_ONGOING_EVENT != 0

    private fun describeCard(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        return "id=${sbn.id} channel=${n.channelId} title=\"${cardTitle(sbn)}\" text=\"${cardText(sbn)}\" ongoing=${cardOngoing(sbn)} " +
            "press=${n.contentIntent != null} visibility=${n.visibility} (secret ${n.visibility == Notification.VISIBILITY_SECRET}) " +
            "localOnly=${n.flags and Notification.FLAG_LOCAL_ONLY != 0} category=${n.category}"
    }

    /** Pull the shade down and wait for a node of the system UI whose label `matches`; null when none came in time. */
    private fun openShade(timeoutMs: Long, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(SYSTEM_UI, matches)?.let { return it }
            SystemClock.sleep(250)
        }
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

    // --- Home and back ---------------------------------------------------------------------------

    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    /**
     * Zenium back in front: the running activity's task comes forward, no relaunch. Through the
     * shell, as the private lock demo does (an activity start from this process while the app
     * stands behind the launcher is a background start the system may refuse); the in-process
     * start is the fallback when the shell's answer is not ok.
     */
    private fun returnToApp() {
        val started = shell("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        if (!started.contains("Status: ok")) {
            finding("  am start: ${started.trim().lines().joinToString(" | ")}; starting from the process instead")
            app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

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

    // --- the scheme ------------------------------------------------------------------------------

    private fun setScheme(scheme: String) {
        coreInvoke("settings.update", """{"colorScheme":"$scheme"}""")
        // The theme blends over 240 ms (v2 §11.6); the emulator's software GPU takes its time.
        SystemClock.sleep(2_500)
    }

    private fun chromeSchemeSetting(): String = coreState().optJSONObject("settings")?.optString("colorScheme", "light") ?: "light"

    /** The colour scheme the chrome's root carries (`data-theme`): `dark` on the private theme whatever the setting. */
    private fun chromeScheme(): String = jsString("document.documentElement.dataset.theme||''")

    // --- plumbing --------------------------------------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    /** A JS expression's string result in the chrome ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** A core command's arguments as JSON text. */
    private fun json(vararg pairs: Pair<String, Any?>): JSONObject =
        JSONObject().also { for ((key, value) in pairs) it.put(key, value ?: JSONObject.NULL) }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand(command)).use { it.bufferedReader().readText() }

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun nearly(value: Double, expected: Double, tolerance: Double = 1.0): Boolean =
        !value.isNaN() && kotlin.math.abs(value - expected) <= tolerance

    private fun JSONArray?.toStringList(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { optString(it) }

    private fun fmt(value: Double): String = "%.1f".format(value)

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

    private companion object {
        val THEME: String = InstrumentationRegistry.getArguments().getString("theme").let { if (it == "dark") "dark" else "light" }

        /** The http site, on every interface: the device's own address is the one the seeded tabs name. */
        const val SITE_PORT = 18175
        /** The tracker, on the second loopback host: another site, so its frame in the probe is a third party's. */
        const val TRACKER_PORT = 18176
        const val TRACKER_ORIGIN = "http://127.0.0.2:$TRACKER_PORT"
        /** The cookies probe, read on the first loopback host (both loopbacks are the same, trustworthy, address space). */
        const val COOKIES_ORIGIN = "http://127.0.0.1:$SITE_PORT"
        const val COOKIES_URL = "$COOKIES_ORIGIN/cookies.html"
        const val PAGE_STYLE = "body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}main{padding:36px 24px}" +
            "h1{font-size:28px;margin:0 0 16px}p{font-size:18px;line-height:1.5;color:#3b3a44;margin:0 0 20px}"
        /** The seeded regular tabs (`private-security-demo-state.json`). */
        const val SITE_TAB = "tab_site"
        const val NOTES_TAB = "tab_notes"
        /** Set with `locksettings set-pin` before the app starts; cleared at the end. */
        const val PIN = "1234"
        /** A certificate that failed verification, for the triangle (best effort: the network). */
        const val EXPIRED_CERT_URL = "https://expired.badssl.com/"
        const val SYSTEM_UI = "com.android.systemui"

        // The chrome's words, pinned by the vitests as well.
        const val PRIVATE_TITLE = "You're browsing privately"
        const val EMPTY_TITLE = "No private tabs"
        const val NOT_SECURE_DETAIL = "Anyone on the way can read what you send to this site. Don't enter passwords or card details here."

        // The chrome's hooks.
        const val COOKIES_ROW = "[data-testid=\"private-ntp-cookies\"]"
        const val COVER = "[data-testid=\"private-lock-cover\"]"
        /** The sheet's root Connection row (a `SheetRow` button named by its parts). */
        const val CONNECTION_ROW = "button.zen-sheet-item[aria-label^=\"Connection, \"]"
        /** The Connection level's status row: its pane's two-line static row with the headline and the explanation (every level's pane is mounted in the track). */
        const val LEVEL_ROW = "section[data-level=\"connection\"] .zen-sheet-item.zen-sheet-item-two-line"
        /** The Connection level is the one on screen: the sheet's header reads its title. */
        const val LEVEL_SHOWN_JS = "(function(){var h=document.querySelector('.zen-sheet-title');return h&&h.textContent.trim()==='Connection'})()"
        const val NUDGE = 12f

        /** The pill as the chrome's document has it (the fold demo's reading); the widths in CSS px. */
        val READ_PILL_JS = """
            (function () {
              var pill = document.querySelector('.zen-phone-pill:not(.zen-pill-ghost)');
              var host = pill && pill.querySelector('[data-testid="pill-host"]');
              var address = pill && pill.querySelector('[data-testid="pill-address"]');
              var run = pill && pill.querySelector('[data-testid="pill-chips"]');
              var box = host ? host.getBoundingClientRect() : null;
              return JSON.stringify({
                pillWidth: pill ? Math.round(pill.getBoundingClientRect().width * 10) / 10 : null,
                hostBox: box ? Math.round(box.width * 10) / 10 : null,
                hostText: host ? host.textContent : null,
                chips: run ? Array.from(run.querySelectorAll(':scope > [data-chip]')).map(function (c) { return c.dataset.chip; }) : [],
                buttons: pill ? Array.from(pill.querySelectorAll('button')).map(function (b) { return b.getAttribute('aria-label'); }) : [],
                address: address ? address.getAttribute('aria-label') : null,
                dpr: window.devicePixelRatio
              });
            })()
        """.trimIndent()

        /**
         * A frame watch in the chrome's document for the pane's entry under the lock: on every
         * animation frame, each private grid in the document (the live slot's and a still's) is
         * read for its cover beside it, its `inert`, and its cards' masks; the counts go to
         * `window.__paneWatch`. `bare`, `unmasked` and `live` are leaks; `pictures` is on record.
         */
        val PANE_WATCH_JS = """
            (function () {
              if (window.__paneWatch) window.__paneWatch.stopped = true;
              var w = { frames: 0, panes: 0, bare: 0, unmasked: 0, live: 0, pictures: 0, stopped: false, notes: [] };
              window.__paneWatch = w;
              function sample() {
                if (w.stopped) return;
                w.frames++;
                var grids = document.querySelectorAll('.zen-overview-grid[data-pane="private"]');
                for (var i = 0; i < grids.length; i++) {
                  var g = grids[i];
                  w.panes++;
                  var slot = g.parentElement;
                  if (!slot || !slot.querySelector('[data-testid="private-lock-cover"]')) {
                    w.bare++;
                    if (w.notes.length < 4) w.notes.push('frame ' + w.frames + ': a private grid without its cover');
                  }
                  if (!g.hasAttribute('inert')) w.live++;
                  var cards = g.querySelectorAll('.zen-overview-card');
                  for (var j = 0; j < cards.length; j++) { if (!cards[j].hasAttribute('data-masked')) w.unmasked++; }
                  if (g.querySelector('.zen-overview-card-preview img')) w.pictures++;
                }
                requestAnimationFrame(sample);
              }
              requestAnimationFrame(sample);
              return 'armed';
            })()
        """.trimIndent()
    }
}
