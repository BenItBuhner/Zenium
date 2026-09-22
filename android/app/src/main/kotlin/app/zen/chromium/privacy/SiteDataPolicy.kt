package app.zen.chromium.privacy

import org.json.JSONArray
import org.json.JSONObject

/**
 * The per-site cookie and site-data policy the core pushes inside the privacy flags
 * (`PrivacyFlags.siteData`, the `SiteDataPolicy` of `src/shared/siteData.ts`): the "block all"
 * default and Chrome's three lists of patterns ([SitePattern]). Resolution mirrors
 * `resolveSiteData` / `cookieVerdict` there: the most specific pattern across the lists decides,
 * the block list winning a tie, then the clear-on-exit list; a site on no list has the default.
 */
class SiteDataPolicy(
    val blockAll: Boolean,
    /** Sites that can always use cookies. */
    val allow: List<String>,
    /** Sites whose cookies and data go when the browser closes (here: at the next launch). */
    val clearOnExit: List<String>,
    /** Sites that can never use cookies. */
    val block: List<String>
) {
    enum class State { ALLOW, BLOCK, CLEAR_ON_EXIT, DEFAULT }

    enum class Verdict { BLOCKED, ALLOWED, DEFAULT }

    /** Whether any list has an entry or the default blocks: a policy that changes nothing is skipped fast. */
    val isEmpty: Boolean get() = !blockAll && allow.isEmpty() && clearOnExit.isEmpty() && block.isEmpty()

    /** Which list decides for `address`, or [State.DEFAULT]. */
    fun resolve(address: SiteAddress): State {
        var best: SitePattern? = null
        var state = State.DEFAULT
        for ((list, word) in listOf(block to State.BLOCK, clearOnExit to State.CLEAR_ON_EXIT, allow to State.ALLOW)) {
            val pattern = SitePattern.match(list, address) ?: continue
            if (best == null || pattern < best) {
                best = pattern
                state = word
            }
        }
        return state
    }

    fun resolve(url: String): State = SiteAddress.of(url)?.let { resolve(it) } ?: State.DEFAULT

    /**
     * The policy's word on a request for `url`, before the third-party rule (`cookieVerdict`):
     * [Verdict.BLOCKED] for a site on the never list and, under `blockAll`, for every site the
     * allow and clear-on-exit lists leave out; [Verdict.ALLOWED] for a listed site, which the
     * third-party rule leaves alone too; [Verdict.DEFAULT] for the rest.
     */
    fun verdict(url: String): Verdict {
        if (isEmpty) return Verdict.DEFAULT
        val address = SiteAddress.of(url) ?: return Verdict.DEFAULT
        return when (resolve(address)) {
            State.BLOCK -> Verdict.BLOCKED
            State.ALLOW, State.CLEAR_ON_EXIT -> Verdict.ALLOWED
            State.DEFAULT -> if (blockAll) Verdict.BLOCKED else Verdict.DEFAULT
        }
    }

    fun toJson(): JSONObject = JSONObject()
        .put("blockAll", blockAll)
        .put("allow", JSONArray(allow))
        .put("clearOnExit", JSONArray(clearOnExit))
        .put("block", JSONArray(block))

    override fun equals(other: Any?): Boolean =
        other is SiteDataPolicy && other.blockAll == blockAll && other.allow == allow &&
            other.clearOnExit == clearOnExit && other.block == block

    override fun hashCode(): Int = toJson().toString().hashCode()

    companion object {
        val EMPTY = SiteDataPolicy(false, emptyList(), emptyList(), emptyList())

        /** Parse the core's document; a missing or malformed field is empty, an unparsable pattern is skipped. */
        fun parse(o: JSONObject?): SiteDataPolicy {
            if (o == null) return EMPTY
            return SiteDataPolicy(
                blockAll = o.optBoolean("blockAll", false),
                allow = patterns(o.optJSONArray("allow")),
                clearOnExit = patterns(o.optJSONArray("clearOnExit")),
                block = patterns(o.optJSONArray("block"))
            )
        }

        private fun patterns(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            val out = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) {
                // Only strings are patterns (the core's `sanitizeSiteDataPolicy` skips the rest too).
                val text = SitePattern.normalize(arr.opt(i) as? String ?: continue) ?: continue
                if (text !in out) out.add(text)
            }
            return out
        }
    }
}
