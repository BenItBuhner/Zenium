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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
 *  1. THE DEFAULT-BROWSER STATE (a two-line band, 76): the title, its detail, "Set as default"
 *     and the × named "Dismiss" (the Design Lead's ruling on #735: every band's × is "Dismiss";
 *     §4's second, dismissing action is that ×, the shared model carrying one action per band),
 *     `role="status"`, at the frame's top; the page translated by the
 *     band's height (the host's own word: the page WebView's `translationY`); a short swipe up
 *     released before half the height springs the band back (`band-swipe-back`); the SYSTEM
 *     BACK is the band's Escape (spec §9 item 6; `band-back-escape`): the host hears the band
 *     as a surface, the Back takes it and the page home UNANSWERED – the page not navigated, the
 *     campaign's prompt as it was (no refusal given; a remembered refusal is only ever the ×).
 *  2. THE INSTALL OFFER (76; the first tenant, §7): "Add Sketch to Home screen" (the manifest's
 *     `short_name`, as the core names an app for the Home screen) with the app's origin, one
 *     "Add", the ×; a swipe past half dismisses it (`band-swipe-dismiss`), the
 *     page following the finger 1:1 on the way (the host's offset sampled under the drag) –
 *     unanswered: the app's record takes no `dismissedAt` (site A); the × (`band-close-x`,
 *     site B) is the refusal: the record's `dismissedAt`, the cooldown, a reload brings no offer.
 *  3. THE READER OFFER (56): "Show Reader View?" with one "Show"; the action (`band-action-show`)
 *     runs the reader crossing, the band gone with it.
 *  4. THE CLOCK: an offer left standing leaves on its own at about `BAND_CLOCK_MS` (10 s); the
 *     timeout is a refusal the reader entry remembers for the site, as today.
 *  5. THE SHEET WAITS: an offer that arises while the app menu stands does not show under it;
 *     the sheet gone, the band comes; a swipe up on the reader offer is no refusal – another
 *     article of the site brings the offer again (the × and the clock still mute the site).
 *  6. ONE AT A TIME, STATE OVER OFFER: the radios off while the install offer stands – the
 *     offline state replaces it (`band-replace-offline`): one band root, the title changed, the
 *     page re-targeted 76 → 56 on the spring.
 *  6b. THE CHROME-DRAWN PAGES (the Design Lead's (B) on #735's question (8), its owed
 *     follow-up): the state's band follows the front onto `zen://settings` (a chrome page typed
 *     opens its own tab, the demo tab its opener; closed after) and onto the phone's new tab
 *     page – pages the chrome draws, with no WebView under them – standing on the
 *     shared `PageBandLayer` (#740) under the desktop seam's contract (depart translates, rest
 *     seats): AT REST one layer SEATED – its box inset by the band's height, no transform – so
 *     the page starts where the band ends and Settings scrolls to its last row above the
 *     frame's bottom (the Lead's check on #758); THROUGH A TRAVEL the layer translated at seat
 *     0 (read under the finger mid-swipe); the host's WebView unmoved throughout; a swipe up on
 *     the new tab page puts the band away (`band-swipe-new-tab`, the layer under the finger);
 *     the radios cycled bring the state back there, seated again, and on a web page after it the
 *     WebView takes the offset again – seated at rest. (Until this layer stood, this scene pinned
 *     the band WAITING on the new tab page.)
 *  6c. THE WEBVIEW SEATS (the Lead's rule on #758 extended to documents, W6-S28-c): on a LONG
 *     web page (`/long`) with the offline state's band standing, at rest the WebView is seated
 *     (translationY 0, height the frame less the band) and the page scrolls to its last line
 *     above the bottom edge – the host lays the view out at top = seat, height = frame − seat
 *     (`TabHost.setBandSeat`, the seat channel beside the pull channel) and translates the
 *     offset less the seat (`PageSeat.kt`); the still `design-web-page-seated-light`; mid-swipe
 *     the view is TRANSLATED at seat 0 (`band-swipe-web-page`, a short swipe released before
 *     half), and seated again at the rest. The page's displacement this driver reads everywhere
 *     ([offsetCss]) is seat + translation: the one picture, whichever carries it.
 *  7. A PULL ON A HELD PAGE (§3.4 Android): a pull-to-refresh begun while the band stands takes
 *     the page over where it sits – the band leaves, the page never jumps home first
 *     (`band-pull-takeover`, the host's offset sampled through the drag), the pull comes home
 *     on the release; the state returns after.
 *  7b. THE BAR UNDER A STANDING BAND: with the state's band holding the page, one finger on
 *     Menu opens the app menu and one on the pill opens the URL field – the page's clipped strip
 *     over the bottom-docked bar is the chrome's (`StripTouchRule`; the readers' run on #735
 *     found the Menu dead under the reader offer), and the band stands through both covers.
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
 * driver reads the band through the accessibility tree (its words, its buttons), the host (the
 * page's translation) and the shared MODEL (`window.__zenStores.band`: the shown entry's form,
 * key, title and action), and through the document only for its root (how many stand, the role,
 * the glyph, where it sits) – that one selector stands in [BAND_PROBE_JS] and is the one place
 * to change if the component names its root otherwise; the chrome-drawn page's layer is read
 * the same way, by its one mark ([LAYER_PROBE_JS]). Every control pressed is a real injected
 * finger with an assertion (#198's rule). See [DemoHarness] for the plumbing.
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
            "/long" to (HTML to LONG_PAGE.toByteArray()),
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
        // The default-browser campaign only speaks while another browser holds the role: the
        // workflow's wrapper (android-band-demo.sh) enables Chrome and hands it the role, as the
        // first-run demo's does; with Zenium the only browser, Android gives it the role unasked.
        val roleHolder = runCatching { shellCommand("cmd role get-role-holders --user 0 android.app.role.BROWSER").trim() }.getOrDefault("?")
        finding("capabilities: defaultBrowser=${caps.optBoolean("defaultBrowser")}; the browser role's holder: '${roleHolder.ifEmpty { "nobody" }}'")
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
            replacement()
            chromePages()
            webPageSeats()
            pullTakeover()
            barUnderBand()
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
        // §4's table gives this band a dismissing action: it is the band's ×, named "Dismiss" like
        // every band's (the Design Lead's ruling on #735 – no tenant names its own; the shared
        // model carries one action per band). The campaign's only remembered refusal is that
        // button (spec §9 item 6).
        bandGeometry("the default-browser band", TWO_LINE, "state", DEFAULT_TITLE, DEFAULT_DETAIL, listOf(DEFAULT_ACTION))
        finding("  a button of the tenant's own name on this band (none expected: the × is '$DISMISS_LABEL'): ${findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == "Not now" } != null} (reported)")
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

        // §9 item 6: the system Back is the band's Escape – it puts the band away UNANSWERED. The
        // host hears the band as a surface a back would dismiss (`back.update`), the Back takes the
        // band and the page home, the page is not navigated, and the campaign stands as it was: no
        // refusal was given (a remembered refusal is only ever an explicit button – the ×).
        val surface = chromeSurfaceUp()
        finding("  the host's word with the band standing: chrome surface up=$surface")
        check("the host hears the standing band as a surface a back would dismiss (the band is the chrome's topmost back surface)", surface)
        val urlBefore = tab()?.optString("url") ?: ""
        val promptBefore = defaultBrowserPrompt()
        val away = scene("band-back-escape", JankBudget.Kind.SPRING, took = { !bandUp() && offsetCss() <= TOLERANCE }) {
            back()
        }
        val awaySamples = sampler.stop()
        finding("  the Back: ${describeSamples(awaySamples)}; ${describeTab()}")
        check("the system Back puts the band away and brings the page home (§9 item 6: Back is the band's Escape)", away)
        SystemClock.sleep(1_500)
        val promptAfter = defaultBrowserPrompt()
        finding("  the campaign after the Back: prompt=$promptAfter (before: $promptBefore)")
        check("the Back is no refusal: the campaign's prompt stands as it was (no dismissal recorded, no cooldown started)", promptAfter == "banner")
        check("the Back did not navigate the page (the band took it; a second Back would)", (tab()?.optString("url") ?: "") == urlBefore)
        check("the band gone, the chrome has no surface left for a back", awaitSurface(up = false, timeoutMs = 4_000))
        snap("default-browser-after-back")
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

        // The swipe that dismisses: the page follows the finger 1:1, let go past half, the band
        // leaves – UNANSWERED (§9 item 6): the core hears the band go as for the clock, and the
        // app's record takes no `dismissedAt` (a card's swipe started the 14-day cooldown).
        val title = fingerOnText(INSTALL_TITLE) ?: return
        val height = offsetCss()
        val gone = scene("band-swipe-dismiss", JankBudget.Kind.GESTURE, took = { !bandUp() && offsetCss() <= TOLERANCE }) {
            Finger().apply {
                down(title.x, title.y)
                moveBy(0f, -NUDGE, 80)
                moveBy(0f, -(height * density) * 0.3f, 240)
                hold(200)
                snap("design-swipe-mid-light")
                moveBy(0f, -(height * density) * 0.7f, 200)
                up()
            }
        }
        val swipeSamples = sampler.stop()
        finding("  the dismissing swipe: ${describeSamples(swipeSamples)}")
        val follow = followedTheFinger(swipeSamples, height)
        finding("  1:1 follow: $follow")
        check("a swipe up past half the height dismisses the band and brings the page home", gone)
        if (!gone) touchFault("a swipe up on the band did not take it off")
        check("the page followed the finger down the way (the offset fell through the drag before the release)", follow.ok)
        val swiped = poll(5_000) { engagement(SITE_A)?.isNull("promptedAt") == false }
        val recordA = engagement(SITE_A)
        finding("  site A's app record after the swipe: $recordA (written=$swiped)")
        check("the swipe is no refusal: the app's record has no dismissedAt (no cooldown), only the prompt's time – an ignored prompt (§9 item 6)", swiped && recordA?.isNull("dismissedAt") == true)
        snap("install-offer-swiped")
        beat()

        // The ×: the explicit refusal – the core hears it, the cooldown starts, a reload brings no offer.
        navigate("$SITE_B/app/")
        val second = awaitBand(INSTALL_TITLE, 12_000)
        check("site B: the install offer stands on the app's second visit, to be refused", second)
        if (!second) return
        SystemClock.sleep(400)
        val x = fingerOnButton(DISMISS_LABEL) ?: run {
            check("a finger can reach the band's ×", false)
            return
        }
        val closed = scene("band-close-x", JankBudget.Kind.OPEN, took = { !bandUp() && offsetCss() <= TOLERANCE }) {
            Finger().tap(x)
        }
        finding("  the ×: ${describeSamples(sampler.stop())}")
        check("the × takes the install offer off and brings the page home", closed)
        if (!closed) touchFault("a touch on the band's × did not take it off")
        snap("install-offer-closed")
        // The cooldown: the core heard the refusal; a reload brings no offer.
        val refused = poll(5_000) { engagement(SITE_B)?.isNull("dismissedAt") == false }
        finding("  site B's app record after the ×: ${engagement(SITE_B)} (written=$refused)")
        check("the × is the refusal: the app's record takes its dismissedAt (the cooldown, as the card's swipe and × did)", refused)
        coreInvoke("tab.reload", "{\"tabId\":\"$TAB\"}")
        awaitLoaded("$SITE_B/app/")
        val again = poll(4_000) { bandTitle() == INSTALL_TITLE }
        finding("  after the reload: band=${bandTitle()}")
        check("the refusal starts the app's cooldown (no offer on the reload)", !again)
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
            // §9 item 6 on the reader offer: a swipe up puts it away UNANSWERED – the site is NOT
            // muted (Chrome's card muted on its swipe; the × and the clock still do), so another
            // article of the site brings the offer again.
            val title = fingerOnText(READER_TITLE)
            if (title != null) {
                val h = offsetCss()
                Finger().apply {
                    down(title.x, title.y)
                    moveBy(0f, -NUDGE, 80)
                    moveBy(0f, -(h * density) * 1.25f, 300)
                    up()
                }
                val gone = poll(4_000) { !bandUp() }
                if (!gone) touchFault("a swipe up on the reader band did not take it off (site C)")
                check("site C: a swipe up takes the reader offer off", gone)
                navigate("$SITE_C/second")
                val secondReaderable = poll(15_000) { tab()?.optBoolean("readerable") == true }
                val again = awaitBand(READER_TITLE, 6_000)
                finding("  site C's second article after the swipe: readerable=$secondReaderable; offer within 6 s=$again")
                check("site C: the swipe was no refusal – another article of the site brings the offer again (§9 item 6: the site is not muted)", secondReaderable && again)
                if (again) closeBand("site C: the second offer")
            }
        }
        beat()
    }

    // --- 6. one at a time, the state over the offer -------------------------------------------------------------------------

    private fun replacement() {
        finding("\n§3.2 one band at a time, state > offer")
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
    }

    // --- 6b. the band over the chrome-drawn pages: Settings and the new tab page ----------------------------------------

    /**
     * The Design Lead's (B) ruling on #735's gate question (8), its owed follow-up: a state's
     * band stands on Settings and on the phone's new tab page too. Neither has a page WebView
     * under it – the chrome draws them – so the host's `translationY` reads 0 there and the pull
     * channel would move nothing; the page rides the shared `PageBandLayer` (Desktop's #740)
     * from the one frame writer (`lib/band/androidHost.ts`: the layer's stores for these
     * surfaces, the pull channel for a document) under the desktop seam's contract: a travel
     * TRANSLATES the layer (seat 0, the frames the offset), the REST SEATS it (the seat the
     * band's height, the offset the seat: the box inset, no transform), so a long chrome page
     * scrolls to its last row above the frame's bottom – the Lead's check on #758 – where the
     * WebView under the pull channel stays translated at rest (§3.4 Android, #734/#735). The band
     * is the same component in the same place, and a swipe up puts it away as on a web page.
     * Read through [LAYER_PROBE_JS] (the layer's transform, its seat and where its page starts)
     * beside the host; the scroll through [SETTINGS_SCROLL_JS].
     */
    private fun chromePages() {
        finding("\n§3.4 Android, §10: the band stands on the chrome-drawn pages – Settings and the new tab page")
        if (!awaitBand(OFFLINE_TITLE, 4_000)) {
            check("the offline band stands to follow the tab onto the chrome-drawn pages", false)
            return
        }
        // Settings: a chrome page typed into the bar opens (or reuses) ITS OWN tab with this one
        // as opener (`submitUrlbar`), so the band follows the FRONT onto the page the chrome
        // draws – the demo tab's WebView goes home behind it – and the layer takes the offset.
        armFrameClock()
        sampler.start()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote(SETTINGS_URL)}}""")
        val settingsTab = poll(10_000) { activeCoreTab()?.optString("url")?.startsWith(SETTINGS_URL) == true }
        val settingsId = activeCoreTab()?.optString("id") ?: ""
        val onSettings = settingsTab && awaitBand(OFFLINE_TITLE, 6_000)
        SystemClock.sleep(900)
        val crossing = sampler.stop()
        finding("  Settings: in front=$settingsTab (tab $settingsId); band=${bandTitle()}; the demo tab behind it: ${describeTab()}; its WebView through the crossing: ${describeSamples(crossing)}; chrome frames ${describeFrames(frameClock())}")
        check("the offline state's band stands on Settings (a chrome-drawn page is a page the band stands on)", onSettings)
        if (onSettings) {
            layerGeometry("Settings", ONE_LINE)
            check("Settings: the page under the layer is the chrome's page host", layerProbe().optBoolean("host"))
            snap("design-settings-offline-light")
            settingsScrollsToItsLastRow()
        }
        beat()
        // Settings' tab closed, the demo tab is the front again (its opener).
        if (settingsId.isNotEmpty() && settingsId != TAB) coreInvoke("tab.close", """{"tabId":"$settingsId","force":true}""")
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        val demoFront = poll(8_000) { activeCoreTab()?.optString("id") == TAB }
        finding("  Settings closed: the demo tab in front=$demoFront; ${describeTab()}")
        check("Settings' own tab closed, the demo tab is the front again", demoFront)
        if (!demoFront) return

        // The new tab page: `zen://newtab` typed on the phone lands on the empty tab the chrome
        // draws the page over (`zen://blank`); the band stands there, the page pushed down under it.
        navigate(NEW_TAB_URL, landsOn = PHONE_NEW_TAB)
        val onNtp = awaitBand(OFFLINE_TITLE, 6_000)
        finding("  the new tab page: band=${bandTitle()}; ${describeTab()}")
        check("the offline state's band stands on the new tab page (the (B) ruling: the band's tenant lands there, no longer waiting for a web page)", onNtp)
        if (!onNtp) return
        layerGeometry("the new tab page", ONE_LINE)
        snap("design-new-tab-offline-light")
        beat()

        // The swipe up: the band leaves and the layer comes home with the page – the state put
        // away by hand (it returns on the next flip, as on a web page). Under the finger the
        // layer is in TRAVEL: translated at seat 0 (the seat read at the rest above is let go
        // at the drag's first frame, so the page keeps covering the frame on its way).
        val title = fingerOnText(OFFLINE_TITLE) ?: return
        var midShift = -1f
        var midSeat = -1
        var midLayers = 0
        val gone = scene("band-swipe-new-tab", JankBudget.Kind.GESTURE, took = { !bandUp() && layerHome() }) {
            Finger().apply {
                down(title.x, title.y)
                moveBy(0f, -NUDGE, 80)
                moveBy(0f, -(ONE_LINE * density) * 0.3f, 240)
                hold(200)
                val mid = layerProbe()
                midShift = mid.optDouble("shift", -1.0).toFloat()
                midSeat = mid.optInt("seat", -1)
                midLayers = mid.optInt("layers")
                snap("new-tab-swipe-mid")
                moveBy(0f, -(ONE_LINE * density) * 0.7f, 200)
                up()
            }
        }
        finding("  the swipe on the new tab page: ${describeSamples(sampler.stop())}; the layer under the finger mid-swipe: shift $midShift, seat $midSeat; after: ${layerProbe()}")
        check("a swipe up past half puts the band away on the new tab page, the layer home (shift ${layerShift()}, seat ${layerProbe().optInt("seat", -1)})", gone)
        if (!gone) touchFault("a swipe up on the band over the new tab page did not take it off")
        check("the page followed the finger: the layer's shift fell under the drag ($midShift, from $ONE_LINE) while the host's WebView never moved (${offsetCss()})", midShift >= 0f && midShift < ONE_LINE - 1f && offsetCss() <= TOLERANCE)
        check(
            "the travel reading: mid-swipe the one layer is TRANSLATED at seat 0 (shift $midShift of $ONE_LINE, seat $midSeat) – depart translates, rest seats",
            midLayers == 1 && midSeat == 0 && midShift > TOLERANCE && midShift < ONE_LINE - 1f
        )
        snap("new-tab-band-swiped")
        beat()

        // The state returns on the next loss (online, then offline again) – here while the new
        // tab page is in front, so the return lands on the layer; then a web page, where §7's
        // pull and the bar find the state standing on the WebView again.
        radios(true)
        val toast = poll(15_000, step = 100) { findNode { it == BACK_ONLINE_TOAST } != null }
        finding("  the radios back after the swipe: '$BACK_ONLINE_TOAST' seen=$toast")
        SystemClock.sleep(1_500)
        radios(false)
        val returned = awaitBand(OFFLINE_TITLE, 20_000)
        SystemClock.sleep(900)
        val back = layerProbe()
        finding("  the radios off again on the new tab page: band=${bandTitle()}; $back")
        check(
            "the state's return lands on the new tab page too, the layer taking it – seated again at rest (seat ${back.optInt("seat", -1)}, shift ${back.optDouble("shift", -1.0)})",
            returned && layerSeatedAt(back, ONE_LINE)
        )
        navigate("$SITE_A/plain")
        val onWeb = awaitBand(OFFLINE_TITLE, 6_000)
        SystemClock.sleep(900)
        val web = viewGeometry()
        finding("  back on a web page: band=${bandTitle()}; host offset ${offsetCss()}; $web; ${layerProbe()}")
        check("back on a web page the state's band holds and the host's WebView takes the offset again (the layer gone with the chrome's page)", onWeb && abs(offsetCss() - ONE_LINE) <= TOLERANCE && layerProbe().optInt("layers") == 0)
        check("back on a web page the WebView arriving under the resting band is SEATED (seat ${web.seatPx} px = ${ONE_LINE.roundToInt()} CSS, translationY ${web.translationY}), as the layer was", onWeb && web.seatedAt(ONE_LINE))
        beat()
    }

    // --- 6c. the WebView seats under a standing band ----------------------------------------------------------------------

    /**
     * The Lead's rule on #758, extended to documents (W6-S28-c): the WebView under a standing
     * band SEATS at rest as the chrome pages' layer does – `TabHost.place` lays it out at
     * top = seat, height = frame − seat (`BarHidePlacement.of`'s `seatPx`), and `TabWebView`
     * translates the pull channel's offset less the seat (`PageSeat.kt`): translationY 0 at the
     * rest, the view's bottom at its frame's bottom, so a long page scrolls to its last line
     * above the frame's bottom edge instead of leaving it under the band. Translated at rest
     * instead (#734/#735's picture), the view kept the frame's full height and its last band of
     * content stood under the frame's bottom, unreachable by any scroll. Read off the host's view
     * on the main thread ([viewGeometry]: translationY, top, height, the seat, the chrome's
     * reported frame) and off the page ([LONG_PAGE_SCROLL_JS]: scrolled to its end, where its
     * last line sits against the frame's bottom in the page's own viewport). Mid-swipe the view
     * is TRANSLATED at seat 0 – a finger's drag unseats at its first frame below the seat, the
     * band's host writing seat 0 ahead of the offset – and seated again at the rest.
     */
    private fun webPageSeats() {
        finding("\nthe WebView seats under a standing band (the Lead's rule on #758, for documents): a long web page under the offline state")
        armFrameClock()
        sampler.start()
        navigate("$SITE_A/long")
        val up = awaitBand(OFFLINE_TITLE, 6_000)
        SystemClock.sleep(900)
        val arrival = sampler.stop()
        finding("  the long page under the band: band=${bandTitle()}; ${describeTab()}; the WebView through the navigation: ${describeSamples(arrival)}; chrome frames ${describeFrames(frameClock())}")
        check("the offline state's band stands on the long web page", up)
        if (!up) return
        val rest = viewGeometry()
        val band = bandProbe()
        val layer = layerProbe()
        val bandBottomPx = layer.optDouble("bandBottom", -1e6) * density
        finding("  at rest: $rest; band root top ${band.optInt("top", -1)} height ${band.optInt("height", -1)} CSS (bottom ${layer.optInt("bandBottom", -1)} CSS = ${"%.1f".format(bandBottomPx)} px); page offset ${offsetCss()}")
        val frame = rest.frame
        check(
            "the seated WebView's laid-out height is the frame's less the band's (${rest.height} px against ${frame?.height() ?: -1} − ${rest.seatPx}; ± 1 px)",
            frame != null && abs(rest.height - (frame.height() - rest.seatPx)) <= 1
        )
        check(
            "the seated WebView's top is the band's bottom (${rest.top} px against the band's ${"%.1f".format(bandBottomPx)} px and the frame's ${frame?.top ?: -1} + seat ${rest.seatPx}; ± 1.5 px: the frame's top is truncated to a device px and the seat rounded to one)",
            frame != null && abs(rest.top - bandBottomPx) <= 1.5f && rest.top == frame.top + rest.seatPx
        )
        check("the seat is the band's height (${rest.seatPx} px = ${ONE_LINE.roundToInt()} CSS × $density, ± 1 px)", abs(rest.seatPx - ONE_LINE * density) <= 1f)
        // The page scrolled to its end (instant), its last line read against the frame's bottom
        // edge in the page's own viewport: the frame's bottom is the view's bottom once seated.
        longPageScroll()
        SystemClock.sleep(400)
        val scrolled = longPageScroll()
        val after = viewGeometry()
        val frameBottomInPage = if (frame != null) (frame.bottom - (after.top + after.translationY)) / density else -1f
        val lastBottom = scrolled.optDouble("lastBottom", 1e6)
        finding("  scrolled to its end: $scrolled; the frame's bottom edge in the page's viewport ${"%.1f".format(frameBottomInPage)} CSS; the view after the scroll: $after")
        check(
            "at rest the WebView is seated (translationY 0, height the frame less the band) and the page scrolls to its last line above the bottom edge " +
                "(translationY ${rest.translationY} px, height ${rest.height} of frame ${frame?.height() ?: -1} less seat ${rest.seatPx}; " +
                "the last line '${scrolled.optString("lastText")}' bottom $lastBottom CSS against the frame's bottom edge ${"%.1f".format(frameBottomInPage)} CSS in the page's viewport; " +
                "scrollTop ${scrolled.optInt("scrollTop")} of ${scrolled.optInt("scrollHeight")} in ${scrolled.optInt("innerHeight")})",
            frame != null && abs(rest.translationY) <= 1f && abs(rest.height - (frame.height() - rest.seatPx)) <= 1 &&
                scrolled.optBoolean("overflows") && scrolled.optBoolean("atBottom") && frameBottomInPage > 0f && lastBottom <= frameBottomInPage - 1f
        )
        snap("design-web-page-seated-light")
        beat()

        // A short swipe up on the band, held mid-way: the view TRANSLATED at seat 0 – the drag's
        // first frame below the seat unseats it (seat 0 written ahead of that frame's offset), so
        // the page keeps covering the frame on its way; released before half, the band springs
        // back and the rest seats the view again.
        val title = fingerOnText(OFFLINE_TITLE) ?: return
        var mid = viewGeometry()
        val back = scene("band-swipe-web-page", JankBudget.Kind.SPRING, took = { bandTitle() == OFFLINE_TITLE && viewGeometry().seatedAt(ONE_LINE) }) {
            Finger().apply {
                down(title.x, title.y)
                moveBy(0f, -NUDGE, 80)
                moveBy(0f, -(ONE_LINE * density) * 0.3f, 240)
                hold(200)
                mid = viewGeometry()
                snap("web-page-swipe-mid")
                hold(120)
                up()
            }
        }
        val swipe = sampler.stop()
        val settled = viewGeometry()
        finding("  the short swipe on the long page: ${describeSamples(swipe)}; under the finger mid-swipe: $mid; at rest after: $settled")
        check(
            "the travel reading: mid-swipe the WebView is TRANSLATED at seat 0 (translationY ${mid.translationY} px of ${ONE_LINE * density}, seat ${mid.seatPx}) – depart translates, rest seats",
            mid.seatPx == 0 && mid.translationY > TOLERANCE * density && mid.translationY < ONE_LINE * density - 1f
        )
        check("a swipe up released before half the height springs the band back and the rest SEATS the WebView again (seat ${settled.seatPx} px, translationY ${settled.translationY})", back)
        if (!back) touchFault("a short swipe on the band over the long page did not leave the band standing")
        beat()
        // The short page again for the pull and the bar (their scenes read the page where it was).
        navigate("$SITE_A/plain")
        awaitBand(OFFLINE_TITLE, 6_000)
        SystemClock.sleep(600)
    }

    /**
     * Where the host's view for the demo tab stands, read on the main thread: its translation,
     * its laid-out top and height (the container's device px), the band's seat it is laid out
     * under (`TabWebView.bandSeatPx`) and the frame the chrome last reported for it
     * (`TabHost.reportedFrameOf`). `seatedAt(h)`: the desktop seam's REST – the seat the band's
     * height, no translation.
     */
    private data class ViewGeometry(val translationY: Float, val top: Int, val height: Int, val seatPx: Int, val frame: Rect?, val density: Float) {
        fun seatedAt(h: Float): Boolean = abs(seatPx - h * density) <= 1f && abs(translationY) <= 1f
        override fun toString(): String = "view translationY $translationY top $top height $height seat $seatPx px; reported frame $frame"
    }

    private fun viewGeometry(): ViewGeometry {
        var out = ViewGeometry(0f, 0, 0, 0, null, density)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
            if (view != null) out = ViewGeometry(view.translationY, view.top, view.height, view.bandSeatPx, host.tabs.reportedFrameOf(TAB), density)
        }
        return out
    }

    /** The long page scrolled to its end and its geometry read ([LONG_PAGE_SCROLL_JS]); `{}` when the page did not answer. */
    private fun longPageScroll(): JSONObject = runCatching { JSONObject(jsonString(pageJs(LONG_PAGE_SCROLL_JS))) }.getOrDefault(JSONObject())

    /** Evaluate in the demo tab's WebView; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
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
        // The band standing here is a STATE: the pull takes the page over where it sits and the
        // band goes (unseen while the pull has the page), the page comes home on the release –
        // and then the state, which holds, returns on its own entrance and the page is held again.
        // So the verdict reads the host's samples (the page's offset every 8 ms through the whole
        // act) and the band under the finger at the pull's peak, not one instant after the release
        // that the state's return overwrites within a frame or two. `took` is the page at rest at
        // either of its two rests (home, or the state's).
        var midPullBand = ""
        var midPullOffset = 0f
        val settled = scene("band-pull-takeover", JankBudget.Kind.GESTURE, timeoutMs = 6_000, took = { val o = offsetCss(); o <= TOLERANCE || abs(o - held) <= TOLERANCE }) {
            Finger().apply {
                down(pageX, pageY)
                moveBy(0f, NUDGE, 80)
                moveBy(0f, 200 * density, 600)
                hold(300)
                midPullBand = bandTitle()
                midPullOffset = offsetCss()
                snap("pull-takeover-finger-down")
                up()
            }
        }
        val samples = sampler.stop()
        val jumped = jumpedHome(samples, held)
        val home = lowestAfterPeak(samples)
        finding("  the pull: ${describeSamples(samples)}; the page's lowest offset before the pull's peak: ${"%.1f".format(jumped.lowestBeforePeak)} (held at $held); after the peak: ${"%.1f".format(home)}; under the finger at the pull's peak: band='$midPullBand', page offset $midPullOffset")
        check("the band leaves on the pull: no band under the finger at the pull's peak, the page the pull's (offset $midPullOffset, past the band's $held)", midPullBand.isEmpty() && midPullOffset > held + PULL_SLACK)
        check("the page comes home on the release (the lowest offset after the pull's peak ${"%.1f".format(home)} ≤ $TOLERANCE)", home <= TOLERANCE)
        if (!settled) touchFault("a pull on the held page left the page at rest at neither home nor the band's offset")
        check("the page never jumped home under the finger: the pull carried on from the band's offset (lowest ${"%.1f".format(jumped.lowestBeforePeak)} ≥ ${held - PULL_SLACK})", jumped.ok)
        val returned = awaitBand(OFFLINE_TITLE, 8_000)
        finding("  after the pull: band=${bandTitle()}, returned=$returned (the state holds; its return is reported, not gated); page offset ${offsetCss()}")
        snap("pull-takeover-after")
        beat()
    }

    // --- 7b. the bar under a standing band ---------------------------------------------------------------------------------------

    /**
     * The chrome's bar keeps its touches while a band holds the page. The readers' run on #735
     * found the Menu dead under the reader offer: the page translated down by the band's height
     * hangs over the bottom-docked bar – the parent hit-tests it by its translated rect – and its
     * clipped strip there took the bar's touches; `StripTouchRule` hands them to the chrome, where
     * the bar is. One finger each, no retry (the harness's [tapMenuButton] taps again on nothing;
     * the fault must show), with the offline state's band standing: Menu opens the app menu (read
     * off the chrome's document – to the host the standing band is a surface already), the pill
     * opens the URL field (`urlbar.open`); a Back after each, and the band stands through both (a
     * sheet and the field are covers the band keeps under), the page held where it was.
     */
    private fun barUnderBand() {
        finding("\nthe bar under a standing band: the page's clipped strip over the bar is the chrome's (StripTouchRule)")
        if (!awaitBand(OFFLINE_TITLE, 4_000)) {
            check("the offline band stands for the bar's taps", false)
            return
        }
        val held = offsetCss()
        val menu = findByLabelPrefix(MENU_LABEL)?.let { touchPoint(it) }
        finding("  the Menu button under the band: $menu; page offset $held")
        if (menu == null) {
            check("a finger can reach the Menu button with the band standing", false)
        } else {
            Finger().tap(menu)
            val opened = poll(MENU_OPEN_MS, 150) { menuSheetUp() }
            finding("  one tap on Menu: the app menu in the chrome's document=$opened; band=${bandTitle()}; page offset ${offsetCss()}")
            if (!opened) touchFault("a touch on the Menu button under a standing band opened no app menu")
            check("one tap on Menu opens the app menu while the band holds the page", opened)
            if (opened) {
                SystemClock.sleep(600)
                snap("menu-under-band")
                back()
                poll(8_000, 150) { !menuSheetUp() }
                SystemClock.sleep(600)
            }
        }
        val pill = pillPoint()
        Finger().tap(pill)
        val field = poll(6_000, 150) { urlbarOpen() }
        finding("  one tap on the pill at $pill: URL field open=$field; band=${bandTitle()}; page offset ${offsetCss()}")
        if (!field) touchFault("a touch on the address pill under a standing band opened no URL field")
        check("one tap on the pill opens the URL field while the band holds the page", field)
        if (field) {
            val close = closeUrlField()
            finding("  the field closed: ${close.describe()}")
        }
        val standing = awaitBand(OFFLINE_TITLE, 6_000)
        finding("  after the taps: band=${bandTitle()}; page offset ${offsetCss()} (held at $held)")
        check("the band stands through the menu and the field (covers it keeps under), the page held", standing && abs(offsetCss() - held) <= TOLERANCE)
        beat()
    }

    /** The app menu's sheet is in the chrome's document (its handle); the band's own surface aside. */
    private fun menuSheetUp(): Boolean =
        chromeJs("!!document.querySelector('.zen-sheet [aria-label=\"$MENU_HANDLE_LABEL\"]')") == "true"

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
            // The toast runs the §9.33 clock (TOAST_SHOW_MS, 2.8 s) from the word's turn and its
            // node reaches the tree a beat after the band's leave, which can be done in a second;
            // the scene's trace pull takes longer than the toast lives, so it is watched out here,
            // not after the scene (the fold's run under the StripTouchRule fix saw it drawn in the
            // recording and missed by a look that came too late).
            if (!toast) toast = waitFor(BACK_ONLINE_TOAST, 3_500) != null
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
     * CSS px), the title and the actions in the tree, the × under its one name (the content
     * component's "Dismiss" on every band – the Design Lead's ruling on #735; no tenant names its
     * own); from the document the form, one root, `role="status"`, the glyph and its place at the
     * frame's top.
     */
    private fun bandGeometry(where: String, bandHeight: Float, form: String, title: String, detail: String?, actions: List<String>) {
        val close = DISMISS_LABEL
        val offset = offsetCss()
        val probe = bandProbe()
        finding("  $where: page offset $offset; $probe")
        check("$where: the page is translated by the band's height ($bandHeight; the host reads $offset)", abs(offset - bandHeight) <= TOLERANCE)
        check("$where: the title '$title' is on screen", findNode { it == title } != null)
        if (detail != null) check("$where: the detail line '$detail' is on screen", findNode { it == detail || it.contains(detail) } != null)
        for (action in actions) check("$where: the action '$action' is a button", findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == action } != null)
        check("$where: the × ('$close') is a button", findNodeWhere { n -> n.isClickable && (n.text ?: n.contentDescription)?.toString() == close } != null)
        // The root's top in the chrome's document (CSS px) sits at or above the touchable window's
        // top edge: the band is at the frame's top, under the status bar, whichever bar position.
        val top = probe.optInt("top", Int.MAX_VALUE).toFloat() * density
        check(
            "$where: one band root, the $form form, role status, the glyph, at the frame's top (root top ${probe.optInt("top", -1)} CSS px; the seam's hooks: $BAND_ROOT)",
            probe.optInt("count") == 1 && probe.optString("form") == form && probe.optString("role") == "status" &&
                probe.optBoolean("glyph") && top <= frameTopPx() + 8 * density
        )
    }

    /**
     * The chrome-drawn page's shape under the band AT REST: one layer ([LAYER_PROBE_JS]) SEATED
     * – its box inset by the band's height (`top` the seat) with no transform, the desktop seam's
     * rest (the travel's reading, translated at seat 0, is taken under the finger in the swipe
     * scene) – its page starting where the band ends – pushed down, not covered; the host's
     * WebView unmoved (no page view stands under a chrome-drawn page); one band root, the state
     * form, at the frame's top.
     */
    private fun layerGeometry(where: String, bandHeight: Float) {
        val layer = layerProbe()
        val band = bandProbe()
        val host = offsetCss()
        finding("  $where: host offset $host; layer $layer; band $band")
        val shift = layer.optDouble("shift", -1.0).toFloat()
        check(
            "$where: one page layer under the band, SEATED at rest – its box inset by the band's height ($bandHeight; the layer reads seat ${layer.optInt("seat", -1)}, shift $shift) – depart translates, rest seats",
            layerSeatedAt(layer, bandHeight)
        )
        val pageTop = layer.optDouble("pageTop", -1e6)
        val bandTop = band.optDouble("top", 1e6)
        check(
            "$where: the page starts where the band ends (page top $pageTop, band top $bandTop + $bandHeight; the page pushed down, never covered)",
            abs(pageTop - (bandTop + bandHeight)) <= TOLERANCE
        )
        check("$where: the host's page WebView never moved (translationY $host; the layer's move is the chrome's, the pull channel a document's)", host <= TOLERANCE)
        val top = band.optInt("top", Int.MAX_VALUE).toFloat() * density
        check(
            "$where: one band root, the state form, role status, at the frame's top (root top ${band.optInt("top", -1)} CSS px)",
            band.optInt("count") == 1 && band.optString("form") == "state" && band.optString("role") == "status" && top <= frameTopPx() + 8 * density
        )
    }

    /** The chrome-drawn page's layer from the chrome's document ([LAYER_PROBE_JS]); `{layers:0}` without one. */
    private fun layerProbe(): JSONObject = runCatching { JSONObject(jsonString(chromeJs(LAYER_PROBE_JS))) }.getOrDefault(JSONObject())

    /** The layer's translation below the frame's top, CSS px; 0 without a layer (the page home, or no chrome-drawn page in front). */
    private fun layerShift(): Float = layerProbe().optDouble("shift", 0.0).toFloat()

    /**
     * The desktop seam's REST on a chrome-drawn page: one layer, SEATED – its `top` the band's
     * height [h] (the box inset) and no translation – as [LAYER_PROBE_JS] read it in [probe].
     */
    private fun layerSeatedAt(probe: JSONObject, h: Float): Boolean =
        probe.optInt("layers") == 1 && probe.optInt("seat", -1) == h.roundToInt() && abs(probe.optDouble("shift", 1e6)) <= TOLERANCE

    /** The layer home – no translation, no seat (the band gone: a plain full-frame box) – or no layer at all. */
    private fun layerHome(): Boolean {
        val probe = layerProbe()
        return abs(probe.optDouble("shift", 0.0)) <= TOLERANCE && probe.optInt("seat", 0) == 0
    }

    /**
     * The Lead's check on #758, the reason the layer SEATS at rest: with the state's band standing
     * on Settings – the layer read `{layers:1, shift:0, seat:<band height>}` – the landing scrolled
     * to its bottom puts its last category row's bottom edge INSIDE the frame, above the frame's
     * bottom. The seat insets the layer's box by the band's height, so the page's own scroller is
     * that much shorter and reaches its last row; translated at rest instead (the first cut's
     * reading, `shift 56, seat 0`), the box kept the frame's full height and its last 56 px – the
     * last row – stood under the frame's bottom, unreachable by any scroll. Read through
     * [SETTINGS_SCROLL_JS] (the scroll is instant, the geometry read in the same evaluation, then
     * read again settled); the still `design-settings-seated-light` after it.
     */
    private fun settingsScrollsToItsLastRow() {
        val layer = layerProbe()
        val seated = layerSeatedAt(layer, ONE_LINE)
        settingsScroll()
        SystemClock.sleep(400)
        val scrolled = settingsScroll()
        finding("  Settings scrolled to its bottom under the band: layer $layer; scroll $scrolled")
        val frameBottom = scrolled.optDouble("frameBottom", -1.0)
        val lastBottom = scrolled.optDouble("lastBottom", 1e6)
        check(
            "at rest the layer is seated (`top` the band's height, no transform) and `zen://settings` scrolls to its last row above the frame's bottom " +
                "(layer seat ${layer.optInt("seat", -1)}, shift ${layer.optDouble("shift", -1.0)}; " +
                "${scrolled.optInt("rows")} rows, the last '${scrolled.optString("lastLabel")}' bottom $lastBottom against the frame's bottom $frameBottom; " +
                "scrollTop ${scrolled.optInt("scrollTop")} of ${scrolled.optInt("scrollHeight")} in ${scrolled.optInt("clientHeight")})",
            seated && scrolled.optBoolean("scroller") && scrolled.optBoolean("overflows") && scrolled.optBoolean("atBottom") &&
                frameBottom > 0 && lastBottom <= frameBottom - 1f
        )
        snap("design-settings-seated-light")
    }

    /** Settings' landing scrolled to its bottom inside the layer and its geometry read ([SETTINGS_SCROLL_JS]); `{layers:0}` without a layer. */
    private fun settingsScroll(): JSONObject = runCatching { JSONObject(jsonString(chromeJs(SETTINGS_SCROLL_JS))) }.getOrDefault(JSONObject())

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

    /**
     * The install prompt's record for a site's app, from the core's `webapps.json` (the test
     * shares the app's uid): `{visits, firstVisitAt, lastVisitAt, dismissedAt, promptedAt}`, or
     * null while the file or the record is not there yet (the core writes it after the show).
     * [site] is the site's URL ([SITE_A] …); the record's key is the app's id, the manifest's
     * `/app/` resolved against the site – the key [seedMore] wrote.
     */
    private fun engagement(site: String): JSONObject? {
        val file = File(File(app.filesDir, "zen"), "webapps.json")
        if (!file.exists()) return null
        val doc = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return null
        return doc.optJSONObject("engagement")?.optJSONObject("$site/app/")
    }

    private fun chromeTheme(): String = jsonString(chromeJs("(function(){return document.documentElement.getAttribute('data-theme')||''})()"))

    /**
     * The page's displacement below the frame's top, CSS px, from the host's view (the one
     * source of truth for where the page is): the band's seat the view is laid out under plus
     * its translation (`PageSeat.kt`: seated at rest the seat carries the offset and the
     * translation is 0; through a travel, a drag or a pull the translation carries it). The one
     * picture, whichever carries it – what every check here reads as the page's offset.
     */
    private fun offsetCss(): Float {
        var offset = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
            if (view != null) offset = (view.bandSeatPx + view.translationY) / density
        }
        return (offset * 10).roundToInt() / 10f
    }

    // --- the host sampler and the chrome's frame clock -------------------------------------------------------------------------------

    /**
     * The page's offset ([offsetCss]'s reading: seat + translation) read on the main thread
     * every [SAMPLE_MS] from [start] to [stop]: the motion the host drew, as it drew it.
     * Started by [scene] before its block, stopped by the act after it (the samples run a little
     * past the block, into the settle).
     */
    private inner class OffsetSampler {
        private val handler = Handler(Looper.getMainLooper())
        private val samples = ArrayList<Pair<Long, Float>>()
        private var on = false
        private val tick = object : Runnable {
            override fun run() {
                if (!on) return
                val view = host.tabs.get(TAB)
                samples.add(SystemClock.uptimeMillis() to (if (view == null) 0f else (view.bandSeatPx + view.translationY) / density))
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

    /**
     * The lowest offset the host drew after the pull's peak: the release brings the page home
     * (≈ 0) before a state that still holds brings its band back, so the band's return is no
     * miss – the page's visit home is the fact, read from the samples rather than the rest.
     */
    private fun lowestAfterPeak(samples: List<Pair<Long, Float>>): Float {
        if (samples.isEmpty()) return Float.MAX_VALUE
        val values = samples.map { it.second }
        val peak = values.indices.maxByOrNull { values[it] } ?: 0
        return values.drop(peak).minOrNull() ?: Float.MAX_VALUE
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

    /** Navigates the demo tab to [url] and waits for it – or for [landsOn], where the core takes the typed address elsewhere (`zen://newtab` on the phone). */
    private fun navigate(url: String, landsOn: String = url) {
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote(url)}}""")
        awaitLoaded(landsOn)
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
        /** Where `zen://newtab` lands on the phone: the empty tab the chrome draws the new tab page over (`core/browser.ts`'s `typedToUrl`). */
        private const val PHONE_NEW_TAB = "zen://blank"
        /** A page the chrome draws itself (`render: 'chrome'`, `InternalPageHost`): no page WebView under it. */
        private const val SETTINGS_URL = "zen://settings"
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
        /** The app's manifest `short_name`: on the Home-screen surface the core names the app by it (`launcherName`). */
        private const val INSTALL_TITLE = "Add Sketch to Home screen"
        private const val INSTALL_ACTION = "Add"
        private const val READER_TITLE = "Show Reader View?"
        private const val READER_ACTION = "Show"
        private const val OFFLINE_TITLE = "No internet connection"
        private const val BACK_ONLINE_TOAST = "Back online"
        /** The band's × (its `aria-label`, the banner card's word kept). */
        private const val DISMISS_LABEL = "Dismiss"
        private val TITLES = listOf(DEFAULT_TITLE, INSTALL_TITLE, READER_TITLE, OFFLINE_TITLE)

        /**
         * THE SEAM'S HOOKS, in one place. The band's words, form, key and action come from the
         * shared MODEL (`window.__zenStores.band`, Desktop's W8-M2 `lib/band.ts`): the entry the
         * model itself says is shown (`BandState.shown`, the id `chooseBand` picked at its last
         * commit – states before offers, the newest, on the front tab, while the host says a band
         * may stand (`ok`) and, for an offer, that offers may; under a cover the one that stood
         * before it), looked up among its entries – no rule re-read here, so no DOM name is read
         * for the words; the document is read only for
         * the band's ROOT (`.zen-band`) – how many stand, its role, whether it carries a glyph
         * (an `svg`) and where it sits – the one selector to change if the content component
         * names its root otherwise. `count` is the roots'; `standing` the model's entries (shown
         * or waiting); `title` is empty when none is shown.
         */
        private const val BAND_ROOT = ".zen-band"
        private const val BAND_PROBE_JS =
            "(function(){var S=window.__zenStores&&window.__zenStores.band;var st=S?S.get():null;var shown=null;" +
                "if(st&&st.shown!==null){shown=st.entries.filter(function(e){return e.id===st.shown})[0]||null}" +
                "var b=document.querySelectorAll('$BAND_ROOT');var f=b[0];" +
                "var o={model:!!S,standing:st?st.entries.length:0,ok:st?st.ok:false,covered:st?st.covered:false,front:st?st.front:null,count:b.length," +
                "form:shown?shown.form:'',key:shown?shown.key:'',title:shown?shown.title:'',detail:shown&&shown.detail?shown.detail:''," +
                "actions:shown&&shown.action?[shown.action.label]:[],close:shown?(shown.closeLabel||'Dismiss'):''," +
                "theme:document.documentElement.getAttribute('data-theme')};" +
                "if(f){var r=f.getBoundingClientRect();var role=f.getAttribute('role')||(f.querySelector('[role]')?f.querySelector('[role]').getAttribute('role'):'');" +
                "o.role=role;o.glyph=!!f.querySelector('svg');o.top=Math.round(r.top);o.left=Math.round(r.left);o.width=Math.round(r.width);o.height=Math.round(r.height)}" +
                "return JSON.stringify(o)})()"

        /**
         * The chrome-drawn page's LAYER (`PageBandLayer`, Desktop's #740; its `data-band-layer`
         * mark is the one selector here): how many stand (`layers`), its translation from its
         * computed transform (`shift`, CSS px – the band's offset less the seat, as the host
         * writes it per frame: the TRAVEL's reading, 0 at rest), its seat (`seat`, the layer's
         * computed `top`: the REST's reading, the band's height, 0 through a travel – the
         * desktop seam's contract, depart translates and rest seats), where it sits (`top`) and
         * where its page starts (`pageTop`, its first child's top), whether that page is the
         * chrome's page host (`.zen-page-host`, Settings and the other `render: 'chrome'` pages;
         * the phone's new tab page is its own component), and the band root's edges beside them.
         */
        private const val LAYER_ROOT = "[data-band-layer]"
        private const val LAYER_PROBE_JS =
            "(function(){var l=document.querySelectorAll('$LAYER_ROOT');var f=l[0];var o={layers:l.length};" +
                "if(f){var cs=getComputedStyle(f);var m=cs.transform;var y=0;if(m&&m!=='none'){var p=m.match(/matrix\\(([^)]+)\\)/);" +
                "if(p){y=parseFloat(p[1].split(',')[5])}else{var q=m.match(/matrix3d\\(([^)]+)\\)/);if(q){y=parseFloat(q[1].split(',')[13])}}}" +
                "var r=f.getBoundingClientRect();o.shift=Math.round(y*10)/10;o.top=Math.round(r.top);o.seat=Math.round(parseFloat(cs.top)||0);" +
                "var c=f.firstElementChild;if(c){o.pageTop=Math.round(c.getBoundingClientRect().top*10)/10}o.host=!!f.querySelector('.zen-page-host')}" +
                "var b=document.querySelector('$BAND_ROOT');if(b){var br=b.getBoundingClientRect();o.bandTop=Math.round(br.top);o.bandBottom=Math.round(br.bottom)}" +
                "return JSON.stringify(o)})()"

        /**
         * Settings' landing under the layer SCROLLED TO ITS BOTTOM, and where that leaves its
         * last row (the Lead's check on #758): the landing's own scroller (`.zen-settings-scroll`,
         * `SettingsPage.tsx`; it scrolls, the page under it does not) is put at its end – instant,
         * no smooth scroll – and read in the same evaluation: `scrollTop`, `scrollHeight`,
         * `clientHeight`, whether it `overflows` and is `atBottom`; the category rows'
         * (`.zen-settings-category`) count and the LAST row's edges (`lastTop`, `lastBottom`, its
         * label); the frame's bottom (`frameBottom`, the layer's parent – the frame's viewport)
         * and the layer's own edges (`layerTop`, `layerBottom`). Seated, the last row's bottom
         * sits inside the frame; translated at rest it would sit under the frame's bottom by the
         * band's height.
         */
        private const val SETTINGS_SCROLL_JS =
            "(function(){var l=document.querySelectorAll('$LAYER_ROOT');var f=l[0];var o={layers:l.length};if(!f){return JSON.stringify(o)}" +
                "var s=f.querySelector('.zen-settings-scroll');o.scroller=!!s;if(!s){return JSON.stringify(o)}" +
                "s.scrollTop=s.scrollHeight;" +
                "var rows=s.querySelectorAll('.zen-settings-category');o.rows=rows.length;var last=rows[rows.length-1];" +
                "var pr=f.parentElement.getBoundingClientRect();var lr=f.getBoundingClientRect();" +
                "o.frameBottom=Math.round(pr.bottom*10)/10;o.layerTop=Math.round(lr.top*10)/10;o.layerBottom=Math.round(lr.bottom*10)/10;" +
                "if(last){var rr=last.getBoundingClientRect();o.lastTop=Math.round(rr.top*10)/10;o.lastBottom=Math.round(rr.bottom*10)/10;o.lastLabel=(last.textContent||'').trim()}" +
                "o.scrollTop=Math.round(s.scrollTop);o.scrollHeight=s.scrollHeight;o.clientHeight=s.clientHeight;" +
                "o.overflows=s.scrollHeight>s.clientHeight+1;o.atBottom=s.scrollTop+s.clientHeight>=s.scrollHeight-1;" +
                "return JSON.stringify(o)})()"

        /** A short page, no article, no manifest: the start page and the page the states stand on. */
        private const val PLAIN_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<title>Harbour notices</title><style>body{margin:0;padding:24px 20px;font:17px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff}" +
            "@media (prefers-color-scheme: dark){body{color:#e6e6e6;background:#121212}}</style></head>" +
            "<body><h1>Harbour notices</h1><p>The harbour office is closed on Sunday.</p></body></html>"

        /**
         * A LONG page for the seat's verdict (scene 6c): forty notices, well past any phone's
         * frame, ending in the one line the check scrolls to (`#last`). No article (the reader
         * offer must not arise on it), no manifest.
         */
        private val LONG_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<title>Harbour notices, the year</title><style>body{margin:0;padding:24px 20px;font:17px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff}" +
            "p{margin:0 0 14px}#last{font-weight:600}" +
            "@media (prefers-color-scheme: dark){body{color:#e6e6e6;background:#121212}}</style></head>" +
            "<body><h1>Harbour notices</h1>" +
            (1..40).joinToString("") { "<p>Notice $it: the east quay is closed for dredging on day $it.</p>" } +
            "<p id=\"last\">Last line: the harbour office is closed on Sunday.</p></body></html>"

        /**
         * The long page SCROLLED TO ITS END and read in the same evaluation (in the page's own
         * viewport, CSS px): `scrollTop`, `scrollHeight`, `innerHeight`, whether it `overflows`
         * and is `atBottom`; the last line's edges (`lastTop`, `lastBottom`, its `lastText`).
         * Seated, the view's bottom is the frame's bottom and the last line's bottom sits inside
         * the viewport; translated at rest (the old picture) the view ran a band past the frame's
         * bottom and the last line's bottom, at the viewport's, stood under the frame's edge.
         */
        private const val LONG_PAGE_SCROLL_JS =
            "(function(){var s=document.scrollingElement||document.documentElement;s.scrollTop=s.scrollHeight;" +
                "var last=document.getElementById('last');var o={innerHeight:window.innerHeight,scrollTop:Math.round(s.scrollTop),scrollHeight:s.scrollHeight};" +
                "o.overflows=s.scrollHeight>window.innerHeight+1;o.atBottom=s.scrollTop+window.innerHeight>=s.scrollHeight-1;" +
                "if(last){var r=last.getBoundingClientRect();o.lastTop=Math.round(r.top*10)/10;o.lastBottom=Math.round(r.bottom*10)/10;o.lastText=(last.textContent||'').trim()}" +
                "return JSON.stringify(o)})()"

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
