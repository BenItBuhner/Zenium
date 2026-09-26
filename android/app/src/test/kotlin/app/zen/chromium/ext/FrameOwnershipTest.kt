package app.zen.chromium.ext

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The extension's own frame in a web tab told from the tab's page without an initiator: by a
 * CORS request's `Origin`, or by a Referer-less request for a file while the tab holds a frame
 * document of the extension (Search by Image's views under `no-referrer`, compat round 19).
 */
class FrameOwnershipTest {
    private val sbi = "cnojnbdhbhnkbcieeekonklommdnndci"
    private val other = "o".repeat(32)
    private val origin = "https://$sbi.ext.zenium.invalid"
    private val frames = FrameOwnership<String>()

    private fun own(tab: String = "gallery", id: String = sbi, referer: String? = null, originHeader: String? = null, document: Boolean = false) =
        frames.ownRequest(tab, id, origin, referer, originHeader, document)

    @Test
    fun `a Referer-less request for a file is a web page's until the tab holds a frame document of the extension`() {
        assertFalse(own())
        // The view's document served into the gallery tab's frame: its scripts, styles and fonts
        // come next with no Referer (the view's meta referrer is no-referrer).
        frames.framed("gallery", sbi)
        assertTrue(frames.holds("gallery", sbi))
        assertTrue(own())
        // Another tab, another extension: not this frame's.
        assertFalse(own(tab = "other-tab"))
        assertFalse(own(id = other))
        assertFalse(frames.holds("gallery", other))
    }

    @Test
    fun `a document is never admitted by the frame, only a file`() {
        frames.framed("gallery", sbi)
        assertTrue(own(document = false))
        assertFalse(own(document = true))
    }

    @Test
    fun `a request carrying a Referer is left to the Referer's reading`() {
        frames.framed("gallery", sbi)
        assertFalse(own(referer = "http://10.0.2.2:8765/gallery.html?sbi"))
        assertFalse(own(referer = "$origin/src/select/index.html"))
    }

    @Test
    fun `the extension's own Origin header is the extension's document, framed or not`() {
        // A font or a module script of the view (a CORS request) names the view's origin.
        assertTrue(own(originHeader = origin))
        assertTrue(own(originHeader = origin, referer = "$origin/src/select/index.html"))
        // A web page's CORS request names the page; a content script's module import on the
        // one-realm WebView names the page too.
        assertFalse(own(originHeader = "http://10.0.2.2:8765"))
        frames.framed("gallery", sbi)
        assertFalse(own(originHeader = "http://10.0.2.2:8765", referer = "http://10.0.2.2:8765/gallery.html?sbi"))
        // The origin with a trailing slash is not how an Origin header spells it.
        assertFalse(own(originHeader = "$origin/", referer = "http://10.0.2.2:8765/"))
    }

    @Test
    fun `the tab's next page takes the frames with it, and a reset takes all`() {
        frames.framed("gallery", sbi)
        frames.framed("shop", sbi)
        frames.forget("gallery")
        assertFalse(frames.holds("gallery", sbi))
        assertFalse(own())
        assertTrue(frames.holds("shop", sbi))
        frames.clear()
        assertFalse(frames.holds("shop", sbi))
    }
}
