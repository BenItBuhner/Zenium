package app.zen.chromium

import android.content.res.Configuration
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The `android-band-demo` workflow: the page-edge band on the phone (motion spec §3; §3.4
 * Android; §4's four tenants; §6's guards) – the pull pattern for prompts: the page slides down
 * by the band's height on `SPRING_GENTLE` and the prompt lives in the gap the frame opens, one
 * band at a time, never a card over the page. Five loopback SITES on one port (`127.0.0.1` to
 * `.5`: a site of its own to the reader entry's per-site memory and the install prompt's
 * per-app record) serve a short page at `/plain`, the read-aloud demo's article at `/article`
 * (with a re-titled copy at `/second`) and the PWA demo's Sketch Studio at `/app/` (its manifest,
 * icons and screenshots; `webapps.json` seeded with one visit a day ago, so the load here is the
 * second visit and the install prompt is due). The default-browser campaign is seeded so the
 * phone's lighter reminder is due in this session (the sheet had its say the session before).
 * Writes `band-findings.txt` next to the stills (a `PASS` or `FAIL` per check; the run fails at
 * its end when any did, or when a touch did not take):
 *
 *  1. THE DEFAULT-BROWSER STATE (a two-line band, 76): the title, its detail, "Set as default",
 *     "Not now" and the ×, `role="status"`, at the frame's top; the page translated by the
 *     band's height (the host's own word: the page WebView's `translationY`); a short swipe up
 *     released before half the height springs the band back (`band-swipe-back`); a swipe past
 *     half dismisses it (`band-swipe-dismiss`), the page following the finger 1:1 on the way
 *     (the host's offset sampled under the drag), the campaign's "Not now" recorded by the core.
 *  2. THE INSTALL OFFER (76; the first tenant, §7): "Add Sketch Studio to Home screen" with the
 *     app's origin, one "Add", the ×; the × (`band-close-x`) takes the band off and starts the
 *     app's cooldown (a reload brings no offer).
 *  3. THE READER OFFER (56): "Show Reader View?" with one "Show"; the action (`band-action-show`)
 *     runs the reader crossing, the band gone with it.
 *  4. THE CLOCK: an offer left standing leaves on its own at about `BAND_CLOCK_MS` (10 s); the
 *     timeout is a refusal the reader entry remembers for the site, as today.
 *  5. THE SHEET WAITS: an offer that arises while the app menu stands does not show under it;
 *     the sheet gone, the band comes.
 *  6. ONE AT A TIME, STATE OVER OFFER: the radios off while the install offer stands – the
 *     offline state replaces it (`band-replace-offline`): one band root, the title changed, the
 *     page re-targeted 76 → 56 on the spring; NEVER ON THE NEW TAB PAGE: on `zen://newtab` no
 *     band and the page home; back on a web page the state returns (it holds).
 *  7. A PULL ON A HELD PAGE (§3.4 Android): a pull-to-refresh begun while the band stands takes
 *     the page over where it sits – the band leaves, the page never jumps home first
 *     (`band-pull-takeover`, the host's offset sampled through the drag), the pull comes home
 *     on the release; the state returns after.
 *  8. THE STATE ENDS: the radios back – the band leaves (`band-leave-online`), "Back online" as
 *     a toast.
 *  9. DARK: the install offer, the reader offer and the offline state on the dark ground
 *     (Zenium's own Dark first, the system's second – ReaderUiDemo's order).
 *
 * THE FRAME RECORD (§6; PERF-3's harness, [traceFrames], `frames.jsonl`): every band motion the
 * driver causes with a finger or a tap is a scene; beside HWUI's summary and the renderer's
 * trace, two readings of the driver's own: the HOST SAMPLER (the page's `translationY` read on
 * the main thread every [SAMPLE_MS] through the motion – the curve the user sees, from the host
 * that draws it: where it set out, where it landed, the longest stretch mid-motion in which the
 * page did not move) and the CHROME'S FRAME CLOCK (a `requestAnimationFrame` loop in the chrome's
 * document through the scene: the gaps between its frames; a gap of two frames or more is the
 * §6 defect – "a motion that misses two consecutive frames"). Both are REPORTED with a verdict:
 * the emulator's software GPU makes every frame janky by construction (the harness's own
 * caveat), so the run does not fail on them; the stills, the recording and these lines are the
 * evidence the perf program's table reads.
 *
 * THE SEAM'S HOOKS: the band's content component is the shared layer's (Desktop's W8-M2); this
 * driver reads it through the accessibility tree (its words, its buttons) and the host (the page's
 * translation), and through the document for what the tree does not say (the form, the role, how
 * many roots) – those selectors stand together in [BAND_PROBE_JS] and are the one place to
 * change if the component names them otherwise. Every control pressed is a real injected finger
 * with an assertion (#198's rule). See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class BandDemo : DemoHarness("band-demo-state.json", MEDIA_PREFIX, "band-demo") {
    override val tag = "BandDemo"
    private var servers: List<DemoServer> = emptyList()
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    private var radiosOff = false
    private val host get() = (activity as MainActivity).host
    private val sampler = OffsetSampler()

    @Test
    fun record() {
        val article = readAsset("read-aloud-demo-page.html")
        val second = article.replace("lighthouse keeper", "harbourmaster")
        val routes = mapOf(
            "/plain" to (HTML to PLAIN_PAGE.toByteArray()),
            "/article" to (HTML to article.toByteArray()),
            "/second" to (HTML to second.toByteArray()),
            "/app/" to (HTML to APP_PAGE.toByteArray()),
            "/app/manifest.webmanifest" to ("application/manifest+json" to MANIFEST.toByteArray()),
            "/webapp/icon.svg" to ("image/svg+xml" to asset("webapp/icon.svg")),
            "/webapp/icon-192.png" to ("image/png" to asset("webapp/icon-192.png")),
            "/webapp/shot-canvas.svg" to ("image/svg+xml" to asset("webapp/shot-canvas.svg")),
            "/webapp/shot-colours.svg" to ("image/svg+xml" to asset("webapp/shot-colours.svg")),
            "/webapp/shot-gallery.svg" to ("image/svg+xml" to asset("webapp/shot-gallery.svg"))
        )
        servers = SITES.map { address -> DemoServer(PORT, routes, address = address).also { it.start() } }
        try {
            runDemo()
        } finally {
            if (radiosOff) runCatching { radios(true) }
            servers.forEach { runCatching { it.close() } }
        }
        if (failures > 0) throw AssertionError("$failures band check(s) failed; see band-findings.txt")
    }

    /** Every site's app was visited once, a day ago: the load in the demo is the second visit, and the install prompt is due. */
    override fun seedMore(zen: File) {
        val dayAgo = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        val engagement = JSONObject()
        for (site in SITES) {
            engagement.put(
                "http://$site:$PORT/app/",
                JSONObject()
                    .put("visits", 1)
                    .put("firstVisitAt", dayAgo)
                    .put("lastVisitAt", dayAgo)
                    .put("dismissedAt", JSONObject.NULL)
                    .put("promptedAt", JSONObject.NULL)
            )
        }
        val doc = JSONObject().put("version", 1).put("pinned", JSONArray()).put("engagement", engagement)
        File(zen, "webapps.json").writeText(doc.toString())
    }

    override fun warmUp() {
        findings = File(out, "band-findings.txt")
        findings.writeText("Zenium Android page-edge band checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        for ((i, server) in servers.withIndex()) finding("demo server ${SITES[i]}: ${server.selfCheck()}")
        val state = coreState()
        val caps = state.getJSONObject("capabilities")
        finding("capabilities: phone=${caps.optBoolean("phone")} defaultBrowser=${caps.optBoolean("defaultBrowser")}")
        awaitLoaded("$SITE_A/plain")
        // The default-browser reminder is due in this session: its band is the first on screen.
        val prompt = poll(15_000) { defaultBrowserPrompt() == "banner" }
        finding("the default-browser campaign at the start: prompt=${defaultBrowserPrompt()} (due=$prompt); ${describeTab()}")
        val up = poll(12_000) { bandTitle() == DEFAULT_TITLE }
        finding("the default-browser band at warm-up: up=$up; ${bandProbe()}; page offset ${offsetCss()}")
        val close = closeUrlField()
        finding("URL field at warm-up: ${close.describe()}")
        check("the URL field is closed (or was never open) before the recording", close.ok)
        SystemClock.sleep(1_200)
    }

    override fun demo() {
        try {
            defaultBrowserBand()
            installOffer()
            readerOffer()
            clock()
            sheetWaits()
            replacementAndNewTab()
            pullTakeover()
            stateEnds()
            dark()
            finding("\nend: ${describeTab()}${if (failures == 0) "" else "; $failures FAIL"}")
        } finally {
            if (radiosOff) runCatching { radios(true) }
            framesFinding()
        }
    }

    // --- 1. the default-browser state band ----------------------------------------------------------------

    private fun defaultBrowserBand() {
        finding("\n§3 / §4 the default-browser reminder on the band (state form, two lines)")
        ensureForeground()
        val up = awaitBand(DEFAULT_TITLE, 10_000)
        check("the default-browser band stands on the start page ('$DEFAULT_TITLE')", up)
        if (!up) {
            finding("  no band: the default-browser act cannot be recorded (prompt=${defaultBrowserPrompt()})")
            return
        }
        bandGeometry("the default-browser band", TWO_LINE, "state", DEFAULT_TITLE, DEFAULT_DETAIL, listOf(DEFAULT_ACTION, DEFAULT_SECONDARY))
        snap("design-default-browser-light")
        beat()

        // A short swipe, let go before half the height: the band springs back (§3.2).
        val title = fingerOnText(DEFAULT_TITLE) ?: return
        val before = offsetCss()
        val back = scene("band-swipe-back", JankBudget.Kind.SPRING, took = { bandTitle() == DEFAULT_TITLE && abs(offsetCss() - before) <= TOLERANCE }) {
            Finger().apply {
                down(title.x, title.y)
                moveBy(0f, -NUDGE, 80)
                moveBy(0f, -(before * density) * 0.25f, 220)
                hold(120)
                up()
            }
        }
        val backSamples = sampler.stop()
        finding("  the short swipe: ${describeSamples(backSamples)}")
        check("a swipe up released before half the height springs the band back (the page at $before again)", back)
        if (!back) touchFault("a short swipe on the band did not leave the band standing")
        beat()

        // The swipe that dismisses: the page follows the finger 1:1, let go past half, the band leaves.
        val again = fingerOnText(DEFAULT_TITLE) ?: return
        val height = offsetCss()
        val gone = scene("band-swipe-dismiss", JankBudget.Kind.GESTURE, took = { !bandUp() && offsetCss() <= TOLERANCE }) {
            Finger().apply {
                down(again.x, again.y)
                moveBy(0f, -NUDGE, 80)
                moveBy(0f, -(height * density) * 0.3f, 240)
                hold(200)
                snap("design-swipe-mid-light")
                moveBy(0f, -(height * density) * 0.7f, 200)
                up()
            }
        }
        val samples = sampler.stop()
        finding("  the dismissing swipe: ${describeSamples(samples)}")
        val follow = followedTheFinger(samples, height)
        finding("  1:1 follow: $follow")
        check("a swipe up past half the height dismisses the band and brings the page home", gone)
        if (!gone) touchFault("a swipe up on the band did not take it off")
        check("the page followed the finger down the way (the offset fell through the drag before the release)", follow.ok)
        val prompt = poll(4_000) { defaultBrowserPrompt() == null }
        finding("  the campaign after the swipe: prompt=${defaultBrowserPrompt()}")
        check("the swipe is the campaign's \"Not now\" (the core's prompt cleared, as the banner's swipe did)", prompt)
        snap("default-browser-dismissed")
        beat()
    }

    // --- 2. the install offer -----------------------------------------------------------------------------------

    private fun installOffer() {
        finding("\n§4 the install offer on the band (offer form, two lines; §7's first tenant)")
        armFrameClock()
        sampler.start()
        navigate("$SITE_A/app/")
        val up = awaitBand(INSTALL_TITLE, 12_000)
        SystemClock.sleep(900)
        val samples = sampler.stop()
        val frames = frameClock()
        finding("  the offer's arrival: ${describeSamples(samples)}; chrome frames ${describeFrames(frames)}")
        check("the install offer stands on the app's second visit ('$INSTALL_TITLE')", up)
        if (!up) return
        bandGeometry("the install offer", TWO_LINE, "offer", INSTALL_TITLE, "127.0.0.1:$PORT", listOf(INSTALL_ACTION))
        snap("design-install-offer-light")
        // No beat: the offer is on its clock.
        SystemClock.sleep(400)
        val x = fingerOnButton(DISMISS_LABEL) ?: run {
            check("a finger can reach the band's ×", false)
            return
        }
        val gone = scene("band-close-x", JankBudget.Kind.OPEN, took = { !bandUp() && offsetCss() <= TOLERANCE }) {
            Finger().tap(x)
        }
        finding("  the ×: ${describeSamples(sampler.stop())}")
        check("the × takes the install offer off and brings the page home", gone)
        if (!gone) touchFault("a touch on the band's × did not take it off")
        snap("install-offer-closed")
        // The cooldown: the core heard the refusal; a reload brings no offer.
        coreInvoke("tab.reload", "{\"tabId\":\"$TAB\"}")
        awaitLoaded("$SITE_A/app/")
        val again = poll(4_000) { bandTitle() == INSTALL_TITLE }
        finding("  after the reload: band=${bandTitle()}")
        check("the refusal starts the app's cooldown (no offer on the reload, as the banner's swipe did)", !again)
        beat()
    }

    // --- 3. the reader offer and its action ------------------------------------------------------------------------

    private fun readerOffer() {
        finding("\n§4 the reader offer on the band (offer form, one line) and its action")
        armFrameClock()
        sampler.start()
        navigate("$SITE_A/article")
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        val up = awaitBand(READER_TITLE, 10_000)
        SystemClock.sleep(900)
        val samples = sampler.stop()
        val frames = frameClock()
        finding("  the offer's arrival: readerable=$readerable; ${describeSamples(samples)}; chrome frames ${describeFrames(frames)}")
        check("the reader offer stands on the article ('$READER_TITLE')", up)
        if (!up) return
        bandGeometry("the reader offer", ONE_LINE, "offer", READER_TITLE, null, listOf(READER_ACTION))
        snap("design-reader-offer-light")
        SystemClock.sleep(400)
        val show = fingerOnButton(READER_ACTION) ?: run {
            check("a finger can reach '$READER_ACTION'", false)
            return
        }
        val entered = scene("band-action-show", JankBudget.Kind.OPEN, timeoutMs = 15_000, took = { isReader() && !bandUp() && offsetCss() <= TOLERANCE }) {
            Finger().tap(show)
        }
        finding("  the action: ${describeSamples(sampler.stop())}; ${describeTab()}")
        check("'$READER_ACTION' performs (the reader document up) and the band leaves with the page home", entered)
        if (!entered) touchFault("a touch on $READER_ACTION did not bring the reader document up")
        snap("reader-after-show")
        beat()
    }

    // --- 4. the clock --------------------------------------------------------------------------------------------------

    private fun clock() {
        finding("\n§3.2 the clock: an offer left standing leaves on its own at about $CLOCK_MS ms; the timeout is the reader entry's mute")
        navigate("$SITE_B/article")
        poll(15_000) { tab()?.optBoolean("readerable") == true }
        val shownAt = SystemClock.uptimeMillis()
        val up = awaitBand(READER_TITLE, 10_000, step = 100)
        val appeared = SystemClock.uptimeMillis()
        check("site B: an offer stands to be left alone", up)
        if (!up) return
        // Nothing touches the screen: a finger on the band would pause the clock (§3.2).
        val gone = poll(CLOCK_MS + 8_000, step = 100) { !bandUp() }
        val left = SystemClock.uptimeMillis()
        val life = left - appeared
        finding("  the offer appeared ${appeared - shownAt} ms after the article was read; it stood $life ms (its appearance to its going, the leave motion included)")
        check("site B: the offer left standing leaves on its own", gone)
        check("site B: it stood about ten seconds – within ${CLOCK_MIN_MS / 1000}–${CLOCK_MAX_MS / 1000.0} s (the clock and its leave motion)", life in CLOCK_MIN_MS..CLOCK_MAX_MS)
        check("the page is home once the clock ran out", poll(3_000) { offsetCss() <= TOLERANCE })
        snap("clock-ran-out")
        navigate("$SITE_B/second")
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        val again = poll(4_000) { bandTitle() == READER_TITLE }
        finding("  site B's second article: readerable=$readerable; offer within 4 s=$again")
        check("site B after the clock: another article of the site brings no offer (the timeout is a mute for the session, as today)", readerable && !again)
        beat()
    }

    // --- 5. the sheet waits ----------------------------------------------------------------------------------------------

    private fun sheetWaits() {
        finding("\n§3.2 never while a sheet stands: the band waits, it does not stack")
        tapMenuButton()
        val menu = waitFor(MENU_HANDLE_LABEL, 6_000) != null
        check("the app menu opens under a finger (the sheet the band waits for)", menu)
        if (!menu) {
            touchFault("a touch on the Menu button opened no app menu")
            return
        }
        SystemClock.sleep(800)
        // The article arrives under the sheet, through the core.
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote("$SITE_C/article")}}""")
        awaitLoaded("$SITE_C/article", 20_000)
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        val under = poll(3_000) { bandUp() }
        finding("  under the sheet: readerable=$readerable; band within 3 s=$under; page offset ${offsetCss()}; sheet up=${chromeSurfaceUp()}")
        check("site C: the offer does not show under the standing sheet", readerable && !under && offsetCss() <= TOLERANCE)
        snap("sheet-over-article-no-band")
        back()
        awaitSurface(up = false, timeoutMs = 8_000)
        val after = awaitBand(READER_TITLE, 6_000)
        finding("  the sheet gone: band=${bandTitle()}; page offset ${offsetCss()}")
        check("site C: the sheet gone, the waiting offer comes", after)
        snap("sheet-gone-band-up")
        if (after) {
            val x = fingerOnButton(DISMISS_LABEL)
            if (x != null) {
                Finger().tap(x)
                val gone = poll(4_000) { !bandUp() }
                if (!gone) touchFault("a touch on the band's × did not take it off (site C)")
            }
        }
        beat()
    }

    // --- 6. one at a time, the state over the offer; never on the new tab page -----------------------------------------

    private fun replacementAndNewTab() {
        finding("\n§3.2 one band at a time, state > offer; never on the new tab page")
        navigate("$SITE_D/app/")
        val up = awaitBand(INSTALL_TITLE, 12_000)
        check("site D: the install offer stands to be replaced", up)
        if (!up) return
        val offerHeight = offsetCss()
        finding("  the offer's height: $offerHeight")
        var replaced = false
        scene("band-replace-offline", JankBudget.Kind.OPEN, timeoutMs = 1, took = { true }) {
            radios(false)
            replaced = poll(20_000, step = 100) { bandTitle() == OFFLINE_TITLE }
            SystemClock.sleep(900)
        }
        val samples = sampler.stop()
        val probe = bandProbe()
        finding("  the radios off while the offer stood: replaced=$replaced; ${describeSamples(samples)}; ${probe}")
        check("the offline state replaces the standing offer (the newer prompt, and a state over an offer)", replaced)
        check("one band root in the document through the replacement (never two)", probe.optInt("count") <= 1 && maxRoots <= 1)
        check("the page re-targets from the two-line offer to the one-line state ($offerHeight → $ONE_LINE)", abs(offsetCss() - ONE_LINE) <= TOLERANCE)
        bandGeometry("the offline state", ONE_LINE, "state", OFFLINE_TITLE, null, emptyList())
        snap("design-offline-light")
        beat()

        // Never on the new tab page: the state holds, the band does not show there.
        navigate(NEW_TAB_URL)
        val onNtp = poll(3_000) { bandUp() }
        finding("  on the new tab page: band within 3 s=$onNtp; page offset ${offsetCss()}; ${describeTab()}")
        check("no band on the new tab page, the page home (the offline state holds, unseen)", !onNtp && offsetCss() <= TOLERANCE)
        snap("new-tab-no-band")
        navigate("$SITE_A/plain")
        val returned = awaitBand(OFFLINE_TITLE, 6_000)
        finding("  back on a web page: band=${bandTitle()}; page offset ${offsetCss()}")
        check("back on a web page the state's band returns (a state stands while the state holds)", returned)
        beat()
    }

    // --- 7. a pull on the held page ------------------------------------------------------------------------------------------

    private fun pullTakeover() {
        finding("\n§3.4 Android: a pull while a band stands dismisses the band first – the pull takes the page over where it sits")
        if (!awaitBand(OFFLINE_TITLE, 4_000)) {
            check("the offline band stands for the pull", false)
            return
        }
        val held = offsetCss()
        val pageX = width * 0.5f
        val pageY = height * 0.45f
        val away = scene("band-pull-takeover", JankBudget.Kind.GESTURE, timeoutMs = 6_000, took = { !bandUp() && offsetCss() <= TOLERANCE }) {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, NUDGE, 80)
                moveBy(0f, 200 * density, 600)
                hold(300)
                snap("pull-takeover-finger-down")
                up()
            }
        }
        val samples = sampler.stop()
        val jumped = jumpedHome(samples, held)
        finding("  the pull: ${describeSamples(samples)}; the page's lowest offset before the pull's peak: ${"%.1f".format(jumped.lowestBeforePeak)} (held at $held)")
        check("the band leaves on the pull and the page comes home on the release", away)
        if (!away) touchFault("a pull on the held page did not take the band off, or the page did not come home")
        check("the page never jumped home under the finger: the pull carried on from the band's offset (lowest ${"%.1f".format(jumped.lowestBeforePeak)} ≥ ${held - PULL_SLACK})", jumped.ok)
        val returned = awaitBand(OFFLINE_TITLE, 8_000)
        finding("  after the pull: band=${bandTitle()} (the state holds; its return is reported, not gated); page offset ${offsetCss()}")
        snap("pull-takeover-after")
        beat()
    }

    // --- 8. the state ends ----------------------------------------------------------------------------------------------------

    private fun stateEnds() {
        finding("\n§4 connectivity: the state's band leaves when the state ends")
        val standing = bandTitle() == OFFLINE_TITLE
        finding("  before the radios: band=${bandTitle()}")
        var gone = false
        // The toast comes with the band's leave and goes on its own clock: watched through the
        // same poll, not after it.
        var toast = false
        scene("band-leave-online", JankBudget.Kind.OPEN, timeoutMs = 1, took = { true }) {
            radios(true)
            gone = poll(25_000, step = 100) {
                if (!toast && findNode { it == BACK_ONLINE_TOAST } != null) toast = true
                !bandUp()
            }
            SystemClock.sleep(900)
        }
        finding("  the radios back: band gone=$gone; ${describeSamples(sampler.stop())}; page offset ${offsetCss()}")
        if (standing) check("the offline band leaves when the device is back online, the page home", gone && offsetCss() <= TOLERANCE)
        if (!toast) toast = waitFor(BACK_ONLINE_TOAST, 6_000) != null
        finding("  the toast: '$BACK_ONLINE_TOAST' in the tree=$toast")
        check("'$BACK_ONLINE_TOAST' runs as a toast (the toast seat stays the toast's)", toast)
        snap("back-online")
        beat()
    }

    // --- 9. dark -----------------------------------------------------------------------------------------------------------------

    private fun dark() {
        finding("\ndesign record: the band in dark (site E)")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        val applied = poll(8_000) { activityNight() }
        finding("  Zenium's own Dark reached the app's night mode: $applied")
        shellCommand("cmd uimode night yes")
        SystemClock.sleep(2_500)
        ensureForeground()
        navigate("$SITE_E/app/")
        val install = awaitBand(INSTALL_TITLE, 12_000)
        finding("  dark: the chrome's theme ${chromeTheme()}; install offer=$install")
        check("dark: the chrome is dark under the band", chromeTheme() == "dark")
        if (install) {
            snap("design-install-offer-dark")
            SystemClock.sleep(300)
            closeBand("dark: the install offer")
        }
        navigate("$SITE_E/article")
        poll(15_000) { tab()?.optBoolean("readerable") == true }
        val reader = awaitBand(READER_TITLE, 10_000)
        check("dark: the reader offer stands on site E's article", reader)
        if (reader) {
            snap("design-reader-offer-dark")
            SystemClock.sleep(300)
            closeBand("dark: the reader offer")
        }
        radios(false)
        val offline = awaitBand(OFFLINE_TITLE, 20_000)
        check("dark: the offline state's band stands", offline)
        if (offline) snap("design-offline-dark")
        radios(true)
        poll(25_000) { !bandUp() }
        // Back the same way round: Zenium's Light first, then the system's change.
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        poll(8_000) { !activityNight() }
        shellCommand("cmd uimode night no")
        SystemClock.sleep(1_500)
        finding("  back in light: the chrome's theme ${chromeTheme()}")
    }

    private fun closeBand(where: String) {
        val x = fingerOnButton(DISMISS_LABEL) ?: run {
            check("$where: a finger can reach the band's ×", false)
            return
        }
        Finger().tap(x)
        val gone = poll(4_000) { !bandUp() }
        if (!gone) touchFault("$where: a touch on the band's × did not take it off")
        check("$where: the × takes the band off", gone)
        SystemClock.sleep(400)
    }

    // --- the band as the page shows it ------------------------------------------------------------------------------------------

    /**
     * The band's shape and words: the page translated by its height (the host's `translationY`,
     * CSS px), the title and the actions in the tree, the ×; from the document the form, one root,
     * `role="status"`, the glyph and its place at the frame's top.
     */
    private fun bandGeometry(where: String, bandHeight: Float, form: String, title: String, detail: String?, actions: List<String>) {
        val offset = offsetCss()
        val probe = bandProbe()
        finding("  $where: page offset $offset; $probe")
        check("$where: the page is translated by the band's height ($bandHeight; the host reads $offset)", abs(offset - bandHeight) <= TOLERANCE)
        check("$where: the title '$title' is on screen", findNode { it == title } != null)
        if (detail != null) check("$where: the detail line '$detail' is on screen", findNode { it == detail || it.contains(detail) } != null)
        for (action in actions) check("$where: the action '$action' is a button", findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == action } != null)
        check("$where: the × ('$DISMISS_LABEL') is a button", findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == DISMISS_LABEL } != null)
        // The root's top in the chrome's document (CSS px) sits at or above the touchable window's
        // top edge: the band is at the frame's top, under the status bar, whichever bar position.
        val top = probe.optInt("top", Int.MAX_VALUE).toFloat() * density
        check(
            "$where: one band root, the $form form, role status, the glyph, at the frame's top (root top ${probe.optInt("top", -1)} CSS px; the seam's hooks: $BAND_ROOT)",
            probe.optInt("count") == 1 && probe.optString("form") == form && probe.optString("role") == "status" &&
                probe.optBoolean("glyph") && top <= frameTopPx() + 8 * density
        )
    }

    /** Where the frame's top edge is on screen (px): the touchable window's top, the status bar above it. */
    private fun frameTopPx(): Float = touchable.top.toFloat().coerceAtLeast(0f)

    private fun bandUp(): Boolean = bandTitle().isNotEmpty()

    /** The standing band's title: the tree's word first (any of the four tenants'), the document's second. */
    private fun bandTitle(): String {
        for (title in TITLES) if (findNode { it == title } != null) return title
        return bandProbe().optString("title")
    }

    private fun awaitBand(title: String, timeoutMs: Long, step: Long = 200): Boolean = poll(timeoutMs, step) { bandTitle() == title }

    /** The band's roots seen at once, the most across every probe since the last reset (the one-at-a-time claim). */
    private var maxRoots = 0

    /** The band from the chrome's document ([BAND_PROBE_JS]); `{count:0}` without one. */
    private fun bandProbe(): JSONObject {
        val raw = jsonString(chromeJs(BAND_PROBE_JS))
        val probe = runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
        if (probe.optInt("count") > maxRoots) maxRoots = probe.optInt("count")
        return probe
    }

    private fun chromeTheme(): String = jsonString(chromeJs("(function(){return document.documentElement.getAttribute('data-theme')||''})()"))

    /** The page's translation below the frame's top, CSS px, from the host's view (the one source of truth for where the page is). */
    private fun offsetCss(): Float {
        var offset = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
            if (view != null) offset = view.translationY / density
        }
        return (offset * 10).roundToInt() / 10f
    }

    // --- the host sampler and the chrome's frame clock -------------------------------------------------------------------------------

    /**
     * The page's offset read on the main thread every [SAMPLE_MS] from [start] to [stop]: the
     * motion the host drew, as it drew it. Started by [scene] before its block, stopped by the
     * act after it (the samples run a little past the block, into the settle).
     */
    private inner class OffsetSampler {
        private val handler = Handler(Looper.getMainLooper())
        private val samples = ArrayList<Pair<Long, Float>>()
        private var on = false
        private val tick = object : Runnable {
            override fun run() {
                if (!on) return
                val view = host.tabs.get(TAB)
                samples.add(SystemClock.uptimeMillis() to (view?.translationY ?: 0f) / density)
                handler.postDelayed(this, SAMPLE_MS)
            }
        }

        fun start() {
            instrumentation.runOnMainSync {
                samples.clear()
                on = true
                handler.removeCallbacks(tick)
                handler.post(tick)
            }
        }

        fun stop(): List<Pair<Long, Float>> {
            var out: List<Pair<Long, Float>> = emptyList()
            instrumentation.runOnMainSync {
                on = false
                handler.removeCallbacks(tick)
                out = samples.toList()
            }
            return out
        }
    }

    /**
     * The samples in words: where the page set out and landed, how far it went, how many
     * distinct offsets the host drew, and the longest stretch mid-motion (between the first and
     * the last change) in which it did not move – two frames or more (≥ [STALL_MS]) is the §6
     * defect, reported with its verdict.
     */
    private fun describeSamples(samples: List<Pair<Long, Float>>): String {
        if (samples.size < 2) return "host sampler: ${samples.size} sample(s)"
        val first = samples.first()
        val last = samples.last()
        val values = samples.map { it.second }
        val distinct = values.distinct().size
        val changes = samples.indices.filter { i -> i > 0 && values[i] != values[i - 1] }
        val stall = if (changes.size >= 2) {
            var longest = 0L
            for (k in 1 until changes.size) {
                val gap = samples[changes[k]].first - samples[changes[k - 1]].first
                if (gap > longest) longest = gap
            }
            longest
        } else 0L
        val motionMs = if (changes.isNotEmpty()) samples[changes.last()].first - samples[changes.first()].first else 0L
        return "host sampler: ${samples.size} samples over ${last.first - first.first} ms; offset ${first.second} → ${last.second} (min ${values.minOrNull()}, max ${values.maxOrNull()}); " +
            "$distinct distinct offsets, the page in motion for $motionMs ms; longest stall mid-motion $stall ms – two frames or more (≥ $STALL_MS ms) ${verdict(stall < STALL_MS)} (reported, not asserted: the emulator's GPU)"
    }

    private data class Follow(val ok: Boolean, val words: String)

    /**
     * Under the dismissing swipe the page follows the finger 1:1: before the release the offset
     * fell from the band's height through at least a third of it, in more than one step.
     */
    private fun followedTheFinger(samples: List<Pair<Long, Float>>, height: Float): Follow {
        if (samples.size < 4) return Follow(false, "too few samples")
        val values = samples.map { it.second }
        val start = values.first()
        val lowest = values.minOrNull() ?: start
        val steps = values.indices.count { i -> i > 0 && values[i] < values[i - 1] }
        val ok = start >= height - TOLERANCE && lowest <= height * 0.66f && steps >= 2
        return Follow(ok, "set out at $start, fell to $lowest in $steps downward steps ${verdict(ok)}")
    }

    private data class Jump(val ok: Boolean, val lowestBeforePeak: Float)

    /**
     * Under the pull the page carried on from the band's offset: before its highest offset (the
     * pull's peak) it never sat lower than the held offset less [PULL_SLACK] – a jump home first
     * would read as a dip towards 0.
     */
    private fun jumpedHome(samples: List<Pair<Long, Float>>, held: Float): Jump {
        if (samples.isEmpty()) return Jump(false, 0f)
        val values = samples.map { it.second }
        val peak = values.indices.maxByOrNull { values[it] } ?: 0
        val lowest = values.take(peak + 1).minOrNull() ?: 0f
        return Jump(lowest >= held - PULL_SLACK, lowest)
    }

    /** A `requestAnimationFrame` loop in the chrome's document noting every frame's time, armed before a motion and read after it ([frameClock]). */
    private fun armFrameClock() {
        chromeJs(
            "(function(){var w=window;if(w.__zenBandFrames)w.__zenBandFrames.on=false;var s={t:[],on:true};" +
                "function tick(now){if(!s.on)return;s.t.push(Math.round(now*10)/10);requestAnimationFrame(tick);}" +
                "w.__zenBandFrames=s;requestAnimationFrame(tick);return 'armed'})()"
        )
    }

    /** The frames' times since the clock was armed, then the clock stopped. */
    private fun frameClock(): List<Double> {
        val raw = jsonString(chromeJs("(function(){var s=window.__zenBandFrames;if(!s)return '[]';s.on=false;return JSON.stringify(s.t)})()"))
        return runCatching {
            val a = JSONArray(raw)
            (0 until a.length()).map { a.getDouble(it) }
        }.getOrDefault(emptyList())
    }

    /** The chrome's frame cadence: the frames, the longest gap, how many gaps were two frames or more (§6's "two consecutive misses"). */
    private fun describeFrames(times: List<Double>): String {
        if (times.size < 2) return "${times.size} frame(s)"
        var longest = 0.0
        var misses = 0
        for (i in 1 until times.size) {
            val gap = times[i] - times[i - 1]
            if (gap > longest) longest = gap
            if (gap >= STALL_MS) misses++
        }
        return "${times.size} frames over ${"%.0f".format(times.last() - times.first())} ms; longest gap ${"%.1f".format(longest)} ms; gaps of two frames or more: $misses ${verdict(misses == 0)} (reported, not asserted)"
    }

    // --- the frame record ---------------------------------------------------------------------------------------------------------------

    /**
     * One scene through the harness's one helper ([traceFrames]), the host sampler and the
     * chrome's frame clock running through it: the block is `motion` – the finger, the tap, the
     * radios – and [MOTION_MS] for what it does; `took` is polled AFTER the block for up to
     * `timeoutMs` more (#198's rule, every finger with its assertion, kept out of the frames).
     * The act stops the sampler and reads it; the frame clock's reading goes into the findings
     * here. Answers whether `took` held.
     */
    private fun scene(name: String, kind: JankBudget.Kind, timeoutMs: Long = 6_000, took: () -> Boolean, motion: () -> Unit): Boolean {
        armFrameClock()
        sampler.start()
        traceFrames(name, kind) {
            motion()
            SystemClock.sleep(MOTION_MS)
        }
        val frames = frameClock()
        finding("  $name: chrome frames ${describeFrames(frames)}")
        return poll(timeoutMs, 100, took)
    }

    private fun Finger.tap(at: PointF) = tap(at.x, at.y)

    /** Where a finger lands on the node reading `text` exactly (the band's title: a swipe from the words, not a control). */
    private fun fingerOnText(text: String, timeoutMs: Long = 8_000): PointF? {
        val node = awaitNode(timeoutMs) { it == text } ?: run {
            finding("  nothing on screen reads '$text'")
            check("a finger can reach '$text'", false)
            return null
        }
        return pointOn(node, text)
    }

    /** Where a finger lands on the clickable node reading `label` (an action, the ×); any node reading it when none is clickable. */
    private fun fingerOnButton(label: String, timeoutMs: Long = 8_000): PointF? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var clickable: AccessibilityNodeInfo? = null
        while (clickable == null && SystemClock.uptimeMillis() < deadline) {
            clickable = findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == label }
            if (clickable == null) SystemClock.sleep(200)
        }
        val node = clickable ?: findNode { it == label } ?: run {
            finding("  nothing on screen reads '$label'")
            return null
        }
        return pointOn(node, label)
    }

    private fun pointOn(node: AccessibilityNodeInfo, label: String): PointF? {
        val bounds: Rect = steadyBounds(node) ?: run {
            finding("  '$label' left the tree before the finger")
            return null
        }
        return touchPoint(bounds) ?: run {
            finding("  no part of '$label' ($bounds) is inside the touchable window")
            null
        }
    }

    /**
     * The record's scenes, one line each, into the findings: HWUI's summary and long stage, the
     * trace's reading, the budget's verdict (the tables are the harness's `frames.txt`, the
     * record `frames.jsonl`).
     */
    private fun framesFinding() {
        val scenes = frameScenes
        if (scenes.isEmpty()) {
            finding("\nframes: no scene was measured")
            return
        }
        finding("\nframes (DemoHarness.traceFrames, PERF-3's harness; gate ${jankGate.key}; the emulator's software GPU makes every frame janky by construction: the trace columns, the host sampler's stalls and the chrome's frame gaps above, and the same scenes run to run on this one recipe, are the reading):")
        for (s in scenes) {
            val summary = s.summary
            val hwui = if (summary == null) {
                "not measured (no HWUI summary in the dump)"
            } else {
                "${summary.frames} frames, ${summary.janky} janky, p50 ${summary.p50Ms} p90 ${summary.p90Ms} p95 ${summary.p95Ms} p99 ${summary.p99Ms} ms, long stage ${s.analysis.dominant ?: "-"}"
            }
            val t = s.trace
            val trace = if (t != null && t.found && t.frames > 0) {
                "; renderer: ${t.frames} main-thread frames, layouts ${"%.2f".format(t.layoutCount.toDouble() / t.frames)}/frame, paints ${"%.2f".format(t.paintCount.toDouble() / t.frames)}/frame (§6's line: ≤ $PAINTS_PER_FRAME ${verdict(t.paintCount.toDouble() / t.frames <= PAINTS_PER_FRAME)}, reported), long tasks ${t.longTasks}"
            } else {
                s.traceMissing?.let { "; trace: none read ($it)" } ?: ""
            }
            finding("  ${s.name} (${s.kind.key}, ${s.durationMs} ms): $hwui$trace; ${s.verdict.describe()}")
        }
    }

    // --- the page, the core, the radios -------------------------------------------------------------------------------------------------

    private fun isReader(): Boolean = tab()?.optString("url")?.startsWith("zen://reader") == true

    private fun defaultBrowserPrompt(): String? {
        val status = coreState().optJSONObject("defaultBrowser") ?: return null
        return if (status.isNull("prompt")) null else status.optString("prompt")
    }

    private fun radios(on: Boolean) {
        val verb = if (on) "enable" else "disable"
        shellCommand("svc wifi $verb")
        shellCommand("svc data $verb")
        radiosOff = !on
    }

    /** The activity's night bit, read on the main thread: Zenium's scheme as AppCompat applied it. */
    private fun activityNight(): Boolean {
        var night = false
        instrumentation.runOnMainSync {
            night = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        }
        return night
    }

    private fun asset(name: String): ByteArray = instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    private fun tab(): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(TAB)

    private fun describeTab(): String {
        val tab = tab() ?: return "tab $TAB gone"
        return "url=${tab.optString("url").take(60)} title=\"${tab.optString("title").take(40)}\" readerable=${tab.optBoolean("readerable")} loading=${tab.optBoolean("loading")}"
    }

    private fun navigate(url: String) {
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote(url)}}""")
        awaitLoaded(url)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = tab()
            if (tab != null && tab.optString("url").trimEnd('/') == url.trimEnd('/') && !tab.optBoolean("loading")) {
                SystemClock.sleep(800)
                return
            }
            SystemClock.sleep(400)
        }
        finding("  $url never finished loading: ${describeTab()}")
    }

    // --- findings ------------------------------------------------------------------------------------------------------------------------

    private fun snap(name: String) = shot("%02d-%s".format(++shots, name))

    private fun poll(timeoutMs: Long, step: Long = 200, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(step)
        }
        return condition()
    }

    private fun verdict(ok: Boolean): String = if (ok) "PASS" else "FAIL"

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  ${verdict(ok)}: $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18157
        /** Five loopback addresses, five sites to the reader entry's memory and the install prompt's records, one port. */
        private val SITES = listOf("127.0.0.1", "127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5")
        private const val SITE_A = "http://127.0.0.1:$PORT"
        private const val SITE_B = "http://127.0.0.2:$PORT"
        private const val SITE_C = "http://127.0.0.3:$PORT"
        private const val SITE_D = "http://127.0.0.4:$PORT"
        private const val SITE_E = "http://127.0.0.5:$PORT"
        private const val TAB = "tab_demo"
        private const val NEW_TAB_URL = "zen://newtab"
        private const val HTML = "text/html; charset=utf-8"
        /** The stills' and the frame files' prefix (the harness's `shotPrefix`). */
        private const val MEDIA_PREFIX = "android-band"

        /** The band's heights (spec §3.1): one line, two lines; CSS px. */
        private const val ONE_LINE = 56f
        private const val TWO_LINE = 76f
        /** How far the host's reading may sit from the band's height (a device-pixel rounding). */
        private const val TOLERANCE = 3f
        /** Under a pull on a held page the page may sit this much below the held offset (the classifier's slop) without having jumped. */
        private const val PULL_SLACK = 8f
        /** The offer's clock (`BAND_CLOCK_MS`, spec §3.2) and the window its life is read against (the leave motion after it). */
        private const val CLOCK_MS = 10_000L
        private const val CLOCK_MIN_MS = 9_000L
        private const val CLOCK_MAX_MS = 13_000L
        /** What a measured scene's block gives the motion after the finger: `SPRING_GENTLE`'s travel and the content's fade, with room. */
        private const val MOTION_MS = 900L
        /** The host sampler's step. */
        private const val SAMPLE_MS = 8L
        /** Two frames at 60 Hz, with half a frame's slack: a stall or a gap this long is "two consecutive misses" (§6). */
        private const val STALL_MS = 40.0
        /** §11's provisional paints-per-frame line that §6 cites. */
        private const val PAINTS_PER_FRAME = 2.0

        /** The tenants' words, 1:1 today's (`PhoneShell.tsx`, `lib/installBanner.ts`, `lib/readerEntry.ts`, `lib/connectivityMessages.ts`). */
        private const val DEFAULT_TITLE = "Open links in Zenium"
        private const val DEFAULT_DETAIL = "Make it your default browser"
        private const val DEFAULT_ACTION = "Set as default"
        private const val DEFAULT_SECONDARY = "Not now"
        private const val INSTALL_TITLE = "Add Sketch Studio to Home screen"
        private const val INSTALL_ACTION = "Add"
        private const val READER_TITLE = "Show Reader View?"
        private const val READER_ACTION = "Show"
        private const val OFFLINE_TITLE = "No internet connection"
        private const val BACK_ONLINE_TOAST = "Back online"
        /** The band's × (its `aria-label`, the banner card's word kept). */
        private const val DISMISS_LABEL = "Dismiss"
        private val TITLES = listOf(DEFAULT_TITLE, INSTALL_TITLE, READER_TITLE, OFFLINE_TITLE)

        /**
         * THE SEAM'S HOOKS, in one place: the band's root (`data-zen-band`, with `data-form`
         * `offer` | `state`), its title, detail, actions, glyph and × – what the shared content
         * component (Desktop's W8-M2) names them. The probe answers `{count:0}` without a root.
         */
        private const val BAND_ROOT = "[data-zen-band]"
        private const val BAND_PROBE_JS =
            "(function(){var b=document.querySelectorAll('$BAND_ROOT');var f=b[0];if(!f)return JSON.stringify({count:0});" +
                "var r=f.getBoundingClientRect();var t=f.querySelector('.zen-band-title');var d=f.querySelector('.zen-band-detail');" +
                "var a=Array.prototype.map.call(f.querySelectorAll('.zen-band-action'),function(x){return (x.textContent||'').trim()});" +
                "return JSON.stringify({count:b.length,form:f.getAttribute('data-form')||'',key:f.getAttribute('data-band-key')||''," +
                "title:t?(t.textContent||'').trim():'',detail:d?(d.textContent||'').trim():'',actions:a,glyph:!!f.querySelector('.zen-band-glyph')," +
                "close:!!f.querySelector('.zen-band-close'),role:f.getAttribute('role'),top:Math.round(r.top),left:Math.round(r.left)," +
                "width:Math.round(r.width),height:Math.round(r.height),theme:document.documentElement.getAttribute('data-theme')})})()"

        /** A short page, no article, no manifest: the start page and the page the states stand on. */
        private const val PLAIN_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<title>Harbour notices</title><style>body{margin:0;padding:24px 20px;font:17px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff}" +
            "@media (prefers-color-scheme: dark){body{color:#e6e6e6;background:#121212}}</style></head>" +
            "<body><h1>Harbour notices</h1><p>The harbour office is closed on Sunday.</p></body></html>"

        /** The PWA demo's Sketch Studio: a page with a manifest (PwaDemo's words, so the install sheet is the same app's). */
        private val APP_PAGE = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <title>Sketch Studio</title>
            <link rel=manifest href="/app/manifest.webmanifest">
            <meta name=theme-color content="#2f6f8f">
            <style>body{margin:0;font-family:sans-serif;color:#15141a;background:#e8f1f5}
            h1{font-size:28px;padding:40px 24px 8px}p{padding:0 24px;font-size:20px;line-height:1.4}
            .canvas{margin:24px;height:38vh;border-radius:16px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.12)}</style></head>
            <body><h1>Sketch Studio</h1><p>Draw, ink and colour on an endless canvas. This page declares a web app manifest.</p>
            <div class=canvas></div></body></html>
        """.trimIndent()

        private val MANIFEST = """
            {
              "id": "/app/",
              "name": "Sketch Studio",
              "short_name": "Sketch",
              "description": "Draw, ink and colour on an endless canvas. Sketches sync between your devices and open offline.",
              "start_url": "/app/",
              "scope": "/app/",
              "display": "standalone",
              "theme_color": "#2f6f8f",
              "background_color": "#e8f1f5",
              "icons": [
                { "src": "/webapp/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
                { "src": "/webapp/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" }
              ],
              "screenshots": [
                { "src": "/webapp/shot-canvas.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "An ink sketch on the canvas" },
                { "src": "/webapp/shot-colours.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The colour palette" },
                { "src": "/webapp/shot-gallery.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The sketch gallery" }
              ]
            }
        """.trimIndent()
    }
}
