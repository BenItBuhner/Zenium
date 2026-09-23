package app.zen.chromium.ext

import org.json.JSONObject
import java.io.File

/**
 * Assembles the scripts the extension layer injects (pure string work, unit-tested):
 *
 *  - the document-start script for tab WebViews: the boot config, every content-script group of
 *    every enabled extension as a real function literal, the CSS texts, then the bundled
 *    bootstrap (`assets/ext.js`). Function literals – not eval – so a page's Content-Security-Policy
 *    cannot block them, and the files of one declaration share one scope like the files of one
 *    isolated world share their global;
 *  - the page bootstrap for background pages, popups and options pages (config only);
 *  - the `scripting.executeScript` wrapper the host evaluates in a tab.
 */
object ExtensionScripts {
    /**
     * One content-script file's text as the assembly consumes it: [length] characters, written
     * into the builder by [appendTo] exactly once. A held string ([Source] of a text) stays
     * around – the compiler keeps small files softly for the next re-plan. A [transient] one lets
     * go of its text the moment it is copied in, so that while a large file (Monica's 28 million
     * characters of `content.js`) is being assembled the heap holds the text and the builder, and
     * at the copy out only the builder and the script: two copies at the peak, never three. The
     * third copy was the allocation that failed on the 192 MB debug heap.
     */
    class Source(val length: Int, val names: List<String>, private val write: (StringBuilder) -> Unit) {
        constructor(text: String) : this(text.length, TopLevelDeclarations.scanSource(text), { it.append(text) })

        fun appendTo(sb: StringBuilder) = write(sb)

        companion object {
            /** A text appended once and released: after [appendTo] the source no longer holds it. */
            fun transient(text: String): Source {
                var held: String? = text
                return Source(text.length, TopLevelDeclarations.scanSource(text)) { sb ->
                    sb.append(held ?: throw IllegalStateException("a transient source is appended once"))
                    held = null
                }
            }
        }
    }

    /** One content-script group: the extension id, the group index and its files' sources in order. */
    class Group(val extensionId: String, val index: Int, val sources: List<Source>, val isolation: String) {
        companion object {
            /** A group over texts held in memory. */
            fun of(extensionId: String, index: Int, sources: List<String>, isolation: String): Group =
                Group(extensionId, index, sources.map { Source(it) }, isolation)
        }
    }

    /**
     * The `//# sourceURL` of the scripts the host runs in a tab's main world (the document-start
     * script, the `executeScript` wrapper): a location no page script can carry, so the bootstrap's
     * Trusted Types shield can tell an extension's DOM write from the page's by its stack frame
     * (`extensionIsolation.ts`, `ownScriptMatcher`). Also what DevTools and error events name them.
     */
    const val SOURCE_URL = "zenium-ext://content-scripts/boot.js"

    /** The magic comment that names a script [SOURCE_URL]; last in the text, so a file's own magic comment does not win. */
    private const val SOURCE_URL_TAIL = "\n//# sourceURL=$SOURCE_URL"

    /** The [guarded] shell around an expression, and the close of the [exec] function literal. */
    private const val GUARD_HEAD = "(function(){try{return {v:"
    private const val GUARD_TAIL = "}}catch(e){return {e:String(e&&e.message||e)}}})()"
    private const val EXEC_TAIL = "\n})"
    private const val EXEC_TAIL_SCOPED = "\n}})"

    /** Between two injected files: a file ending in a line comment cannot swallow the next one. */
    private const val FILE_JOIN = "\n;\n"

    /** `script` named [SOURCE_URL] for stack frames (the `executeScript` wrapper; a document-start script is born named). */
    fun named(script: String): String = script + SOURCE_URL_TAIL

    /**
     * The document-start script, named [SOURCE_URL]. Assembled in one builder sized for the whole
     * text and copied out once: an extension's units can run to ten million characters (Grammarly)
     * or twenty-eight million (Monica), and a 192 MB debug heap that holds the sources, the
     * builder's `char[]` and the string at once has no room for a second builder growing by
     * doubling on top of them (a `named(toString())` pass did that, and a 37 MB `char[]` for it
     * was the allocation that failed on the emulator). The sources of large files are
     * [Source.transient]: released as they are copied in, so the peak is two copies of the text,
     * not three (the third, Monica's 57 MB string at the copy out, was the next allocation to fail).
     */
    fun documentStart(
        bootstrap: String,
        configJson: String,
        groups: List<Group>,
        css: Map<String, String>,
        debug: Boolean
    ): String {
        val sb = StringBuilder(
            bootstrap.length + configJson.length + groups.sumOf { g -> g.sources.sumOf { it.length } + mirrorOf(g).length + 96 } +
                css.entries.sumOf { (key, text) -> key.length + text.length + 8 } + SOURCE_URL_TAIL.length + 4096
        )
        sb.append("(function(){var __zenExtBoot={config:").append(configJson).append(",debug:").append(debug)
        sb.append(",css:{")
        var first = true
        for ((key, text) in css) {
            if (!first) sb.append(',')
            first = false
            sb.append(JSONObject.quote(key)).append(':').append(JSONObject.quote(text))
        }
        sb.append("},sources:{")
        first = true
        for (group in groups) {
            if (!first) sb.append(',')
            first = false
            sb.append(JSONObject.quote("${group.extensionId}/${group.index}")).append(':')
            appendGroupFunction(sb, group)
        }
        sb.append("}};\n").append(bootstrap).append("\n})();").append(SOURCE_URL_TAIL)
        return sb.toString()
    }

    /**
     * `function (window, self, globalThis, chrome, browser, __zenMirror) { <files> <mirror> }`.
     * Each file ends with a newline (a trailing `//` comment must not swallow the next file) and
     * a `;` (a file ending in an expression must not become a call of the next file's leading
     * parenthesis). The mirror ([TopLevelDeclarations.mirror]) hands the files' top-level
     * declarations to the extension's scope, where Chrome's world would have had them as globals.
     */
    fun appendGroupFunction(sb: StringBuilder, group: Group) {
        sb.append(FUNCTION_HEAD)
        if (group.isolation == "with") sb.append("with(window){")
        for (source in group.sources) {
            sb.append('\n')
            source.appendTo(sb)
            sb.append("\n;")
        }
        sb.append(mirrorOf(group))
        if (group.isolation == "with") sb.append('}')
        sb.append("\n}")
    }

    /** The mirror tail of a group: its files' top-level names, each once, in order. */
    fun mirrorOf(group: Group): String {
        if (group.sources.all { it.names.isEmpty() }) return ""
        val names = LinkedHashSet<String>()
        for (source in group.sources) names.addAll(source.names)
        return TopLevelDeclarations.mirror(names)
    }

    /** The parameters of a content-script or `executeScript` function literal; the bootstrap's `runGroup` / `exec` call it with these. */
    private const val FUNCTION_HEAD = "function(window,self,globalThis,chrome,browser,${TopLevelDeclarations.MIRROR_PARAM}){"

    /**
     * The `executeScript` wrapper's seventh parameter, where a script injection's completion value
     * waits for the return: the bootstrap passes six arguments, so it starts undefined, and a
     * bare assignment to it inside the `with` block resolves past the scope proxy (which answers
     * `has` for its store and the browser's globals only) to the parameter.
     */
    const val COMPLETION_PARAM = "__zenCompletion"

    /** The `executeScript` wrapper's head: [FUNCTION_HEAD]'s parameters and [COMPLETION_PARAM]. */
    private const val EXEC_FUNCTION_HEAD = "function(window,self,globalThis,chrome,browser,${TopLevelDeclarations.MIRROR_PARAM},$COMPLETION_PARAM){"

    /** Written before a script's last expression statement, so the statement's value is the parameter's. */
    private const val COMPLETION_ASSIGN = "$COMPLETION_PARAM="

    /** After the body and the mirror: the completion value returned. */
    private const val COMPLETION_RETURN = "\n;return $COMPLETION_PARAM"

    /**
     * The bootstrap for an extension page (background, popup, options): config only. While
     * [debug], the page exposes its debug stats (`__zenExtStats`: its engine's flow counters)
     * as a content world does; the compat sweep reads them off a background or a popup.
     */
    fun page(bootstrap: String, configJson: String, debug: Boolean = false): String =
        "(function(){var __zenExtBoot={config:$configJson,debug:$debug,css:{},sources:{}};\n$bootstrap\n})();"

    /**
     * What the host evaluates in a tab for `scripting.executeScript` / `tabs.executeScript`: the
     * code becomes a function literal handed to the bootstrap's `__zenExtExec`, which runs it in
     * the extension's scope. `funcSource` + `args` (MV3 `func`) returns the function's value.
     *
     * `scoped`: the injection runs in the main world for the extension's `with` scope (a WebView
     * without isolated worlds, or a document that predates the extension's world), so the body is
     * a `with(window){…}` block as [appendGroupFunction] makes a content script's: the scope proxy
     * is then where a bare identifier resolves as well as what `globalThis` names, and a file that
     * writes `globalThis.litPropertyMetadata = …` then reads the bare `litPropertyMetadata` (Lit's
     * reactive element, in Read&Write's toolbar) finds its own write. Without the block the bare
     * name looked the page's global up and threw `litPropertyMetadata is not defined`. An
     * isolated world, and a `world: "MAIN"` injection, run unscoped: their global is the scope.
     *
     * `code` (MV2 `tabs.executeScript({ code })`) is a script in Chrome, so its top-level
     * declarations are mirrored onto the scope after it ran ([TopLevelDeclarations]); a `func` is
     * a function there too, its declarations its own.
     *
     * A script's value in Chrome is its completion value – the last statement's, when that is an
     * expression (`document.title`; Imageye's `imageScraper.js` ends in an IIFE returning its
     * list; `tabs.detectLanguage`'s own probe is one) – where a function body's is what it
     * returns, nothing. So when the text's last statement is an expression
     * ([TopLevelDeclarations.lastExpressionStatement]) the wrapper writes it into its completion
     * parameter and returns that after the mirror; a promise there is awaited by the bootstrap as
     * a `func`'s is. A script ending in a declaration or a block answers undefined, as in Chrome.
     */
    fun exec(token: String, extensionId: String, kind: String, payload: JSONObject, code: String?, funcSource: String?, argsJson: String?, scoped: Boolean = false): String {
        val body = execBody(code, funcSource, argsJson)
        val script = if (funcSource == null) code else null
        val completion = if (script != null) TopLevelDeclarations.lastExpressionStatement(body) else null
        val captured = if (completion == null) body else body.substring(0, completion[0]) + COMPLETION_ASSIGN + body.substring(completion[0])
        return execHead(token, extensionId, kind, payload, scoped) + captured +
            (if (script != null) TopLevelDeclarations.mirror(TopLevelDeclarations.scanSource(script)) else "") +
            (if (completion != null) COMPLETION_RETURN else "") +
            execTail(scoped)
    }

    /**
     * A document without the extension's bootstrap (one the runtime could not reach: loaded
     * before the extension was attached, or a scheme it does not inject into) has no
     * `__zenExtExec`; the caller hears Chrome's refusal for a page it cannot script, not
     * `__zenExtExec is not a function`.
     */
    const val NO_ACCESS = "Cannot access contents of the page. Extension manifest must request permission to access the respective host."

    private fun execHead(token: String, extensionId: String, kind: String, payload: JSONObject, scoped: Boolean): String =
        "(typeof __zenExtExec===\"function\"?__zenExtExec:function(){throw new Error(${JSONObject.quote(NO_ACCESS)})})" +
            "(${JSONObject.quote(token)},${JSONObject.quote(extensionId)},${JSONObject.quote(kind)},$payload," +
            EXEC_FUNCTION_HEAD + (if (scoped) "with(window){" else "") + "\n"

    private fun execTail(scoped: Boolean): String = if (scoped) EXEC_TAIL_SCOPED else EXEC_TAIL

    private fun execBody(code: String?, funcSource: String?, argsJson: String?): String = when {
        funcSource != null -> "return (${funcSource}).apply(null,${argsJson ?: "[]"});"
        code != null -> code
        else -> ""
    }

    /**
     * `expression`, evaluated so that its outcome always comes back as JSON the host can read:
     * `{"v": <value>}` when it returned, `{"e": "<message>"}` when it threw (`evaluateJavascript`
     * alone answers an exception with a bare `null`, indistinguishable from a script returning null).
     */
    fun guarded(expression: String): String = GUARD_HEAD + expression + GUARD_TAIL

    /**
     * The whole script one `ext.exec` evaluates – [exec] inside [guarded], after `prefix` (a late
     * boot) when there is one, named like the document-start script when `named` – assembled in
     * one builder sized for its parts and copied out once. The extension's own files (MV3 `files`,
     * MV2 `file`) are streamed into it here, in order, joined the way [exec]'s code joins them,
     * instead of travelling through the bridge as text: Loom injects a 13 MB `content.js` on its
     * action click, and that text as a `readFile` answer, an `exec` argument, a parsed JSON
     * string, a template, a guard and a name was six copies of it on a 192 MB heap (the sweep's
     * process died on the fifth). This way it is on the heap twice: the builder and the string
     * the WebView takes. A file's size in bytes bounds its length in chars, so the builder never
     * grows.
     */
    fun execScript(
        token: String,
        extensionId: String,
        kind: String,
        payload: JSONObject,
        code: String?,
        files: List<File>,
        funcSource: String?,
        argsJson: String?,
        prefix: String?,
        named: Boolean,
        scoped: Boolean = false
    ): String {
        val head = execHead(token, extensionId, kind, payload, scoped)
        val body = execBody(code, funcSource, argsJson)
        val tail = execTail(scoped)
        // A script's declarations (`code`, `files`) are mirrored onto the scope after the body; a
        // `func` is a function in Chrome too. The files' names are read off the builder once they
        // are in it, so the tail's room is a bound, not a measure (TopLevelDeclarations.MIRROR_ROOM).
        // A script's completion value (the last file's last expression statement, see [exec]) is
        // written into the completion parameter in place, which shifts the text after it once.
        val mirrored = funcSource == null && (code != null || files.isNotEmpty())
        val capacity = (prefix?.length ?: -1) + 1 + GUARD_HEAD.length + head.length + body.length +
            files.sumOf { it.length().toInt() + FILE_JOIN.length } + tail.length + GUARD_TAIL.length +
            (if (named) SOURCE_URL_TAIL.length else 0) +
            (if (mirrored) TopLevelDeclarations.MIRROR_ROOM + COMPLETION_ASSIGN.length + COMPLETION_RETURN.length else 0)
        val sb = StringBuilder(capacity)
        if (prefix != null) sb.append(prefix).append('\n')
        sb.append(GUARD_HEAD).append(head)
        val names = LinkedHashSet<String>()
        val bodyStart = sb.length
        var lastStart = bodyStart
        sb.append(body)
        if (mirrored && code != null) names.addAll(TopLevelDeclarations.scanSource(sb, bodyStart, sb.length))
        var joined = body.isNotEmpty()
        val buffer = CharArray(64 * 1024)
        for (file in files) {
            if (joined) sb.append(FILE_JOIN)
            joined = true
            val fileStart = sb.length
            lastStart = fileStart
            file.bufferedReader().use { reader ->
                while (true) {
                    val n = reader.read(buffer)
                    if (n < 0) break
                    sb.append(buffer, 0, n)
                }
            }
            if (mirrored) names.addAll(TopLevelDeclarations.scanSource(sb, fileStart, sb.length))
        }
        val completion = if (mirrored) TopLevelDeclarations.lastExpressionStatement(sb, lastStart, sb.length) else null
        if (completion != null) sb.insert(completion[0], COMPLETION_ASSIGN)
        if (names.isNotEmpty()) sb.append(TopLevelDeclarations.mirror(names))
        if (completion != null) sb.append(COMPLETION_RETURN)
        sb.append(tail).append(GUARD_TAIL)
        if (named) sb.append(SOURCE_URL_TAIL)
        return sb.toString()
    }

    /**
     * A late boot: the content bootstrap with the extension's late config and no sources,
     * evaluated by the host into the main world of a document that predates the extension's
     * world (or on a WebView without worlds) so that a following `exec` finds a scope. The
     * bootstrap is idempotent in a document that booted already.
     */
    fun lateBoot(bootstrap: String, lateConfigJson: String, debug: Boolean): String =
        documentStart(bootstrap, lateConfigJson, emptyList(), emptyMap(), debug)

    /** True for a file the runtime serves as a script (`.js`, `.mjs`). */
    fun isScriptPath(path: String): Boolean = mimeType(path) == "text/javascript"

    /**
     * A served module's text bracketed for a one-realm WebView: `globalThis.__zenExtModule(id)`
     * shares the text's first line (line numbers, and so source maps, stay) and
     * `__zenExtModuleEnd(id)` takes a line of its own after whatever the file ended in. While
     * the module's body evaluates, the page's real `chrome`, `self` and `globalThis` answer with
     * the extension's (the bootstrap's accessors, `extensionModuleChrome.ts`); both calls are
     * guarded, so the same text also runs where the brackets were never installed. The prologue
     * also binds `chrome` in the module's own scope (`let chrome = <the entry>`), so a handler the
     * module runs later keeps the extension's (Buyhatke's Vite chunks read `chrome.storage` from
     * theirs); a webpack chunk ([isWebpackChunk]) binds `self` the same way for the registry its
     * factories read; a module declaring `chrome` itself ([declaresChrome]) keeps the bare entry.
     * The TypeScript twin is `wrapModuleText`; `extensionModuleChrome.test.ts` and
     * `ExtensionScriptsTest` pin the shape.
     */
    fun moduleChromeWrap(text: String, extensionId: String): String =
        moduleChromeOpen(extensionId, text) + text + moduleChromeClose(extensionId)

    /** How far into a served script the host looks for a webpack chunk's registration. */
    const val WEBPACK_CHUNK_HEAD = 512

    /**
     * A webpack chunk's registration, as webpack writes it at the top of every non-entry chunk
     * of a `web`-like target: `(self.webpackChunk<name>=self.webpackChunk<name>||[]).push([...`,
     * the global spelled `self`, `globalThis` or `window` by `output.globalObject`; a directive,
     * a comment or a one-line polyfill (`"undefined"!=typeof browser&&(chrome=browser);`) may
     * come first. The same expression is `WEBPACK_CHUNK` in `extensionModuleChrome.ts`.
     */
    private val WEBPACK_CHUNK = Regex("""\((self|globalThis|window)\.(webpackChunk\w*)\s*=\s*\1\.\2\s*\|\|\s*\[\]\)\s*\.push\s*\(""")

    /** Whether the head of a served script is a webpack chunk's registration ([WEBPACK_CHUNK]). */
    fun isWebpackChunk(head: String): Boolean = WEBPACK_CHUNK.containsMatchIn(head.take(WEBPACK_CHUNK_HEAD))

    /** How far into a served module the host looks for a declaration of `chrome` of its own. */
    const val MODULE_SCAN_HEAD = 1 shl 20

    /**
     * A binding named `chrome` a module may declare itself: a declaration keyword before the
     * name, an `import` of it (default, namespace or `as chrome`), or the name alone between the
     * braces or commas of a destructuring pattern or an import list. Read conservatively: a match
     * inside a function body or a string costs the module only the module-scoped binding, a miss
     * would cost it its whole text. The same expression is `OWN_CHROME` in `extensionModuleChrome.ts`.
     */
    private val OWN_CHROME = Regex(
        """(?:^|[^\w$.])(?:(?:let|const|var|class|function)\s+chrome|function\s*\*\s*chrome|import\s+chrome|import\s*\*\s*as\s+chrome|as\s+chrome)(?![\w$])|[{,]\s*chrome\s*(?=[,}]|=(?!=))"""
    )

    /** Whether the head of a served module declares a `chrome` of its own ([OWN_CHROME]). */
    fun declaresChrome(head: String): Boolean = OWN_CHROME.containsMatchIn(head.take(MODULE_SCAN_HEAD))

    /**
     * The bracket ahead of a served module's text, given the text's head ([MODULE_SCAN_HEAD]
     * chars are enough); ASCII, so it prefixes the file's UTF-8 bytes as it is. The entry is
     * the module-scoped `chrome` (a `let`, so the module's own functions keep the extension's
     * later); a webpack chunk is one `push` expression and declares nothing at its top level, so
     * its prologue binds `self` the same way; a module declaring `chrome` itself keeps the bare
     * entry, since a second declaration would be a SyntaxError for the file.
     */
    fun moduleChromeOpen(extensionId: String, head: String = ""): String {
        val id = JSONObject.quote(extensionId)
        val chrome = "let chrome=globalThis.__zenExtModule?globalThis.__zenExtModule($id):globalThis.chrome"
        if (isWebpackChunk(head)) return "$chrome,self=globalThis.__zenExtModuleSelf?globalThis.__zenExtModuleSelf($id):globalThis.self;"
        if (declaresChrome(head)) return "globalThis.__zenExtModule&&globalThis.__zenExtModule($id);"
        return "$chrome;"
    }

    /** The bracket after a served module's text, on a line of its own. */
    fun moduleChromeClose(extensionId: String): String =
        "\n;globalThis.__zenExtModuleEnd&&globalThis.__zenExtModuleEnd(${JSONObject.quote(extensionId)});"

    /** `Content-Type` for a file inside the extension directory, by extension. */
    fun mimeType(path: String): String {
        val ext = path.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "html", "htm" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "svg" -> "image/svg+xml"
            "webp" -> "image/webp"
            "ico" -> "image/x-icon"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "txt" -> "text/plain"
            "xml" -> "application/xml"
            "wasm" -> "application/wasm"
            "mp3" -> "audio/mpeg"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            "ogg" -> "audio/ogg"
            "pdf" -> "application/pdf"
            else -> "application/octet-stream"
        }
    }
}
