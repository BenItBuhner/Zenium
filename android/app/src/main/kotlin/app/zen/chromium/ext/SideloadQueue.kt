package app.zen.chromium.ext

import org.json.JSONArray
import org.json.JSONObject

/**
 * The packages other apps handed Zenium that the host has not collected yet
 * ([ExtensionStore.sideload]): their handles, in the order the imports landed, until the host's
 * `extStore.takeSideloads` drains them.
 *
 * Two handovers. The normal one queues the handle and announces it (`extension.sideload`), and
 * the chrome, if it is up, collects at once and asks with its own sheet; a chrome still booting
 * misses the announcement and its store's `start()` collects instead, with no window to show
 * that sheet, so the prompt is the native chassis's ([ExtensionPromptFallback]). The quiet one
 * ([ExtensionStore.EXTRA_QUIET_HANDOVER], a debuggable build's driver flag) queues without the
 * announcement so the store's `start()` is the collector whatever the chrome's boot time, and a
 * take asked while a quiet import is still copying waits for it: the import runs on the host's
 * `io` executor behind the boot's own reads, and a chrome that got to its `start()` first would
 * otherwise find the queue empty and the package would wait for the next start.
 */
class SideloadQueue {
    private val handles = ArrayList<JSONObject>()
    private var quietImports = 0
    private val takers = ArrayList<(JSONArray) -> Unit>()

    /** Handles queued and not yet taken. */
    val size: Int get() = handles.size

    /** An import began; `quiet` when the handover is the quiet one. */
    fun beginImport(quiet: Boolean) {
        if (quiet) quietImports++
    }

    /**
     * An import landed (`handle` null when the copy failed). Queues the handle and answers the
     * takes that waited on a quiet import once none is left. True when the host should hear the
     * announcement: a handle from a normal handover.
     */
    fun endImport(quiet: Boolean, handle: JSONObject?): Boolean {
        if (quiet) quietImports--
        if (handle != null) handles.add(handle)
        if (quietImports == 0 && takers.isNotEmpty()) {
            val waiting = takers.toList()
            takers.clear()
            // The first take drains; any other asked meanwhile finds what a second take finds.
            waiting.forEachIndexed { i, reply -> reply(if (i == 0) drain() else JSONArray()) }
        }
        return handle != null && !quiet
    }

    /** The host collects: everything queued, at once, or once the quiet imports in flight land. */
    fun take(reply: (JSONArray) -> Unit) {
        if (quietImports > 0) takers.add(reply) else reply(drain())
    }

    private fun drain(): JSONArray {
        val taken = JSONArray(handles)
        handles.clear()
        return taken
    }
}
