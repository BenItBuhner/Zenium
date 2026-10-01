package app.zen.chromium

/**
 * Whose a touch on a tab view's clipped strip is, and where the chrome under the page sees it.
 *
 * The page is layered above the chrome WebView and clipped out of two kinds of strip: the ones a
 * chrome message's card draws over ([ContentCover]) and the one the page's own displacement
 * opens – held down by the page-edge band (`lib/band/androidHost.ts` through
 * [TabWebView.setPullOffset]) or by a pull, the page sits lower and its bottom is clipped by as
 * much. Android hit-tests a child by its TRANSLATED rect and hands it the touch in its own
 * coordinates (the inverse of the translation applied), so the displaced page still receives
 * every touch that lands on the strip it has left – which on a phone with its bar docked at the
 * bottom is the bar itself: the URL field, the tab count, Menu, dead for as long as a band stood
 * (#735's readers' run: the Menu under the reader offer). Both strips are the chrome's – the
 * card's for its buttons, the displacement's because what lies under the clipped page there is
 * the chrome's own row – and the handed touch must carry the translation, or the chrome reads it
 * a band's height above where the finger is. Pure, so the unit tests run it without a view.
 */
object StripTouchRule {
    /**
     * Whether the gesture beginning at `y` (the page view's own coordinates) is the chrome's: a
     * view under the page exists, a strip is in force – a card's (`coverActive`) or the page's
     * displacement (`pulledDown`) – and the touch lands in a strip, outside the page's visible
     * part [`visibleTop`, `visibleBottom`). A page at rest with no card keeps every touch.
     */
    fun chromesTouch(hasChrome: Boolean, coverActive: Boolean, pulledDown: Boolean, y: Float, visibleTop: Int, visibleBottom: Int): Boolean =
        hasChrome && (coverActive || pulledDown) && (y < visibleTop || y >= visibleBottom)

    /**
     * The offset that carries a touch from the page view's coordinates into the chrome's: the
     * page's laid-out place plus its translation – the parent handed the page its local point
     * through the inverse of that translation, so the point on screen is the local point plus the
     * place plus the translation – less the chrome's place. With the page at rest it is the two
     * places' difference, as before.
     */
    fun offsetToChrome(viewLeft: Int, viewTop: Int, translationX: Float, translationY: Float, chromeLeft: Int, chromeTop: Int): Pair<Float, Float> =
        Pair(viewLeft + translationX - chromeLeft, viewTop + translationY - chromeTop)
}
