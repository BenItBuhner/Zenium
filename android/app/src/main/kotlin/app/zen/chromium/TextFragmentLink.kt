package app.zen.chromium

import org.json.JSONTokener

/**
 * Copy link to highlight in a page's text-selection action mode (PUI-40; Chrome's item of the
 * same name, behind the toolbar's overflow): the link that scrolls to and highlights the selected
 * passage, `page#:~:text=[prefix-,]start[,end][,-suffix]`.
 *
 * The directive is the page script's to make – the one generator, `src/shared/textFragment.ts`,
 * serves the desktop's menu, the phone's Share and this item alike – and the action mode asks it
 * through the DOM: [GENERATE_SCRIPT] dispatches [EVENT] on the document with an object as its
 * `detail` and the script's listener writes the encoded `text=` directive into it (null when the
 * selection cannot be singled out). No bridge message and no global: `evaluateJavascript` runs
 * the script in the page's world, where the listener stands (`installTextFragmentScript`).
 *
 * The rule for context is the generator's, the same as Chrome's: the exact text alone when it
 * occurs once in the page; a prefix and/or suffix – grown a word at a time – when an earlier
 * passage matches too; a selection past 300 characters becomes a `start,end` range; a passage
 * still ambiguous after ten words of context has no link. Commas, ampersands and dashes inside
 * the terms come percent-encoded (`%2C`, `%26`, `%2D`) so they cannot be read as the syntax.
 *
 * Pure Kotlin: the host reads the WebView and the clipboard (`TabWebView.SelectionActionMode`).
 */
object TextFragmentLink {
    /** The DOM event the page script listens for (`TEXT_FRAGMENT_LINK_EVENT` in `textFragmentScript.ts`). */
    const val EVENT = "zen-text-fragment-link"

    /** The item's label: Chrome's, sentence case as a toolbar item (design language §9.1). */
    const val TITLE = "Copy link to highlight"

    /** The fragment directive delimiter (`FRAGMENT_DIRECTIVE` in `textFragment.ts`). */
    const val DELIMITER = ":~:"

    /**
     * Ask the page for its selection's directive: the answer is the `text=` directive as a JSON
     * string, or `null` – for a page without the script (a custom tab, a document the script did
     * not reach) the event has no listener and the detail stays empty, which is null too.
     */
    val GENERATE_SCRIPT: String = "(function(){try{var d={};" +
        "document.dispatchEvent(new CustomEvent(\"$EVENT\",{detail:d}));" +
        "return typeof d.directive===\"string\"?d.directive:null}catch(e){return null}})()"

    /**
     * What the page may answer: `text=` and the encoded terms – the characters `encodeURIComponent`
     * leaves bare, percent escapes, and the syntax's own commas and dashes. Anything else is not
     * a directive the page script made and is not put in a URL.
     */
    private val DIRECTIVE = Regex("text=[A-Za-z0-9%_.!~*'(),-]+")

    /**
     * Whether the item is offered for a page at [pageUrl]: a web page (http or https) alone – a
     * highlight in a `zen://` page, a file or a `data:` document means nothing to whoever gets the
     * link (the core's rule for its menu item).
     */
    fun offers(pageUrl: String?): Boolean {
        val url = pageUrl ?: return false
        return url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)
    }

    /**
     * The directive out of `evaluateJavascript`'s answer to [GENERATE_SCRIPT]: the JSON string's
     * value when it is a whole `text=` directive; null for `null`, garbage, or anything else.
     */
    fun directiveOf(raw: String?): String? {
        val value = runCatching { JSONTokener(raw ?: "").nextValue() as? String }.getOrNull() ?: return null
        return value.takeIf { DIRECTIVE.matches(it) }
    }

    /**
     * [pageUrl] with [directive] as its fragment directive: the page's own fragment stays ahead of
     * the `:~:`; an earlier fragment directive is replaced (`appendTextDirective` in
     * `textFragment.ts`, Chrome's `AppendSelectors`). Null unless the page is one to link to and
     * the directive is one the page script made.
     */
    fun linkTo(pageUrl: String?, directive: String?): String? {
        if (!offers(pageUrl) || directive == null || !DIRECTIVE.matches(directive)) return null
        val url = pageUrl!!
        val hash = url.indexOf('#')
        val base = if (hash < 0) url else url.substring(0, hash)
        var fragment = if (hash < 0) "" else url.substring(hash + 1)
        val at = fragment.indexOf(DELIMITER)
        if (at >= 0) fragment = fragment.substring(0, at)
        return "$base#$fragment$DELIMITER$directive"
    }
}
