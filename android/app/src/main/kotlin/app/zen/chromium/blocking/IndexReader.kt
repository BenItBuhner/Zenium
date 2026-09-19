package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Reads `blocking/index.json` – what `RuleSetStore` (`store.ts`) writes: every set's metadata
 * with its structured rules inline – set by set, stepping over the text instead of building a
 * document of it, and compiles only the rules that changed since the previous read.
 *
 * The core rewrites the index whole for every change of any set (a filter list's update, an
 * extension's dynamic rule, a site exception), and with an extension like uBlock Origin Lite
 * installed it carries some 18,000 rules in five megabytes. Read into an `org.json` tree, each
 * rebuild was tens of megabytes of short-lived objects and a recompilation of every rule, and
 * the rebuilds of a start-up burst met the rest of the heap (a snapshot OOM on the emulator when
 * the safe-browsing feed's 11 MB fetch landed between two of them). Now an unchanged set costs
 * the scan of its text and nothing else: its [CompiledRules] are the previous read's, shared
 * with the snapshot still in use.
 *
 * "Unchanged" is known for an extension's sets (`source: "dnr"`): the translator stamps
 * `updatedAt` on every emission and emits a set only when its rules or priority changed
 * (`DnrTranslator`; the Android runtime keeps the stamps strictly increasing), so the pair
 * (priority, updatedAt) stands for the rules. The store writes those fields before `rules`; an
 * entry in another order is compiled once it has been read whole. The built-in sets carry no
 * stamp and are small; they are compiled at every read. One reader per engine, used on its
 * builder thread only.
 */
internal class IndexReader {
    private var compiled: Map<String, CompiledRules> = emptyMap()

    /** The sets of a version-1 index (an empty list for another version). Throws [JSONException] on malformed text. */
    fun read(raw: String): List<RuleSetInfo> {
        val c = Cursor(raw)
        val next = HashMap<String, CompiledRules>()
        var version = -1
        var sets: List<RuleSetInfo> = emptyList()
        c.objectEntries { key ->
            when (key) {
                "version" -> version = c.int()
                "sets" -> sets = readSets(c, next)
                else -> c.skipValue()
            }
        }
        c.end()
        if (version != 1) return emptyList()
        compiled = next
        return sets
    }

    private fun readSets(c: Cursor, next: HashMap<String, CompiledRules>): List<RuleSetInfo> {
        val out = ArrayList<RuleSetInfo>()
        c.arrayElements {
            // An element that is not an object is left out, as the document parser leaves it out.
            if (c.atObject()) readSet(c, next)?.let { out.add(it) } else c.skipValue()
        }
        return out
    }

    private fun readSet(c: Cursor, next: HashMap<String, CompiledRules>): RuleSetInfo? {
        var id = ""
        var source = "filter-list"
        var priority: Int? = null
        var enabled = true
        var hasText = false
        var filterCount = 0
        var updatedAt = 0L
        var file: String? = null
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
        val result = when {
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
        /** What a `dnr` set's compiled rules can be recognised by; null for sets that are compiled at every read. */
        internal fun fingerprintOf(source: String, priority: Int, updatedAt: Long): String? =
            if (source == "dnr" && updatedAt != 0L) "$priority:$updatedAt" else null
    }
}

/**
 * A position in JSON text that steps over values without building them (RFC 8259 grammar; a
 * malformed document is a [JSONException] at the offending offset). Works on the text as a
 * `char[]`: with uBlock Origin Lite's index at 7.7 M chars and re-read for every rule change,
 * the scan is the cost, and the emulator's debug APK runs it without the JIT that hides
 * `String.charAt`'s dispatch – array reads keep it about `org.json`'s own tokeniser's speed
 * while allocating a fraction of what building its tree would.
 */
private class Cursor(s: String) {
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

    private fun fail(expected: String): Nothing = throw JSONException("blocking index: expected $expected at offset $i")

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
