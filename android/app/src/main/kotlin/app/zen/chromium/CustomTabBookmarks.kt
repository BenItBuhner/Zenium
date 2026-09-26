package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject

/**
 * The star of a custom tab's menu (CCT-03), as rules over the two documents it reads.
 *
 * The bookmarks are the core's: `bookmarkTree.nodes` in `state.json`, written by the core running
 * in the browser's chrome and by nothing else. A custom tab has no core, so it READS them – a
 * bookmarked page opens with its star filled; the core's own `hasUrl` is an exact match on the
 * URL, and so is this – and FILES a tap: an inbox document of its own, [INBOX] under `files/zen/`,
 * one entry per page (`url`, `title`, `at`), for the browser to take into its bookmarks through
 * `browser.bookmarks.create` when it next runs. A pending entry counts as bookmarked (the star
 * fills at the tap); a second tap on a pending entry withdraws it. Nothing here writes the model.
 * Pure and JVM-tested; `Storage` does the reading and writing.
 */
object CustomTabBookmarks {
    /** The inbox document's name under `files/zen/`. */
    const val INBOX = "bookmarks-inbox.json"
    /** The core's state document, read for `bookmarkTree.nodes`. */
    const val STATE = "state.json"
    /** More than this many pending entries and the oldest go: a custom tab is not a bookmark store. */
    const val INBOX_CAP = 200

    data class Entry(val url: String, val title: String, val at: Long)

    /** The URLs the core's tree holds (`type: "url"`), from the state document's text; empty when unreadable. */
    fun bookmarkedUrls(stateJson: String?): Set<String> {
        val nodes = runCatching { JSONObject(stateJson ?: return emptySet()).optJSONObject("bookmarkTree")?.optJSONArray("nodes") }
            .getOrNull() ?: return emptySet()
        val urls = HashSet<String>()
        for (i in 0 until nodes.length()) {
            val node = nodes.optJSONObject(i) ?: continue
            if (node.optString("type") != "url") continue
            val url = node.optString("url")
            if (url.isNotEmpty()) urls.add(url)
        }
        return urls
    }

    /** The inbox's entries in filing order; empty when unreadable. */
    fun entries(inboxJson: String?): List<Entry> {
        val array = runCatching { JSONObject(inboxJson ?: return emptyList()).optJSONArray("entries") }.getOrNull() ?: return emptyList()
        val out = ArrayList<Entry>()
        for (i in 0 until array.length()) {
            val entry = array.optJSONObject(i) ?: continue
            val url = entry.optString("url")
            if (url.isEmpty()) continue
            out.add(Entry(url, entry.optString("title"), entry.optLong("at", 0L)))
        }
        return out
    }

    fun isBookmarked(url: String, bookmarked: Set<String>, pending: List<Entry>): Boolean =
        url in bookmarked || pending.any { it.url == url }

    /** The inbox with `entry` filed (once per URL, the newest filing kept, the oldest past [INBOX_CAP] dropped). */
    fun withEntry(pending: List<Entry>, entry: Entry): List<Entry> {
        val kept = pending.filter { it.url != entry.url } + entry
        return if (kept.size > INBOX_CAP) kept.takeLast(INBOX_CAP) else kept
    }

    /** The inbox without any entry for `url` (a second tap withdraws the pending bookmark). */
    fun withoutEntry(pending: List<Entry>, url: String): List<Entry> = pending.filter { it.url != url }

    fun serialize(pending: List<Entry>): String {
        val array = JSONArray()
        for (entry in pending) {
            array.put(JSONObject().put("url", entry.url).put("title", entry.title).put("at", entry.at))
        }
        return JSONObject().put("version", 1).put("entries", array).toString()
    }
}
