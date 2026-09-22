package app.zen.chromium

import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import org.json.JSONObject
import org.json.JSONTokener

/**
 * What the downloads demos share besides their sequences: driving the phone's downloads sheet
 * (`DownloadsSheet`; with a pointer it would be the shared downloads page, `DownloadRow`) and
 * reading what the downloader leaves in `MediaStore.Downloads`. [DownloadsDemo] (the transfers:
 * pause, resume, Range, data: and blob:, the failure reasons, Deleted) and [DownloadSafetyDemo]
 * (the safety states: the insecure block, the danger tiers, the auto-resume countdown) are its
 * two sequences.
 *
 * Each row's accessible node is labelled `<name>. <status>` on the accessibility tree – the
 * sheet's rows hold the name and status in one focusable node with the row's icon buttons
 * (Pause, Resume, Retry, Cancel) as its labelled siblings, the page's as its children – so a
 * driver reads a row's state from that label once the row holds still ([rowReads]; the
 * software-rendered emulator seldom serves the sheet's subtree while a row moves, and its chrome
 * WebView answers an engine call seconds late meanwhile) and presses its controls through the
 * tree when they are there, else through the engine command the control runs ([press]); the
 * engine's own list is checked over `app.getState()` either way. The sheet takes focus on its
 * first row and raises no keyboard; the page's search field would, so [hideKeyboard] still blurs
 * the chrome's focused element before the settled screenshots.
 *
 * The files' bytes come from one formula on both sides ([expectedByte]; the runner's Node server
 * and the on-device [DemoServer] fixtures generate them the same way), so a resumed or a kept
 * file is checked byte for byte ([intact]).
 */
@RequiresApi(Build.VERSION_CODES.Q)
abstract class DownloadsDemoBase(stateAsset: String, shotPrefix: String, handshakeDir: String) :
    DemoHarness(stateAsset, shotPrefix, handshakeDir) {

    protected val failures = ArrayList<String>()

    // --- driving ---------------------------------------------------------------------------------

    /**
     * Click a labelled element through the accessibility tree, else tap where it is. The tree
     * trails the screen by a second or two after a transition on the software-rendered emulator,
     * so a label that is not there yet is waited for before it counts as missing.
     */
    protected fun click(label: String) {
        if (clickByLabel(label)) return
        val where = waitFor(label, 8_000)
        if (where == null) {
            fail("nothing labelled \"$label\" on screen")
            return
        }
        if (clickByLabel(label)) return
        Finger().tap(where.exactCenterX(), where.exactCenterY())
    }

    /**
     * Press a row's control (Pause, Resume, Retry, Keep, Delete): a real touch on it when
     * `viaTree` (the sheet flow's injected touch, the rule in DemoHarness: the engine's row for
     * `name` must satisfy `took` within five seconds of the finger, else the touch did not take
     * and the run fails at its end; the command then runs so the demo goes on), the tree's click
     * for a control the tree carries without bounds on screen, and straight through the engine
     * command the control runs when the tree is not read – while a row moves, the emulator's
     * tree cannot be traversed in time (a node fetch waits on the busy WebView thread), so Pause
     * on a running transfer goes that way. Either way the row must satisfy `took` within five
     * seconds, else the command runs outright. The log says which way the press went.
     */
    protected fun press(
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
            touchTapLabelExpecting(label, "the engine's row for $name answered the control") { rowFor(name)?.let(took) == true } ->
                "a touch on the row's control"
            clickByLabel(label) -> "a click on the row's control (after a touch that did not take, or with no bounds on screen to touch)"
            else -> {
                downloadCommand(command, id)
                "$command (the control is not on the accessibility tree)"
            }
        }
        Log.i(tag, "$label: $how")
        if (awaitRow(name, 5_000, took) == null) {
            Log.i(tag, "$label did not take; running $command for the row")
            downloadCommand(command, id)
        }
    }

    /** Whether an accessibility label is the row for `name` reading `status` (a row is labelled `<name>. <status>`). */
    protected fun rowReads(label: String, name: String, status: String = ""): Boolean = label.startsWith("$name. $status")

    /** Poll for a node whose label satisfies `matches`, for up to `timeoutMs`. */
    protected fun waitForRow(timeoutMs: Long, matches: (String) -> Boolean): Rect? {
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
    protected fun logTree(why: String) {
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

    /**
     * The downloads surface must go before the next link can be tapped. Every download opens it
     * (the default setting), so it may still be on its way in when the file has already landed.
     * On a phone it is the v2 bottom sheet, which the back gesture dismisses (its header's
     * settings button is how we know it is up on the tree; the chrome's DOM says so at once
     * where the tree trails); with a pointer it is the panel with a close button. Its dismissal
     * is a spring and the frame's return, which the tree trails, so this waits for the surface
     * to be gone – off the tree and out of the DOM – rather than for a fixed time.
     */
    protected fun closePanel() {
        if (findByLabel(CLOSE) != null) {
            click(CLOSE)
        } else if (waitFor(SHEET_SETTINGS, 4_000) != null || sheetInDom()) {
            back()
        }
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline && (findAny(SHEET_SETTINGS, CLOSE) != null || sheetInDom())) {
            SystemClock.sleep(200)
        }
        SystemClock.sleep(1_200)
    }

    /** Whether a v2 sheet stands in the chrome's DOM (what the accessibility tree shows a beat later). */
    protected fun sheetInDom(): Boolean = chromeJs("!!document.querySelector('.zen-sheet')") == "true"

    /**
     * Drop the keyboard a focused field would have raised (the page's search field takes focus
     * when it opens; the sheet focuses a row, which raises none): blur the chrome's focused
     * element (what a tap outside the field does) and give the keyboard a moment to slide out.
     */
    protected fun hideKeyboard() {
        chromeJs("document.activeElement&&document.activeElement.blur&&document.activeElement.blur()")
        SystemClock.sleep(800)
    }

    protected fun check(ok: Boolean, message: String) {
        if (!ok) fail(message)
    }

    protected fun fail(message: String) {
        Log.e(tag, message)
        failures.add(message)
    }

    // --- the engine's list ----------------------------------------------------------------------

    /** The engine's row for this file (`app.getState().downloads`), null when there is none. */
    protected fun rowFor(name: String): JSONObject? {
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
    protected fun awaitRow(name: String, timeoutMs: Long, accept: (JSONObject) -> Boolean): JSONObject? {
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
    protected fun downloadCommand(command: String, id: String): Any? {
        val started = SystemClock.uptimeMillis()
        val raw = coreInvoke(command, JSONObject().put("id", id).toString())
        val value = JSONTokener(raw).nextValue()
        Log.i(tag, "$command($id) -> $raw (${SystemClock.uptimeMillis() - started} ms)")
        return if (value == JSONObject.NULL) null else value
    }

    // --- what landed in MediaStore.Downloads ----------------------------------------------------

    /** The published (not pending) row with this name, null when there is none. */
    protected fun publishedRow(name: String): Uri? =
        app.contentResolver.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DISPLAY_NAME} = ?", arrayOf(name), null
        )?.use { c -> if (c.moveToFirst()) Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0).toString()) else null }

    /** Bytes on disk of the still-pending (in-flight) row with this name, -1 when there is none. */
    protected fun pendingSize(name: String): Long {
        val uri = pendingRow(name) ?: return -1L
        return runCatching { app.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } }.getOrNull() ?: -1L
    }

    @Suppress("DEPRECATION")
    protected fun pendingRow(name: String): Uri? {
        val collection = MediaStore.setIncludePending(MediaStore.Downloads.EXTERNAL_CONTENT_URI)
        return app.contentResolver.query(
            collection, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DISPLAY_NAME} = ? AND ${MediaStore.MediaColumns.IS_PENDING} = 1", arrayOf(name), null
        )?.use { c -> if (c.moveToFirst()) Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0).toString()) else null }
    }

    /** Poll until a published (no longer pending) row with this name has `size` bytes on disk. */
    protected fun awaitPublished(name: String, size: Long, timeoutMs: Long): Uri? {
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
    protected fun intact(uri: Uri, size: Long): Boolean {
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

    protected fun text(uri: Uri): String? =
        app.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }

    companion object {
        /** The downloads page's close button (with a pointer; the phone has the sheet). */
        const val CLOSE = "Close (Esc)"
        /** The phone sheet's header button (its label): how the driver knows the sheet is up. */
        const val SHEET_SETTINGS = "Downloads settings"
        /**
         * The status line for a `network-failed` row: Chrome's wording behind `Failed ·`, the same
         * on the phone sheet and the desktop rows (`lib/downloadsView.ts`, `lib/downloadText.ts`).
         */
        const val FAILED_NETWORK = "Failed \u00b7 Check internet connection"

        /** The server's byte at `index`; the same formula on both sides. */
        fun expectedByte(index: Int): Int = (index * 31 + (index shr 8)) and 0xff

        /** `size` bytes of the servers' formula: a file the demos can check byte for byte. */
        fun formulaBytes(size: Int): ByteArray = ByteArray(size) { expectedByte(it).toByte() }
    }
}
