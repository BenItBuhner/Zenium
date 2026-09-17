package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.DownloadManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the Zenium downloader on an emulator and checks what lands in `MediaStore.Downloads`:
 * a throttled file paused and resumed from the downloads panel, a file whose connection the
 * server cuts halfway (resumed on our own with `Range`), a `data:` link and a `blob:` link named
 * from their anchors, the progress and completion notifications, and the files in the system
 * Downloads app. The page and the files come from a small Node server on the runner
 * (`.github/scripts/downloads-demo-server.mjs`, reached at `10.0.2.2:18923` from inside the
 * emulator), which generates every byte from the same formula as [expectedByte], so a resumed
 * file is checked byte for byte.
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
        // 1. A throttled download: the panel opens, Pause holds the bytes, Resume completes the file.
        click(LINK_SLOW)
        if (waitFor("Pause", 15_000) == null) fail("the downloads panel with a running transfer never showed")
        SystemClock.sleep(2_500)
        shot("01-in-progress")
        click("Pause")
        if (waitFor("Resume", 8_000) == null) fail("pause did not take")
        val atPause = pendingSize("slow.bin")
        SystemClock.sleep(2_500)
        val later = pendingSize("slow.bin")
        check(atPause > 0 && later == atPause, "a paused transfer kept moving ($atPause -> $later bytes)")
        Log.i(tag, "paused at $atPause bytes")
        shot("02-paused")
        click("Resume")
        val slow = awaitPublished("slow.bin", SLOW_SIZE, 60_000)
        check(slow != null && intact(slow, SLOW_SIZE), "slow.bin did not complete intact after pause and resume")
        SystemClock.sleep(1_500)
        shot("03-completed")

        // The completion notification (and the progress one before it) live in the shade.
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        SystemClock.sleep(2_500)
        shot("04-notification")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        SystemClock.sleep(1_500)
        ensureForeground()

        // 2. The server drops the connection after 1 MiB; the downloader continues with Range.
        closePanel()
        click(LINK_FLAKY)
        val flaky = awaitPublished("flaky.bin", FLAKY_SIZE, 60_000)
        check(flaky != null && intact(flaky, FLAKY_SIZE), "flaky.bin did not survive the cut connection")
        SystemClock.sleep(1_000)
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
        shot("06-data-and-blob")

        // 4. The files are ordinary downloads: the system Downloads app lists them.
        app.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        SystemClock.sleep(5_000)
        shot("07-system-downloads")
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

    /** The panel fills the content area on a phone; it must go before the next link can be tapped. */
    private fun closePanel() {
        if (findByLabel(CLOSE) != null) click(CLOSE)
        SystemClock.sleep(1_200)
    }

    private fun check(ok: Boolean, message: String) {
        if (!ok) fail(message)
    }

    private fun fail(message: String) {
        Log.e(tag, message)
        failures.add(message)
    }

    // --- what landed in MediaStore.Downloads ----------------------------------------------------

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
            val uri = app.contentResolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DISPLAY_NAME} = ?", arrayOf(name), null
            )?.use { c -> if (c.moveToFirst()) Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0).toString()) else null }
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
        const val LINK_DATA = "Download hello-data.txt"
        const val LINK_BLOB = "Download hello-blob.txt"
        const val CLOSE = "Close (Esc)"
        const val SLOW_SIZE = 3L * 1024 * 1024
        const val FLAKY_SIZE = 2L * 1024 * 1024
        const val DATA_TEXT = "Hello from a Zenium data: link\n"
        const val BLOB_TEXT = "Hello from a Zenium blob: link\n"

        /** The server's byte at `index`; the same formula on both sides. */
        fun expectedByte(index: Int): Int = (index * 31 + (index shr 8)) and 0xff
    }
}
