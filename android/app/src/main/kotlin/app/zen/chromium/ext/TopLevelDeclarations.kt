package app.zen.chromium.ext

/**
 * The names a script declares at its top level (`var`, `let`, `const`, `function`, `class`),
 * and the tail that hands them to the bootstrap after the script ran.
 *
 * Why: Chrome runs each content script – a manifest group's files, every `executeScript` of
 * `files` or MV2 `code` – as a classic script at the global scope of the extension's isolated
 * world, so a top-level `var readAloudDoc = …` in one injection is a global the next injection
 * (or the manifest's content script, or a `func` probe like `typeof brapi != "undefined"`) finds
 * by its bare name. The phone hands the same text to the WebView as a function literal (never
 * eval, so a page's CSP cannot refuse it), and a function's top-level declarations are its own:
 * Read Aloud injects `content.js` in one `executeScript` and `js/content/html-doc.js`, which
 * declares `readAloudDoc`, in the next, and `content.js` then read `ReferenceError: readAloudDoc
 * is not defined`. The bootstrap cannot see a function's locals, so the host reads the text once
 * as it assembles the script and appends, after the body, one guarded line per declared name:
 * `try{__zenMirror("name",name)}catch(e){}` – `__zenMirror` is the wrapper's last parameter, the
 * bootstrap's setter onto the extension's scope (the world's global, or the `with` proxy's store
 * on a WebView without worlds), which skips the browser's own globals. A name the scan found
 * that is not a binding (a named function expression, `x = function foo(){}`) throws inside its
 * own `try` and costs nothing; a declaration the scan missed leaves that name where it was. The
 * scan is a tokenizer, not a parser: it knows comments, strings, template literals with their
 * `${…}`, regular expression literals against division by the token before, and the nesting of
 * `{}`, `()` and `[]`; it takes a declaration keyword at the top level and, for `var` and
 * `function`, inside the top level's statement blocks (see [scan]). Compile-time work (the unit
 * compiler's io thread, `exec`'s file read), one pass, off the frame path.
 */
object TopLevelDeclarations {
    /** The wrapper parameter the mirror line calls; the bootstrap passes its setter as the sixth argument. */
    const val MIRROR_PARAM = "__zenMirror"

    /** Declared names past this many are left where they are (a tail of a thousand lines is plenty). */
    const val MAX_NAMES = 1000

    /** A binding name past this length is left where it is (the tail's room is sized by it). */
    const val MAX_NAME_CHARS = 64

    /** The room [ExtensionScripts.execScript] keeps for the tail: [MAX_NAMES] lines of the longest name. */
    const val MIRROR_ROOM = MAX_NAMES * (40 + 2 * MAX_NAME_CHARS)

    /**
     * A file of a million characters or more is not scanned: a bundle that size wraps itself in a
     * function (webpack, esbuild, Closure), so its top level declares nothing another injection
     * would read by name, and the scan's tokens would be tens of millions of objects on the
     * compile of a file the heap is already tight for (`UnitCompiler.LARGE_SOURCE_CHARS`).
     */
    const val MAX_SCAN_CHARS = 1 shl 20

    /** [scan] for a content-script file or `executeScript` text: nothing for one over [MAX_SCAN_CHARS]. */
    fun scanSource(text: CharSequence, from: Int = 0, to: Int = text.length): List<String> =
        if (to - from >= MAX_SCAN_CHARS) emptyList() else scan(text, from, to)

    private val DECLARATORS = setOf("var", "let", "const")

    /** After these words a `/` starts a regular expression, not a division. */
    private val REGEX_AFTER_WORDS = setOf(
        "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"
    )

    /** Words that are never binding names. */
    private val RESERVED = setOf(
        "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
        "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
        "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "await",
        "implements", "interface", "package", "private", "protected", "public"
    )

    private const val REGEX_AFTER_CHARS = "(,=:[!&|?{};+-*%<>~^"

    /** The mirror tail for [names]: nothing for none, else a `;`-led line per name (each in its own `try`). */
    fun mirror(names: Collection<String>): String {
        if (names.isEmpty()) return ""
        val sb = StringBuilder(names.size * 40 + 2)
        sb.append("\n;")
        for (name in names) sb.append("try{").append(MIRROR_PARAM).append("(\"").append(name).append("\",").append(name).append(")}catch(e){}")
        return sb.toString()
    }

    /** A `(` after one of these opens a statement's header, and the `{` after its `)` a block. */
    private val CONTROL_WORDS = setOf("if", "for", "while", "switch", "catch", "with")

    /** A `{` after one of these is a block. */
    private val BLOCK_AFTER_WORDS = setOf("else", "try", "finally", "do", "catch")

    private val STATEMENT_END = Token(Kind.PUNCT, ";")

    /**
     * The names declared at the top level of `text[from, to)`, in order of first declaration, at
     * most [MAX_NAMES]. The top level reaches through statement blocks (`if (…) { var x }`,
     * `try { … }`, `switch (…) { case 1: … }`), where a script's `var` and `function` are the
     * script's globals, and stops at a function or class body and an object literal; a `let`,
     * `const` or `class` is taken outside any block only (a block scopes them). A `{` is read as
     * a block where a statement can begin – after `;`, `:`, another block's `}`, `else`, `try`,
     * `finally`, `do`, the `)` of an `if` / `for` / `while` / `switch` / `catch` / `with` header,
     * or a line break after an expression's end – and as a body or a literal everywhere else.
     */
    fun scan(text: CharSequence, from: Int = 0, to: Int = text.length): List<String> {
        val names = LinkedHashSet<String>()
        val lexer = Lexer(text, from, to)
        /** Each open bracket: its char, whether a `{` is a block, whether a `(` is a statement header's. */
        val open = ArrayDeque<Bracket>()
        var depth = 0
        var blocks = 0
        var statementStart = true
        var prev: Token? = null
        var newlineBefore = false
        var lastParenControl = false
        while (true) {
            val token = lexer.next() ?: break
            if (token.kind == Kind.NEWLINE) {
                if (depth == 0) statementStart = true
                newlineBefore = true
                continue
            }
            val afterDot = prev != null && prev.kind == Kind.PUNCT && prev.text == "."
            when (token.kind) {
                Kind.OPEN -> {
                    val p = prev
                    val control = token.text == "(" && p != null && p.kind == Kind.WORD && p.text in CONTROL_WORDS
                    val block = token.text == "{" && depth == 0 && when {
                        p == null -> true
                        p.kind == Kind.PUNCT -> p.text == ";" || p.text == ":"
                        p.kind == Kind.CLOSE -> p.text == "}" || (p.text == ")" && lastParenControl) || (p.text == "]" && newlineBefore)
                        p.kind == Kind.WORD -> p.text in BLOCK_AFTER_WORDS || (newlineBefore && p.text !in RESERVED)
                        p.kind == Kind.LITERAL -> newlineBefore
                        else -> false
                    }
                    open.addLast(Bracket(token.text, block, control))
                    if (block) blocks++ else depth++
                    statementStart = token.text == "{"
                }
                Kind.CLOSE -> {
                    val bracket = open.removeLastOrNull()
                    if (bracket != null) {
                        if (bracket.block) blocks-- else if (depth > 0) depth--
                        lastParenControl = bracket.text == "(" && bracket.control
                    }
                    statementStart = depth == 0 && token.text == "}"
                }
                Kind.PUNCT -> statementStart = token.text == ";" || token.text == ":"
                Kind.WORD -> {
                    val word = token.text
                    if (depth == 0 && !afterDot) {
                        when {
                            word in DECLARATORS -> {
                                if ((word == "var" || blocks == 0) && (word != "let" || lexer.peekIdentifierOrPattern())) {
                                    declarators(lexer, names)
                                    statementStart = true
                                    prev = STATEMENT_END
                                    newlineBefore = false
                                    continue
                                }
                            }
                            statementStart && word == "function" -> {
                                lexer.skipStar()
                                lexer.peekWord()?.let { name -> if (isBindingName(name)) addName(names, name) }
                            }
                            statementStart && word == "async" -> {
                                if (lexer.peekWord() == "function") {
                                    lexer.next()
                                    lexer.skipStar()
                                    lexer.peekWord()?.let { name -> if (isBindingName(name)) addName(names, name) }
                                }
                            }
                            statementStart && blocks == 0 && word == "class" -> {
                                lexer.peekWord()?.let { name -> if (name != "extends" && isBindingName(name)) addName(names, name) }
                            }
                        }
                    }
                    statementStart = false
                }
                Kind.LITERAL -> statementStart = false
                Kind.NEWLINE -> {}
            }
            prev = token
            newlineBefore = false
            if (names.size >= MAX_NAMES) break
        }
        return names.toList()
    }

    private class Bracket(val text: String, val block: Boolean, val control: Boolean)

    private fun addName(names: MutableSet<String>, name: String) {
        if (names.size < MAX_NAMES) names.add(name)
    }

    private fun isBindingName(word: String): Boolean =
        word.isNotEmpty() && word.length <= MAX_NAME_CHARS && word !in RESERVED &&
            word.all { it == '_' || it == '$' || it.isLetterOrDigit() }

    /**
     * `a = init, b, c = init` after a declarator keyword: each name, its initializer skipped to
     * the `,` or the end of the statement (`;`, or a line end where the expression can end: the
     * next line does not begin with something that continues one). A destructuring pattern ends
     * the reading (its names stay where they are).
     */
    private fun declarators(lexer: Lexer, names: MutableSet<String>) {
        while (true) {
            lexer.skipNewlines()
            val name = lexer.peekWord() ?: return
            if (!isBindingName(name)) return
            lexer.next()
            addName(names, name)
            lexer.skipNewlines()
            var token = lexer.peek() ?: return
            if (token.kind == Kind.PUNCT && token.text == "=") {
                lexer.next()
                if (!skipInitializer(lexer)) return
                token = lexer.peek() ?: return
            }
            if (token.kind == Kind.PUNCT && token.text == ",") {
                lexer.next()
                continue
            }
            return
        }
    }

    /** Past an initializer; true when the declaration goes on (`,` is next), false when it ended. */
    private fun skipInitializer(lexer: Lexer): Boolean {
        var depth = 0
        var lastKind: Kind? = null
        var lastText = ""
        while (true) {
            val token = lexer.peek() ?: return false
            when (token.kind) {
                Kind.NEWLINE -> {
                    lexer.next()
                    if (depth == 0 && lastKind != null && expressionCanEnd(lastKind, lastText)) {
                        val next = lexer.peek() ?: return false
                        if (!continuesExpression(next)) return false
                    }
                    continue
                }
                Kind.OPEN -> depth++
                Kind.CLOSE -> {
                    if (depth == 0) return false
                    depth--
                }
                Kind.PUNCT -> if (depth == 0 && (token.text == ";" || token.text == ",")) return token.text == ","
                else -> {}
            }
            lastKind = token.kind
            lastText = token.text
            lexer.next()
        }
    }

    private fun expressionCanEnd(kind: Kind, text: String): Boolean = when (kind) {
        Kind.WORD, Kind.LITERAL, Kind.CLOSE -> true
        Kind.PUNCT -> text == "++" || text == "--"
        else -> false
    }

    /** A token that carries the line before it on (no semicolon is inserted before it): an operator, a call or index, a tagged template. */
    private fun continuesExpression(token: Token): Boolean = when (token.kind) {
        Kind.PUNCT -> token.text != ";" && token.text != ","
        Kind.OPEN -> token.text != "{"
        Kind.WORD -> token.text == "in" || token.text == "instanceof"
        Kind.LITERAL -> token.text == "template"
        else -> false
    }

    /**
     * Words that open a statement that is no expression (a declaration, a block statement, a
     * control statement), and the clause words a split before them would leave at a statement's head.
     */
    private val STATEMENT_WORDS = setOf(
        "var", "let", "const", "function", "class", "if", "for", "while", "do", "switch", "try", "with", "return", "throw",
        "break", "continue", "debugger", "import", "export", "enum", "else", "catch", "finally", "case", "default"
    )

    /** Punctuation an expression statement can begin with (a prefix operator). */
    private val EXPRESSION_PREFIXES = setOf("!", "~", "+", "-", "++", "--")

    /** After the `}` of a statement one of these opened, a following word of these carries the statement on. */
    private val STATEMENT_CONTINUATIONS = setOf("else", "catch", "finally")

    /**
     * Words whose statement ends at the `}` closing what they opened, whatever follows (a
     * declaration or a block statement has no expression to carry on: `function f() {}` and then
     * `(function () {})()` on the next line are two statements in Chrome, the second the script's
     * value); a `var`, `return` or `throw` whose `}` closes an expression is read on by
     * [continuesExpression], as the line-break rule has it.
     */
    private val BLOCK_WORDS = setOf("function", "async", "class", "if", "for", "while", "do", "switch", "try", "with", "{")

    /**
     * The last statement of `text[from, to)` when it is an expression statement: the offset of its
     * first token and the end of its last (a trailing `;`, comments and blank lines left out), null
     * when the script ends in a declaration, a block, a control statement, a label, or nothing.
     * This is what Chrome answers for a `files` or `code` injection – the script's completion
     * value, as `eval` gives it – and the exec wrapper ([ExtensionScripts.execScript]) keeps that
     * statement's value in its completion parameter to return after the mirror ran. Statement
     * boundaries: `;` at the top level; the `}` closing a statement a keyword opened (`function`,
     * `class`, `if`, `try`, …) unless what follows carries the statement on (`else`, `catch`,
     * `finally`, `while` after `do`; after a `var`, `return` or `throw`, anything that continues an
     * expression, [BLOCK_WORDS]); a line end where an
     * expression can end and the next line does not continue one (automatic semicolon insertion,
     * as [skipInitializer] reads it). Only a split is ever wrong in a way that matters (an
     * assignment written into the middle of an expression), so the reading merges where it is
     * unsure: a statement it read as one when it was two returns no value, nothing more. Nothing
     * for a text of [MAX_SCAN_CHARS] or more, as [scanSource]: a bundle that size is a function
     * of its own.
     */
    fun lastExpressionStatement(text: CharSequence, from: Int = 0, to: Int = text.length): IntArray? {
        if (to - from >= MAX_SCAN_CHARS) return null
        val lexer = Lexer(text, from, to)
        var depth = 0
        var start = -1
        var expression = false
        var word: String? = null
        var count = 0
        var lastEnd = -1
        var prev: Token? = null
        var last: IntArray? = null
        fun close(end: Int) {
            if (start >= 0) last = if (expression && end > start) intArrayOf(start, end) else null
            start = -1
        }
        while (true) {
            val token = lexer.next() ?: break
            if (token.kind == Kind.NEWLINE) {
                val p = prev
                if (depth == 0 && start >= 0 && p != null && expressionCanEnd(p.kind, p.text)) {
                    lexer.skipNewlines()
                    val next = lexer.peek()
                    if (next == null || !continuesExpression(next)) close(lastEnd)
                }
                continue
            }
            if (depth == 0 && start < 0 && !(token.kind == Kind.PUNCT && token.text == ";")) {
                start = token.start
                count = 0
                word = null
                expression = when (token.kind) {
                    Kind.WORD -> when {
                        token.text in STATEMENT_WORDS -> { word = token.text; false }
                        token.text == "async" && lexer.peekWord() == "function" -> { word = token.text; false }
                        else -> true
                    }
                    Kind.OPEN -> token.text != "{"
                    Kind.PUNCT -> token.text in EXPRESSION_PREFIXES
                    Kind.LITERAL -> true
                    else -> false
                }
                if (token.kind == Kind.OPEN && token.text == "{") word = "{"
            } else if (depth == 0 && start >= 0 && count == 1 && expression && token.kind == Kind.PUNCT && token.text == ":") {
                expression = false // a label
            }
            count++
            when (token.kind) {
                Kind.OPEN -> depth++
                Kind.CLOSE -> {
                    if (depth > 0) depth--
                    if (depth == 0 && token.text == "}" && word != null) {
                        lexer.skipNewlines()
                        val next = lexer.peek()
                        val carriesOn = next != null && (
                            (word !in BLOCK_WORDS && continuesExpression(next)) ||
                                (next.kind == Kind.WORD && (next.text in STATEMENT_CONTINUATIONS || (word == "do" && next.text == "while")))
                            )
                        if (!carriesOn) {
                            lastEnd = token.end
                            close(lastEnd)
                            prev = token
                            continue
                        }
                    }
                }
                Kind.PUNCT -> if (depth == 0 && token.text == ";") {
                    close(lastEnd)
                    prev = token
                    continue
                }
                else -> {}
            }
            lastEnd = token.end
            prev = token
        }
        // A bracket left open (a text the WebView will refuse to compile) is no statement to write into.
        if (depth != 0) return null
        close(lastEnd)
        return last
    }

    private enum class Kind { WORD, LITERAL, PUNCT, OPEN, CLOSE, NEWLINE }

    /** One token: its kind, its text (a literal's is its sort), and `[start, end)` in the source. */
    private class Token(val kind: Kind, val text: String, val start: Int = -1, val end: Int = -1)

    /**
     * Tokens of a script: words (identifiers and keywords), literals (strings, numbers, regular
     * expressions, template literals – a template's `${…}` is lexed as `(` … `)` around its
     * tokens), punctuation, brackets, newlines. Comments are skipped.
     */
    private class Lexer(private val text: CharSequence, from: Int, private val to: Int) {
        private var i = from
        private var pending: Token? = null
        /** The last token that was not a newline: what decides whether a `/` opens a regular expression. */
        private var last: Token? = null
        /** Brace depths at which a template's `${` opened; a `}` at one resumes the template text. */
        private val templates = ArrayDeque<Int>()
        private var braces = 0
        /** The `}` that closed a `${…}` was just emitted as `)`: the next read continues the template's text. */
        private var resumeTemplate = false

        fun peek(): Token? {
            if (pending == null) pending = read()
            return pending
        }

        fun next(): Token? {
            val token = peek()
            pending = null
            return token
        }

        /** The next word (newlines skipped), left in place. */
        fun peekWord(): String? {
            skipNewlines()
            val token = peek() ?: return null
            return if (token.kind == Kind.WORD) token.text else null
        }

        /** After `let`: an identifier (a declaration) or a pattern's `{` / `[` on the same line; `let` alone is a name. */
        fun peekIdentifierOrPattern(): Boolean {
            val token = peek() ?: return false
            return (token.kind == Kind.WORD && token.text !in setOf("in", "instanceof")) ||
                (token.kind == Kind.OPEN && (token.text == "{" || token.text == "["))
        }

        fun skipStar() {
            skipNewlines()
            val token = peek()
            if (token != null && token.kind == Kind.PUNCT && token.text == "*") next()
        }

        fun skipNewlines() {
            while (true) {
                val token = peek() ?: return
                if (token.kind != Kind.NEWLINE) return
                next()
            }
        }

        private fun peekChar(k: Int): Char = if (i + k < to) text[i + k] else '\u0000'

        /** A token from `start` to the read position. */
        private fun emit(kind: Kind, value: String, start: Int): Token {
            val token = Token(kind, value, start, i)
            if (kind != Kind.NEWLINE) last = token
            return token
        }

        private fun read(): Token? {
            if (resumeTemplate) {
                resumeTemplate = false
                return template(i)
            }
            while (i < to) {
                val c = text[i]
                val start = i
                when {
                    c == '\n' -> {
                        i++
                        return emit(Kind.NEWLINE, "\n", start)
                    }
                    c.isWhitespace() -> i++
                    c == '/' && peekChar(1) == '/' -> {
                        while (i < to && text[i] != '\n') i++
                    }
                    c == '/' && peekChar(1) == '*' -> {
                        i += 2
                        while (i < to && !(text[i] == '*' && peekChar(1) == '/')) i++
                        i = minOf(to, i + 2)
                    }
                    c == '\'' || c == '"' -> {
                        skipString(c)
                        return emit(Kind.LITERAL, "string", start)
                    }
                    c == '`' -> {
                        i++
                        return template(start)
                    }
                    c == '/' -> {
                        if (regexAllowed() && skipRegex()) return emit(Kind.LITERAL, "regex", start)
                        i++
                        if (i < to && text[i] == '=') i++
                        return emit(Kind.PUNCT, "/", start)
                    }
                    c == '{' || c == '(' || c == '[' -> {
                        i++
                        if (c == '{') braces++
                        return emit(Kind.OPEN, c.toString(), start)
                    }
                    c == '}' -> {
                        i++
                        braces--
                        if (templates.isNotEmpty() && templates.last() == braces) {
                            templates.removeLast()
                            resumeTemplate = true
                            return emit(Kind.CLOSE, ")", start)
                        }
                        return emit(Kind.CLOSE, "}", start)
                    }
                    c == ')' || c == ']' -> {
                        i++
                        return emit(Kind.CLOSE, c.toString(), start)
                    }
                    c.isDigit() || (c == '.' && peekChar(1).isDigit()) -> {
                        while (i < to && (text[i].isLetterOrDigit() || text[i] == '.' || text[i] == '_')) i++
                        return emit(Kind.LITERAL, "number", start)
                    }
                    isIdentifierStart(c) -> {
                        while (i < to && isIdentifierPart(text[i])) i++
                        return emit(Kind.WORD, text.subSequence(start, i).toString(), start)
                    }
                    c == '\\' -> {
                        // A unicode escape in an identifier: read the word as one, unnamed.
                        i++
                        while (i < to && (isIdentifierPart(text[i]) || text[i] == '\\')) i++
                        return emit(Kind.WORD, "\\", start)
                    }
                    else -> {
                        i++
                        if (i < to && (c == '+' || c == '-') && text[i] == c) {
                            i++
                            return emit(Kind.PUNCT, "$c$c", start)
                        }
                        if (c == '=' && i < to && text[i] == '>') {
                            i++
                            return emit(Kind.PUNCT, "=>", start)
                        }
                        if (c == '?' && i < to && text[i] == '.' && !peekChar(1).isDigit()) {
                            i++
                            return emit(Kind.PUNCT, ".", start)
                        }
                        return emit(Kind.PUNCT, c.toString(), start)
                    }
                }
            }
            return null
        }

        private fun skipString(quote: Char) {
            i++
            while (i < to) {
                val c = text[i]
                if (c == '\\') {
                    i += 2
                    continue
                }
                i++
                if (c == quote || c == '\n') return
            }
        }

        /** From inside a template's text: to its closing backtick (a literal), or into its `${` (an opening bracket). */
        private fun template(start: Int): Token {
            while (i < to) {
                val c = text[i]
                if (c == '\\') {
                    i += 2
                    continue
                }
                if (c == '`') {
                    i++
                    return emit(Kind.LITERAL, "template", start)
                }
                if (c == '$' && peekChar(1) == '{') {
                    i += 2
                    templates.addLast(braces)
                    braces++
                    return emit(Kind.OPEN, "(", start)
                }
                i++
            }
            return emit(Kind.LITERAL, "template", start)
        }

        private fun regexAllowed(): Boolean {
            val prev = last ?: return true
            return when (prev.kind) {
                Kind.NEWLINE -> true
                Kind.OPEN -> true
                Kind.CLOSE -> prev.text == "}"
                Kind.PUNCT -> prev.text != "++" && prev.text != "--" && prev.text.all { it in REGEX_AFTER_CHARS }
                Kind.WORD -> prev.text in REGEX_AFTER_WORDS
                Kind.LITERAL -> false
            }
        }

        /** Past a regular expression literal starting at `/`; false (position unchanged) when the line ends first. */
        private fun skipRegex(): Boolean {
            var j = i + 1
            var inClass = false
            while (j < to) {
                val c = text[j]
                when {
                    c == '\\' -> j++
                    c == '\n' -> return false
                    c == '[' -> inClass = true
                    c == ']' -> inClass = false
                    c == '/' && !inClass -> {
                        j++
                        while (j < to && text[j].isLetter()) j++
                        i = j
                        return true
                    }
                }
                j++
            }
            return false
        }

        private fun isIdentifierStart(c: Char): Boolean = c == '_' || c == '$' || c.isLetter()

        private fun isIdentifierPart(c: Char): Boolean = c == '_' || c == '$' || c.isLetterOrDigit() || c == '\u200c' || c == '\u200d'
    }
}
