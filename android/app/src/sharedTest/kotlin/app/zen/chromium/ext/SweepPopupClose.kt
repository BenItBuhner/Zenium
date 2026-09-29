package app.zen.chromium.ext

/**
 * The word of a popup stage whose popup came up and closed itself before the read (the compat
 * sweep's popup stage; compat round 24). A popup document that does its work and calls
 * `window.close()` at once – Bitget Wallet's popup.html for a wallet with no vault opens its
 * onboarding in a tab and closes – leaves the sheet loop a rendered view and the settled read
 * nothing: round 23 §7 graded the row P at "0x0 css px in a 0x0 dp sheet, 0 elements", right
 * about the surface and blind about the close. Pure: the driver hands over how long after its
 * render the popup's view was gone and the tabs it found after it, and this words the stage as
 * Chrome shows it (the popup's window closes; the tab it opened stays).
 *
 * The tabs after the close are the popup's answer – a tab opened, a tab of the row's own the
 * popup sent the tab under it to (`tabs.update`), or an open page of the extension's own the
 * click brought to the front – and with one the stage is P. With none, what the popup did
 * before its close is not readable after it: the stage is PARTIAL and says so, so a P never
 * claims what was not seen.
 */
object SweepPopupClose {
    /** The verdict and its note. */
    data class Word(val verdict: String, val note: String)

    /**
     * @param closedAfterMs how long after its render the popup's view was gone
     * @param opened the tabs opened after the click, the URL a tab was first seen on leading
     * @param sent the pages of the row's own the popup sent the tab under it to
     * @param raised the extension's open page the click brought to the front, or null
     */
    fun word(closedAfterMs: Long, opened: List<String>, sent: List<String>, raised: String?): Word {
        val after = listOfNotNull(
            opened.takeIf { it.isNotEmpty() }?.let { "opened ${it.joinToString().take(160)}" },
            sent.takeIf { it.isNotEmpty() }?.let { "sent the tab under it to ${it.joinToString().take(160)}" },
            raised?.let { "brought its open page ${it.take(160)} to the front" }
        )
        val closing = "the popup came up and closed itself within $closedAfterMs ms of its render (a popup document's own window.close(), as Chrome shows it)"
        return if (after.isEmpty()) Word("PARTIAL", "$closing; tabs after: none – what the popup did before its close is not readable after it")
        else Word("P", "$closing; tabs after: ${after.joinToString("; ")}")
    }
}
