package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

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
 */
internal class IndexReader(private val log: (String) -> Unit = {}) {
    private var compiled: Map<String, CompiledRules> = emptyMap()

    /**
     * The sets of the index `raw` (an empty list for a version other than 1 or 2), their rules
     * from the documents `document` opens – the text of `blocking/<name>`, null when there is
     * none. Throws [JSONException] on malformed index text.
     */
    fun read(raw: String, document: (String) -> String? = { null }): List<RuleSetInfo> {
        val c = Cursor(raw, "blocking index")
        val next = HashMap<String, CompiledRules>()
        var version = -1
        var sets: List<RuleSetInfo> = emptyList()
        c.objectEntries { key ->
            when (key) {
                "version" -> version = c.int()
                "sets" -> sets = readSets(c, next, document)
                else -> c.skipValue()
            }
        }
        c.end()
        if (version != 1 && version != 2) return emptyList()
        compiled = next
        return sets
    }

    private fun readSets(c: Cursor, next: HashMap<String, CompiledRules>, document: (String) -> String?): List<RuleSetInfo> {
        val out = ArrayList<RuleSetInfo>()
        c.arrayElements {
            // An element that is not an object is left out, as the document parser leaves it out.
            if (c.atObject()) readSet(c, next, document)?.let { out.add(it) } else c.skipValue()
        }
        return out
    }

    private fun readSet(c: Cursor, next: HashMap<String, CompiledRules>, document: (String) -> String?): RuleSetInfo? {
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
        var rules: CompiledRules? = null
        var deferred: IntRange? = null
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
                "rules" -> {
                    val p = priority
                    if (p == null) {
                        deferred = c.skipValue()
                    } else {
                        val fingerprint = fingerprintOf(source, p, updatedAt)
                        val previous = known(id, fingerprint)
                        if (previous != null) {
                            c.skipValue()
                            rules = previous
                        } else {
                            rules = readRules(c, p, fingerprint)
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
            documentName != null && documentName.isNotEmpty() -> {
                val fingerprint = fingerprintOf(p, tag)
                known(id, fingerprint) ?: readDocument(id, documentName, p, fingerprint, document) ?: return null
            }
            pending != null -> {
                val fingerprint = fingerprintOf(source, p, updatedAt)
                known(id, fingerprint) ?: CompiledRules.parse(JSONArray(c.text(pending)), p, fingerprint)
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
            partitions = partitions
        )
    }

    /** The previous read's compiled rules of set `id` when they were compiled from `fingerprint`. */
    private fun known(id: String, fingerprint: String?): CompiledRules? =
        if (fingerprint == null) null else compiled[id]?.takeIf { it.fingerprint == fingerprint }

    /**
     * The set document `name` of set `id` (`{"id", "rules"}`, `store.ts`'s `SetDocument`)
     * compiled; null, with a line to [log], when it is missing, is another set's, or is not a
     * document (a write cut short) – the set is left out of this read.
     */
    private fun readDocument(id: String, name: String, priority: Int, fingerprint: String?, document: (String) -> String?): CompiledRules? {
        val text = document(name)
        if (text == null) {
            log("blocking set $id left out: its document $name is missing")
            return null
        }
        return try {
            val c = Cursor(text, "blocking set document $name")
            var documentId: String? = null
            var rules: CompiledRules? = null
            c.objectEntries { key ->
                when (key) {
                    "id" -> documentId = c.stringOrNull()
                    "rules" -> rules = readRules(c, priority, fingerprint)
                    else -> c.skipValue()
                }
            }
            c.end()
            if (documentId != id) {
                log("blocking set $id left out: $name is the document of ${documentId ?: "no set"}")
                null
            } else rules ?: CompiledRules.of(ArrayList(), fingerprint)
        } catch (e: JSONException) {
            log("blocking set $id left out: ${e.message}")
            null
        }
    }

    /** One rule at a time: a rule's object is the only document built, and only until it is compiled. */
    private fun readRules(c: Cursor, priority: Int, fingerprint: String?): CompiledRules {
        val out = ArrayList<DnrRule>()
        c.arrayElements {
            val range = c.skipValue()
            if (c.charAt(range.first) == '{') DnrRule.parse(JSONObject(c.text(range)), priority)?.let { out.add(it) }
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
 * malformed document is a [JSONException] at the offending offset, naming `what`). Works on the
 * text as a `char[]`: with uBlock Origin Lite's sets at 7.7 M chars between them, and read
 * whole at first start and whenever they change, the scan is the cost, and the emulator's debug
 * APK runs it without the JIT that hides `String.charAt`'s dispatch – array reads keep it about
 * `org.json`'s own tokeniser's speed while allocating a fraction of what building its tree would.
 */
private class Cursor(s: String, private val what: String) {
    private val a: CharArray = s.toCharArray()
    private val n = a.size
    private var i = 0

    fun charAt(index: Int): Char = a[index]

    fun text(range: IntRange): String = String(a, range.first, range.last - range.first + 1)

    private fun whitespace() {
        var j = i
        while (j < n) {
            val ch = a[j]
            if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') j++ else break
        }
        i = j
    }

    private fun peek(): Char {
        whitespace()
        return if (i < n) a[i] else END
    }

    private fun take(ch: Char): Boolean {
        if (peek() != ch) return false
        i++
        return true
    }

    private fun expect(ch: Char) {
        if (!take(ch)) fail("'$ch'")
    }

    private fun fail(expected: String): Nothing = throw JSONException("$what: expected $expected at offset $i")

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
        val start = i + 1
        skipString()
        return decode(start, i - 1)
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
        val start = i
        var j = i
        while (j < n) {
            val ch = a[j]
            if (ch == ',' || ch == '}' || ch == ']' || ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') break
            j++
        }
        i = j
        if (i == start) fail("a value")
        return String(a, start, i - start)
    }

    /** Steps over one value of any kind and returns the text it spanned. */
    fun skipValue(): IntRange {
        peek()
        val start = i
        when (if (i < n) a[i] else END) {
            '"' -> skipString()
            '{', '[' -> skipNested()
            else -> literal()
        }
        return start until i
    }

    /**
     * From an opening bracket past the closer that matches it. Strings are stepped over whole;
     * every closer must match its opener, so `{]` is malformed here rather than a fragment handed
     * to a document parser later.
     */
    private fun skipNested() {
        var stack = CharArray(64)
        var top = 0
        var j = i
        while (j < n) {
            when (val ch = a[j]) {
                '"' -> {
                    i = j
                    skipString()
                    j = i
                }
                '{', '[' -> {
                    if (top == stack.size) stack = stack.copyOf(top * 2)
                    stack[top++] = ch
                    j++
                }
                '}', ']' -> {
                    val closer = if (stack[top - 1] == '{') '}' else ']'
                    if (ch != closer) { i = j; fail("'$closer'") }
                    top--
                    j++
                    if (top == 0) { i = j; return }
                }
                else -> j++
            }
        }
        i = j
        fail("the end of a value")
    }

    /** From the opening quote past the closing one. */
    private fun skipString() {
        var j = i + 1
        while (j < n) {
            val ch = a[j++]
            if (ch == '\\') j++ else if (ch == '"') { i = j; return }
        }
        i = j
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
    }
}
