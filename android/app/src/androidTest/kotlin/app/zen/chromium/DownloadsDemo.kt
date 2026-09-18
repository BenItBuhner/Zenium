package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.DownloadManager
import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the Zenium downloader on an emulator and checks what lands in `MediaStore.Downloads`:
 * a throttled file paused and resumed from the downloads panel, a file whose connection the
 * server cuts halfway (resumed on our own with `Range`), a `data:` link and a `blob:` link named
 * from their anchors, the progress and completion notifications, a file whose server dies on
 * every attempt until the row fails with Chrome's reason and wording (`network-failed`, "Check
 * internet connection") and is completed by Resume (the server takes Range and the partial file
 * was kept), a completed file removed through `download.deleteFile` and one deleted behind the
 * browser's back (both rows read "Deleted", Retry downloads the file again), and the files in
 * the system Downloads app. The page and the files come from a small Node server on the runner
 * (`.github/scripts/downloads-demo-server.mjs`, reached at `10.0.2.2:18923` from inside the
 * emulator), which generates every byte from the same formula as [expectedByte], so a resumed
 * file is checked byte for byte.
 *
 * The panel on screen is the shared downloads page (`DownloadRow`): each row is one focusable
 * node labelled `<name>. <status>` on the accessibility tree with its controls as children, so
 * the driver reads a row's state from that label once the row holds still ([rowReads]; the
 * software-rendered emulator seldom serves the panel's subtree while a row moves, and its chrome
 * WebView answers an engine call seconds late meanwhile) and presses its controls through the
 * tree when they are there, else through the engine command the control runs ([press]); the
 * engine's own list is checked over `app.getState()` either way. The panel's search field takes
 * focus when it opens and the emulator raises the keyboard over the page; [hideKeyboard] drops it
 * before the settled screenshots.
 *
 * Run from the dispatch-only workflow `.github/workflows/android-downloads-demo.yml`, a caller of
 * the shared `android-emulator-demo.yml` that starts the server from `setup-script` and hands the
 * driver `DEMO_CLASS=app.zen.chromium.DownloadsDemo`. See [DemoHarness] for the recorder handshake.
 */
@RequiresApi(Build.VERSION_CODES.Q)
@RunWith(AndroidJUnit4::class)
class DownloadsDemo : DemoHarness("downloads-demo-state.json", "downloads", "downloads-demo") {
    override val tag = "DownloadsDemo"

    private val failures = ArrayList<String>()

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
        // 1. A throttled download: the panel opens on the transfer, Pause holds the bytes, Resume
        //    completes the file. While the row moves the emulator's chrome WebView is busy
        //    repainting it, so every engine call waits seconds and the accessibility tree cannot
        //    be traversed in time: the running row is the engine's word plus the screenshot and
        //    the recording, Pause goes through the engine the moment the row exists, and the tree
        //    is read once the row holds still ("slow.bin. Paused · <received> of 3.0 MB").
        val tapped = SystemClock.uptimeMillis()
        click(LINK_SLOW)
        val slowId = awaitRow("slow.bin", 20_000) { it.optString("state") == "progressing" }?.optString("id").orEmpty()
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

        // 4. The server dies on the downloader's first dead.bin attempt and on each of its five
        //    resumes, so the row fails with the reason the engine mapped the failure to and
        //    Chrome's wording for it. The server takes Range and the failure kept the partial
        //    file, so the row offers Resume (as Chrome's does; Retry is for the rest), and the
        //    server serves that response whole.
        closePanel()
        click(LINK_DEAD)
        val failed = awaitRow("dead.bin", 120_000) { it.optString("state") == "interrupted" }
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
        Log.i(tag, if (failures.isEmpty()) "all checks passed" else "failures: $failures")
    }

    // --- driving ---------------------------------------------------------------------------------

    /** Click a labelled element through the accessibility tree, else tap where it is. */
    private fun click(label: String) {
        if (clickByLabel(label)) return
        val where = findByLabel(label)
        if (where == null) {
            fail("nothing labelled \"$label\" on screen")
            return
        }
        Finger().tap(where.exactCenterX(), where.exactCenterY())
    }

    /**
     * Press a row's control (Pause, Resume, Retry): through the accessibility tree (a click on
     * the node, else a touch on its bounds) when `viaTree`, else straight through the engine
     * command the control runs – while a row moves, the emulator's tree cannot be traversed in
     * time (a node fetch waits on the busy WebView thread), so Pause on a running transfer goes
     * that way. Either way the engine's row for `name` must satisfy `took` within five seconds,
     * else the command runs outright. The log says which way the press went.
     */
    private fun press(
        label: String,
        command: String,
        name: String,
        id: String,
        viaTree: Boolean = true,
        took: (JSONObject) -> Boolean
    ) {
        val how = when {
            !viaTree -> {
                downloadCommand(command, id)
                "$command (the row is moving; the tree is not read)"
            }
            clickByLabel(label) -> "a click on the row's control"
            else -> {
                val where = findByLabel(label)
                if (where != null) {
                    Finger().tap(where.exactCenterX(), where.exactCenterY())
                    "a touch on the row's control at $where"
                } else {
                    downloadCommand(command, id)
                    "$command (the control is not on the accessibility tree)"
                }
            }
        }
        Log.i(tag, "$label: $how")
        if (awaitRow(name, 5_000, took) == null) {
            Log.i(tag, "$label did not take; running $command for the row")
            downloadCommand(command, id)
        }
    }

    /** Whether an accessibility label is the row for `name` reading `status` (a row is labelled `<name>. <status>`). */
    private fun rowReads(label: String, name: String, status: String = ""): Boolean = label.startsWith("$name. $status")

    /** Poll for a node whose label satisfies `matches`, for up to `timeoutMs`. */
    private fun waitForRow(timeoutMs: Long, matches: (String) -> Boolean): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findNode(matches)?.let { node -> return Rect().also { node.getBoundsInScreen(it) } }
            SystemClock.sleep(200)
        }
        return null
    }

    /**
     * The labelled nodes of the active window, breadth first, in the run's log: how the panel's
     * rows and their controls reach the accessibility tree (what [press] finds or does not).
     */
    private fun logTree(why: String) {
        val root = ui.rootInActiveWindow ?: return
        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        queue.add(root to 0)
        var lines = 0
        Log.i(tag, "accessibility tree, $why:")
        while (queue.isNotEmpty() && lines < 80) {
            val (node, depth) = queue.removeFirst()
            val label = node.contentDescription?.toString() ?: node.text?.toString()
            if (!label.isNullOrEmpty()) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val flags = listOfNotNull(
                    "clickable".takeIf { node.isClickable },
                    "focusable".takeIf { node.isFocusable },
                    "${node.childCount} children".takeIf { node.childCount > 0 }
                ).joinToString(" ")
                Log.i(tag, "  ${"  ".repeat(depth)}${node.className?.toString()?.substringAfterLast('.')} \"$label\" $flags $bounds")
                lines++
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it to depth + 1) }
        }
    }

    /** The panel fills the content area on a phone; it must go before the next link can be tapped. */
    private fun closePanel() {
        if (findByLabel(CLOSE) != null) click(CLOSE)
        SystemClock.sleep(1_200)
    }

    /**
     * Drop the keyboard the panel's search field raised when it took focus: blur the chrome's
     * focused element (what a tap outside the field does) and give the keyboard a moment to slide out.
     */
    private fun hideKeyboard() {
        chromeJs("document.activeElement&&document.activeElement.blur&&document.activeElement.blur()")
        SystemClock.sleep(800)
    }

    private fun check(ok: Boolean, message: String) {
        if (!ok) fail(message)
    }

    private fun fail(message: String) {
        Log.e(tag, message)
        failures.add(message)
    }

    // --- the engine's list ----------------------------------------------------------------------

    /** The engine's row for this file (`app.getState().downloads`), null when there is none. */
    private fun rowFor(name: String): JSONObject? {
        val rows = coreState().optJSONArray("downloads") ?: return null
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            if (row.optString("filename") == name) return row
        }
        return null
    }

    /**
     * Poll the engine until its row for `name` satisfies `accept`; null (logged) when it never
     * does. The log says how long the wait was and how many state reads it took: a read of the
     * state is an `evaluateJavascript` on the chrome WebView, seconds long while a row moves.
     */
    private fun awaitRow(name: String, timeoutMs: Long, accept: (JSONObject) -> Boolean): JSONObject? {
        val started = SystemClock.uptimeMillis()
        val deadline = started + timeoutMs
        var reads = 0
        while (SystemClock.uptimeMillis() < deadline) {
            val row = rowFor(name)
            reads++
            if (row != null && accept(row)) {
                Log.i(tag, "$name reached the expected state after ${SystemClock.uptimeMillis() - started} ms ($reads state reads)")
                return row
            }
            SystemClock.sleep(500)
        }
        Log.e(tag, "$name never reached the expected state in ${timeoutMs} ms ($reads state reads); last row ${rowFor(name)}")
        return null
    }

    /** A `download.*` command on one row; the JSON value it resolved with (a string, a boolean, null). */
    private fun downloadCommand(command: String, id: String): Any? {
        val started = SystemClock.uptimeMillis()
        val raw = coreInvoke(command, JSONObject().put("id", id).toString())
        val value = JSONTokener(raw).nextValue()
        Log.i(tag, "$command($id) -> $raw (${SystemClock.uptimeMillis() - started} ms)")
        return if (value == JSONObject.NULL) null else value
    }

    // --- what landed in MediaStore.Downloads ----------------------------------------------------

    /** The published (not pending) row with this name, null when there is none. */
    private fun publishedRow(name: String): Uri? =
        app.contentResolver.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DISPLAY_NAME} = ?", arrayOf(name), null
        )?.use { c -> if (c.moveToFirst()) Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0).toString()) else null }

    /** Bytes on disk of the still-pending (in-flight) row with this name, -1 when there is none. */
    private fun pendingSize(name: String): Long {
        val uri = pendingRow(name) ?: return -1L
        return runCatching { app.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: -1L
    }

    @Suppress("DEPRECATION")
    private fun pendingRow(name: String): Uri? {
        val collection = MediaStore.setIncludePending(MediaStore.Downloads.EXTERNAL_CONTENT_URI)
        return app.contentResolver.query(
            collection, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.IS_PENDING} = 1", arrayOf(name), null
        )?.use { c -> if (c.moveToFirst()) Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0).toString()) else null }
    }

    /** Poll until a published (no longer pending) row with this name has `size` bytes on disk. */
    private fun awaitPublished(name: String, size: Long, timeoutMs: Long): Uri? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val uri = publishedRow(name)
            if (uri != null) {
                val onDisk = runCatching { app.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: -1L
                if (onDisk == size) {
                    Log.i(tag, "$name published as $uri ($onDisk bytes)")
                    return uri
                }
            }
            SystemClock.sleep(400)
        }
        Log.e(tag, "$name never reached $size published bytes")
        return null
    }

    /** Every byte matches the server's formula: the file was neither truncated nor stitched wrongly. */
    private fun intact(uri: Uri, size: Long): Boolean {
        val input = app.contentResolver.openInputStream(uri) ?: return false
        var index = 0
        val buffer = ByteArray(64 * 1024)
        input.use {
            while (true) {
                val n = it.read(buffer)
                if (n < 0) break
                for (i in 0 until n) {
                    if ((buffer[i].toInt() and 0xff) != expectedByte(index)) {
                        Log.e(tag, "byte $index of $uri is wrong")
                        return false
                    }
                    index++
                }
            }
        }
        return index.toLong() == size
    }

    private fun text(uri: Uri): String? =
        app.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }

    companion object {
        const val LINK_SLOW = "Download slow.bin"
        const val LINK_FLAKY = "Download flaky.bin"
        const val LINK_DEAD = "Download dead.bin"
        const val LINK_DATA = "Download hello-data.txt"
        const val LINK_BLOB = "Download hello-blob.txt"
        const val CLOSE = "Close (Esc)"
        /** The panel's status line for a `network-failed` row: Chrome's wording behind "Failed –". */
        const val FAILED_NETWORK = "Failed \u2013 Check internet connection"
        const val SLOW_SIZE = 3L * 1024 * 1024
        const val FLAKY_SIZE = 2L * 1024 * 1024
        const val DEAD_SIZE = 1L * 1024 * 1024
        const val DATA_TEXT = "Hello from a Zenium data: link\n"
        const val BLOB_TEXT = "Hello from a Zenium blob: link\n"

        /** The server's byte at `index`; the same formula on both sides. */
        fun expectedByte(index: Int): Int = (index * 31 + (index shr 8)) and 0xff
    }
}
