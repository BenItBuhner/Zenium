package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject

/**
 * Zenium's own record of where the user shares (SH-03): per share target – an activity's
 * component, keyed under the share's kind (`text` or `image`, Chrome's two ranking types) – how
 * many times it was chosen, when it was chosen in the last seven days, and when last. Kept as
 * one JSON string in the app's preferences (`Store`); no usage-stats permission. The share
 * panel's apps row is ordered by [rank]: the most used in the last week first (Chrome's
 * `kRecentWindowDays`), then the most used ever, then the most recently used, then the order the
 * caller passed (the system's list sorted by package name, so a never-used app keeps its slot).
 * Nothing is recorded from a private tab: [record] is told the share was one and writes nothing.
 * At most [MAX_COMPONENTS] targets are kept per type – past that the least recently used go –
 * so the record cannot grow with every app ever installed. Reads and writes are synchronised:
 * the panel ranks on one IO thread and records on another.
 */
class ShareHistory(private val store: Store, private val now: () -> Long = System::currentTimeMillis) {
    /** Where the JSON lives; a `SharedPreferences` string in the app. */
    interface Store {
        fun read(): String?
        fun write(value: String)
    }

    /** One target's record. */
    data class Use(val count: Int, val recent: List<Long>, val lastUsed: Long)

    private var loaded: MutableMap<String, MutableMap<String, Use>>? = null

    /**
     * The user chose `component` for a share of `type`. A private tab's share (`private`) leaves
     * no record: nothing is read, nothing is written. The flag has no default: a call site that
     * left it off would record a private share unnoticed, so every caller says which it is.
     */
    @Synchronized
    fun record(type: String, component: String, private: Boolean) {
        if (private) return
        val all = load()
        val byType = all.getOrPut(type) { LinkedHashMap() }
        val at = now()
        val old = byType[component]
        val recent = ((old?.recent ?: emptyList()) + at).filter { it > at - RECENT_WINDOW_MS }.takeLast(MAX_RECENT)
        byType[component] = Use((old?.count ?: 0) + 1, recent, at)
        trim(byType, component)
        store.write(serialise(all))
    }

    /** At most [MAX_COMPONENTS] targets per type: past it the least recently used go, never the one just chosen. */
    private fun trim(byType: MutableMap<String, Use>, keep: String) {
        while (byType.size > MAX_COMPONENTS) {
            val oldest = byType.entries.filter { it.key != keep }.minByOrNull { it.value.lastUsed } ?: return
            byType.remove(oldest.key)
        }
    }

    /** The record of `component` for `type`, or null when it was never chosen. */
    @Synchronized
    fun use(type: String, component: String): Use? = load()[type]?.get(component)

    /**
     * `candidates` in the order the row shows them: by the count of the last seven days, then by
     * the count of all time, then by the last use, then as given. Stable for ties.
     */
    @Synchronized
    fun rank(type: String, candidates: List<String>): List<String> {
        val byType = load()[type] ?: return candidates
        val at = now()
        val keyed = candidates.map { component ->
            val use = byType[component]
            val recent = use?.recent?.count { it > at - RECENT_WINDOW_MS } ?: 0
            Triple(component, recent, use)
        }
        return keyed.sortedWith(
            compareByDescending<Triple<String, Int, Use?>> { it.second }
                .thenByDescending { it.third?.count ?: 0 }
                .thenByDescending { it.third?.lastUsed ?: 0L }
        ).map { it.first }
    }

    /** Forget a target that is no longer installed (the row never shows it either way). */
    @Synchronized
    fun forget(component: String) {
        val all = load()
        var changed = false
        for (byType in all.values) if (byType.remove(component) != null) changed = true
        if (changed) store.write(serialise(all))
    }

    private fun load(): MutableMap<String, MutableMap<String, Use>> =
        loaded ?: parse(store.read()).also { loaded = it }

    companion object {
        /** Chrome's `kRecentWindowDays`: uses inside this window rank first. */
        const val RECENT_WINDOW_MS = 7L * 24 * 60 * 60 * 1000
        /** The recent timestamps kept per target; enough for a week of heavy use. */
        const val MAX_RECENT = 64
        /** The targets remembered per type: the row shows seven, a phone's sheet lists a few dozen; the least recently used go past this. */
        const val MAX_COMPONENTS = 32
        const val TYPE_TEXT = "text"
        const val TYPE_IMAGE = "image"

        fun parse(json: String?): MutableMap<String, MutableMap<String, Use>> {
            val out = LinkedHashMap<String, MutableMap<String, Use>>()
            if (json.isNullOrEmpty()) return out
            val root = runCatching { JSONObject(json) }.getOrNull() ?: return out
            for (type in root.keys()) {
                val byType = root.optJSONObject(type) ?: continue
                val uses = LinkedHashMap<String, Use>()
                for (component in byType.keys()) {
                    val entry = byType.optJSONObject(component) ?: continue
                    val recent = entry.optJSONArray("recent")?.let { array -> List(array.length()) { array.optLong(it) } } ?: emptyList()
                    uses[component] = Use(entry.optInt("count"), recent, entry.optLong("lastUsed"))
                }
                out[type] = uses
            }
            return out
        }

        fun serialise(all: Map<String, Map<String, Use>>): String {
            val root = JSONObject()
            for ((type, byType) in all) {
                val uses = JSONObject()
                for ((component, use) in byType) {
                    uses.put(
                        component,
                        JSONObject()
                            .put("count", use.count)
                            .put("recent", JSONArray().also { array -> use.recent.forEach { array.put(it) } })
                            .put("lastUsed", use.lastUsed)
                    )
                }
                root.put(type, uses)
            }
            return root.toString()
        }
    }
}
