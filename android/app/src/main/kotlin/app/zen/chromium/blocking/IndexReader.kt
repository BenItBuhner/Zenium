package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.io.Reader
import java.io.StringReader

/**
 * Reads `blocking/index.json` – what `RuleSetStore` (`store.ts`) writes: one summary per set
 * (`version: 2`) naming the document under `blocking/sets/` that holds the set's structured
 * rules and the version tag of that document's bytes – opens the documents of the sets that
 * changed since the previous read, rule by rule, and compiles only those. The previous shape
 * (`version: 1`, every set's rules inline in the index) is still read, the same way, so the
 * engine keeps blocking through the first start of the build whose core migrates it.
 *
 * With an extension like uBlock Origin Lite installed the sets carry some 18,000 rules in five
 * megabytes; the index that named them inline was re-read whole for every change of any set (a
 * filter list's update, an extension's dynamic rule, a site exception), and read into an
 * `org.json` tree each rebuild was tens of megabytes of short-lived objects and a recompilation
 * of every rule (a snapshot OOM on the emulator when the safe-browsing feed's 11 MB fetch landed
 * between two of them). Now the index is a few kilobytes of summaries and an unchanged set costs
 * the read of its summary and nothing else: its document is not opened, and its [CompiledRules]
 * are the previous read's, shared with the snapshot still in use.
 *
 * "Unchanged" is exact: the store tags a set document with a hash of its bytes and rewrites it
 * only when the rules changed, so the pair (priority, tag) stands for the compiled rules of any
 * set – an extension's, the user's, a built-in's. In a version-1 index the pair (priority,
 * updatedAt) stands in for an extension's set (`source: "dnr"`; the translator stamps every
 * emission and the Android runtime keeps the stamps strictly increasing) and the other sets are
 * compiled at every read, as before. A set whose document is missing, is another set's or is
 * malformed (half-written) is left out with a line to `log`, never a failed read: the index
 * that follows the document's rewrite brings it back. One reader per engine, used on its
 * builder thread only.
 *
 * Four economies of a read, measured on the JVM for a 61 K-rule set (`RuleMemoryTest`):
 * - A DISABLED set is not compiled. Its summary is read and kept (the snapshot lists it), its
 *   document stays closed and it holds no [DnrRule]; the read that finds it enabled compiles
 *   it then, the way a changed set is compiled. A set that flips to disabled is dropped from
 *   the compiled ones with the same read.
 * - A set document is STREAMED from its file ([Documents]): the cursor scans a bounded buffer,
 *   one rule's text at a time, so a changed set costs its largest rule's text while it is
 *   read, not the whole document as a `String` and again as a `char[]` (three bytes per
 *   character of document, live for the length of the parse).
 * - The strings and domain sets of one read are INTERNED ([Interner]): rules of every set
 *   compiled in the read share one instance per distinct domain, hostname and domain list –
 *   the lists over [SortedDomainSet.THRESHOLD] excepted, which are close to all distinct.
 * - A domain list over that threshold is a [SortedDomainSet] (a sorted array, a reference per
 *   domain), and a rule whose `requestDomains` run past [RuleIndex.BIG_LIST] stands in the
 *   index on its own rather than as an entry per domain of the host map.
 */
internal class IndexReader(private val log: (String) -> Unit = {}) {
    /** Where a set's document is read from: a reader over its text, or null when there is none. */
    fun interface Documents {
        fun open(name: String): Reader?
    }

    private var compiled: Map<String, CompiledRules> = emptyMap()

    /**
     * The sets of the index `raw` (an empty list for a version other than 1 or 2), their rules
     * from the documents `document` opens – the text of `blocking/<name>`, null when there is
     * none. Throws [JSONException] on malformed index text.
     */
    fun read(raw: String, document: (String) -> String? = { null }): List<RuleSetInfo> =
        read(raw, Documents { name -> document(name)?.let { StringReader(it) } })

    /**
     * The sets of the index `raw`, their rules streamed from the documents `documents` opens
     * (closed here). Throws [JSONException] on malformed index text.
     */
    fun read(raw: String, documents: Documents): List<RuleSetInfo> {
        val c = Cursor(raw, "blocking index")
        val next = HashMap<String, CompiledRules>()
        val intern = Interner()
        var version = -1
        var sets: List<RuleSetInfo> = emptyList()
        c.objectEntries { key ->
            when (key) {
                "version" -> version = c.int()
                "sets" -> sets = readSets(c, next, documents, intern)
                else -> c.skipValue()
            }
        }
        c.end()
        if (version != 1 && version != 2) return emptyList()
        compiled = next
        return sets
    }

    private fun readSets(c: Cursor, next: HashMap<String, CompiledRules>, documents: Documents, intern: Interner): List<RuleSetInfo> {
        val out = ArrayList<RuleSetInfo>()
        c.arrayElements {
            // An element that is not an object is left out, as the document parser leaves it out.
            if (c.atObject()) readSet(c, next, documents, intern)?.let { out.add(it) } else c.skipValue()
        }
        return out
    }

    private fun readSet(c: Cursor, next: HashMap<String, CompiledRules>, documents: Documents, intern: Interner): RuleSetInfo? {
        var id = ""
        var source = "filter-list"
        var priority: Int? = null
        var enabled = true
        var hasText = false
        var filterCount = 0
        var updatedAt = 0L
        var file: String? = null
        var name: String? = null
        var tag: String? = null
        var partitions: HashSet<String>? = null
        var excludedPartitions: HashSet<String>? = null
        var rules: CompiledRules? = null
        var deferred: String? = null
        c.objectEntries { key ->
            when (key) {
                "id" -> id = c.stringOrNull() ?: ""
                "source" -> source = c.stringOrNull() ?: "filter-list"
                "priority" -> priority = c.int()
                "enabled" -> enabled = c.boolean()
                "hasFilterText" -> hasText = c.boolean()
                "filterCount" -> filterCount = c.int()
                "updatedAt" -> updatedAt = c.long()
                "file" -> file = c.stringOrNull()
                "document" -> name = c.stringOrNull()
                "tag" -> tag = c.stringOrNull()
                "partitions" -> partitions = c.strings()
                "excludedPartitions" -> excludedPartitions = c.strings()
                "rules" -> {
                    val p = priority
                    if (!enabled) {
                        // The store writes `enabled` ahead of `rules`: a disabled set's inline rules are stepped over, never built.
                        c.skipValue()
                    } else if (p == null) {
                        deferred = c.valueText()
                    } else {
                        val fingerprint = fingerprintOf(source, p, updatedAt)
                        val previous = known(id, fingerprint)
                        if (previous != null) {
                            c.skipValue()
                            rules = previous
                        } else {
                            rules = readRules(c, p, fingerprint, intern)
                        }
                    }
                }
                else -> c.skipValue()
            }
        }
        val p = priority
        if (id.isEmpty() || p == null) return null
        val pending = deferred
        val documentName = name
        val result = when {
            // Not compiled and not carried: a disabled set costs its summary. The read that finds it enabled compiles it.
            !enabled -> CompiledRules.NONE
            documentName != null && documentName.isNotEmpty() -> {
                val fingerprint = fingerprintOf(p, tag)
                known(id, fingerprint) ?: readDocument(id, documentName, p, fingerprint, documents, intern) ?: return null
            }
            pending != null -> {
                val fingerprint = fingerprintOf(source, p, updatedAt)
                known(id, fingerprint) ?: CompiledRules.parse(JSONArray(pending), p, fingerprint, intern)
            }
            else -> rules ?: CompiledRules.NONE
        }
        if (result.fingerprint != null) next[id] = result
        return RuleSetInfo(
            id = id,
            source = source,
            priority = p,
            enabled = enabled,
            compiled = result,
            hasFilterText = hasText,
            file = file?.takeIf { hasText && it.isNotEmpty() },
            updatedAt = updatedAt,
            filterCount = filterCount,
            partitions = partitions,
            excludedPartitions = excludedPartitions
        )
    }

    /** The previous read's compiled rules of set `id` when they were compiled from `fingerprint`. */
    private fun known(id: String, fingerprint: String?): CompiledRules? =
        if (fingerprint == null) null else compiled[id]?.takeIf { it.fingerprint == fingerprint }

    /**
     * The set document `name` of set `id` (`{"id", "rules"}`, `store.ts`'s `SetDocument`)
     * compiled, streamed from `documents`; null, with a line to [log], when it is missing, is
     * another set's, is not a document (a write cut short) or cannot be read – the set is left
     * out of this read.
     */
    private fun readDocument(id: String, name: String, priority: Int, fingerprint: String?, documents: Documents, intern: Interner): CompiledRules? {
        val reader = documents.open(name)
        if (reader == null) {
            log("blocking set $id left out: its document $name is missing")
            return null
        }
        return try {
            reader.use { r ->
                val c = Cursor(r, "blocking set document $name")
                var documentId: String? = null
                var rules: CompiledRules? = null
                c.objectEntries { key ->
                    when (key) {
                        "id" -> documentId = c.stringOrNull()
                        "rules" -> rules = readRules(c, priority, fingerprint, intern)
                        else -> c.skipValue()
                    }
                }
                c.end()
                if (documentId != id) {
                    log("blocking set $id left out: $name is the document of ${documentId ?: "no set"}")
                    null
                } else rules ?: CompiledRules.of(ArrayList(), fingerprint)
            }
        } catch (e: JSONException) {
            log("blocking set $id left out: ${e.message}")
            null
        } catch (e: IOException) {
            log("blocking set $id left out: $name could not be read (${e.message})")
            null
        }
    }

    /** One rule at a time: a rule's object is the only document built, and only until it is compiled. */
    private fun readRules(c: Cursor, priority: Int, fingerprint: String?, intern: Interner): CompiledRules {
        val out = ArrayList<DnrRule>()
        c.arrayElements {
            if (c.atObject()) DnrRule.parse(JSONObject(c.valueText()), priority, intern)?.let { out.add(it) } else c.skipValue()
        }
        return CompiledRules.of(out, fingerprint)
    }

    companion object {
        /**
         * What a set's compiled rules can be recognised by from its summary: the priority they
         * were compiled with and the tag of the document's bytes (`tagOf` in `store.ts`: a
         * length and two hashes, never a bare number, so it cannot be mistaken for a version-1
         * stamp). Null without a tag: compiled at every read.
         */
        internal fun fingerprintOf(priority: Int, tag: String?): String? =
            if (tag.isNullOrEmpty()) null else "$priority:$tag"

        /** A version-1 entry's: what a `dnr` set's compiled rules can be recognised by; null for sets that are compiled at every read. */
        internal fun fingerprintOf(source: String, priority: Int, updatedAt: Long): String? =
            if (source == "dnr" && updatedAt != 0L) "$priority:$updatedAt" else null
    }
}

/**
 * A position in JSON text that steps over values without building them (RFC 8259 grammar; a
 * malformed document is a [JSONException] at the offending offset, naming `what`). Works on a
 * `char[]`: with uBlock Origin Lite's sets at 7.7 M chars between them, and read whole at first
 * start and whenever they change, the scan is the cost, and the emulator's debug APK runs it
 * without the JIT that hides `String.charAt`'s dispatch – array reads keep it about `org.json`'s
 * own tokeniser's speed while allocating a fraction of what building its tree would.
 *
 * Over a [Reader] the array is a window onto the stream (32 K chars, grown only for a value
 * longer than that – uBlock Origin Lite folds a hosts file into one rule's `requestDomains`),
 * refilled as the scan reaches its end; the text of the value being spanned ([valueText],
 * [string], a literal) is kept through refills and nothing before it is. Over a [String] the
 * array is the whole text, as before – the index is a few kilobytes of summaries.
 */
private class Cursor private constructor(private val source: Reader?, buffer: CharArray, filled: Int, private val what: String) {
    constructor(text: String, what: String) : this(null, text.toCharArray(), text.length, what)
    constructor(reader: Reader, what: String) : this(reader, CharArray(WINDOW), 0, what)

    private var a: CharArray = buffer
    /** Chars of `a` that hold input. */
    private var n = filled
    /** The position. */
    private var i = 0
    /** No input follows `a[n - 1]`. */
    private var eof = source == null
    /** Start of the value being spanned, kept through refills; -1 between spans. */
    private var mark = -1
    /** Chars dropped from the front of the window (for offsets in messages). */
    private var dropped = 0L

    /** Whether `a[i]` holds input, refilling the window when the scan has reached its end. */
    private fun more(): Boolean {
        if (i < n) return true
        if (eof) return false
        refill()
        return i < n
    }

    private fun refill() {
        val keep = if (mark >= 0) mark else i
        if (keep > 0) {
            System.arraycopy(a, keep, a, 0, n - keep)
            n -= keep
            i -= keep
            if (mark >= 0) mark -= keep
            dropped += keep
        }
        if (n == a.size) a = a.copyOf(a.size * 2)
        while (true) {
            val read = source!!.read(a, n, a.size - n)
            if (read < 0) {
                eof = true
                return
            }
            if (read > 0) {
                n += read
                return
            }
        }
    }

    /** Runs `step` (which advances the position) with the text from the position kept, and hands its window indices to `result`. */
    private inline fun <T> spanned(step: () -> Unit, result: (start: Int, end: Int) -> T): T {
        mark = i
        step()
        val start = mark
        mark = -1
        return result(start, i)
    }

    private fun whitespace() {
        while (i < n || more()) {
            val ch = a[i]
            if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') i++ else return
        }
    }

    private fun peek(): Char {
        whitespace()
        return if (i < n || more()) a[i] else END
    }

    private fun take(ch: Char): Boolean {
        if (peek() != ch) return false
        i++
        return true
    }

    private fun expect(ch: Char) {
        if (!take(ch)) fail("'$ch'")
    }

    private fun fail(expected: String): Nothing = throw JSONException("$what: expected $expected at offset ${dropped + i}")

    /** Nothing but whitespace may follow the document. */
    fun end() {
        if (peek() != END) fail("the end of the document")
    }

    /** Whether the next value is an object. */
    fun atObject(): Boolean = peek() == '{'

    /** Visits the entries of the object the cursor is on; `visit` must consume the value of its key. */
    inline fun objectEntries(visit: (String) -> Unit) {
        expect('{')
        if (take('}')) return
        do {
            val key = string()
            expect(':')
            visit(key)
        } while (take(','))
        expect('}')
    }

    /** Visits the elements of the array the cursor is on; `visit` must consume one element. */
    inline fun arrayElements(visit: () -> Unit) {
        expect('[')
        if (take(']')) return
        do {
            visit()
        } while (take(','))
        expect(']')
    }

    fun string(): String {
        if (peek() != '"') fail("a string")
        return spanned({ skipString() }) { start, end -> decode(start + 1, end - 1) }
    }

    fun stringOrNull(): String? {
        if (peek() != 'n') return string()
        if (literal() != "null") fail("a string or null")
        return null
    }

    fun boolean(): Boolean = when (literal()) {
        "true" -> true
        "false" -> false
        else -> fail("a boolean")
    }

    fun int(): Int = long().toInt()

    fun long(): Long {
        val text = literal()
        return text.toLongOrNull() ?: text.toDoubleOrNull()?.toLong() ?: fail("a number")
    }

    /** An array of strings as a set; nulls and empty strings are left out. */
    fun strings(): HashSet<String> {
        val out = HashSet<String>()
        arrayElements {
            val value = stringOrNull()
            if (!value.isNullOrEmpty()) out.add(value)
        }
        return out
    }

    /** A number, `true`, `false` or `null`, as written. */
    private fun literal(): String {
        peek()
        return spanned({ skipLiteral() }) { start, end ->
            if (start == end) fail("a value")
            String(a, start, end - start)
        }
    }

    private fun skipLiteral() {
        while (i < n || more()) {
            val ch = a[i]
            if (ch == ',' || ch == '}' || ch == ']' || ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') return
            i++
        }
    }

    /** Steps over one value of any kind. */
    fun skipValue() {
        when (peek()) {
            '"' -> skipString()
            '{', '[' -> skipNested()
            else -> skipLiteral()
        }
    }

    /** Steps over one value of any kind and returns the text it spanned. */
    fun valueText(): String {
        peek()
        return spanned({ skipValue() }) { start, end -> String(a, start, end - start) }
    }

    /**
     * From an opening bracket past the closer that matches it. Strings are stepped over whole;
     * every closer must match its opener, so `{]` is malformed here rather than a fragment handed
     * to a document parser later.
     */
    private fun skipNested() {
        var stack = CharArray(64)
        var top = 0
        while (i < n || more()) {
            when (val ch = a[i]) {
                '"' -> skipString()
                '{', '[' -> {
                    if (top == stack.size) stack = stack.copyOf(top * 2)
                    stack[top++] = ch
                    i++
                }
                '}', ']' -> {
                    val closer = if (stack[top - 1] == '{') '}' else ']'
                    if (ch != closer) fail("'$closer'")
                    top--
                    i++
                    if (top == 0) return
                }
                else -> i++
            }
        }
        fail("the end of a value")
    }

    /** From the opening quote past the closing one. */
    private fun skipString() {
        i++
        while (i < n || more()) {
            val ch = a[i++]
            if (ch == '\\') {
                if (i < n || more()) i++ else break
            } else if (ch == '"') return
        }
        fail("the end of a string")
    }

    /** The characters of a string between its quotes, with JSON escapes decoded. */
    private fun decode(start: Int, end: Int): String {
        var slash = start
        while (slash < end && a[slash] != '\\') slash++
        if (slash >= end) return String(a, start, end - start)
        val out = StringBuilder(end - start)
        out.append(a, start, slash - start)
        var from = slash
        while (from < end) {
            val ch = a[from]
            if (ch != '\\') {
                out.append(ch)
                from++
                continue
            }
            if (from + 1 >= end) fail("an escape")
            val escaped = a[from + 1]
            var next = from + 2
            when (escaped) {
                '"', '\\', '/' -> out.append(escaped)
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'u' -> {
                    if (from + 6 > end) fail("a unicode escape")
                    var code = 0
                    for (k in from + 2 until from + 6) {
                        val digit = Character.digit(a[k], 16)
                        if (digit < 0) fail("a unicode escape")
                        code = code * 16 + digit
                    }
                    out.append(code.toChar())
                    next = from + 6
                }
                else -> fail("an escape")
            }
            from = next
        }
        return out.toString()
    }

    private companion object {
        const val END = '\u0000'
        const val WINDOW = 32 * 1024
    }
}
