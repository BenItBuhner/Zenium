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
 * module and every module it statically imports from a relative path get a module-scoped `var
 * window;` prologue instead (a module's top-level `var` is a module binding, not a global
 * property; it has no temporal dead zone and sits beside the module's own `var window`), skipped
 * for a module that declares `window` at its own top level in a form the prologue cannot sit
 * beside. A `self.window = …` polyfill and the bare name stay apart in this shape.
 *
 * Every prefix is one line without a newline, so the original text's line numbers hold; the
 * suffix closes the block after a newline, so a trailing line comment cannot swallow it. The
 * files are rewritten in place on the unpacked package (the host serves them from disk on every
 * request, `Cache-Control: no-cache`) and restored from the driver's backup afterwards.
 *
 * Sample 2, [Shape.FULL], is the fuller chrome-shaping over the same files: the `with` block's
 * proxy answers for five names – `window` and `document` are misses (both read through the
 * worker global, where they are absent until a polyfill defines them), `self` and `globalThis`
 * are one worker-shaped global G, and `Function` is a constructor whose functions run inside the
 * same bracket with a sloppy `this` of G. G is built once per page by [BUILDER] over the
 * runtime's own `self` proxy S: G's target holds `self` as a non-configurable, non-writable own
 * property (a scuttler cannot redefine it, as a real `ServiceWorkerGlobalScope` has it), a
 * `defineProperty` of a name the page global refuses lands in G's target instead of throwing
 * (LavaMoat's scuttle then runs to its end, as in Chrome, and the page global the runtime reads
 * is untouched), a non-configurable define of a new name goes to the page and is mirrored onto
 * the target (the proxy invariant, as the runtime's `self` mirrors onto its own held set), a
 * descriptor read through G hands out the operation bound to the page and an
 * accessor that tolerates G as its receiver (LavaMoat copies the global by descriptors), and
 * G's prototype carries the prototype chain's operations bound the same way. The page's `self`
 * and `globalThis` are repointed to G, so the runtime's `instanceof` answers for it. A module
 * worker cannot carry a `with`: its graph gets the shape from one added file
 * (`__zen-bare-window.js`, imported first by the worker's module) and a module-scoped `var
 * window; var document; var Function = F;` prologue per module – each `var` skipped for a name
 * the graph installs on the global itself (the runtime's word from the `off` pass: ZeroOmega's
 * `globalThis.window = globalThis`) or declares at its top level.
 */
object BareWindowBracket {
    /** The two shapes: sample 1's `window` alone, sample 2's fuller chrome. */
    enum class Shape { WINDOW, FULL }

    /** The one file a module graph gets under [Shape.FULL], at the package root. */
    const val SHAPE_FILE = "__zen-bare-window.js"

    /**
     * The shape's builder, `(function(W){...})`: called with the page global once, it returns
     * `{W,S,T,G,F,P,RF,GP}` and stashes it as `W.__zenBW`. Kept as lines here for reading and
     * joined without separators for the prefix (every line ends a statement or opens a block);
     * strict-mode valid, so the module shape file can carry it too. The names: S the runtime's
     * `self` proxy, T G's target, G the worker-shaped global, GP its prototype, F the bracketed
     * `Function`, P the `with` proxy, RF the page's real `Function`.
     */
    val BUILDER: String = """
        (function(W){
        var S=W.self;
        var RF=W.Function;
        var hop=Object.prototype.hasOwnProperty;
        var T=Object.create(null);
        var own=function(k){return hop.call(T,k)};
        var zen=function(k){return typeof k==='string'&&k.lastIndexOf('__zen',0)===0};
        var RAW={parseInt:1,parseFloat:1,isNaN:1,isFinite:1,decodeURI:1,decodeURIComponent:1,encodeURI:1,encodeURIComponent:1,escape:1,unescape:1,eval:1};
        var GP=Object.create(Reflect.getPrototypeOf(W));
        var G=new Proxy(T,{
        get:function(t,k){if(k==='self')return G;if(k==='globalThis')return own(k)?Reflect.get(T,k,G):G;if(own(k))return Reflect.get(T,k,G);if(typeof k==='string'&&hop.call(RAW,k))return Reflect.get(W,k);return Reflect.get(S,k)},
        set:function(t,k,v){if(k==='self')return v===G;if(k==='globalThis')return true;if(own(k))return Reflect.set(T,k,v,G);return Reflect.set(S,k,v)},
        has:function(t,k){if(own(k))return true;return Reflect.has(S,k)},
        deleteProperty:function(t,k){if(own(k))return Reflect.deleteProperty(T,k);return Reflect.deleteProperty(S,k)},
        defineProperty:function(t,k,d){
        if(own(k))return Reflect.defineProperty(T,k,d);
        var s=Reflect.getOwnPropertyDescriptor(S,k);
        if(!s){var r=Reflect.defineProperty(S,k,d);if(r&&!d.configurable)Reflect.defineProperty(T,k,d);return r}
        var seed={enumerable:!!s.enumerable,configurable:true};
        if(k==='globalThis'){seed.value=G;seed.writable=true}
        else if('value' in s){seed.value=s.value;seed.writable=!!s.writable}
        else{seed.value=Reflect.get(S,k);seed.writable=typeof s.set==='function'}
        Reflect.defineProperty(T,k,seed);
        return Reflect.defineProperty(T,k,d)},
        getOwnPropertyDescriptor:function(t,k){
        if(own(k))return Reflect.getOwnPropertyDescriptor(T,k);
        var s=Reflect.getOwnPropertyDescriptor(S,k);
        if(!s)return undefined;
        if(k==='globalThis')return{value:G,writable:true,enumerable:!!s.enumerable,configurable:true};
        if('value' in s){var v=s.value;if(typeof v==='function')v=Reflect.get(G,k);return{value:v,writable:!!s.writable,enumerable:!!s.enumerable,configurable:true}}
        var d={enumerable:!!s.enumerable,configurable:true,get:function(){return Reflect.get(S,k)},set:undefined};
        if(typeof s.set==='function')d.set=function(v){Reflect.set(S,k,v)};
        return d},
        ownKeys:function(){var keys=Reflect.ownKeys(S).filter(function(k){return !zen(k)});var extra=Reflect.ownKeys(T).filter(function(k){return keys.indexOf(k)<0});return extra.length?keys.concat(extra):keys},
        getPrototypeOf:function(){return GP},
        setPrototypeOf:function(){return false},
        isExtensible:function(){return true},
        preventExtensions:function(){return false}
        });
        Reflect.defineProperty(T,'self',{value:G,writable:false,enumerable:true,configurable:false});
        (function(){var o=Reflect.getPrototypeOf(W);while(o&&o!==Object.prototype){Reflect.ownKeys(o).forEach(function(k){if(hop.call(GP,k))return;var d=Reflect.getOwnPropertyDescriptor(o,k);if(d&&'value' in d&&typeof d.value==='function'&&!hop.call(d.value,'prototype'))Reflect.defineProperty(GP,k,{value:Reflect.get(S,k),writable:true,enumerable:false,configurable:true})});o=Reflect.getPrototypeOf(o)}})();
        var SW=W.ServiceWorkerGlobalScope;
        if(typeof SW==='function'){Reflect.defineProperty(GP,'constructor',{value:SW,writable:true,enumerable:false,configurable:true});Reflect.defineProperty(GP,Symbol.toStringTag,{value:'ServiceWorkerGlobalScope',writable:false,enumerable:false,configurable:true})}
        var STRICT=/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(['"])use strict\1/;
        var F=function Function(){
        var a=Array.prototype.slice.call(arguments);
        var n=a.length;
        var body=n?String(a[n-1]):'';
        var params=n>1?Array.prototype.join.call(a.slice(0,n-1),','):'';
        RF.apply(null,a);
        var inner=STRICT.test(body)?'function anonymous('+params+'\n){'+body+'\n}':'function anonymous('+params+'\n){return(function(){'+body+'\n}).apply(this===__zenBW.W?__zenBW.G:this,arguments)}';
        return RF('with(__zenBW.P){return '+inner+'}')()};
        Object.defineProperty(F,'prototype',{value:RF.prototype,writable:false,enumerable:false,configurable:false});
        Object.defineProperty(F,'length',{value:1,writable:false,enumerable:false,configurable:true});
        var FN=F;
        var NAMES={window:1,document:1,self:1,globalThis:1,Function:1};
        var P=new Proxy(Object.create(null),{
        has:function(t,k){return typeof k==='string'&&hop.call(NAMES,k)},
        get:function(t,k){if(k==='self'||k==='globalThis')return G;if(k==='Function')return FN;if(k==='window'||k==='document')return Reflect.get(G,k);return undefined},
        set:function(t,k,v){if(k==='window'||k==='document'){Reflect.set(G,k,v);return true}if(k==='Function'){FN=v;return true}return true},
        deleteProperty:function(t,k){if(k==='window'||k==='document')return Reflect.deleteProperty(G,k);return true}
        });
        var K={W:W,S:S,T:T,G:G,F:F,P:P,RF:RF,GP:GP};
        var selfWas=Object.getOwnPropertyDescriptor(W,'self');
        Object.defineProperty(W,'__zenBW',{value:K,writable:true,enumerable:false,configurable:true});
        Object.defineProperty(W,'self',{value:G,writable:true,enumerable:!!(selfWas&&selfWas.enumerable),configurable:true});
        Object.defineProperty(W,'globalThis',{value:G,writable:true,enumerable:false,configurable:true});
        return K
        })
    """.trimIndent().lines().map { it.trim() }.filter { it.isNotEmpty() }.joinToString("")
    /**
     * Whether `text` opens with a `'use strict'` directive (past blanks, a byte order mark and
     * comments): the one a `with` block turns into a plain statement. A hand scan, linear in the
     * prologue's length – a regex over the comments backtracks across every comment close of a
     * bundle.
     */
    fun hasStrictPrologue(text: CharSequence): Boolean {
        val n = text.length
        var i = 0
        while (i < n) {
            val c = text[i]
            if (c.isWhitespace() || c == '\uFEFF') { i++; continue }
            if (c == '/' && i + 1 < n && text[i + 1] == '/') {
                while (i < n && text[i] != '\n') i++
                continue
            }
            if (c == '/' && i + 1 < n && text[i + 1] == '*') {
                var j = i + 2
                while (j + 1 < n && !(text[j] == '*' && text[j + 1] == '/')) j++
                i = if (j + 1 < n) j + 2 else n
                continue
            }
            if (c != '\'' && c != '"') return false
            val lit = "use strict"
            return i + lit.length + 1 < n && text.regionMatches(i + 1, lit, 0, lit.length) && text[i + 1 + lit.length] == c
        }
        return false
    }

    /** A UTF-8 byte order mark as [scanFile]'s byte-for-char decoding shows it. */
    private const val BOM_LATIN1 = "\u00EF\u00BB\u00BF"

    /** An identifier `window` that is not a member read (`.window`) and not part of another word. */
    val BARE_WINDOW = Regex("""(?<![.\w$])window\b""")

    /** The fuller shape's five names as bare identifiers (what its bracket changes; a file without one is left as it is). */
    val BARE_FULL = Regex("""(?<![.\w$])(?:window|document|self|globalThis|Function)\b""")

    /** The names a module prologue shadows with a `var` under the fuller shape (`self` and `globalThis` are the page's own, repointed by the shape file). */
    val MODULE_VARS = listOf("window", "document", "Function")

    /**
     * A declaration of `window` at the start of a line with no indentation: a top-level one as
     * unminified code writes it (an indented `const window = …` inside a function is the
     * function's own, and shadows nothing the prologue touches). A module with one gets no
     * prologue: `let`/`const`/`class`/`function` beside the prologue's `var` is a redeclaration,
     * and a module with its own `var window` shadows the global already. A minified module keeps
     * its top level on one line, where this cannot see it; a redeclaration there is a SyntaxError
     * the driver records under its own signature.
     */
    val DECLARES_WINDOW = Regex("""(?m)^(?:export\s+)?(?:let|const|var|function|class)\s+window\b""")

    /** The same for the fuller shape's three module names, the name captured. */
    val DECLARES = Regex("""(?m)^(?:export\s+)?(?:let|const|var|function|class)\s+(window|document|Function)\b""")

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
        val already: Boolean,
        /** The shape this plan was made for. */
        val shape: Shape = Shape.WINDOW,
        /** The fuller shape's names this module declares at its top level (no `var` for them). */
        val declares: Set<String> = emptySet(),
        /** The fuller shape's module `var`s this file gets (the others skipped: declared here, or installed by the graph). */
        val shadows: List<String> = emptyList()
    )

    /** Files past this many are not followed (the count's cap). */
    const val MAX_FILES = 300

    /** The bracketed head of a classic script: `with` over the proxy, the probe, then the original text on the same line. */
    fun classicPrefix(file: String, strict: Boolean, main: Boolean, shape: Shape = Shape.WINDOW): String {
        if (shape == Shape.FULL) {
            // The page global is the sloppy IIFE's `this`; the shape is built once and stashed on it.
            val proxy = "(function(){var W=(function(){return this})();return (W.__zenBW||($BUILDER)(W)).P})()"
            return MARKER + "with(" + proxy + "){" + probe(file, "with", strict, main, shape)
        }
        val proxy = "(function(){var s=self;return new Proxy(Object.create(null),{" +
            "has:function(t,k){return k==='window'}," +
            "get:function(t,k){return k==='window'?s.window:undefined}," +
            "set:function(t,k,v){if(k==='window'){s.window=v;return true}return false}," +
            "deleteProperty:function(t,k){if(k==='window'){try{delete s.window}catch(e){}}return true}})})()"
        return MARKER + "with(" + proxy + "){" + probe(file, "with", strict, main, shape)
    }

    /**
     * The head of a module: the module-scoped `var window;`, the probe, then the original text on
     * the same line. Under the fuller shape: the shape file imported first (evaluated before every
     * other module of the graph, so `self` and `globalThis` are G by the time any runs), a `var`
     * per shadowed name (`Function` set to the bracketed constructor), the probe.
     */
    fun modulePrefix(file: String, main: Boolean, shape: Shape = Shape.WINDOW, shadows: List<String> = MODULE_VARS): String {
        if (shape == Shape.FULL) {
            val vars = shadows.joinToString("") { if (it == "Function") "var Function=__zenBWF;" else "var $it;" }
            return MARKER + "import{F as __zenBWF}from\"${shapeImport(file)}\";" + vars + probe(file, "module", false, main, shape)
        }
        return MARKER + "var window;" + probe(file, "module", false, main, shape)
    }

    /** The module specifier of [SHAPE_FILE] from a package-relative module path (`a/b/c.js` imports `../../__zen-bare-window.js`). */
    fun shapeImport(file: String): String {
        val depth = file.trimStart('/').count { it == '/' }
        return (if (depth == 0) "./" else "../".repeat(depth)) + SHAPE_FILE
    }

    /** The shape file's text: the builder run once with the page global (a module's `document` is the page's), G, F and P exported. */
    val SHAPE_FILE_TEXT: String = MARKER + "const W=document.defaultView;const K=W.__zenBW||($BUILDER)(W);export const G=K.G,F=K.F,P=K.P;\n"

    /** The tail of a classic script: the block closed on its own line. */
    const val CLASSIC_SUFFIX = "\n}\n"

    /**
     * The probe, the block's first statement: what `typeof window` reads where the script's own
     * code reads it. In its own `try`: a script that declares `let window` at its top level (the
     * round 11 rescue's case) has the name in its temporal dead zone here, and the `typeof`
     * throws – recorded as the probe's `error`, the script's own code untouched. The fuller shape
     * adds `typeof document`, whether `self` is `globalThis` and the shape's G, what
     * `Function("return this")()` and the unit's top-level `this` reach.
     */
    private fun probe(file: String, mode: String, strict: Boolean, main: Boolean, shape: Shape): String {
        val head = "mode:'$mode',file:'${js(file)}',strict:$strict"
        val full = if (shape == Shape.FULL) {
            ",typeofDocument:typeof document,inSelfDocument:('document' in self),selfDocument:typeof self.document," +
                "selfIsGlobalThis:self===globalThis,selfIsShape:self===__zenBW.G," +
                "functionThis:(function(){try{return Function('return this')()===self}catch(e){return String(e)}})()," +
                "topThis:(this===undefined?'undefined':(this===self?'self':'window'))"
        } else ""
        val record = "{$head,typeofWindow:typeof window,inSelf:('window' in self),inGlobalThis:('window' in globalThis),selfWindow:typeof self.window$full,at:Date.now()}"
        val fallback = "{$head,error:String(e),at:Date.now()}"
        return if (main) "try{self.__zenBareWindow=$record}catch(e){self.__zenBareWindow=$fallback};"
        else "try{self.__zenBareWindowFiles=(self.__zenBareWindowFiles||[]).concat([$record])}catch(e){self.__zenBareWindowFiles=(self.__zenBareWindowFiles||[]).concat([$fallback])};"
    }

    private fun js(text: String): String = text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")

    /** The whole bracketed text of a classic script (the file form streams the same three parts). */
    fun bracketClassic(text: String, file: String, main: Boolean = true, shape: Shape = Shape.WINDOW): String =
        classicPrefix(file, hasStrictPrologue(text), main, shape) + text + CLASSIC_SUFFIX

    /** The whole prologued text of a module. */
    fun bracketModule(text: String, file: String, main: Boolean = true, shape: Shape = Shape.WINDOW, shadows: List<String> = MODULE_VARS): String =
        modulePrefix(file, main, shape, shadows) + text

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
        strict = hasStrictPrologue(text),
        bareReads = BARE_WINDOW.findAll(text).count(),
        declaresWindow = DECLARES_WINDOW.containsMatchIn(text),
        lexicalAtLineStart = LEXICAL_AT_LINE_START.findAll(text).count(),
        dynamicImports = DYNAMIC_IMPORT.findAll(text).count(),
        importScripts = importScriptsOf(text),
        staticImports = staticImportsOf(text),
        already = text.startsWith(MARKER) || text.startsWith("\uFEFF$MARKER"),
        bareFull = BARE_FULL.findAll(text).count(),
        declares = DECLARES.findAll(text).map { it.groupValues[1] }.toSet()
    )

    data class Scan(
        val strict: Boolean,
        val bareReads: Int,
        val declaresWindow: Boolean,
        val lexicalAtLineStart: Int,
        val dynamicImports: Int,
        val importScripts: List<String>,
        val staticImports: List<String>,
        val already: Boolean,
        /** Bare reads of the fuller shape's five names. */
        val bareFull: Int = 0,
        /** The fuller shape's module names declared at the top level. */
        val declares: Set<String> = emptySet()
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
        var bareFull = 0
        var declares = false
        val declared = LinkedHashSet<String>()
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
                    strict = hasStrictPrologue(head)
                    already = head.startsWith(MARKER)
                    first = false
                }
                val from = carry.length
                val last = n < buf.size
                bare += countNew(BARE_WINDOW, text, from, last)
                bareFull += countNew(BARE_FULL, text, from, last)
                if (!declares && DECLARES_WINDOW.containsMatchIn(text)) declares = true
                for (m in DECLARES.findAll(text)) declared += m.groupValues[1]
                lexical += countNew(LEXICAL_AT_LINE_START, text, from, last)
                dynamic += countNew(DYNAMIC_IMPORT, text, from, last)
                imports += importScriptsOf(text)
                statics += staticImportsOf(text)
                if (last) break
                carry = text.substring(maxOf(0, text.length - OVERLAP))
            }
        }
        return Scan(strict, bare, declares, lexical, dynamic, imports.toList(), statics.toList(), already, bareFull, declared)
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
    fun plan(dir: File, worker: String, module: Boolean, shape: Shape = Shape.WINDOW, installs: Set<String> = emptySet()): List<Plan> {
        val out = ArrayList<Plan>()
        val seen = LinkedHashSet<String>()
        val queue = ArrayDeque<String>()
        val start = resolve("", "/" + worker.trimStart('/')) ?: worker.trimStart('/')
        val mode = if (module) Mode.MODULE else Mode.WITH
        queue += start
        while (queue.isNotEmpty() && out.size < MAX_FILES) {
            val rel = queue.removeFirst()
            if (!seen.add(rel)) continue
            val file = File(dir, rel)
            val main = rel == start
            if (!file.isFile) {
                out += Plan(rel, mode, main, false, 0, false, 0, false, 0, 0, emptyList(), false, false, shape)
                continue
            }
            val scan = scanFile(file)
            val imports = (if (module) scan.staticImports else scan.importScripts).mapNotNull { resolve(rel, it, url = !module) }
            val plan = if (shape == Shape.FULL) {
                // Every unit with one of the five names gets the bracket; a module's `var`s skip
                // a name it declares itself or the graph installs on the global (the runtime's word).
                val shadows = if (module) MODULE_VARS.filter { it !in scan.declares && it !in installs } else emptyList()
                val apply = !scan.already && (main || scan.bareFull > 0)
                Plan(
                    rel, mode, main, true, file.length(), scan.strict, scan.bareFull, scan.declaresWindow, scan.lexicalAtLineStart,
                    scan.dynamicImports, imports, apply, scan.already, shape, scan.declares, shadows
                )
            } else {
                val apply = !scan.already && (main || scan.bareReads > 0) && !(module && scan.declaresWindow)
                Plan(
                    rel, mode, main, true, file.length(), scan.strict, scan.bareReads, scan.declaresWindow, scan.lexicalAtLineStart,
                    scan.dynamicImports, imports, apply, scan.already, shape
                )
            }
            out += plan
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

    /**
     * Applies the plan's files: the prefix and suffix per mode. Returns per file what was
     * written, or the reason it was left. A module graph under the fuller shape gets
     * [SHAPE_FILE] written at the package root first (removed by [restore]); an existing file of
     * that name is left alone and reported.
     */
    fun apply(dir: File, plans: List<Plan>, backupDir: File): List<Pair<Plan, String>> {
        val shapeFile = plans.any { it.shape == Shape.FULL && it.mode == Mode.MODULE && it.apply }
        val shapeOutcome = if (shapeFile) {
            val target = File(dir, SHAPE_FILE)
            runCatching {
                if (target.exists() && !target.readText().startsWith(MARKER)) "shape file exists and is not ours"
                else { target.writeText(SHAPE_FILE_TEXT); "written: ${target.length()} bytes" }
            }.getOrElse { "shape file failed: $it" }
        } else null
        return plans.map { plan ->
            val file = File(dir, plan.file)
            val outcome = when {
                !plan.exists -> "missing"
                plan.already -> "already bracketed"
                !plan.apply -> if (plan.shape == Shape.FULL) "left as is (no bare read of the five names)" else "left as is (no bare window read)"
                else -> runCatching {
                    val prefix = if (plan.mode == Mode.MODULE) modulePrefix(plan.file, plan.main, plan.shape, plan.shadows) else classicPrefix(plan.file, plan.strict, plan.main, plan.shape)
                    val suffix = if (plan.mode == Mode.MODULE) "" else CLASSIC_SUFFIX
                    "rewritten: ${rewrite(file, prefix, suffix, File(backupDir, plan.file))} bytes" +
                        (if (plan.main && shapeOutcome != null) "; $SHAPE_FILE $shapeOutcome" else "")
                }.getOrElse { "rewrite failed: $it" }
            }
            plan to outcome
        }
    }

    /**
     * Puts every backed-up file of `backupDir` back under `dir` and removes the shape file when it
     * is ours. Returns the files restored and any that failed.
     */
    fun restore(dir: File, backupDir: File): Pair<List<String>, List<String>> {
        val restored = ArrayList<String>()
        val failed = ArrayList<String>()
        val shape = File(dir, SHAPE_FILE)
        if (shape.isFile && runCatching { shape.readText().startsWith(MARKER) }.getOrDefault(false)) {
            if (shape.delete()) restored += "$SHAPE_FILE (removed)" else failed += SHAPE_FILE
        }
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
