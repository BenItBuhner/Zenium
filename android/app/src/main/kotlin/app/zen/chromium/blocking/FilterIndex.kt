package app.zen.chromium.blocking

/**
 * Network filters indexed for sub-millisecond lookups. Hostname-only filters (`||host^`, most of
 * every list) live in a hash map keyed by hostname and are found by walking the request host's
 * label suffixes; every other filter sits in the bucket of its rarest token, so a request only
 * tests the filters that share a token with its URL. Filters without a usable token (regular
 * expressions, `*ads*`) are tested for every request.
 */
class FilterIndex(filters: Collection<NetworkFilter>) {
    /** hostname → NetworkFilter or Array<NetworkFilter>. */
    private val hosts = HashMap<String, Any>()
    private val buckets: HashMap<Int, Array<NetworkFilter>>
    private val wildcard: Array<NetworkFilter>
    val size: Int = filters.size

    init {
        val indexed = ArrayList<NetworkFilter>()
        for (f in filters) {
            if (f.pattern.isHostnameOnly) {
                val key = f.pattern.hostname
                when (val existing = hosts[key]) {
                    null -> hosts[key] = f
                    is NetworkFilter -> hosts[key] = arrayOf(existing, f)
                    is Array<*> -> {
                        @Suppress("UNCHECKED_CAST")
                        hosts[key] = (existing as Array<NetworkFilter>) + f
                    }
                }
            } else {
                indexed.add(f)
            }
        }
        val tokens = ArrayList<IntArray>(indexed.size)
        val histogram = HashMap<Int, Int>()
        for (f in indexed) {
            val t = f.pattern.tokens()
            tokens.add(t)
            for (h in t) histogram[h] = (histogram[h] ?: 0) + 1
        }
        val building = HashMap<Int, ArrayList<NetworkFilter>>()
        val loose = ArrayList<NetworkFilter>()
        for (i in indexed.indices) {
            val t = tokens[i]
            if (t.isEmpty()) {
                loose.add(indexed[i])
                continue
            }
            var best = t[0]
            var bestCount = histogram[best] ?: 0
            for (h in t) {
                val count = histogram[h] ?: 0
                if (count < bestCount) {
                    best = h
                    bestCount = count
                }
            }
            building.getOrPut(best) { ArrayList() }.add(indexed[i])
        }
        buckets = HashMap(building.size)
        for ((k, v) in building) buckets[k] = v.toTypedArray()
        wildcard = loose.toTypedArray()
    }

    /** Filters that had no token to index them by (tested for every request). */
    val wildcardCount: Int get() = wildcard.size

    /** The first filter that matches `req`, or null. */
    fun match(req: Request): NetworkFilter? {
        if (req.host.isNotEmpty() && hosts.isNotEmpty()) walkHost(req.host, req)?.let { return it }
        for (t in req.tokens) {
            val bucket = buckets[t] ?: continue
            for (f in bucket) if (f.matches(req)) return f
        }
        for (f in wildcard) if (f.matches(req)) return f
        return null
    }

    private fun walkHost(host: String, req: Request): NetworkFilter? {
        var start = 0
        while (true) {
            val key = if (start == 0) host else host.substring(start)
            when (val hit = hosts[key]) {
                is NetworkFilter -> if (hit.matchesOptions(req)) return hit
                is Array<*> -> for (item in hit) {
                    val f = item as NetworkFilter
                    if (f.matchesOptions(req)) return f
                }
            }
            val dot = host.indexOf('.', start)
            if (dot == -1) return null
            start = dot + 1
        }
    }
}

/** What the text engine answers for a request. */
class TextMatch(val action: Action, val filter: NetworkFilter) {
    enum class Action { BLOCK, ALLOW, REDIRECT }
}

/**
 * All enabled filter lists as one matcher with uBlock Origin's resolution order: an
 * `@@…$document` exception on the page switches filtering off for everything it loads, then
 * `$important` blocks beat exceptions, and exceptions beat blocks. Built once per change on a
 * background thread and swapped in atomically.
 */
class TextEngine private constructor(
    private val blocks: FilterIndex,
    private val important: FilterIndex,
    private val exceptions: FilterIndex,
    /** `@@…$document` exceptions, matched against the document a request belongs to. */
    private val documentExceptions: FilterIndex,
    /** Network filters accepted from the lists. */
    val filterCount: Int,
    /** Lines the parser rejected (unsupported options, invalid patterns). */
    val rejectedCount: Int
) {
    /** The last document looked up, so a page's burst of requests builds its request once. */
    @Volatile
    private var lastDocument: Request? = null

    fun match(req: Request): TextMatch? {
        if (documentExceptions.size > 0 && req.type != ResourceType.MAIN_FRAME) {
            val doc = documentRequestFor(req)
            if (doc != null) documentExceptions.match(doc)?.let { return TextMatch(TextMatch.Action.ALLOW, it) }
        }
        val forced = if (important.size > 0) important.match(req) else null
        if (forced != null) return TextMatch(if (forced.isRedirect) TextMatch.Action.REDIRECT else TextMatch.Action.BLOCK, forced)
        val block = blocks.match(req) ?: return null
        val exception = if (exceptions.size > 0) exceptions.match(req) else null
        if (exception != null) return TextMatch(TextMatch.Action.ALLOW, exception)
        return TextMatch(if (block.isRedirect) TextMatch.Action.REDIRECT else TextMatch.Action.BLOCK, block)
    }

    private fun documentRequestFor(req: Request): Request? {
        val url = req.documentUrl ?: return null
        val cached = lastDocument
        if (cached != null && cached.url == url) return cached
        val doc = Request(url, ResourceType.MAIN_FRAME, null, "GET", thirdParty = false, tabId = req.tabId)
        lastDocument = doc
        return doc
    }

    val wildcardCount: Int get() = blocks.wildcardCount + important.wildcardCount + exceptions.wildcardCount + documentExceptions.wildcardCount

    companion object {
        val EMPTY: TextEngine = parse(emptyList())

        /** Parse the filter text of every enabled set (one string per set). */
        fun parse(texts: List<String>): TextEngine {
            val badfilters = HashSet<String>()
            for (text in texts) {
                if (!text.contains("badfilter")) continue
                forEachLine(text) { line ->
                    if (line.endsWith("badfilter") || line.contains("badfilter,")) {
                        NetworkFilter.badfilterTarget(line)?.let { badfilters.add(it) }
                    }
                }
            }
            val blocks = ArrayList<NetworkFilter>()
            val important = ArrayList<NetworkFilter>()
            val exceptions = ArrayList<NetworkFilter>()
            val documentExceptions = ArrayList<NetworkFilter>()
            var rejected = 0
            for (text in texts) {
                forEachLine(text) { line ->
                    if (line.isEmpty()) return@forEachLine
                    if (badfilters.isNotEmpty() && badfilters.contains(line)) return@forEachLine
                    val filter = NetworkFilter.parse(line)
                    if (filter == null) {
                        // Comments, list headers, cosmetic filters and `$badfilter` lines are not network filters.
                        if (!line.startsWith("!") && !line.startsWith("[") && !line.contains("badfilter") &&
                            !NetworkFilter.isCosmetic(line)
                        ) rejected++
                        return@forEachLine
                    }
                    when {
                        filter.isException -> {
                            exceptions.add(filter)
                            if (filter.whitelistsDocument) documentExceptions.add(filter)
                        }
                        filter.isImportant -> important.add(filter)
                        else -> blocks.add(filter)
                    }
                }
            }
            return TextEngine(
                FilterIndex(blocks), FilterIndex(important), FilterIndex(exceptions), FilterIndex(documentExceptions),
                blocks.size + important.size + exceptions.size, rejected
            )
        }

        private inline fun forEachLine(text: String, action: (String) -> Unit) {
            var start = 0
            val n = text.length
            while (start < n) {
                var end = text.indexOf('\n', start)
                if (end == -1) end = n
                var stop = end
                if (stop > start && text[stop - 1] == '\r') stop--
                action(text.substring(start, stop).trim())
                start = end + 1
            }
        }
    }
}
