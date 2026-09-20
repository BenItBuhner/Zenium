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
 * the prefix (desktop's, a synced one, garbage) is never unmarshalled; a bundle that reads but
 * is not shaped like a WebView's state never reaches `restoreState` ([isWebViewState]); one over
 * [HOST_STATE_MAX] is never sent (the core keeps the same bound, and a restore without it has
 * the core load the current entry); a private tab's is never produced. Nothing of its content
 * is logged.
 *
 * The internal pages (`zen://…`, rendered by `loadDataWithBaseURL`) sit in the WebView's list
 * as `data:` items, and every one of them under the same URL: the `data:` header the document
 * was loaded under with nothing behind its comma ([isDocumentPlaceholder]; the document itself
 * is the entry's, not the URL's, which is how the list's items stay small). The snapshot's
 * entries name them by the URL the view showed for them – by position, since the items cannot
 * be told apart ([publicUrl], [internalNamesOf]) – which is what the core, the session store
 * and the back list want. The document is inside `hostState`, though: `saveState` pickles
 * every entry, an internal page's document with it, so a stack holding a large one (the new
 * tab page, an error page, a long reader page) is over [HOST_STATE_MAX] once encoded, no state
 * goes out for it, and that tab restores URL-only – the core loads the current entry. A reader
 * page of ordinary length fits.
 */
object NavigationState {
    /** The longest `hostState` string that leaves the host (`sanitizeSnapshot` in the core keeps the same bound). */
    const val HOST_STATE_MAX = 64 * 1024

    /** Zenium's WebView state, encoding 1; a string that does not start with it is not ours. */
    const val HOST_STATE_PREFIX = "zwv1:"

    /** A `data:` entry the view never showed under another URL is kept verbatim up to this length. */
    const val DATA_URL_KEEP_MAX = 2048

    /** What a `data:` entry too long to keep, or an internal page's item nobody has a name for, becomes in the snapshot. */
    const val BLANK_URL = "about:blank"

    /** The internal pages' scheme: what the view shows for a `loadDataWithBaseURL` document of the chrome's. */
    const val INTERNAL_URL_PREFIX = "zen://"

    /** The most entries a WebView's list holds (Chromium's session history cap): one goes when another would be the 51st. */
    const val LIST_MAX = 50

    private const val TAG = "ZenNavState"

    /** One entry as the list reports it (`WebHistoryItem`), before [publicUrl] is applied. */
    class Item(val url: String, val title: String?, val originalUrl: String?)

    /** `{ entries: [], index: -1 }`: a tab without a WebView, or one with nothing in its list yet. */
    fun emptySnapshot(): JSONObject = json("entries" to JSONArray(), "index" to -1)

    /**
     * `{ entries: [{ url, title, originalUrl? }], index }`. `originalUrl` goes along only where it
     * says something the URL does not (the address a redirect was requested at); `names` are the
     * internal pages' by position, and each URL goes by [publicUrl].
     */
    fun snapshotJson(items: List<Item>, currentIndex: Int, names: Map<Int, String> = emptyMap()): JSONObject {
        val entries = JSONArray()
        for ((i, item) in items.withIndex()) {
            val url = publicUrl(item.url, names[i])
            val entry = json("url" to url, "title" to (item.title ?: ""))
            val original = item.originalUrl?.let { publicUrl(it, names[i]) }
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
     * A WebView's state bundle out of [marshall]'s bytes, or null when they do not read as one.
     * The bytes came from the profile, so nothing about them is trusted: a length field that
     * asks for more than there is fails inside the platform's reader, and that failure –
     * whatever it is – only means there is no bundle; a bundle that reads but is not shaped
     * like a WebView's state ([isWebViewState]) is refused here, before the WebView sees it.
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
            // than inside the WebView.
            if (isWebViewState(bundle)) return bundle
            Log.i(TAG, "hostState is not a WebView's state: ${bundle.size()} keys")
            null
        } catch (e: Throwable) {
            Log.i(TAG, "hostState does not unmarshall: ${e.javaClass.simpleName}")
            null
        } finally {
            parcel.recycle()
        }
    }

    /**
     * Whether `bundle` is shaped like what `saveState` writes: one key, its value a byte array
     * (the WebView's opaque pickle; the key is the WebView's own). Anything else – nothing in it,
     * more keys, a value of another kind, a Parcelable named in it – is not a state to hand to
     * `restoreState`, whatever the WebView would make of it.
     */
    @Suppress("DEPRECATION")
    fun isWebViewState(bundle: Bundle): Boolean {
        if (bundle.size() != 1) return false
        val key = bundle.keySet().firstOrNull() ?: return false
        return bundle.get(key) is ByteArray
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
     * The names of the internal pages in a restored list, from the snapshot's entries: each
     * position whose item is a `data:` document and whose entry names a `zen://` page, to that
     * name, the way the view that saved the list had them ([keptNames]), so the fresh view
     * names them the same from its first push. Positions that do not match are skipped.
     */
    fun internalNamesOf(items: List<String?>, entries: List<String>): Map<Int, String> {
        val names = LinkedHashMap<Int, String>()
        for (i in 0 until minOf(items.size, entries.size)) {
            val item = items[i] ?: continue
            if (item.startsWith("data:") && entries[i].startsWith(INTERNAL_URL_PREFIX)) names[i] = entries[i]
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
     * Whether `url` is the URL WebView gives every `loadDataWithBaseURL` document's list item:
     * the `data:` header it loaded the document under, with nothing behind the comma (the
     * document travels with the entry, not in the URL). One and the same for every internal
     * page of a tab, so the item says which kind of page it is and not which one.
     */
    fun isDocumentPlaceholder(url: String): Boolean = url.startsWith("data:") && url.endsWith(",")

    /**
     * The URL the snapshot names an entry by: the entry's own, unless it is a `data:` item with
     * a `name` (the `zen://` URL the view showed it as, by position). A `data:` URL nobody has a
     * name for is kept while it is a page's own and short (one the user opened as such), and is
     * [BLANK_URL] when it is an internal page's placeholder ([isDocumentPlaceholder]) or too long
     * to carry in every snapshot of the tab.
     */
    fun publicUrl(entryUrl: String, name: String?): String {
        if (!entryUrl.startsWith("data:")) return entryUrl
        if (name != null) return name
        return if (isDocumentPlaceholder(entryUrl) || entryUrl.length > DATA_URL_KEEP_MAX) BLANK_URL else entryUrl
    }

    /**
     * The names still standing once the list is `items`: a position keeps its name while it
     * holds a `data:` item. One pruned (the entries past the current one go when a new page
     * commits) or taken by a web page has none; the commit of a new internal page at a position
     * names it afresh, so a name is never older than the item at its position.
     */
    fun keptNames(names: Map<Int, String>, items: List<String?>): Map<Int, String> =
        names.filterKeys { i -> i in items.indices && items[i]?.startsWith("data:") == true }

    /**
     * Whether the commit that took the list from `previousSize` entries with `previousIndex`
     * current to `size` with `currentIndex` current dropped the list's oldest entry: a new entry
     * from the last position of a list at [LIST_MAX] (a load, a `pushState`) leaves the list as
     * long and the last position current, with everything before it moved down one. A reload of
     * that position looks the same and moves nothing, and is told apart; a navigation replacing
     * that entry (`location.replace`, `replaceState`) looks the same too and is not, so it
     * counts as a drop: the names go for nothing, which costs an `about:blank` where a name
     * was, never a name at the wrong position. Which entry a drop takes is Chromium's choice
     * (the oldest it may skip, else the first), so after one no name is its position's any
     * more, other than the one the commit itself brings.
     */
    fun listDroppedAnEntry(previousIndex: Int, previousSize: Int, currentIndex: Int, size: Int, reload: Boolean): Boolean =
        !reload && size >= LIST_MAX && previousSize == size && previousIndex == size - 1 && currentIndex == size - 1
}
