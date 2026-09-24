package app.zen.chromium

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets

/**
 * The bare-window sample's bracket (a DRIVER-SIDE experiment, `CompatSweep` under `bareWindow`;
 * never part of the app): the text edits that hide the identifier `window` from an MV3 worker
 * script run as the emulation's hidden page, so a bare `window` in it is a miss the way it is in
 * Chrome's worker, while `self` and `globalThis` stay what the runtime shapes them to be.
 *
 * A classic worker script is wrapped as `with (proxy) { <probe> <text> }`: the proxy's `has`
 * answers true for the one name `window` (every other free identifier still resolves on the
 * page's global as it does today) and its `get`/`set` route the name to `self.window` – the
 * runtime's worker global, where `window` is absent until a script's own `self.window = self`
 * polyfill defines it, so the bare name and the property agree as they do in Chrome. `typeof
 * window` reads `"undefined"`, `"window" in self` is false, a `window.x` read throws a
 * `TypeError` where Chrome throws a `ReferenceError` (the one difference the design has; the
 * driver records it). A `with` statement is illegal in strict code, so a script whose top level
 * opens with `'use strict'` runs sloppy under the bracket – the driver records which did – and
 * the block takes the script's top-level `let`/`const`/`class` away from a later
 * `importScripts` file (`var` and function declarations still hoist to the global).
 *
 * A module worker (`"type": "module"`) cannot carry a `with` (a SyntaxError in modules); its
 * module and every module it statically imports from a relative path get a module-scoped `let
 * window;` prologue instead (legal at module scope: only a Script's global declaration
 * instantiation rejects the restricted global names), skipped for a module that declares
 * `window` itself. A `self.window = …` polyfill and the bare name stay apart in this shape.
 *
 * Every prefix is one line without a newline, so the original text's line numbers hold; the
 * suffix closes the block after a newline, so a trailing line comment cannot swallow it. The
 * files are rewritten in place on the unpacked package (the host serves them from disk on every
 * request, `Cache-Control: no-cache`) and restored from the driver's backup afterwards.
 */
object BareWindowBracket {
    /** A leading `'use strict'` directive prologue (after blanks and comments), as the runtime's own `STRICT_PROLOGUE` reads it. */
    val STRICT_PROLOGUE = Regex("""^(?:[\s\uFEFF]|//[^\n]*\n|/\*[\s\S]*?\*/)*(['"])use strict\1\s*;?""")

    /** A UTF-8 byte order mark as [scanFile]'s byte-for-char decoding shows it. */
    private const val BOM_LATIN1 = "\u00EF\u00BB\u00BF"

    /** An identifier `window` that is not a member read (`.window`) and not part of another word. */
    val BARE_WINDOW = Regex("""(?<![.\w$])window\b""")

    /** A module-scope declaration of `window` (a module with one needs no prologue: a second `let` would be a redeclaration). */
    val DECLARES_WINDOW = Regex("""(?m)^\s*(?:let|const|var|function|class)\s+window\b""")

    /** `importScripts(...)` calls with their string arguments (the rest of the call's text is left out). */
    val IMPORT_SCRIPTS = Regex("""importScripts\s*\(([^)]{0,4000})\)""")

    /** A static `import ... from '...'` / `export ... from '...'` / bare `import '...'` (minified modules put many on one line; a dynamic `import(` does not match). */
    val STATIC_IMPORT = Regex("""(?<![\w$.])(?:import\s*(?:[^;'"`()]*?\bfrom\s*)?|export\s*(?:\*(?:\s*as\s*[\w$]+)?|\{[^}]*\})\s*from\s*)(['"])([^'"\n]+)\1""")

    /** A `let`/`const`/`class` at the start of a line: the declarations a block would take away from the next `importScripts` file (an estimate: minified files put everything on one line). */
    val LEXICAL_AT_LINE_START = Regex("""(?m)^\s*(?:let|const|class)\s""")

    /** A dynamic `import(` (a module the static graph does not reach). */
    val DYNAMIC_IMPORT = Regex("""(?<![\w$.])import\s*\(""")

    /** The marker at the head of every rewritten file; a file that carries it is not rewritten twice. */
    const val MARKER = "/*zen-bare-window*/"

    /** How one file is bracketed. */
    enum class Mode { WITH, MODULE }

    /** One file of the plan: the package-relative path, the mode, what the scan found, and whether the bracket is applied to it. */
    data class Plan(
        val file: String,
        val mode: Mode,
        /** The worker's own file (carries the main probe); the others are its imports. */
        val main: Boolean,
        val exists: Boolean,
        val bytes: Long,
        val strict: Boolean,
        val bareReads: Int,
        val declaresWindow: Boolean,
        val lexicalAtLineStart: Int,
        val dynamicImports: Int,
        val imports: List<String>,
        val apply: Boolean,
        val already: Boolean
    )

    /** Files past this many are not followed (the count's cap). */
    const val MAX_FILES = 300

    /** The bracketed head of a classic script: `with` over the proxy, the probe, then the original text on the same line. */
    fun classicPrefix(file: String, strict: Boolean, main: Boolean): String {
        val proxy = "(function(){var s=self;return new Proxy(Object.create(null),{" +
            "has:function(t,k){return k==='window'}," +
            "get:function(t,k){return k==='window'?s.window:undefined}," +
            "set:function(t,k,v){if(k==='window'){s.window=v;return true}return false}," +
            "deleteProperty:function(t,k){if(k==='window'){try{delete s.window}catch(e){}}return true}})})()"
        return MARKER + "with(" + proxy + "){" + probe(file, "with", strict, main)
    }

    /** The head of a module: the module-scoped `let window;`, the probe, then the original text on the same line. */
    fun modulePrefix(file: String, main: Boolean): String = MARKER + "let window;" + probe(file, "module", false, main)

    /** The tail of a classic script: the block closed on its own line. */
    const val CLASSIC_SUFFIX = "\n}\n"

    /**
     * The probe, the block's first statement: what `typeof window` reads where the script's own
     * code reads it. In its own `try`: a script that declares `let window` at its top level (the
     * round 11 rescue's case) has the name in its temporal dead zone here, and the `typeof`
     * throws – recorded as the probe's `error`, the script's own code untouched.
     */
    private fun probe(file: String, mode: String, strict: Boolean, main: Boolean): String {
        val head = "mode:'$mode',file:'${js(file)}',strict:$strict"
        val record = "{$head,typeofWindow:typeof window,inSelf:('window' in self),inGlobalThis:('window' in globalThis),selfWindow:typeof self.window,at:Date.now()}"
        val fallback = "{$head,error:String(e),at:Date.now()}"
        return if (main) "try{self.__zenBareWindow=$record}catch(e){self.__zenBareWindow=$fallback};"
        else "try{self.__zenBareWindowFiles=(self.__zenBareWindowFiles||[]).concat([$record])}catch(e){self.__zenBareWindowFiles=(self.__zenBareWindowFiles||[]).concat([$fallback])};"
    }

    private fun js(text: String): String = text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")

    /** The whole bracketed text of a classic script (the file form streams the same three parts). */
    fun bracketClassic(text: String, file: String, main: Boolean = true): String =
        classicPrefix(file, STRICT_PROLOGUE.containsMatchIn(text), main) + text + CLASSIC_SUFFIX

    /** The whole prologued text of a module. */
    fun bracketModule(text: String, file: String, main: Boolean = true): String = modulePrefix(file, main) + text

    /**
     * `spec` imported from `from` (both package-relative), or null for one the package does not
     * hold (a foreign URL, a bare module specifier). An `importScripts` argument is a URL
     * (`url = true`): `lib/a.js` is relative to the importing file and a `chrome-extension://`
     * URL is the package's own path; a module specifier must start with `./`, `../` or `/`.
     */
    fun resolve(from: String, spec: String, url: Boolean = true): String? {
        var s = spec.trim()
        if (s.isEmpty() || s.startsWith("data:") || s.startsWith("blob:")) return null
        if (s.startsWith("chrome-extension://")) s = "/" + s.removePrefix("chrome-extension://").substringAfter('/', "")
        if (s.contains("://")) return null
        val raw = if (s.startsWith("/")) s.substring(1) else if (s.startsWith(".") || url) {
            val base = from.substringBeforeLast('/', "")
            if (base.isEmpty()) s else "$base/$s"
        } else return null
        val parts = ArrayList<String>()
        for (part in raw.substringBefore('?').substringBefore('#').split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1) else return null
                else -> parts += part
            }
        }
        return if (parts.isEmpty()) null else parts.joinToString("/")
    }

    /** The string arguments of every `importScripts(...)` in `text`, in order. */
    fun importScriptsOf(text: CharSequence): List<String> {
        val out = ArrayList<String>()
        for (call in IMPORT_SCRIPTS.findAll(text)) {
            for (arg in Regex("""(['"])([^'"\n]+)\1""").findAll(call.groupValues[1])) out += arg.groupValues[2]
        }
        return out
    }

    /** The specifiers of every static import / re-export in `text`, in order. */
    fun staticImportsOf(text: CharSequence): List<String> = STATIC_IMPORT.findAll(text).map { it.groupValues[2] }.toList()

    /** What one file's text says, for the plan (the file form scans in chunks; this is the whole-text form the tests use). */
    fun scanText(text: CharSequence): Scan = Scan(
        strict = STRICT_PROLOGUE.containsMatchIn(text),
        bareReads = BARE_WINDOW.findAll(text).count(),
        declaresWindow = DECLARES_WINDOW.containsMatchIn(text),
        lexicalAtLineStart = LEXICAL_AT_LINE_START.findAll(text).count(),
        dynamicImports = DYNAMIC_IMPORT.findAll(text).count(),
        importScripts = importScriptsOf(text),
        staticImports = staticImportsOf(text),
        already = text.startsWith(MARKER) || text.startsWith("\uFEFF$MARKER")
    )

    data class Scan(
        val strict: Boolean,
        val bareReads: Int,
        val declaresWindow: Boolean,
        val lexicalAtLineStart: Int,
        val dynamicImports: Int,
        val importScripts: List<String>,
        val staticImports: List<String>,
        val already: Boolean
    )

    /** A chunk of this many chars, each overlapping the next by [OVERLAP], so a bundle of tens of megabytes is never one String. */
    const val CHUNK = 1 shl 21
    const val OVERLAP = 1 shl 13

    /**
     * [scanText] over a file read in overlapping chunks decoded byte-for-char (ISO-8859-1: the
     * patterns are ASCII, and no UTF-8 sequence can be misread as one). A match belongs to the
     * chunk where its last character is new; one touching a chunk's end (no lookahead past the
     * buffer) is left to the next chunk, which sees it whole in the carried overlap.
     */
    fun scanFile(file: File): Scan {
        var strict = false
        var bare = 0
        var declares = false
        var lexical = 0
        var dynamic = 0
        val imports = LinkedHashSet<String>()
        val statics = LinkedHashSet<String>()
        var already = false
        var first = true
        InputStreamReader(FileInputStream(file), StandardCharsets.ISO_8859_1).use { reader ->
            val buf = CharArray(CHUNK)
            var carry = ""
            while (true) {
                var n = 0
                while (n < buf.size) {
                    val read = reader.read(buf, n, buf.size - n)
                    if (read < 0) break
                    n += read
                }
                if (n == 0 && carry.isEmpty()) break
                val text = carry + String(buf, 0, n)
                if (first) {
                    val head = text.removePrefix(BOM_LATIN1)
                    strict = STRICT_PROLOGUE.containsMatchIn(head)
                    already = head.startsWith(MARKER)
                    first = false
                }
                val from = carry.length
                val last = n < buf.size
                bare += countNew(BARE_WINDOW, text, from, last)
                if (!declares && DECLARES_WINDOW.containsMatchIn(text)) declares = true
                lexical += countNew(LEXICAL_AT_LINE_START, text, from, last)
                dynamic += countNew(DYNAMIC_IMPORT, text, from, last)
                imports += importScriptsOf(text)
                statics += staticImportsOf(text)
                if (last) break
                carry = text.substring(maxOf(0, text.length - OVERLAP))
            }
        }
        return Scan(strict, bare, declares, lexical, dynamic, imports.toList(), statics.toList(), already)
    }

    /**
     * The matches of `re` in one chunk that this chunk owns: those ending in the new part (or on
     * the carry's last char: the previous chunk left them), not those touching a non-final
     * chunk's end (the next chunk reads them with their lookahead).
     */
    private fun countNew(re: Regex, text: String, from: Int, last: Boolean): Int {
        var count = 0
        val end = text.length - 1
        for (m in re.findAll(text)) {
            val l = m.range.last
            if (l < from - 1) continue
            if (!last && l >= end) continue
            count++
        }
        return count
    }

    /**
     * The plan for a worker: the worker's file and what it reaches – `importScripts` files for a
     * classic worker (bracketed when they read a bare `window`), statically imported modules for
     * a module worker (prologued when they read a bare `window` and do not declare it). The
     * worker's own file is always in (it carries the probe).
     */
    fun plan(dir: File, worker: String, module: Boolean): List<Plan> {
        val out = ArrayList<Plan>()
        val seen = LinkedHashSet<String>()
        val queue = ArrayDeque<String>()
        val start = resolve("", "/" + worker.trimStart('/')) ?: worker.trimStart('/')
        queue += start
        while (queue.isNotEmpty() && out.size < MAX_FILES) {
            val rel = queue.removeFirst()
            if (!seen.add(rel)) continue
            val file = File(dir, rel)
            val main = rel == start
            if (!file.isFile) {
                out += Plan(rel, if (module) Mode.MODULE else Mode.WITH, main, false, 0, false, 0, false, 0, 0, emptyList(), false, false)
                continue
            }
            val scan = scanFile(file)
            val imports = (if (module) scan.staticImports else scan.importScripts).mapNotNull { resolve(rel, it, url = !module) }
            val apply = !scan.already && (main || scan.bareReads > 0) && !(module && scan.declaresWindow)
            out += Plan(
                rel, if (module) Mode.MODULE else Mode.WITH, main, true, file.length(), scan.strict, scan.bareReads,
                scan.declaresWindow, scan.lexicalAtLineStart, scan.dynamicImports, imports, apply, scan.already
            )
            for (next in imports) if (next !in seen) queue += next
        }
        return out
    }

    /**
     * Rewrites `file` in place as prefix + its bytes + suffix, streaming (a 40 MB bundle is never a
     * String on the debug heap), the original copied to `backup` first. Returns the bytes written.
     */
    fun rewrite(file: File, prefix: String, suffix: String, backup: File): Long {
        backup.parentFile?.mkdirs()
        file.copyTo(backup, overwrite = true)
        val tmp = File(file.parentFile, file.name + ".zen-bare-window.tmp")
        var written = 0L
        FileOutputStream(tmp).use { out ->
            val head = prefix.toByteArray(StandardCharsets.UTF_8)
            out.write(head)
            written += head.size
            FileInputStream(file).use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    written += n
                }
            }
            val tail = suffix.toByteArray(StandardCharsets.UTF_8)
            out.write(tail)
            written += tail.size
        }
        if (!tmp.renameTo(file)) {
            tmp.copyTo(file, overwrite = true)
            tmp.delete()
        }
        return written
    }

    /** Applies the plan's files: the prefix and suffix per mode. Returns per file what was written, or the reason it was left. */
    fun apply(dir: File, plans: List<Plan>, backupDir: File): List<Pair<Plan, String>> = plans.map { plan ->
        val file = File(dir, plan.file)
        val outcome = when {
            !plan.exists -> "missing"
            plan.already -> "already bracketed"
            !plan.apply -> "left as is (no bare window read)"
            else -> runCatching {
                val prefix = if (plan.mode == Mode.MODULE) modulePrefix(plan.file, plan.main) else classicPrefix(plan.file, plan.strict, plan.main)
                val suffix = if (plan.mode == Mode.MODULE) "" else CLASSIC_SUFFIX
                "rewritten: ${rewrite(file, prefix, suffix, File(backupDir, plan.file))} bytes"
            }.getOrElse { "rewrite failed: $it" }
        }
        plan to outcome
    }

    /** Puts every backed-up file of `backupDir` back under `dir`. Returns the files restored and any that failed. */
    fun restore(dir: File, backupDir: File): Pair<List<String>, List<String>> {
        val restored = ArrayList<String>()
        val failed = ArrayList<String>()
        if (!backupDir.isDirectory) return restored to failed
        for (backup in backupDir.walkTopDown().filter { it.isFile }) {
            val rel = backup.relativeTo(backupDir).path.replace(File.separatorChar, '/')
            val target = File(dir, rel)
            val ok = runCatching {
                backup.copyTo(target, overwrite = true)
                target.length() == backup.length() && !File(target.parentFile, target.name + ".zen-bare-window.tmp").exists()
            }.getOrDefault(false)
            if (ok) restored += rel else failed += rel
        }
        return restored to failed
    }
}
