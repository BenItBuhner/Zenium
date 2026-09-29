package app.zen.chromium

import android.content.Context
import android.content.RestrictionsManager
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject

/**
 * The managed configuration a device or profile owner handed the app (TB-13; the core's
 * `shared/managed.ts`): Android's app restrictions, read through
 * [RestrictionsManager.getApplicationRestrictions] – what Chrome's `AppRestrictionsProvider`
 * reads and turns into policies, any one of which makes the browser managed. The host reads
 * the bundle once, on the bridge's `managed.read`, which the core sends on the app menu's first
 * build or the Management page's mount – never at boot – and answers with the keys the bundle
 * carries and the organisation's name when the `EnterpriseCustomLabel` string gives one
 * (Chrome's key for the name chrome://management shows). No other value leaves the bundle: a
 * managed configuration may carry credentials, and the page lists what is configured, not what
 * it is set to. The folding of a bundle into the reply is [summarize], free of Android types
 * for JUnit.
 */
object ManagedRestrictions {
    /** Chrome's key for the organisation's display name (the `EnterpriseCustomLabel` policy). */
    const val ORG_KEY = "EnterpriseCustomLabel"

    /** Read the bundle now, on the calling thread (the host's `io` executor, not main). */
    fun read(context: Context): JSONObject {
        val manager = context.getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager
        val bundle = runCatching { manager?.applicationRestrictions }.getOrNull()
        return summarize(entriesOf(bundle))
    }

    /**
     * The reply for a bundle's entries: `keys` – the bundle's keys, trimmed, each once, sorted –
     * and `by`, the trimmed `EnterpriseCustomLabel` string when it is one and the bundle has any
     * key, else null. Values other than the label are not read.
     */
    fun summarize(entries: Map<String, Any?>): JSONObject {
        val keys = entries.keys.map { it.trim() }.filter { it.isNotEmpty() }.distinct().sorted()
        val label = (entries[ORG_KEY] as? String)?.trim()
        val by = if (keys.isNotEmpty() && !label.isNullOrEmpty()) label else null
        return json("by" to by, "keys" to JSONArray(keys))
    }

    /** The bundle's keys, with the one value [summarize] reads and no other. */
    private fun entriesOf(bundle: Bundle?): Map<String, Any?> {
        if (bundle == null) return emptyMap()
        val entries = LinkedHashMap<String, Any?>()
        for (key in bundle.keySet()) entries[key] = if (key == ORG_KEY) bundle.getString(key) else null
        return entries
    }
}
