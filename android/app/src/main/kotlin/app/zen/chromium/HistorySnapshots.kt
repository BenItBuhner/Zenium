package app.zen.chromium

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.webkit.WebBackForwardList

/**
 * What the pages behind the back gesture look like: a scaled bitmap per history entry a tab has
 * navigated away from, so a predictive back can slide the real previous page in before the
 * WebView has gone anywhere. Entries are keyed by tab and history index and remember the URL
 * they were taken at; a lookup only answers when the entry at that index still carries that URL,
 * so forward history that has since been replaced never shows a stale page.
 *
 * Memory is the bound, not a count: the cache is a byte-budgeted LRU that drops the least
 * recently used bitmaps once the budget is exceeded, forgets a tab's entries when the tab goes
 * away and empties itself under memory pressure (`MainActivity.onTrimMemory`).
 */
class HistorySnapshots(context: Context) {
    class Entry(
        val tabId: String,
        val index: Int,
        val url: String,
        val title: String,
        val favicon: Bitmap?,
        val bitmap: Bitmap
    ) {
        val bytes: Long
            get() = bitmap.allocationByteCount.toLong() + (favicon?.allocationByteCount?.toLong() ?: 0L)
    }

    private val lru = ByteBudgetLru<Entry>(budgetFor(context)) { it.bytes }

    val bytes: Long get() = lru.bytes
    val size: Int get() = lru.size

    fun remember(entry: Entry) {
        lru.put(key(entry.tabId, entry.index), entry)
    }

    /** The snapshot of `tabId`'s history entry `index`, provided it was taken of `url`. */
    fun get(tabId: String, index: Int, url: String): Entry? =
        lru.get(key(tabId, index))?.takeIf { it.url == url }

    fun forget(tabId: String) {
        lru.removeIf { it.tabId == tabId }
    }

    /** Drop entries the history no longer agrees with (a replaced forward history, a pruned list). */
    fun validate(tabId: String, history: WebBackForwardList) {
        lru.removeIf { entry ->
            entry.tabId == tabId &&
                (entry.index < 0 || entry.index >= history.size || history.getItemAtIndex(entry.index)?.url != entry.url)
        }
    }

    fun clear() {
        lru.clear()
    }

    private fun key(tabId: String, index: Int) = "$tabId#$index"

    companion object {
        /** Snapshots are scaled so their width is at most this many device pixels. */
        const val MAX_WIDTH = 720

        /** A sixth of the heap class, within [12, 48] MB: a dozen to forty phone-sized pages. */
        fun budgetFor(context: Context): Long {
            val classMb = context.getSystemService(ActivityManager::class.java)?.memoryClass ?: 128
            return (classMb.toLong() * MB / 6).coerceIn(12 * MB, 48 * MB)
        }

        private const val MB = 1024L * 1024L
    }
}

/**
 * An LRU keyed cache bounded by the summed size of its values rather than their number. `get`
 * counts as a use. Pure Kotlin so the eviction rules have a JVM test.
 */
class ByteBudgetLru<V : Any>(val budget: Long, private val sizeOf: (V) -> Long) {
    private val entries = LinkedHashMap<String, V>(32, 0.75f, true)
    var bytes = 0L
        private set

    val size: Int get() = entries.size

    fun get(key: String): V? = entries[key]

    fun put(key: String, value: V) {
        entries.remove(key)?.let { bytes -= sizeOf(it) }
        entries[key] = value
        bytes += sizeOf(value)
        val iterator = entries.entries.iterator()
        // Least recently used first; the value just added is last and survives even when it alone
        // is over budget – a preview that is too big to keep beats no preview at all.
        while (bytes > budget && entries.size > 1 && iterator.hasNext()) {
            val oldest = iterator.next()
            iterator.remove()
            bytes -= sizeOf(oldest.value)
        }
    }

    fun removeIf(predicate: (V) -> Boolean) {
        val iterator = entries.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (predicate(entry.value)) {
                iterator.remove()
                bytes -= sizeOf(entry.value)
            }
        }
    }

    fun clear() {
        entries.clear()
        bytes = 0L
    }
}
