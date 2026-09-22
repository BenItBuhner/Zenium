package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.Socket
import java.util.Locale

/**
 * Records the download safety states of the phone's downloads sheet (HB-44, HB-19 / PS-34, HB-43;
 * the interface's verbs table) against fixtures on the device itself, and checks each claim on the
 * engine's list and in `MediaStore.Downloads`:
 *
 *  1. An insecure download blocked and kept: a page on a potentially trustworthy origin links to a
 *     file on one that is not; the row comes up `Blocked · Insecure download` with Keep anyway and
 *     Discard, no byte on disk; a finger on Keep anyway runs the transfer with `insecureAccepted`
 *     and the file lands whole.
 *  2. A dangerous type into Keep / Delete: an `.apk` (an executable on Android: `dangerous`, red)
 *     finishes into quarantine, its row `Blocked · Dangerous` over the tier's sentence, Keep
 *     releasing it into MediaStore; a `.dng` (Chromium's always-warn type on Android, `dangerous`
 *     by type alone) into Delete, its row and its quarantined file gone.
 *  3. An interruption resumed: a file whose server drops the downloader's first attempt at 256 KiB
 *     and dies on each of the three automatic resumes; the row counts down `Resuming in N s…` to
 *     each (the text alone changes), fails for good as `Failed · Check internet connection` with
 *     Resume (never Retry beside it), and a finger on Resume completes it with `Range`.
 *
 * The fixtures are two [DemoServer]s in the instrumentation's own process – the page and the
 * files on the loopback (`http://127.0.0.1`), which Chromium's `IsUrlPotentiallyTrustworthy`,
 * the core's port and `DownloadLogic.kt`'s treat exactly as `https:` (no one on the network can
 * tamper with it), and the insecure file on the device's own network address
 * ([DemoServer.siteAddress], `10.0.2.15` on the emulator), a plain `http:` host that is not the
 * loopback – so the run needs nothing from the runner or the network, and no certificate the
 * WebView would have to be made to trust (the app trusts the system's CAs alone, as a release
 * should; an on-device `https:` server would stop on the certificate interstitial, and the
 * downloader's own connection would refuse it). Every file's bytes come from the demos' formula
 * ([DownloadsDemoBase.expectedByte]), so a kept or resumed file is checked byte for byte. The
 * seeded profile turns HTTPS-only mode off: the insecure link is the point.
 *
 * Frames (PERF-3, `DemoHarness.traceFrames`): the app menu up and down once as the baseline (a
 * sheet main had before this PR), then the downloads sheet revealed by the first download and
 * closed by a back against it, the finger on Keep anyway, and three seconds of the countdown
 * ticking – the record is `frames.jsonl` / `frames.txt` in the findings, its table in the notes.
 * The URL field is closed the harness's way ([closeUrlField]) after the warm-up and after each
 * act, the outcome in the notes.
 *
 * Run from the dispatch-only workflow `.github/workflows/android-download-safety-demo.yml` with
 * `DEMO_CLASS=app.zen.chromium.DownloadSafetyDemo`; the rows are read and pressed as
 * [DownloadsDemoBase] describes. See [DemoHarness] for the recorder handshake.
 */
@RequiresApi(Build.VERSION_CODES.Q)
@RunWith(AndroidJUnit4::class)
class DownloadSafetyDemo : DownloadsDemoBase("download-safety-demo-state.json", "services-download-safety-android", "download-safety-demo") {
    override val tag = "DownloadSafetyDemo"

    private lateinit var secure: DemoServer
    private lateinit var insecure: DemoServer
    private lateinit var notes: File
    private var shots = 0
    private val startedAt = SystemClock.uptimeMillis()

    @Test
    fun record() {
        val site = DemoServer.siteAddress() ?: error("the device has no network address besides the loopback: no insecure origin to serve from")
        val insecureUrl = "http://$site:$INSECURE_PORT/insecure.bin"
        secure = DemoServer(
            SECURE_PORT,
            mapOf(
                "/page.html" to ("text/html; charset=utf-8" to page(insecureUrl).toByteArray()),
                "/$APK" to ("application/vnd.android.package-archive" to formulaBytes(APK_SIZE)),
                "/$DNG" to ("image/x-adobe-dng" to formulaBytes(DNG_SIZE)),
                "/$FLAKY" to ("application/octet-stream" to formulaBytes(FLAKY_SIZE))
            ),
            cuts = mapOf("/$FLAKY" to DemoServer.Cut(FLAKY_CUT_AT, FLAKY_FAILURES))
        ).also { it.start() }
        insecure = DemoServer(
            INSECURE_PORT,
            mapOf("/insecure.bin" to ("application/octet-stream" to formulaBytes(INSECURE_SIZE))),
            address = "0.0.0.0"
        ).also { it.start() }
        try {
            Log.i(tag, "secure fixture: ${secure.selfCheck()}; insecure fixture at $insecureUrl: ${reach(site, INSECURE_PORT)}")
            runDemo()
        } finally {
            secure.close()
            insecure.close()
        }
        if (failures.isNotEmpty()) error("download safety demo failed: ${failures.joinToString("; ")}")
    }

    /** The test page must be up before the recorder rolls; the field closed the harness's way. */
    override fun warmUp() {
        notes = File(out, "services-download-safety-android-notes.txt")
        notes.writeText("Zenium Android download safety demo (the insecure block, the danger tiers, the auto-resume countdown)\n\n")
        note("fixtures: page and files on ${secure.origin} (the loopback: potentially trustworthy, as https: is); insecure.bin on http://${DemoServer.siteAddress()}:$INSECURE_PORT (the device's own address: not)")
        waitFor(LINK_INSECURE, 45_000) ?: error("the test page never showed its links (did the on-device server start?)")
        val close = closeUrlField()
        note("warm-up: closeUrlField() – ${close.describe()}")
        beat()
    }

    override fun demo() {
        // 0. The frame baseline: the app menu, a sheet main had before this PR, opened with a
        //    finger and dismissed with a back (the same two `open` scenes SheetRecedeDemo cuts).
        note("\n0. the frame baseline: the app menu")
        val menu = menuButton()
        traceFrames(SCENE_MENU_OPEN, JankBudget.Kind.OPEN) {
            Finger().tap(menu.x, menu.y)
            SystemClock.sleep(MOTION_MS)
        }
        val menuUp = waitFor(MENU_HANDLE_LABEL, 6_000) != null
        note("  the app menu ${if (menuUp) "opened under the finger" else "did NOT show its handle on the tree"}")
        traceFrames(SCENE_MENU_CLOSE, JankBudget.Kind.OPEN) {
            back()
            SystemClock.sleep(MOTION_MS)
        }
        awaitSurface(up = false, timeoutMs = 8_000)
        recoverUrlField("the app menu")

        // 1. The insecure block, kept.
        note("\n1. an insecure download blocked, then kept (HB-44)")
        insecureBlocked()
        recoverUrlField("the insecure download")

        // 2. A dangerous type: Keep on the .apk, Delete on the .dng.
        note("\n2. a dangerous type into Keep / Delete (HB-19 / PS-34)")
        dangerousKept()
        dangerousDeleted()
        recoverUrlField("the dangerous downloads")

        // 3. An interruption: the countdown, the failure for good, Resume.
        note("\n3. an interruption resumed (HB-43)")
        interruptedResumed()
        recoverUrlField("the interrupted download")

        noteFrameTable()
        note("\n${if (failures.isEmpty()) "all claims held" else "${failures.size} claim(s) FAILED: ${failures.joinToString("; ")}"}")
        note("done in ${(SystemClock.uptimeMillis() - startedAt) / 1000} s")
    }

    // --- 1. the insecure block --------------------------------------------------------------------

    /**
     * A finger on the page's insecure link: the WebView hands the transfer over, the downloader
     * refuses it before a byte is read (`insecure-blocked`), and the sheet comes up on the row –
     * the first download's reveal, measured as the sheet's `open` scene. Keep anyway is a second
     * finger, its scene the `gesture`; the file must then land whole and the row lose its block.
     */
    private fun insecureBlocked() {
        val link = waitFor(LINK_INSECURE, 8_000) ?: run {
            fail("the page's insecure link is not on screen")
            return
        }
        traceFrames(SCENE_SHEET_OPEN, JankBudget.Kind.OPEN, baseline = SCENE_MENU_OPEN) {
            Finger().tap(link.exactCenterX(), link.exactCenterY())
            SystemClock.sleep(MOTION_MS)
        }
        val blocked = awaitRow(INSECURE, 20_000) { it.optString("state") == "insecure-blocked" }
        if (blocked == null) {
            fail("insecure.bin was not blocked: ${rowFor(INSECURE)}")
            return
        }
        val id = blocked.optString("id")
        note("  engine: state=${blocked.optString("state")} danger=${blocked.optJSONObject("danger")?.optString("level")} insecureAccepted=${blocked.opt("insecureAccepted")} received=${blocked.optLong("receivedBytes")}")
        check(blocked.optLong("receivedBytes") == 0L, "the blocked transfer read bytes: $blocked")
        check(blocked.optJSONObject("danger")?.optString("level") == "safe", "insecure.bin's type is not judged safe: ${blocked.optJSONObject("danger")}")
        check(pendingRow(INSECURE) == null && publishedRow(INSECURE) == null, "the blocked insecure.bin left a file in MediaStore.Downloads")
        val row = waitForRow(10_000) { rowReads(it, INSECURE, BLOCKED_INSECURE) }
        if (row == null) fail("no row reads \"$INSECURE. $BLOCKED_INSECURE\"") else note("  row: ${labelStarting("$INSECURE. ")}")
        val keepAnyway = waitFor(KEEP_ANYWAY, 5_000)
        val discard = findByLabel(DISCARD)
        check(keepAnyway != null, "the blocked row offers no \"$KEEP_ANYWAY\"")
        check(discard != null, "the blocked row offers no \"$DISCARD\"")
        check(findAny("Retry", "Resume", "Open") == null, "the blocked row offers Retry / Resume / Open")
        note("  verbs: ${listOfNotNull(keepAnyway?.let { KEEP_ANYWAY }, discard?.let { DISCARD }).joinToString(" / ")}")
        hideKeyboard()
        snap("insecure-blocked")
        logTree("the sheet with the blocked row")

        // Keep anyway under a finger, as a frame scene: the button's bounds are read before the
        // clock starts, the row's change is awaited after it.
        if (keepAnyway != null) {
            val point = touchPoint(keepAnyway)
            if (point != null) {
                traceFrames(SCENE_KEEP_ANYWAY, JankBudget.Kind.GESTURE) {
                    Finger().tap(point.x, point.y)
                    SystemClock.sleep(KEEP_MOTION_MS)
                }
            }
            if (awaitRow(INSECURE, 5_000) { it.optString("state") != "insecure-blocked" } == null) {
                touchFault("a touch on '$KEEP_ANYWAY' did not take: insecure.bin is still blocked")
                downloadCommand("download.acceptDanger", id)
            } else {
                note("  the touch on Keep anyway took")
            }
        } else {
            downloadCommand("download.acceptDanger", id)
        }
        val uri = awaitPublished(INSECURE, INSECURE_SIZE.toLong(), 30_000)
        check(uri != null && intact(uri, INSECURE_SIZE.toLong()), "insecure.bin did not land whole after Keep anyway")
        val kept = awaitRow(INSECURE, 10_000) { it.optString("state") == "completed" }
        check(kept?.optBoolean("insecureAccepted") == true, "the kept row does not carry insecureAccepted: $kept")
        check(kept?.optString("id") == id, "Keep anyway made a new row instead of running the same one: $kept")
        note("  engine after Keep anyway: state=${kept?.optString("state")} insecureAccepted=${kept?.opt("insecureAccepted")} received=${kept?.optLong("receivedBytes")}; MediaStore: ${uri ?: "no file"}")
        if (waitForRow(8_000) { rowReads(it, INSECURE, "") && !it.contains("Blocked") } == null) fail("insecure.bin's row still reads Blocked")
        note("  row: ${labelStarting("$INSECURE. ")}")
        SystemClock.sleep(800)
        snap("insecure-kept")

        // The sheet closed by a back, the second `open` scene.
        traceFrames(SCENE_SHEET_CLOSE, JankBudget.Kind.OPEN, baseline = SCENE_MENU_CLOSE) {
            back()
            SystemClock.sleep(MOTION_MS)
        }
        closePanel()
    }

    // --- 2. the danger tiers ----------------------------------------------------------------------

    /** The `.apk`: dangerous by type on Android, Keep releases it from quarantine into MediaStore. */
    private fun dangerousKept() {
        tapLink(LINK_APK)
        val flagged = awaitRow(APK, 30_000) { it.optString("state") == "completed" && awaitsDecision(it) }
        if (flagged == null) {
            fail("$APK did not finish into quarantine as a dangerous file: ${rowFor(APK)}")
            return
        }
        val danger = flagged.optJSONObject("danger")
        note("  engine: $APK state=${flagged.optString("state")} danger=${danger?.optString("level")}/${danger?.optString("reason")} \"${danger?.optString("message")}\" dangerAccepted=${flagged.opt("dangerAccepted")}")
        check(danger?.optString("level") == "dangerous", "$APK is not judged dangerous: $danger")
        check(danger?.optString("reason") == "executable", "$APK's reason is not executable: $danger")
        check(publishedRow(APK) == null, "$APK was published before Keep (not quarantined)")
        if (waitForRow(10_000) { rowReads(it, APK, BLOCKED_DANGEROUS) } == null) fail("no row reads \"$APK. $BLOCKED_DANGEROUS\"")
        note("  row: ${labelStarting("$APK. ")}")
        val keep = waitFor(KEEP, 5_000)
        val delete = findByLabel(DELETE)
        check(keep != null && delete != null, "the dangerous row does not offer $KEEP / $DELETE (keep=$keep delete=$delete)")
        check(findAny(KEEP_ANYWAY, DISCARD, "Open") == null, "the dangerous row offers Keep anyway / Discard / Open")
        note("  verbs: ${listOfNotNull(keep?.let { KEEP }, delete?.let { DELETE }).joinToString(" / ")}")
        hideKeyboard()
        snap("dangerous-awaiting")
        press(KEEP, "download.acceptDanger", APK, flagged.optString("id")) { it.optBoolean("dangerAccepted") }
        val uri = awaitPublished(APK, APK_SIZE.toLong(), 30_000)
        check(uri != null && intact(uri, APK_SIZE.toLong()), "$APK was not released whole into MediaStore.Downloads on Keep")
        val kept = rowFor(APK)
        note("  engine after Keep: dangerAccepted=${kept?.opt("dangerAccepted")} savePath=${kept?.optString("savePath")}; MediaStore: ${uri ?: "no file"}")
        if (waitForRow(8_000) { rowReads(it, APK, "") && !it.contains("Blocked") } == null) fail("$APK's row still reads Blocked after Keep")
        note("  row: ${labelStarting("$APK. ")}")
        SystemClock.sleep(800)
        snap("dangerous-kept")
        closePanel()
    }

    /** The `.dng`: Chromium's always-warn type on Android; Delete drops the row and the quarantined file. */
    private fun dangerousDeleted() {
        tapLink(LINK_DNG)
        val flagged = awaitRow(DNG, 30_000) { it.optString("state") == "completed" && awaitsDecision(it) }
        if (flagged == null) {
            fail("$DNG did not finish into quarantine as a dangerous file: ${rowFor(DNG)}")
            return
        }
        val danger = flagged.optJSONObject("danger")
        note("  engine: $DNG state=${flagged.optString("state")} danger=${danger?.optString("level")}/${danger?.optString("reason")} \"${danger?.optString("message")}\"")
        check(danger?.optString("level") == "dangerous", "$DNG is not judged dangerous: $danger")
        check(danger?.optString("reason") == "file-type", "$DNG's reason is not file-type: $danger")
        if (waitForRow(10_000) { rowReads(it, DNG, BLOCKED_DANGEROUS) } == null) fail("no row reads \"$DNG. $BLOCKED_DANGEROUS\"")
        note("  row: ${labelStarting("$DNG. ")}")
        hideKeyboard()
        snap("dangerous-second")
        val id = flagged.optString("id")
        val gone = touchTapLabelExpecting(DELETE, "the row for $DNG is gone from the engine's list") { rowFor(DNG) == null }
        if (!gone) {
            if (rowFor(DNG) != null) downloadCommand("download.discard", id)
        } else {
            note("  the touch on Delete took")
        }
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline && rowFor(DNG) != null) SystemClock.sleep(300)
        check(rowFor(DNG) == null, "$DNG's row is still on the list after Delete: ${rowFor(DNG)}")
        check(publishedRow(DNG) == null && pendingRow(DNG) == null, "$DNG's file is still in MediaStore.Downloads after Delete")
        note("  engine after Delete: row ${if (rowFor(DNG) == null) "gone" else "STILL THERE"}; MediaStore: ${if (publishedRow(DNG) == null && pendingRow(DNG) == null) "no file" else "file STILL THERE"}")
        val treeDeadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < treeDeadline && labelStarting("$DNG. ") != null) SystemClock.sleep(200)
        if (labelStarting("$DNG. ") != null) fail("$DNG's row is still on the tree after Delete")
        SystemClock.sleep(800)
        snap("dangerous-deleted")
        closePanel()
    }

    // --- 3. the interruption ----------------------------------------------------------------------

    /**
     * flaky.bin: the downloader's first attempt dies at 256 KiB, the three automatic resumes at
     * their headers. The row hears of each attempt (`autoResumeAt`) and counts down to it; the
     * third attempt's eight seconds are the window for the still and for three seconds of the
     * ticking as a frame scene. The fourth failure leaves the row interrupted for good with
     * Resume – the server takes Range and the partial was kept – and Resume completes the file.
     */
    private fun interruptedResumed() {
        tapLink(LINK_FLAKY)
        val first = awaitRow(FLAKY, 30_000) { it.optString("state") == "interrupted" && it.has("autoResumeAt") }
        if (first == null) {
            fail("$FLAKY never failed with an automatic resume scheduled: ${rowFor(FLAKY)}")
            return
        }
        val id = first.optString("id")
        note("  engine: first failure error=${first.optString("error")} received=${first.optLong("receivedBytes")} canResume=${first.opt("canResume")} autoResumeAt=+${first.optLong("autoResumeAt") - System.currentTimeMillis()} ms")
        check(first.optString("error") == "network-failed", "the cut is not reported as network-failed: $first")
        check(first.optLong("receivedBytes") == FLAKY_CUT_AT.toLong(), "the first attempt did not stop at $FLAKY_CUT_AT bytes: ${first.optLong("receivedBytes")}")

        // The countdown: the still at the first `Resuming in N s…` the tree shows, the frame
        // scene when a schedule far enough out is caught (the third attempt's, eight seconds).
        var countdownLabel: String? = null
        var ticksMeasured = false
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (countdownLabel == null) {
                labelStarting("$FLAKY. $RESUMING_IN")?.let { label ->
                    countdownLabel = label
                    // The verbs while the engine counts down: Resume (now) and Cancel, no Retry.
                    val verbs = listOfNotNull(findByLabel("Resume")?.let { "Resume" }, findByLabel("Cancel")?.let { "Cancel" }, findByLabel("Retry")?.let { "Retry" })
                    snap("resuming-countdown")
                    note("  row: $label; verbs: ${verbs.joinToString(" / ")}")
                    check("Resume" in verbs && "Cancel" in verbs, "the counting-down row does not offer Resume and Cancel: $verbs")
                    check("Retry" !in verbs, "the counting-down row offers Retry")
                }
            }
            val row = rowFor(FLAKY)
            val left = (row?.optLong("autoResumeAt") ?: 0L) - System.currentTimeMillis()
            if (row != null && row.has("autoResumeAt") && left >= COUNTDOWN_SCENE_MS + 500 && !ticksMeasured) {
                traceFrames(SCENE_COUNTDOWN, JankBudget.Kind.GESTURE) { SystemClock.sleep(COUNTDOWN_SCENE_MS) }
                ticksMeasured = true
                note("  countdown ticks measured over ${COUNTDOWN_SCENE_MS / 1000} s of the attempt ${left / 1000} s out")
            }
            if (row != null && row.optString("state") == "interrupted" && !row.has("autoResumeAt") && row.optString("error").isNotEmpty()) break
            if (row != null && row.optString("state") == "completed") break
            SystemClock.sleep(250)
        }
        check(countdownLabel != null, "no row read \"$FLAKY. $RESUMING_IN…\" during the automatic resumes")
        if (!ticksMeasured) note("  (no automatic resume was caught far enough out to measure the countdown's frames)")

        val failed = awaitRow(FLAKY, 40_000) { it.optString("state") == "interrupted" && !it.has("autoResumeAt") }
        if (failed == null) {
            fail("$FLAKY never failed for good after the automatic resumes: ${rowFor(FLAKY)}")
            return
        }
        note("  engine: failed for good error=${failed.optString("error")} \"${failed.optString("errorMessage")}\" canResume=${failed.opt("canResume")} received=${failed.optLong("receivedBytes")}; the fixture killed ${secure.deaths("/$FLAKY")} responses")
        check(failed.optString("errorMessage") == "Check internet connection", "the failure's wording is not Chrome's: $failed")
        check(failed.optBoolean("canResume"), "the failed row cannot resume although the partial was kept: $failed")
        check(secure.deaths("/$FLAKY") == FLAKY_FAILURES, "the fixture killed ${secure.deaths("/$FLAKY")} responses, not $FLAKY_FAILURES")
        if (waitForRow(10_000) { rowReads(it, FLAKY, FAILED_NETWORK) } == null) fail("no row reads \"$FLAKY. $FAILED_NETWORK\"")
        note("  row: ${labelStarting("$FLAKY. ")}")
        val resume = waitFor("Resume", 5_000)
        check(resume != null, "the failed row offers no Resume")
        check(findByLabel("Retry") == null, "the failed row offers Retry beside Resume")
        note("  verbs: ${listOfNotNull(resume?.let { "Resume" }, findByLabel("Cancel")?.let { "Cancel" }).joinToString(" / ")}")
        hideKeyboard()
        snap("interrupted-resume")
        press("Resume", "download.resume", FLAKY, id) { it.optString("state") != "interrupted" }
        val uri = awaitPublished(FLAKY, FLAKY_SIZE.toLong(), 60_000)
        check(uri != null && intact(uri, FLAKY_SIZE.toLong()), "$FLAKY did not complete intact on Resume")
        val done = awaitRow(FLAKY, 10_000) { it.optString("state") == "completed" }
        check(done != null && !done.has("error"), "the failure stayed on the completed row: $done")
        note("  engine after Resume: state=${done?.optString("state")} received=${done?.optLong("receivedBytes")}; MediaStore: ${uri ?: "no file"}; ${secure.hits("/$FLAKY")} requests to the fixture in all")
        SystemClock.sleep(1_000)
        snap("resumed-complete")
    }

    // --- helpers ----------------------------------------------------------------------------------

    /** A row finished into quarantine and waiting on the user (`needsDangerDecision` in the shared helpers). */
    private fun awaitsDecision(row: JSONObject): Boolean =
        row.optJSONObject("danger")?.optString("level").let { it != null && it != "safe" } && !row.optBoolean("dangerAccepted")

    /** A finger on one of the page's links (the sheet must be down); the tree's click when the finger finds nothing. */
    private fun tapLink(label: String) {
        ensureForeground()
        if (touchTapLabel(label)) return
        Log.w(tag, "no touch went in for '$label'; clicking it")
        click(label)
    }

    /** The first label on the tree starting with `prefix`, null when none does. */
    private fun labelStarting(prefix: String): String? =
        findNode { it.startsWith(prefix) }?.let { it.contentDescription ?: it.text }?.toString()

    /** The bar's Menu button, by label, else where the default bar has it. */
    private fun menuButton(): PointF =
        waitFor(MENU_LABEL, 4_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) } ?: run {
            Log.w(tag, "menu button not in the accessibility tree; tapping the end of the bar")
            PointF(width - 28 * density, pillY)
        }

    /**
     * Undo a finger that opened the URL field instead of pressing `what` (it landed on the
     * chrome's bottom bar): the field closed the harness's way ([closeUrlField]), the outcome in
     * the notes. Nothing when the field is not open.
     */
    private fun recoverUrlField(what: String) {
        val close = closeUrlField()
        if (close == UrlFieldClose.NOT_OPEN) return
        note("  (the finger meant for $what opened the URL field; ${close.describe()})")
    }

    /** Whether `host:port` answers a connection from this process. */
    private fun reach(host: String, port: Int): String =
        runCatching { Socket(host, port).use { "reachable" } }.getOrElse { e -> "NOT reachable: $e" }

    private fun noteFrameTable() {
        note(
            "\nframe stats (DemoHarness.traceFrames: dumpsys gfxinfo ${app.packageName} reset before each scene and read after it, the chrome WebView's trace around it; " +
                "the sheet scenes read against the app menu's, a sheet main had before this PR; janky is HWUI's count of frames past their deadline, 100 % by construction on the software GPU – the verdict reads the trace columns and the ratios)"
        )
        note("  %-24s %-7s %6s %14s %5s %5s %5s %5s  %s".format(Locale.US, "scene", "kind", "frames", "janky", "p50", "p90", "p95", "p99", "verdict"))
        for (scene in frameScenes) {
            val s = scene.summary
            if (s == null) {
                note("  %-24s %-7s %s".format(Locale.US, scene.name, scene.kind.key, "not measured"))
                continue
            }
            note(
                "  %-24s %-7s %6d %14s %5d %5d %5d %5d  %s%s".format(
                    Locale.US, scene.name, scene.kind.key, s.frames, "${s.janky} (${"%.0f".format(Locale.US, s.jankyShare * 100)} %)",
                    s.p50Ms, s.p90Ms, s.p95Ms, s.p99Ms, if (scene.verdict.within) "within" else "over",
                    scene.ratio?.let { " (${it.describe()})" } ?: ""
                )
            )
            scene.trace?.let { note("  %-24s %s".format(Locale.US, "", it.describe())) }
        }
    }

    private fun snap(name: String) {
        shots++
        shot("${shots.toString().padStart(2, '0')}-$name")
        note("  shot $name")
    }

    private fun note(line: String) {
        Log.i(tag, line.trim())
        if (::notes.isInitialized) notes.appendText(line + "\n")
    }

    companion object {
        /** The loopback fixture: the page and the files a trustworthy origin serves. */
        private const val SECURE_PORT = 18931
        /** The fixture on the device's own address: the insecure origin. */
        private const val INSECURE_PORT = 18932
        private const val INSECURE = "insecure.bin"
        private const val APK = "zenium-helper.apk"
        private const val DNG = "IMG_4821.dng"
        private const val FLAKY = "flaky.bin"
        private const val INSECURE_SIZE = 512 * 1024
        private const val APK_SIZE = 384 * 1024
        private const val DNG_SIZE = 640 * 1024
        private const val FLAKY_SIZE = 1024 * 1024
        private const val FLAKY_CUT_AT = 256 * 1024
        /** The downloader's first attempt and its `MAX_AUTO_RESUMES` (3) automatic resumes. */
        private const val FLAKY_FAILURES = 4
        private const val LINK_INSECURE = "Download insecure.bin"
        private const val LINK_APK = "Download zenium-helper.apk"
        private const val LINK_DNG = "Download IMG_4821.dng"
        private const val LINK_FLAKY = "Download flaky.bin"
        /** The status lines (`lib/downloadText.ts`, the same words as the desktop's `downloadsView.ts`). */
        private const val BLOCKED_INSECURE = "Blocked \u00b7 Insecure download"
        private const val BLOCKED_DANGEROUS = "Blocked \u00b7 Dangerous"
        private const val RESUMING_IN = "Resuming in "
        /** The decision pair's words per state (`decisionLabels`). */
        private const val KEEP_ANYWAY = "Keep anyway"
        private const val DISCARD = "Discard"
        private const val KEEP = "Keep"
        private const val DELETE = "Delete"
        private const val SCENE_MENU_OPEN = "menu-sheet-open"
        private const val SCENE_MENU_CLOSE = "menu-sheet-close"
        private const val SCENE_SHEET_OPEN = "downloads-sheet-open"
        private const val SCENE_SHEET_CLOSE = "downloads-sheet-close"
        private const val SCENE_KEEP_ANYWAY = "downloads-keep-anyway"
        private const val SCENE_COUNTDOWN = "downloads-countdown-ticks"
        /** The longest a sheet's spring is given inside a scene's block (a frame nothing moves in is no frame). */
        private const val MOTION_MS = 3_000L
        /** Keep anyway's transfer of 512 KiB from the loopback lands within this; the row's change is in the scene. */
        private const val KEEP_MOTION_MS = 2_500L
        /** How long the countdown's ticking is measured for. */
        private const val COUNTDOWN_SCENE_MS = 3_000L

        /** The test page: one link per act, the insecure one absolute to the other origin. */
        private fun page(insecureUrl: String): String = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>Zenium download safety test</title>
            <style>
              body { font: 18px system-ui, sans-serif; margin: 0; padding: 24px; background: #f6f6f8; color: #111 }
              h1 { font-size: 22px; margin: 0 0 8px }
              p { margin: 0 0 20px; color: #555; font-size: 15px }
              a { display: block; margin: 14px 0; padding: 20px; border-radius: 16px; background: #4f6bed; color: #fff; text-decoration: none; font-weight: 600 }
            </style>
            <h1>Zenium download safety test</h1>
            <p>This page is served from the loopback (a potentially trustworthy origin). insecure.bin comes from the device's network address over plain http; the .apk and the .dng are dangerous types on Android; flaky.bin loses its connection four times.</p>
            <a href="$insecureUrl">$LINK_INSECURE</a>
            <a href="/$APK">$LINK_APK</a>
            <a href="/$DNG">$LINK_DNG</a>
            <a href="/$FLAKY">$LINK_FLAKY</a>
        """.trimIndent()
    }
}
