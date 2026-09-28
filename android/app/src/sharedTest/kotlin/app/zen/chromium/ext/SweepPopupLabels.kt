package app.zen.chromium.ext

/**
 * The compat sweep's read of a popup by its sheet's accessibility labels when the popup's
 * document reads empty to a script (its UI in a closed shadow root: Black Menu for Google's on
 * WebView 156, compat round 24, where the same popup read 434 elements on 113): the labels
 * carrying the row's own words – three or more, of a tree that shows content (the sweep's
 * `shownDespiteEmptyDom`) – are the core's pass, as the popup stage and the account gate read
 * such a sheet. Pure; the driver's `popupMarker` reads the tree and this grades the labels.
 */
object SweepPopupLabels {
    /** The labels carrying the row's own words (`words` matched against each node's text). */
    fun own(labels: List<String>, words: Regex): List<String> = labels.filter { words.containsMatchIn(it) }

    /** The pass: the tree shows content and three or more of its labels are the row's own. */
    fun pass(own: List<String>, shown: Boolean): Boolean = shown && own.size >= 3

    /** The grade's word for a pass: the nodes, the own labels, and what the script read beside them. */
    fun word(nodes: Int, own: List<String>, scriptRead: String): String =
        "read by accessibility – the document reads empty to a script (its UI is in a closed shadow root) and the sheet shows it: " +
            "$nodes nodes, ${own.size} labels carrying the row's own words (\"${own.joinToString(" / ").take(120)}\"); the script read: ${scriptRead.take(120)}"
}
