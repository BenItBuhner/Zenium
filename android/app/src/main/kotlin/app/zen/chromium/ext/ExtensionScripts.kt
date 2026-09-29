package app.zen.chromium.ext

import org.json.JSONObject
import java.io.File
import java.io.Reader
import java.nio.CharBuffer

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
     * into the builder by [appendTo] exactly once – [length] is a contract, exactly what
     * [appendTo] writes (a rewritten file reports its rewritten length, `RelativeImports.source`),
     * since [documentStartSized] sizes its builder from it. A held string ([Source] of a text) stays
     * around – the compiler keeps small files softly for the next re-plan. A [transient] one lets
     * go of its text the moment it is copied in, so that while a large file (Monica's 28 million
     * characters of `content.js`) is being assembled the heap holds the text and the builder, and
     * at the copy out only the builder and the script: two copies at the peak, never three. The
     * third copy was the allocation that failed on the 192 MB debug heap.
     */
    class Source(val length: Int, val names: List<String>, private val write: (Appendable) -> Unit) {
        constructor(text: String) : this(text.length, TopLevelDeclarations.scanSource(text), { it.append(text) })

        /** Write the text into `out` – the unit's builder, or the writer of its file ([documentStartTo]). */
        fun appendTo(out: Appendable) = write(out)

        companion object {
            /** A text appended once and released: after [appendTo] the source no longer holds it. */
            fun transient(text: String): Source {
                var held: String? = text
                return Source(text.length, TopLevelDeclarations.scanSource(text)) { out ->
                    out.append(held ?: throw IllegalStateException("a transient source is appended once"))
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
     * A unit's shape (`UnitShape` in the core's `units.ts`): how much of the bootstrap its script
     * carries. The WebView keeps every registered script whole once per tab view in the app
     * process and once per live frame in the renderer, whatever its origin rules, so a bootstrap
     * per rule set was that many copies of 163 K characters per view and per frame (compat round
     * 19: 21 units across the frame budget's six extensions, 3.4 M of their 17.6 M characters).
     * In an isolated world of the extension's own, one unit carries it and the world's other rule
     * sets attach:
     *
     *  - [SHAPE_WHOLE]: config, CSS, sources and the bootstrap, run at once – the main world's
     *    shape (a carrier there would be a name the page can see) and a world with one unit;
     *  - [SHAPE_CARRIER]: the same, the bootstrap wrapped as a function of the boot that is left
     *    on the world's global as [CARRIER] and called once for this unit's own boot – the
     *    world's `*`-rule unit, registered first, so it has run before any thin unit;
     *  - [SHAPE_HOLDER]: the function alone, defined and not called (no sources to run): what a
     *    world with several rule sets and none over every origin gets, so a frame no set
     *    matches boots nothing;
     *  - [SHAPE_THIN]: config, CSS and sources without the bootstrap: the unit calls the
     *    world's [CARRIER] with its boot, and the bootstrap attaches it to the runtime the
     *    world has (its own hand-off, token-checked) or boots the frame when it is the first
     *    of the world to match it.
     */
    const val SHAPE_WHOLE = "whole"
    const val SHAPE_CARRIER = "carrier"
    const val SHAPE_HOLDER = "holder"
    const val SHAPE_THIN = "thin"

    /** The world global's slot for the carried bootstrap: `function (__zenExtBoot) { <bootstrap> }`. */
    const val CARRIER = "__zenExtCarrier"

    /** Around the bootstrap in a carrier or a holder; the parameter is the free name the bootstrap reads its boot by. */
    private const val CARRIER_HEAD = "var __zenExtCarry=globalThis.$CARRIER=function(__zenExtBoot){\n"
    private const val CARRIER_TAIL = "\n};\n"

    /** A carrier's own boot, through the function it just defined. */
    private const val CARRIER_RUN = "__zenExtCarry(__zenExtBoot);"

    /**
     * A thin unit's whole run: the world's carrier with this unit's boot. No carrier (a world
     * whose bootstrap unit failed to register, which the plan does not allow) is a console line
     * naming the extension, not an exception a page could observe.
     */
    private const val THIN_RUN = "var __zenExtCarry=globalThis.$CARRIER;" +
        "if(typeof __zenExtCarry===\"function\")__zenExtCarry(__zenExtBoot);" +
        "else console.error(\"[Zenium] extension \"+String((__zenExtBoot.config.extension||{}).name||\"\")+" +
        "\": a set of its content scripts found no bootstrap in its world\");"

    /** The most a shape's fixed text adds around the bootstrap (or in its place). */
    private const val SHAPE_ROOM = 512

    /** The document-start script's fixed text, in the order it is written; counted before the builder is made. */
    private const val BOOT_HEAD = "(function(){var __zenExtBoot={config:"
    private const val BOOT_DEBUG = ",debug:"
    private const val BOOT_CSS = ",css:{"
    private const val BOOT_SOURCES = "},sources:{"
    private const val BOOT_END = "}};\n"
    private const val BOOT_CLOSE = "\n})();"
    private const val WITH_HEAD = "with(window){"
    private const val SOURCE_JOIN_HEAD = "\n"
    private const val SOURCE_JOIN_TAIL = "\n;"
    private const val FUNCTION_TAIL = "\n}"

    /**
     * A document-start script and the size its builder was made with. [presized] is the count
     * of the script's text before the builder was allocated; the builder grows only when
     * `script.length` is over it, which the count is written not to allow ([documentStartSized]).
     */
    class Assembled(val script: String, val presized: Int) {
        /** Whether an append grew the builder past its size – what the compat lanes' `configured` line counts. */
        val grown: Boolean get() = script.length > presized
    }

    /**
     * The document-start script, named [SOURCE_URL]. Assembled in one builder sized for the whole
     * text and copied out once: an extension's units can run to ten million characters (Grammarly)
     * or twenty-eight million (Monica), and a 192 MB debug heap that holds the sources, the
     * builder's `char[]` and the string at once has no room for a second builder growing by
     * doubling on top of them (a `named(toString())` pass did that, and a 37 MB `char[]` for it
     * was the allocation that failed on the emulator). The sources of large files are
     * [Source.transient]: released as they are copied in, so the peak is two copies of the text,
     * not three (the third, Monica's 57 MB string at the copy out, was the next allocation to fail).
     *
     * `shape` ([SHAPE_WHOLE] unless the plan says otherwise) decides how the bootstrap goes in;
     * an unknown shape is assembled whole, the shape that runs anywhere.
     */
    fun documentStart(
        bootstrap: String,
        configJson: String,
        groups: List<Group>,
        css: Map<String, String>,
        debug: Boolean,
        shape: String = SHAPE_WHOLE
    ): String = documentStartSized(bootstrap, configJson, groups, css, debug, shape).script

    /**
     * [documentStart] with the size its builder was made with ([Assembled.presized]).
     *
     * The builder is sized by counting the text EXACTLY before it is allocated – every literal,
     * `debug`'s spelling, the quoted CSS keys and texts (bounded from above, [quotedChars]), each
     * group's quoted key, function head, `with` block, per-source joins, mirror and close (the
     * key quoted and the mirror computed once here and handed to the append), the shape's
     * bootstrap part, the close and the name – so that no append ever grows it. The builder that
     * grows doubles: a 10.6 million character carrier (Adblock Ad Blocker Pro's 650 registered
     * scriptlets, one group each) was pre-sized from the sources' lengths plus an estimate of the
     * groups' fixed text that came out 22,601 characters short, and the last append asked for a
     * 21 million character `char[]` – 42 MB, on a 192 MB heap that held the old runtime and the
     * new (compat round 21b, the class's second trigger). A count that is exact has no last
     * append to fail: the builder's `char[]` is the script's size once, and the string copied out
     * of it is the second and last allocation of the size.
     */
    fun documentStartSized(
        bootstrap: String,
        configJson: String,
        groups: List<Group>,
        css: Map<String, String>,
        debug: Boolean,
        shape: String = SHAPE_WHOLE
    ): Assembled {
        val layout = Layout(bootstrap, configJson, groups, css, debug, shape)
        val sb = StringBuilder(layout.count)
        layout.writeTo(sb)
        return Assembled(sb.toString(), layout.count)
    }

    /**
     * What [documentStartTo] wrote: the count the text was laid out to ([Assembled.presized]'s
     * figure) and the characters that went into the sink – the same number when the count is
     * right, which [grown] checks as [Assembled.grown] does.
     */
    class Written(val presized: Int, val chars: Int) {
        val grown: Boolean get() = chars > presized
    }

    /**
     * [documentStartSized]'s text written into `out` as it is assembled – the writer of a file
     * under the runtime's unit store (`UnitCompiler`, compat round 24's R24-1) – so that no
     * builder and no `String` of the unit stands in the Java heap: a 10.6 million character
     * carrier (Adblock Ad Blocker Pro's 650 scriptlets) was a 21 MB builder and a 21 MB string
     * at its copy-out, the 42 MB floor round 23 §4.2 measured, next to the sources being copied
     * in; written through, the peak is the sources alone. The same text, character for
     * character, as [documentStartSized] assembles (its tests hold the two to each other);
     * counted as it goes, so [Written.grown] reads the count against what was written.
     */
    fun documentStartTo(
        out: Appendable,
        bootstrap: String,
        configJson: String,
        groups: List<Group>,
        css: Map<String, String>,
        debug: Boolean,
        shape: String = SHAPE_WHOLE
    ): Written {
        val layout = Layout(bootstrap, configJson, groups, css, debug, shape)
        val counting = Counting(out)
        layout.writeTo(counting)
        return Written(layout.count, counting.chars)
    }

    /** An [Appendable] over another that counts the characters through it. */
    private class Counting(private val out: Appendable) : Appendable {
        var chars = 0

        override fun append(csq: CharSequence?): Appendable {
            val s = csq ?: "null"
            out.append(s)
            chars += s.length
            return this
        }

        override fun append(csq: CharSequence?, start: Int, end: Int): Appendable {
            out.append(csq ?: "null", start, end)
            chars += end - start
            return this
        }

        override fun append(c: Char): Appendable {
            out.append(c)
            chars++
            return this
        }
    }

    /**
     * The document-start script's text laid out before it is written: the groups' quoted keys
     * and mirrors (computed once here and handed to the append), and the EXACT count of the
     * whole – every literal, `debug`'s spelling, the quoted CSS keys and texts (bounded from
     * above, [quotedChars]), each group's function, the shape's bootstrap part, the close and the
     * name – so that a builder sized by it never grows ([documentStartSized]) and a file written
     * by it is checked against it ([documentStartTo]).
     */
    private class Layout(
        private val bootstrap: String,
        private val configJson: String,
        private val groups: List<Group>,
        private val css: Map<String, String>,
        debug: Boolean,
        private val shape: String
    ) {
        private val debugText = debug.toString()
        private val keys = Array(groups.size) { JSONObject.quote("${groups[it].extensionId}/${groups[it].index}") }
        private val mirrors = Array(groups.size) { mirrorOf(groups[it]) }
        val count: Int

        init {
            var count = BOOT_HEAD.length + configJson.length + BOOT_DEBUG.length + debugText.length + BOOT_CSS.length
            var first = true
            for ((key, text) in css) {
                if (!first) count++
                first = false
                count += quotedChars(key) + 1 + quotedChars(text)
            }
            count += BOOT_SOURCES.length
            for (i in groups.indices) {
                if (i > 0) count++
                count += keys[i].length + 1 + groupFunctionChars(groups[i], mirrors[i])
            }
            count += BOOT_END.length + shapeChars(bootstrap.length, shape) + BOOT_CLOSE.length + SOURCE_URL_TAIL.length
            this.count = count
        }

        fun writeTo(out: Appendable) {
            out.append(BOOT_HEAD).append(configJson).append(BOOT_DEBUG).append(debugText)
            out.append(BOOT_CSS)
            var first = true
            for ((key, text) in css) {
                if (!first) out.append(',')
                first = false
                out.append(JSONObject.quote(key)).append(':').append(JSONObject.quote(text))
            }
            out.append(BOOT_SOURCES)
            for (i in groups.indices) {
                if (i > 0) out.append(',')
                out.append(keys[i]).append(':')
                appendGroupFunction(out, groups[i], mirrors[i])
            }
            out.append(BOOT_END)
            when (shape) {
                SHAPE_CARRIER -> out.append(CARRIER_HEAD).append(bootstrap).append(CARRIER_TAIL).append(CARRIER_RUN)
                SHAPE_HOLDER -> out.append(CARRIER_HEAD).append(bootstrap).append(CARRIER_TAIL)
                SHAPE_THIN -> out.append(THIN_RUN)
                else -> out.append(bootstrap)
            }
            out.append(BOOT_CLOSE).append(SOURCE_URL_TAIL)
        }
    }

    /** Exactly what the shape's bootstrap part of [documentStartSized] writes, in characters. */
    private fun shapeChars(bootstrapLength: Int, shape: String): Int = when (shape) {
        SHAPE_CARRIER -> CARRIER_HEAD.length + bootstrapLength + CARRIER_TAIL.length + CARRIER_RUN.length
        SHAPE_HOLDER -> CARRIER_HEAD.length + bootstrapLength + CARRIER_TAIL.length
        SHAPE_THIN -> THIN_RUN.length
        else -> bootstrapLength
    }

    /** Exactly what [appendGroupFunction] writes for `group` with `mirror` as its mirror tail, in characters. */
    fun groupFunctionChars(group: Group, mirror: String): Int {
        var count = FUNCTION_HEAD.length + mirror.length + FUNCTION_TAIL.length
        if (group.isolation == "with") count += WITH_HEAD.length + 1
        for (source in group.sources) count += SOURCE_JOIN_HEAD.length + source.length + SOURCE_JOIN_TAIL.length
        return count
    }

    /**
     * An upper bound on `JSONObject.quote(text).length`, for sizing a builder the quoted text is
     * appended to, that holds for both org.json implementations the code runs over: Android's
     * (which escapes `/` always, and every control character) and the public one the JVM tests
     * use (which escapes `/` after `<` only, and the U+0080-U+009F and U+2000-U+20FF ranges as
     * `\uXXXX` besides the controls). Two for the quotes; two for a character either escapes
     * with a backslash; six for one either writes as `\uXXXX`; one otherwise.
     */
    fun quotedChars(text: String): Int {
        var count = 2
        for (c in text) {
            count += when {
                c == '"' || c == '\\' || c == '/' -> 2
                c == '\t' || c == '\b' || c == '\n' || c == '\r' || c == '\u000C' -> 2
                c < ' ' || (c >= '\u0080' && c < '\u00A0') || (c >= '\u2000' && c < '\u2100') -> 6
                else -> 1
            }
        }
        return count
    }

    /**
     * What a shape's bootstrap part comes to, in characters, from the bootstrap's length alone
     * (with room over the exact figure): how `UnitCompiler` measures a unit against its budget
     * before reading a file. The builder itself is sized by the exact count ([documentStartSized]).
     */
    fun bootstrapChars(bootstrapLength: Int, shape: String): Int =
        if (shape == SHAPE_THIN) SHAPE_ROOM else bootstrapLength + SHAPE_ROOM

    /**
     * `function (window, self, globalThis, chrome, browser, __zenMirror) { <files> <mirror> }`.
     * Each file ends with a newline (a trailing `//` comment must not swallow the next file) and
     * a `;` (a file ending in an expression must not become a call of the next file's leading
     * parenthesis). The mirror ([TopLevelDeclarations.mirror]) hands the files' top-level
     * declarations to the extension's scope, where Chrome's world would have had them as globals.
     */
    fun appendGroupFunction(out: Appendable, group: Group) = appendGroupFunction(out, group, mirrorOf(group))

    /** [appendGroupFunction] with the group's mirror ([mirrorOf]) computed by the caller – the layout counts it first. */
    fun appendGroupFunction(out: Appendable, group: Group, mirror: String) {
        out.append(FUNCTION_HEAD)
        if (group.isolation == "with") out.append(WITH_HEAD)
        for (source in group.sources) {
            out.append(SOURCE_JOIN_HEAD)
            source.appendTo(out)
            out.append(SOURCE_JOIN_TAIL)
        }
        out.append(mirror)
        if (group.isolation == "with") out.append('}')
        out.append(FUNCTION_TAIL)
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
        scoped: Boolean = false,
        mirror: Boolean = true
    ): String {
        val head = execHead(token, extensionId, kind, payload, scoped)
        val body = execBody(code, funcSource, argsJson)
        val tail = execTail(scoped)
        // A script's declarations (`code`, `files`) are mirrored onto the scope after the body; a
        // `func` is a function in Chrome too. The files' names are read off the builder once they
        // are in it, so the tail's room is a bound, not a measure (TopLevelDeclarations.MIRROR_ROOM).
        // A script's completion value (the last file's last expression statement, see [exec]) is
        // written into the completion parameter in place, which shifts the text after it once.
        // A module of the content script's graph run as a block (`mirror` false, the exec of kind
        // `chunk`) keeps its top level to itself, as a module's is its own in Chrome, and has no
        // completion value to answer.
        val mirrored = mirror && funcSource == null && (code != null || files.isNotEmpty())
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

    /**
     * Whether a tab's request for one of an extension's files is a page's module graph, to be
     * served bracketed ([moduleChromeWrap]) on a WebView without isolated worlds: a script, asked
     * for by a module request (a CORS one, which carries the page's `Origin`; a classic
     * `<script src>` carries none and runs as a page script in Chrome too), by a document that is
     * not the extension's own (an options page opened in a tab, a navigation to the extension
     * origin: `pageUrl` on the origin, or the request for that document itself). The request's
     * `Referer` is deliberately not read: a module's static dependencies are fetched with the
     * importing module's URL as their referrer, so by the Referer the dependencies of the entry
     * a content script `import()`ed looked like an extension page's own requests and were served
     * plain – and dependencies evaluate ahead of the entry's body, before any bracket is open, so
     * webextension-polyfill's check in AITOPIA's graph read the page's `chrome` and threw, and
     * Speechify's lazily bound `chrome` was undefined at its first `storage` read (compat round
     * 12, rows 02 and 03 on WebView 113).
     */
    fun isPageModuleGraph(
        path: String,
        isForMainFrame: Boolean,
        pageUrl: String?,
        origin: String,
        originHeader: Boolean,
        isolatedWorlds: Boolean
    ): Boolean =
        !isolatedWorlds && !isForMainFrame && pageUrl?.startsWith(origin) != true && originHeader && isScriptPath(path)

    /**
     * The query a module graph's plain request carries: the file's own text, bracketed, where the
     * stub a webpack chunk is served as ([chunkStub]) could not run it in the scope.
     */
    const val PLAIN_QUERY = "zenium-plain"

    /**
     * What a module graph's request for a webpack chunk ([isWebpackChunk]), or for a module
     * whose text is script-shaped ([isScriptShapedModule]), is served as on a WebView without
     * isolated worlds: a module that hands the file to the bootstrap, which asks the host for it
     * and runs it as a block of the content script's `with` scope (`__zenExtChunk`,
     * `extensionModuleChrome.ts`; `chunkScript` over the bridge; the exec of kind `chunk`), and
     * waits for that (a top-level `await`, so the `import()` resolves once the block ran). A
     * webpack chunk is one `push` expression with no exports, and a script-shaped module
     * declares no import or export either, so a block of the scope runs it as its module would
     * have, and there its bare identifiers resolve as the content script's own do: Mote's
     * runtime chunk wrote `HowlerGlobal` through webpack's `r.g` (the scope proxy) while its
     * sidebar chunk, a module on the real global, read the bare name and found nothing (compat
     * round 11, row 13); Web Highlights' `content.js` wrote `self.QrCreator` and read `QrCreator`
     * bare (compat round 25). Where the bootstrap cannot run it (no scope for the extension in
     * the document, a subframe, no brackets installed at all, a `<script type=module>` element
     * of the page's own asking for the file – `extensionChunkRelay.ts`), or the host cannot (a
     * text that is not a block after all, its SyntaxError), the file is imported again as
     * itself, under [PLAIN_QUERY].
     */
    fun chunkStub(extensionId: String, url: String): String {
        val id = JSONObject.quote(extensionId)
        val plain = JSONObject.quote(url + (if (url.contains('?')) "&" else "?") + "$PLAIN_QUERY=1")
        return "if(!(globalThis.__zenExtChunk&&await globalThis.__zenExtChunk($id,${JSONObject.quote(url)})))await import($plain);\n"
    }

    /**
     * Module syntax a served file may carry: a static `import` declaration (`import x from`,
     * `import {`, `import *`, `import "…"` – a dynamic `import(` is a script's too),
     * `import.meta`, or an `export` declaration (`export {`, `export *`, `export default` and
     * the declared forms). A declaration is a statement of the module's top level, so it is
     * read only in statement position: at the start of the text, or after `;`, `}` or a line
     * break with nothing but indentation between – what tells it from the word in a string
     * (Web Highlights' `content.js` carries Polymer's `"import"===o.getAttribute("rel")` and its
     * blog copy's "how to import all your annotations", twenty-six of them, and the first
     * spelling of this expression read every one as the module graph's, so R25-1's block never
     * ran for its own row – compat round 25's `[lane]`). `import.meta` is an expression and is
     * read anywhere a property read can stand. Still in the safe direction where the position
     * cannot tell: a line of a template literal that starts with `import x from` costs the file
     * only the scope (it is served bracketed on the real global, as every module was before
     * [isScriptShapedModule]); a miss costs a wasted evaluate, since a block with an `import` or
     * an `export` in it is a SyntaxError `evaluateJavascript` answers with a bare null, and the
     * stub imports the file plain (`Extensions.chunkScript`). The same expression is
     * `MODULE_SYNTAX` in `extensionModuleChrome.ts`; the lookbehind is at most
     * [MODULE_SYNTAX_LOOKBEHIND] characters, which a window's overlap carries.
     */
    private val MODULE_SYNTAX = Regex(
        """(?<![^\n\r;} \t][ \t]{0,63})(?:import(?:\s+[\w$]|\s*[*{"'])|export(?:\s+(?:default|const|let|var|function|class|async|enum)(?![\w$])|\s*[{*]))|(?<![\w$.])import\s*\.\s*meta(?![\w$])"""
    )

    /** The most characters [MODULE_SYNTAX] looks behind a declaration (one non-space and the indentation). */
    const val MODULE_SYNTAX_LOOKBEHIND = 64

    /**
     * Whether a text carries module syntax ([MODULE_SYNTAX]) at or after [from]; the characters
     * before [from] are the lookbehind's context, never a match's start.
     */
    fun hasModuleSyntax(text: CharSequence, from: Int = 0): Boolean = MODULE_SYNTAX.find(text, from) != null

    /** How many characters of a served file [isScriptShapedModule] reads at a time. */
    const val MODULE_SYNTAX_WINDOW = 64 * 1024

    /**
     * The overlap between two windows: a declaration across the border is still seen whole, and
     * the [MODULE_SYNTAX_LOOKBEHIND] characters before it are in the window with it – the next
     * window's search starts [MODULE_SYNTAX_LOOKBEHIND] characters in, where the overlap has
     * the context; a start before that was whole in the window before.
     */
    const val MODULE_SYNTAX_OVERLAP = 2 * MODULE_SYNTAX_LOOKBEHIND

    /** A served module file longer than this keeps the bracketed path; the scan and the exec are bounded by it. */
    const val SCRIPT_SHAPED_LIMIT = 8L * 1024 * 1024

    /**
     * Whether a served module's text is script-shaped: no `import` or `export` declaration and
     * no `import.meta` anywhere in it ([MODULE_SYNTAX]), so it runs as a block of the content
     * script's scope as it would have as a module of the world – and there a bare read finds a
     * name the script set through `self`, `window` or `globalThis`. A page's module graph on a
     * WebView without isolated worlds is served the stub for such a file ([chunkStub]), as it
     * is for a webpack chunk: Web Highlights' `content.js`, `import()`ed by its loader, wrote
     * `self.QrCreator = …` and read `QrCreator` bare in the same module – the write went to the
     * scope's store while the module, on the real global, read nothing (compat round 25, R25-1);
     * Web Scrobbler's connectors read the `Connector` its `main.js` set the same way. The text
     * is read in windows of [MODULE_SYNTAX_WINDOW] characters overlapping by
     * [MODULE_SYNTAX_OVERLAP], never whole; an empty file is script-shaped.
     */
    fun isScriptShapedModule(reader: Reader): Boolean {
        val buffer = CharArray(MODULE_SYNTAX_WINDOW)
        var kept = 0
        while (true) {
            var filled = kept
            while (filled < buffer.size) {
                val n = reader.read(buffer, filled, buffer.size - filled)
                if (n < 0) break
                filled += n
            }
            // The first window is searched whole; a later one from the lookbehind's length in,
            // so every start it judges has its context, and every start before that was whole
            // in the window before (the overlap is twice the lookbehind).
            val from = if (kept == 0) 0 else MODULE_SYNTAX_LOOKBEHIND
            if (filled > kept && hasModuleSyntax(CharBuffer.wrap(buffer, 0, filled), from)) return false
            if (filled < buffer.size) return true
            kept = MODULE_SYNTAX_OVERLAP
            System.arraycopy(buffer, filled - kept, buffer, 0, kept)
        }
    }

    /** [isScriptShapedModule] over a file's UTF-8 text: false for a file over [SCRIPT_SHAPED_LIMIT] or one that cannot be read. */
    fun isScriptShapedModule(file: File): Boolean =
        file.length() <= SCRIPT_SHAPED_LIMIT &&
            runCatching { file.bufferedReader(Charsets.UTF_8).use { isScriptShapedModule(it) } }.getOrDefault(false)

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
