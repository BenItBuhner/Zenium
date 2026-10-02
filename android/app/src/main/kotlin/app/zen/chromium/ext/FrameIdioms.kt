package app.zen.chromium.ext

import java.util.regex.Pattern

/**
 * What a content script's text does with the frame tree, read off the file as the unit is
 * assembled, and the name its function literal gets for it – the bootstrap reads `fn.name`
 * before the unit runs and sets its scope's reading of `top` / `parent`
 * (`extensionIsolation.ts`, `ScopeFrames` / `noteFrameIdiom`).
 *
 * Under the `with` fallback (a WebView without isolated worlds) a content script's `window`,
 * `self`, `top` and `parent` are the scope proxy, and a window the DOM hands out –
 * `document.defaultView`, an iframe's `contentWindow`, their `.parent` – is the page's real
 * one: an identity split Chrome's isolated world does not have. Two readings of the top frame's
 * `window.top` follow from it and cannot both hold:
 *
 *  - [IDIOM]: the script compares its own global with `top` / `parent` (`window === window.top`,
 *    `self !== top`, `t === t.parent` after `var t = window`): the top frame's `top` must be
 *    the scope, or the idiom reads every frame as a sub-frame. Twenty of compat round 27's
 *    thirty fixtures carry it;
 *  - [WALK] with [COMPARE]: the script walks a window chain the DOM handed it
 *    (`parentwin = win.parent`) against `window.top` (`while (win != window.top)`): the chain
 *    never reaches the proxy, and the loop ran WebView 113's renderer to V8's heap limit
 *    (Save Page WE's `content-frame.js` keying every frame for its capture, compat round 27
 *    §5.1). Such a script needs the page's own `top`. One fixture in two hundred and ten
 *    carries the pair without the idiom; the chain assignment alone is every framework's tree
 *    (`node = node.parent`), the comparison alone every `e.source !== window.top` check, so
 *    neither alone decides anything.
 *
 * [nameOf] turns the flags into the literal's name: [SCOPE] for the idiom, [PAGE] for the walk
 * without it, anonymous otherwise ([ExtensionScripts.appendGroupFunction], the exec head). The
 * bootstrap's policy over several units of one scope is its own (an idiom unit locks the scope).
 *
 * The scan is a word search for `top` and `parent` with the patterns run on a short window
 * around each hit, so a 28 million character file (Monica) costs its one pass and a few
 * thousand short matches, not a regular expression over the whole. Each window is cut out as
 * the patterns' own input, never set as a region of the file: Android's `Matcher` copies its
 * whole input into the native regex state on every `reset` and `region` (libcore's
 * `MatcherState::updateInput` – a `UChar` array the input's length and a `memcpy`, where
 * OpenJDK's sets two fields; and `Matcher.reset` takes the input's `toString()` first, a whole
 * new String on the Java heap when the input is a builder), so a region moved over the file at
 * each hit copied the file each time – 2.9 s per 8.4 million character unit, 23.7 s for Compose
 * AI's nine units against 1.7 s, at compat round 27's AFTER, and for a file streamed into an
 * `executeScript` builder (Weava's 1.7 million character `main.js`, 552 hits) a 3 MB String per
 * hit, the Java heap at 191 of its 192 MB under blocking collections in seven rows of the sweep;
 * the JVM gate, where a region costs nothing, never saw either.
 */
object FrameIdioms {
    /** The literal's name for a unit with the idiom: `top` / `parent` stay the scope's. */
    const val SCOPE = "__zenScopeFrames"

    /** The literal's name for a unit that walks a DOM-handed window chain against `window.top` without the idiom. */
    const val PAGE = "__zenPageFrames"

    /** The most a name adds to a function literal, for sizing a builder before the text is scanned. */
    val MAX_NAME_LENGTH: Int = maxOf(SCOPE.length, PAGE.length)

    /** The text compares a global with its own `top` / `parent`. */
    const val IDIOM = 1

    /** The text assigns a `.parent` chain step (`x = y.parent`, not a call, not a deeper member). */
    const val WALK = 2

    /** The text compares something against `window.top` / `window.parent` (or `self.` / `globalThis.`). */
    const val COMPARE = 4

    /** Characters either side of a `top` / `parent` hit the patterns see (a match starts inside it: room for two long identifiers). */
    private const val WINDOW = 160

    private const val OP = "(?:===|!==|==|!=)"
    private const val GLOBAL = "(?:window|self|globalThis)"

    private val idiom: Pattern = Pattern.compile(
        "\\b(\\w+)(?:\\.self|\\.window)?\\s*$OP\\s*\\1\\.(?:top|parent)\\b" +
            "|\\b(\\w+)\\.(?:top|parent)\\s*$OP\\s*\\2(?:\\.self|\\.window)?\\b" +
            "|\\b$GLOBAL\\s*$OP\\s*(?:top|parent)\\b" +
            "|\\b(?:top|parent)\\s*$OP\\s*$GLOBAL\\b",
    )

    private val walk: Pattern = Pattern.compile("(?<![=!<>])=(?!=)\\s*\\w+\\.parent\\b(?!\\s*[.(])")

    private val compare: Pattern = Pattern.compile(
        "$OP\\s*$GLOBAL\\.(?:top|parent)\\b(?!\\s*[.(\\[])|\\b$GLOBAL\\.(?:top|parent)\\s*$OP",
    )

    /** The flags ([IDIOM], [WALK], [COMPARE]) of `text` between `start` and `end`. */
    fun scan(text: CharSequence, start: Int = 0, end: Int = text.length): Int {
        var flags = 0
        // Made over nothing and reset to each window (see the class note: a matcher over the
        // text would copy the text at every region on Android).
        val idiomMatcher = idiom.matcher("")
        val walkMatcher = walk.matcher("")
        val compareMatcher = compare.matcher("")
        for (word in WORDS) {
            var at = indexOf(text, word, start)
            while (at >= 0 && at + word.length <= end) {
                if (isWord(text, at, word.length)) {
                    val window = text.subSequence(maxOf(start, at - WINDOW), minOf(end, at + word.length + WINDOW))
                    if (flags and IDIOM == 0 && idiomMatcher.reset(window).find()) flags = flags or IDIOM
                    if (flags and WALK == 0 && word == "parent" && walkMatcher.reset(window).find()) flags = flags or WALK
                    if (flags and COMPARE == 0 && compareMatcher.reset(window).find()) flags = flags or COMPARE
                    if (flags == IDIOM or WALK or COMPARE) return flags
                }
                at = indexOf(text, word, at + 1)
            }
        }
        return flags
    }

    /** `word`'s next start in `text` at or after `from`: a String's and a builder's own search; the generic one for any other sequence. */
    private fun indexOf(text: CharSequence, word: String, from: Int): Int = when (text) {
        is String -> text.indexOf(word, from)
        is StringBuilder -> text.indexOf(word, from)
        else -> text.indexOf(word, from)
    }

    /** The function literal's name for `flags`: [SCOPE], [PAGE], or empty for an anonymous literal. */
    fun nameOf(flags: Int): String = when {
        flags and IDIOM != 0 -> SCOPE
        flags and WALK != 0 && flags and COMPARE != 0 -> PAGE
        else -> ""
    }

    private val WORDS = listOf("top", "parent")

    private fun isWord(text: CharSequence, at: Int, length: Int): Boolean =
        (at == 0 || !isWordChar(text[at - 1])) && (at + length >= text.length || !isWordChar(text[at + length]))

    private fun isWordChar(c: Char): Boolean = c == '_' || c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9'
}
