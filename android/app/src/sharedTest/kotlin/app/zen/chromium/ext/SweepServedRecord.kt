package app.zen.chromium.ext

/**
 * The compat sweep's reading of the runtime's served-resource record (ServedRecord) for an
 * extension's own insertion of one of its files – AdGuard Extra's `userscript.js`, compat round
 * 24: its isolated-world content script appends `<script src="<getURL>/userscript.js?<random>">`
 * at document_start, and the page's Resource Timing cannot show that load. Chrome's cannot
 * either: Blink precludes a resource fetched from an isolated world from the timeline (the world
 * a script element's fetch takes is the one running when it was inserted), and a
 * `chrome-extension://` response is not HTTP, which the timeline requires. So the row's read of
 * the page's timeline was blind by parity on a WebView with worlds, and read a divergence of the
 * emulated https origin on the one-realm WebView, where the insert runs in the page world; the
 * record is the read on both.
 *
 * The record's lines for the row's extension naming the file, less the driver's own probe
 * inserts (their queries start with `zen`), grade the insertion: served (a 2xx line) is the
 * row's pass; a refusal (a 4xx line with the runtime's word) is ours; no line is an insertion
 * that never reached the intercept – the content script did not insert, or the page's policy
 * refused the element before its request (the fixture sends none). Pure; the driver's
 * `adguardExtraProbe` reads the lines and this grades them.
 */
object SweepServedRecord {
    class Reading(val pass: Boolean, val word: String)

    /** The record's lines of the extension `id` whose path names `file`, the driver's own inserts (`?zen…`) left out. */
    fun ownLines(record: List<String>, id: String, file: String): List<String> =
        record.filter { line ->
            line.startsWith("${id.take(8)} ") && line.substringBefore(';').contains(file) && !line.substringBefore(';').contains("$file?zen")
        }

    /** The grade of the extension's own insertion off its lines ([ownLines]); `fixturePolicy` names a CSP the fixture sends, if any. */
    fun reading(own: List<String>, file: String, fixturePolicy: String? = null): Reading {
        if (own.isEmpty()) {
            val cause = if (fixturePolicy != null) {
                "the fixture's policy ($fixturePolicy) refuses the element before its request, as Chrome's would not for an extension's world"
            } else {
                "the fixture sends no policy, so the content script did not insert it – or inserted an address the runtime's origins do not answer"
            }
            return Reading(false, "the served-resource record has no line for the extension's own $file: the insertion never reached the intercept – $cause")
        }
        val served = own.filter { ServedRecord.status(it) in 200..299 }
        val refused = own.filter { ServedRecord.status(it) !in 200..299 }
        if (served.isNotEmpty()) {
            val also = if (refused.isNotEmpty()) " (and ${refused.size} refused, the last: ${refused.last()})" else ""
            return Reading(
                true,
                "the served-resource record has the extension's own insertion served – ${served.last()}$also – where the page's timeline holds no entry for a world's load, as Chrome's holds none: the record is the row's read"
            )
        }
        return Reading(false, "the served-resource record has the extension's own insertion REFUSED by the runtime – ${refused.last()} – ours: the web-accessible gate, the alias spelling or a file not in the bundle, by the line's word")
    }
}
