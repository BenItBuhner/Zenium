package app.zen.chromium.blocking

/**
 * A large domain list as a sorted array with binary-search membership. A `HashSet` holds a node
 * (32 bytes on HotSpot, 24 on ART) and a table slot per domain over the string itself; a hosts
 * file folded into one rule's `requestDomains` – 108 195 domains in the round-21 extension's –
 * is that many nodes, and the rest of an ad blocker's big lists (uBlock Origin Lite: 118 lists
 * over 64 domains carry 84 % of all its domain references) the same again. Sorted, a list costs
 * one reference a domain over its strings, and `contains` is log2(n) string comparisons – 17
 * for 108 K – for each label suffix of the host that [DnrRule.hasDomainOf] tries. Lists of up
 * to [THRESHOLD] domains stay `HashSet`s (or a singleton): they are the many, and a node or two
 * is cheaper than a sort. Equal to any `Set` of the same content ([AbstractSet]), so the
 * [Interner] keys it like the others.
 */
class SortedDomainSet private constructor(internal val sorted: Array<String>) : AbstractSet<String>() {
    override val size: Int get() = sorted.size

    override fun contains(element: String): Boolean = sorted.binarySearch(element) >= 0

    override fun iterator(): Iterator<String> = sorted.iterator()

    companion object {
        /** Lists longer than this are sorted arrays. */
        const val THRESHOLD = 64

        /** The set of `domains` (duplicates dropped), sorted. */
        fun of(domains: Collection<String>): SortedDomainSet {
            val array = domains.toTypedArray()
            array.sort()
            var n = 0
            for (i in array.indices) if (i == 0 || array[i] != array[i - 1]) array[n++] = array[i]
            return SortedDomainSet(if (n == array.size) array else Array(n) { array[it] })
        }
    }
}
