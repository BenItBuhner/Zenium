package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.DownloadManager
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the Zenium downloader on an emulator and checks what lands in `MediaStore.Downloads`:
 * a throttled file paused and resumed from the downloads sheet, a file whose connection the
 * server cuts halfway (resumed on our own with `Range`), a `data:` link and a `blob:` link named
 * from their anchors, the progress and completion notifications, a file whose server dies on
 * every attempt until the row fails with Chrome's reason and wording (`network-failed`, "Check
 * internet connection") and is completed by Resume (the server takes Range and the partial file
 * was kept), a completed file removed through `download.deleteFile` and one deleted behind the
 * browser's back (both rows read "Deleted", Retry downloads the file again), the files in
 * the system Downloads app, and the link menu's Save Link As… asking where that one file goes
 * through the system's save dialog while ask-where-to-save is off (HB-40: the menu's `saveAs`
 * over `view.download`, `Downloads.bind`'s one-download ask). The page and the files come from a small Node server on the runner
 * (`.github/scripts/downloads-demo-server.mjs`, reached at `10.0.2.2:18923` from inside the
 * emulator), which generates every byte from the same formula as [expectedByte], so a resumed
 * file is checked byte for byte. The server speaks plain HTTP, so the seeded profile turns
 * HTTPS-only mode off; at its default "ask" the first navigation would stop on the upgrade's
 * interstitial instead of the page.
 *
 * The surface on screen is the phone's downloads sheet; how its rows are read and pressed, and
 * how the files are found in `MediaStore.Downloads`, is [DownloadsDemoBase], shared with
 * [DownloadSafetyDemo] (the safety states of the same sheet, from fixtures on the device).
 *
 * Run from the dispatch-only workflow `.github/workflows/android-downloads-demo.yml`, a caller of
 * the shared `android-emulator-demo.yml` that starts the server from `setup-script` and hands the
 * driver `DEMO_CLASS=app.zen.chromium.DownloadsDemo`. See [DemoHarness] for the recorder handshake.
 */
@RequiresApi(Build.VERSION_CODES.Q)
@RunWith(AndroidJUnit4::class)
class DownloadsDemo : DownloadsDemoBase("downloads-demo-state.json", "downloads", "downloads-demo") {
    override val tag = "DownloadsDemo"

    @Test
    fun record() {
        runDemo()
        if (failures.isNotEmpty()) error("downloads demo failed: ${failures.joinToString("; ")}")
    }

    /** The test page must be up before the recorder rolls. */
    override fun warmUp() {
        waitFor(LINK_SLOW, 45_000) ?: error("the test page never showed its links (is the server on the runner up?)")
        beat()
    }

    override fun demo() {
        // 1. A throttled download: the sheet opens on the transfer, Pause holds the bytes, Resume
        //    completes the file. While the row moves the emulator's chrome WebView is busy
        //    repainting it, so every engine call may wait seconds and the accessibility tree
        //    cannot be traversed in time: the running row is the engine's word plus the screenshot
        //    and the recording, Pause goes through the engine once the row holds a second's worth
        //    of bytes (a sheet that is cheap to drive would otherwise pause before the first chunk
        //    landed, leaving nothing on disk to measure), and the tree is read once the row holds
        //    still ("slow.bin. Paused · <received> of 3.0 MB").
        val tapped = SystemClock.uptimeMillis()
        click(LINK_SLOW)
        val running = awaitRow("slow.bin", 20_000) {
            it.optString("state") == "progressing" && it.optLong("receivedBytes") >= SLOW_RATE
        }
        val slowId = (running ?: rowFor("slow.bin"))?.optString("id").orEmpty()
        check(slowId.isNotEmpty(), "slow.bin never started downloading")
        shot("01-in-progress")
        press("Pause", "download.pause", "slow.bin", slowId, viaTree = false) { it.optString("state") == "paused" }
        Log.i(tag, "Pause reached the engine ${SystemClock.uptimeMillis() - tapped} ms after the link was tapped")
        hideKeyboard()
        if (waitForRow(15_000) { rowReads(it, "slow.bin", "Paused") } == null) {
            fail("the panel did not show the paused row (\"slow.bin. Paused · … of 3.0 MB\")")
        }
        logTree("the panel with the paused transfer")
        val atPause = pendingSize("slow.bin")
        SystemClock.sleep(2_500)
        val later = pendingSize("slow.bin")
        check(atPause > 0 && later == atPause, "a paused transfer kept moving ($atPause -> $later bytes)")
        Log.i(tag, "paused at $atPause bytes")
        shot("02-paused")
        press("Resume", "download.resume", "slow.bin", slowId) { it.optString("state") != "paused" }
        val slow = awaitPublished("slow.bin", SLOW_SIZE, 90_000)
        check(slow != null && intact(slow, SLOW_SIZE), "slow.bin did not complete intact after pause and resume")
        SystemClock.sleep(1_500)
        hideKeyboard()
        shot("03-completed")

        // The completion notification (and the progress one before it) live in the shade.
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        SystemClock.sleep(2_500)
        shot("04-notification")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(1_500)
        ensureForeground()

        // 2. The server drops the downloader's connection after 1 MiB; it continues with Range.
        closePanel()
        click(LINK_FLAKY)
        val flaky = awaitPublished("flaky.bin", FLAKY_SIZE, 60_000)
        check(flaky != null && intact(flaky, FLAKY_SIZE), "flaky.bin did not survive the cut connection")
        SystemClock.sleep(1_000)
        hideKeyboard()
        shot("05-flaky-resumed")

        // 3. data: and blob: links, named from their anchors.
        closePanel()
        click(LINK_DATA)
        val data = awaitPublished("hello-data.txt", DATA_TEXT.length.toLong(), 20_000)
        check(data != null && text(data) == DATA_TEXT, "the data: download is missing or wrong")
        closePanel()
        click(LINK_BLOB)
        val blob = awaitPublished("hello-blob.txt", BLOB_TEXT.length.toLong(), 30_000)
        check(blob != null && text(blob) == BLOB_TEXT, "the blob: download is missing or wrong")
        SystemClock.sleep(1_500)
        hideKeyboard()
        shot("06-data-and-blob")

        // 4. The server dies on the downloader's first dead.bin attempt and on each of its three
        //    automatic resumes (`DownloadLogic.MAX_AUTO_RESUMES`; the row counts down `Resuming
        //    in N s…` to each, HB-43 – an interrupted row with `autoResumeAt`), so the fourth
        //    failure leaves the row interrupted for good, with the reason the engine mapped the
        //    failure to and Chrome's wording for it. The server takes Range and the failure kept
        //    the partial file, so the row offers Resume (as Chrome's does; Retry is for the
        //    rest), and the server serves that response whole. Some twenty seconds from the tap
        //    (the 2 + 4 + 8 s of back-off and four short attempts).
        closePanel()
        click(LINK_DEAD)
        val failed = awaitRow("dead.bin", 120_000) { restsInterrupted(it) }
        check(
            failed != null && failed.optString("error") == "network-failed" &&
                failed.optString("errorMessage") == "Check internet connection",
            "dead.bin did not fail as network-failed / Check internet connection: $failed"
        )
        hideKeyboard()
        if (waitForRow(8_000) { rowReads(it, "dead.bin", FAILED_NETWORK) } == null) fail("no row reads \"$FAILED_NETWORK\"")
        shot("07-failed-network")
        val resumable = failed?.optBoolean("canResume") == true
        press(
            if (resumable) "Resume" else "Retry", if (resumable) "download.resume" else "download.retry",
            "dead.bin", failed?.optString("id").orEmpty()
        ) { it.optString("state") != "interrupted" }
        val dead = awaitPublished("dead.bin", DEAD_SIZE, 60_000)
        check(dead != null && intact(dead, DEAD_SIZE), "dead.bin did not complete intact after the failure")
        val retried = awaitRow("dead.bin", 10_000) { it.optString("state") == "completed" }
        check(retried != null && !retried.has("error") && !retried.has("errorMessage"), "the failure stayed on the completed row: $retried")
        SystemClock.sleep(1_000)
        shot("08-retried")

        // 5. The file on disk. download.deleteFile removes flaky.bin through the MediaStore uri the
        //    downloader recorded and greys its row "Deleted" (a second call finds it missing);
        //    slow.bin deleted behind the browser's back (the Files app, say) is caught by
        //    download.exists; Retry downloads the deleted file again into the same row.
        val flakyId = rowFor("flaky.bin")?.optString("id").orEmpty()
        val deleted = downloadCommand("download.deleteFile", flakyId)
        check(deleted == "deleted", "download.deleteFile answered $deleted for flaky.bin")
        check(publishedRow("flaky.bin") == null, "flaky.bin is still in MediaStore.Downloads after download.deleteFile")
        check(downloadCommand("download.deleteFile", flakyId) == "missing", "a second download.deleteFile did not answer missing")
        check(rowFor("flaky.bin")?.optBoolean("fileMissing") == true, "flaky.bin's row is not marked fileMissing")
        check(slow != null && app.contentResolver.delete(slow, null, null) == 1, "could not delete slow.bin behind the browser's back")
        check(downloadCommand("download.exists", slowId) == false, "download.exists still finds the deleted slow.bin")
        check(rowFor("slow.bin")?.optBoolean("fileMissing") == true, "slow.bin's row is not marked fileMissing")
        if (waitForRow(8_000) { rowReads(it, "flaky.bin", "Deleted") } == null) fail("flaky.bin's row does not read \"Deleted\"")
        if (waitForRow(8_000) { rowReads(it, "slow.bin", "Deleted") } == null) fail("slow.bin's row does not read \"Deleted\"")
        SystemClock.sleep(1_000)
        shot("09-deleted")
        downloadCommand("download.retry", slowId)
        val slowAgain = awaitPublished("slow.bin", SLOW_SIZE, 90_000)
        check(slowAgain != null && intact(slowAgain, SLOW_SIZE), "the deleted slow.bin did not download again intact on Retry")
        val slowRow = awaitRow("slow.bin", 10_000) { it.optString("state") == "completed" && !it.has("fileMissing") }
        check(slowRow != null && slowRow.optString("id") == slowId, "Retry did not clear fileMissing on slow.bin's row: ${rowFor("slow.bin")}")
        check(rowFor("flaky.bin")?.optBoolean("fileMissing") == true, "flaky.bin's row lost its Deleted state")
        SystemClock.sleep(1_000)
        shot("10-retried-after-delete")

        // 6. The files are ordinary downloads: the system Downloads app lists them.
        app.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        SystemClock.sleep(5_000)
        shot("11-system-downloads")
        app.startActivity(
            Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
        SystemClock.sleep(2_500)

        // 7. Save Link As… (HB-40): the link menu's row asks where that one file goes – the
        //    system's save dialog (`ACTION_CREATE_DOCUMENT`) – with ask-where-to-save off (the
        //    seeded profile's default), as Chrome's per-file dialog does. The link's menu is
        //    raised by the view's own `contextMenu` event for flaky.bin's link (a finger's long
        //    press on the emulator becomes a text selection as often as a menu; ExtensionDemo
        //    notes the same), the row under a real touch. Saving through the dialog writes the
        //    document the picker made and the row completes on it: flaky.bin whole again (the
        //    server's cut was its second response; this one is its third), under the name the
        //    dialog kept, into the folder it opened on. Without a Save button to touch (another
        //    picker), the dialog is dismissed instead and the row reads cancelled – no download.
        closePanel()
        ensureForeground()
        val flakyBefore = rowFor("flaky.bin")?.optString("id").orEmpty()
        val linkTab = activeCoreTab()?.optString("id").orEmpty()
        check(linkTab.isNotEmpty(), "no active tab to raise the link menu on")
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.viewEvent(
                linkTab, "contextMenu",
                JSONObject().put("linkURL", "$ORIGIN/flaky.bin").put("linkText", LINK_FLAKY).put("srcURL", "").put("mediaType", "none").put("x", 120).put("y", 300)
            )
        }
        if (waitFor(SAVE_LINK_AS, 8_000) == null) {
            fail("the link menu did not offer \"$SAVE_LINK_AS\"")
        } else {
            SystemClock.sleep(1_000)
            shot("12-link-menu")
            click(SAVE_LINK_AS)
            // DocumentsUI's button reads SAVE (its text in capitals on the API 34 image); the
            // finger goes where the tree puts it.
            val save = waitFor({ it.equals("Save", ignoreCase = true) }, 15_000)
            check(save != null, "Save Link As… did not open the system's save dialog (no Save button on screen)")
            SystemClock.sleep(1_500)
            shot("13-save-dialog")
            if (save != null) {
                Finger().tap(save.exactCenterX(), save.exactCenterY())
                // A file of the name already in the folder: DocumentsUI asks before it overwrites.
                waitFor({ it.equals("OK", ignoreCase = true) || it.equals("Overwrite", ignoreCase = true) }, 3_000)
                    ?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
                val saved = awaitRow("flaky.bin", 60_000) { it.optString("id") != flakyBefore && it.optString("state") == "completed" }
                check(saved != null, "the download through the save dialog did not complete: ${rowFor("flaky.bin")}")
                check(
                    saved?.optString("savePath")?.startsWith("content:") == true,
                    "the row does not point at the picker's document: ${saved?.optString("savePath")}"
                )
                SystemClock.sleep(1_500)
                hideKeyboard()
                shot("14-saved-through-dialog")
            } else {
                ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                val cancelled = awaitRow("flaky.bin", 20_000) { it.optString("id") != flakyBefore && it.optString("state") == "cancelled" }
                check(cancelled != null, "dismissing the save dialog did not cancel the download: ${rowFor("flaky.bin")}")
            }
        }
        Log.i(tag, if (failures.isEmpty()) "all checks passed" else "failures: $failures")
    }

    companion object {
        /** The server as the emulator reaches it (`setup-script` of the workflow starts it on the runner). */
        const val ORIGIN = "http://10.0.2.2:18923"
        /** The link menu's row (core `menus.ts`, the link's transfer group). */
        const val SAVE_LINK_AS = "Save Link As\u2026"
        const val LINK_SLOW = "Download slow.bin"
        const val LINK_FLAKY = "Download flaky.bin"
        const val LINK_DEAD = "Download dead.bin"
        const val LINK_DATA = "Download hello-data.txt"
        const val LINK_BLOB = "Download hello-blob.txt"
        const val SLOW_SIZE = 3L * 1024 * 1024
        /** The server's throttle on slow.bin (`SLOW_RATE` in downloads-demo-server.mjs): a second of it. */
        const val SLOW_RATE = 64L * 1024
        const val FLAKY_SIZE = 2L * 1024 * 1024
        const val DEAD_SIZE = 1L * 1024 * 1024
        const val DATA_TEXT = "Hello from a Zenium data: link\n"
        const val BLOB_TEXT = "Hello from a Zenium blob: link\n"
    }
}
