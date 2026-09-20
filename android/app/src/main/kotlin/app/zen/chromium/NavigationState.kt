package app.zen.chromium

import android.os.Bundle
import android.os.Parcel
import android.util.Log
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * A tab's back/forward stack in the core's shape (`NavigationSnapshot`: the entries, which one
 * is current, and – Android's own – the opaque `hostState` a fresh WebView rebuilds the stack
 * from), and the way back from it. `TabWebView` reads the list and pushes it to the core as
 * `historyChanged`; `Host.kt` answers `view.navigationEntries`, `view.navigationHostState`,
 * `view.goToIndex` and `view.restoreNavigation` with it (the contract is the services program's
 * navigation-snapshot note; the TypeScript side is `src/android/views.ts`).
 *
 * `hostState` is `WebView.saveState`'s bundle marshalled with a `Parcel` and base64-encoded
 * behind [HOST_STATE_PREFIX]. It is written only by the host that reads it: a string without
 * the prefix (desktop's, a synced one, garbage) is never unmarshalled; one over [HOST_STATE_MAX]
 * is never sent (the core keeps the same bound, and a restore without it has the core load the
 * current entry); a private tab's is never produced. Nothing of its content is logged.
 *
 * The internal pages (`zen://…`, rendered by `loadDataWithBaseURL`) sit in the WebView's list
 * as `data:` URLs carrying their whole HTML; the snapshot's entries name them by the URL the
 * view showed for them ([publicUrl]), which is what the core, the session store and the back
 * list want, and what keeps the document out of the entries. Not out of `hostState`: `saveState`
 * pickles every entry's URL, an internal page's document with it, so a stack holding a large
 * one (the new tab page, an error page, a long reader page) is over [HOST_STATE_MAX] once
 * encoded, no state goes out for it, and that tab restores URL-only – the core loads the
 * current entry. A reader page of ordinary length fits.
 */
object NavigationState {
    /** The longest `hostState` string that leaves the host (`sanitizeSnapshot` in the core keeps the same bound). */
    const val HOST_STATE_MAX = 64 * 1024

    /** Zenium's WebView state, encoding 1; a string that does not start with it is not ours. */
    const val HOST_STATE_PREFIX = "zwv1:"

    /** A `data:` entry the view never showed under another URL is kept verbatim up to this length. */
    const val DATA_URL_KEEP_MAX = 2048

    /** What a `data:` entry too long to keep becomes in the snapshot. */
    const val BLANK_URL = "about:blank"

    /** The internal pages' scheme: what the view shows for a `loadDataWithBaseURL` document of the chrome's. */
    const val INTERNAL_URL_PREFIX = "zen://"

    /** How many internal pages a tab remembers the `data:` URL of (a stack rarely holds more). */
    const val INTERNAL_URLS_MAX = 32

    private const val TAG = "ZenNavState"

    /** One entry as the list reports it (`WebHistoryItem`), before [publicUrl] is applied. */
    class Item(val url: String, val title: String?, val originalUrl: String?)

    /** `{ entries: [], index: -1 }`: a tab without a WebView, or one with nothing in its list yet. */
    fun emptySnapshot(): JSONObject = json("entries" to JSONArray(), "index" to -1)

    /**
     * `{ entries: [{ url, title, originalUrl? }], index }`. `originalUrl` goes along only where it
     * says something the URL does not (the address a redirect was requested at); `resolve` maps
     * each list URL to the one the snapshot names ([publicUrl]).
     */
    fun snapshotJson(items: List<Item>, currentIndex: Int, resolve: (String) -> String = { it }): JSONObject {
        val entries = JSONArray()
        for (item in items) {
            val url = resolve(item.url)
            val entry = json("url" to url, "title" to (item.title ?: ""))
            val original = item.originalUrl?.let(resolve)
            if (!original.isNullOrEmpty() && original != url) entry.put("originalUrl", original)
            entries.put(entry)
        }
        val index = if (items.isEmpty()) -1 else currentIndex.coerceIn(0, items.size - 1)
        return json("entries" to entries, "index" to index)
    }

    /** The URL of `entries[index]` in a `view.restoreNavigation` payload, or null when there is none. */
    fun currentUrl(entries: JSONArray, index: Int): String? {
        if (index < 0 || index >= entries.length()) return null
        return entries.optJSONObject(index)?.strOrNull("url")?.takeIf { it.isNotEmpty() }
    }

    /** The URLs of a `view.restoreNavigation` payload's entries, in order ("" for a malformed one). */
    fun entryUrls(entries: JSONArray): List<String> =
        (0 until entries.length()).map { entries.optJSONObject(it)?.strOrNull("url") ?: "" }

    // --- hostState ------------------------------------------------------------------------------

    /** The most bundle bytes whose encoding fits under [HOST_STATE_MAX] with the prefix (four chars per three bytes). */
    val HOST_STATE_BYTES_MAX = (HOST_STATE_MAX - HOST_STATE_PREFIX.length) / 4 * 3

    /**
     * The marshalled bundle as the string the core carries, or null when that would be over
     * [HOST_STATE_MAX]. A bundle that cannot fit is known from its size, before it is encoded:
     * the mirror is refreshed on every commit, and a long stack's state runs to hundreds of KB.
     */
    fun encodeHostState(bytes: ByteArray): String? {
        if (bytes.size > HOST_STATE_BYTES_MAX) return null
        val text = HOST_STATE_PREFIX + Base64.getEncoder().encodeToString(bytes)
        return if (text.length > HOST_STATE_MAX) null else text
    }

    /**
     * The bundle's bytes out of a `hostState` string, or null for anything that is not one of
     * ours: no prefix, over the bound, or not base64 (nothing of the string is logged).
     */
    fun decodeHostState(text: String?): ByteArray? {
        if (text == null || text.length > HOST_STATE_MAX || !text.startsWith(HOST_STATE_PREFIX)) return null
        val body = text.substring(HOST_STATE_PREFIX.length)
        if (body.isEmpty()) return null
        return try {
            Base64.getDecoder().decode(body)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /**
     * `view`'s `saveState` bundle as a `hostState` string: null for a private tab (nothing of a
     * private session is written anywhere), for a view with nothing to save, and for a state
     * that would not fit under [HOST_STATE_MAX] once encoded – the restore then loads the current
     * URL instead. Main thread.
     */
    fun hostStateOf(view: WebView, private: Boolean): String? {
        if (private) return null
        val bundle = Bundle()
        val saved = try {
            view.saveState(bundle)
        } catch (e: Exception) {
            Log.w(TAG, "saveState failed: ${e.javaClass.simpleName}")
            null
        }
        if (saved == null || saved.size == 0 || bundle.isEmpty) return null
        return encodeHostState(marshall(bundle))
    }

    /** The bundle's bytes, the way a `Parcel` writes it. */
    fun marshall(bundle: Bundle): ByteArray {
        val parcel = Parcel.obtain()
        try {
            parcel.writeBundle(bundle)
            return parcel.marshall()
        } finally {
            parcel.recycle()
        }
    }

    /**
     * A bundle out of [marshall]'s bytes, or null when they do not read as one. The bytes came
     * from the profile, so nothing about them is trusted: a length field that asks for more
     * than there is fails inside the platform's reader, and that failure – whatever it is –
     * only means there is no bundle.
     */
    @Suppress("TooGenericExceptionCaught")
    fun bundleOf(bytes: ByteArray): Bundle? {
        if (bytes.isEmpty()) return null
        val parcel = Parcel.obtain()
        return try {
            parcel.unmarshall(bytes, 0, bytes.size)
            parcel.setDataPosition(0)
            val bundle = parcel.readBundle(Bundle::class.java.classLoader) ?: return null
            // A bundle unparcels its map on first use: here, where a bad value is caught, rather
            // than inside the WebView; one with nothing in it is no state either.
            if (bundle.isEmpty) null else bundle
        } catch (e: Throwable) {
            Log.i(TAG, "hostState does not unmarshall: ${e.javaClass.simpleName}")
            null
        } finally {
            parcel.recycle()
        }
    }

    // --- restore and traversal ------------------------------------------------------------------

    /**
     * Whether the list `restoreState` gave back (`items`: its URLs, `currentIndex`) is the one
     * the snapshot describes (`entries`: the URLs the core names them by, `index`): as long,
     * current at the same place, and at every position the item is the entry, or its
     * `data:` document is the internal entry's ([standsInForInternal]). Read off the two lists
     * alone: not off `getUrl()`, the view's word on its visible entry, which has a timing of its
     * own right after a restore. The core hands `hostState` over only with the whole list it was
     * taken with (`sanitizeSnapshot` drops it when an entry went), so position for position is
     * the test; a list that fails it is not restored, and the core loads the current entry.
     */
    fun restoredMatches(items: List<String?>, currentIndex: Int, entries: List<String>, index: Int): Boolean {
        if (entries.isEmpty() || items.size != entries.size || currentIndex != index) return false
        return items.indices.all { i ->
            val item = items[i]
            !item.isNullOrEmpty() && (item == entries[i] || standsInForInternal(item, entries[i]))
        }
    }

    /**
     * Whether `itemUrl`, a list item's URL, is the document of the internal entry the snapshot
     * names `entryUrl`: a `data:` URL where the snapshot has a `zen://` page ([publicUrl] gave
     * it the name the view showed) or [BLANK_URL] (a `data:` page nobody remembered the name of).
     */
    fun standsInForInternal(itemUrl: String, entryUrl: String): Boolean =
        itemUrl.startsWith("data:") && (entryUrl.startsWith(INTERNAL_URL_PREFIX) || entryUrl == BLANK_URL)

    /**
     * The names of the internal pages in a restored list, from the snapshot's entries: the key
     * of each `data:` item's URL ([dataUrlKey]) to the `zen://` URL the entry at its position
     * names it by, the way the view that saved the list remembered them (`internalUrls`), so the
     * fresh view names them the same from its first push. Positions that do not match are skipped.
     */
    fun internalNamesOf(items: List<String?>, entries: List<String>): Map<Long, String> {
        val names = LinkedHashMap<Long, String>()
        for (i in 0 until minOf(items.size, entries.size)) {
            val item = items[i] ?: continue
            if (item.startsWith("data:") && entries[i].startsWith(INTERNAL_URL_PREFIX)) names[dataUrlKey(item)] = entries[i]
        }
        return names
    }

    /** `goBackOrForward`'s argument for a jump to `index`, or null when `index` is not in the list. */
    fun stepsTo(index: Int, currentIndex: Int, size: Int): Int? =
        if (index < 0 || index >= size || currentIndex < 0) null else index - currentIndex

    // --- internal pages -------------------------------------------------------------------------

    /**
     * Whether the list's current item (`entryUrl`) stands in for the page the view shows as
     * `shownUrl`: an internal page is a `data:` item in the list and `zen://…` on the view.
     */
    fun standsInFor(entryUrl: String, shownUrl: String?): Boolean =
        entryUrl.startsWith("data:") && !shownUrl.isNullOrEmpty() && !shownUrl.startsWith("data:") && shownUrl != entryUrl

    /**
     * The URL the snapshot names an entry by: the entry's own, unless it is a `data:` URL the view
     * once showed under another name (`internal` answers by [dataUrlKey]); a `data:` URL nobody
     * remembers is kept while it is short (a page the user opened as one) and is [BLANK_URL] when
     * it is not, rather than kilobytes of markup in every snapshot of the tab.
     */
    fun publicUrl(entryUrl: String, internal: (Long) -> String?): String {
        if (!entryUrl.startsWith("data:")) return entryUrl
        internal(dataUrlKey(entryUrl))?.let { return it }
        return if (entryUrl.length <= DATA_URL_KEEP_MAX) entryUrl else BLANK_URL
    }

    /**
     * A key for a `data:` URL that does not keep the URL: its length and its hash. Two internal
     * pages with the same length and hash would share a name, which is as likely as a hash
     * collision between two documents, and costs a wrong title in a list at worst.
     */
    fun dataUrlKey(url: String): Long = (url.length.toLong() shl 32) or (url.hashCode().toLong() and 0xffffffffL)
}
