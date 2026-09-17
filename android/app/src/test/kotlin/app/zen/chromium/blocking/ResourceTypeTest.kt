package app.zen.chromium.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResourceTypeTest {
    @Test
    fun dnrNamesRoundTripAndMasksAreDistinct() {
        for (type in ResourceType.entries) {
            assertEquals(type, ResourceType.fromDnrName(type.dnrName))
            assertEquals(1, Integer.bitCount(type.bit))
        }
        assertNull(ResourceType.fromDnrName("popup"))
        assertEquals(ResourceType.entries.size, Integer.bitCount(ResourceType.ALL_MASK))
        assertEquals(0, ResourceType.DEFAULT_MASK and ResourceType.MAIN_FRAME.bit)
        assertEquals(ResourceType.ALL_MASK, ResourceType.DEFAULT_MASK or ResourceType.MAIN_FRAME.bit)
        assertEquals(0, ResourceType.AMBIGUOUS_MASK and (ResourceType.MAIN_FRAME.bit or ResourceType.IMAGE.bit or ResourceType.STYLESHEET.bit))
        assertNotEquals(0, ResourceType.AMBIGUOUS_MASK and ResourceType.SCRIPT.bit)
        assertNotEquals(0, ResourceType.AMBIGUOUS_MASK and ResourceType.XMLHTTPREQUEST.bit)
    }

    @Test
    fun theMainFrameFlagAndTheAcceptHeaderComeFirst() {
        assertEquals(ResourceType.MAIN_FRAME, ResourceType.guessKnown("https://x.example/a.js", true, null))
        assertEquals(ResourceType.WEBSOCKET, ResourceType.guessKnown("wss://x.example/socket", false, null))
        assertEquals(ResourceType.SUB_FRAME, ResourceType.guessKnown("https://x.example/frame", false, "text/html,application/xhtml+xml"))
        assertEquals(ResourceType.STYLESHEET, ResourceType.guessKnown("https://x.example/s", false, "text/css,*/*;q=0.1"))
        assertEquals(ResourceType.IMAGE, ResourceType.guessKnown("https://x.example/pixel", false, "image/avif,image/webp,*/*"))
        assertEquals(ResourceType.MEDIA, ResourceType.guessKnown("https://x.example/clip", false, "video/webm"))
        assertEquals(ResourceType.FONT, ResourceType.guessKnown("https://x.example/f", false, "font/woff2"))
        // The wildcard Accept of scripts and fetches decides nothing; the extension does.
        assertEquals(ResourceType.SCRIPT, ResourceType.guessKnown("https://x.example/app.min.js?v=3", false, "*/*"))
    }

    @Test
    fun theFileExtensionIsTheLastResort() {
        assertEquals(ResourceType.SCRIPT, ResourceType.guessKnown("https://x.example/a.mjs", false, null))
        assertEquals(ResourceType.STYLESHEET, ResourceType.guessKnown("https://x.example/a.css", false, null))
        assertEquals(ResourceType.SUB_FRAME, ResourceType.guessKnown("https://x.example/ad.html", false, null))
        assertEquals(ResourceType.OBJECT, ResourceType.guessKnown("https://x.example/player.swf", false, null))
        assertEquals(ResourceType.IMAGE, ResourceType.guessKnown("https://x.example/a.PNG", false, null))
        assertEquals(ResourceType.FONT, ResourceType.guessKnown("https://x.example/a.woff2", false, null))
        assertEquals(ResourceType.MEDIA, ResourceType.guessKnown("https://x.example/a.mp4", false, null))
        assertNull(ResourceType.guessKnown("https://x.example/collect?e=1", false, null))
        assertNull(ResourceType.guessKnown("https://x.example/", false, "*/*"))
    }

    @Test
    fun unknownRequestsAreFetchesWithTheAmbiguousMask() {
        assertEquals(ResourceType.XMLHTTPREQUEST, ResourceType.guess("https://x.example/collect", false, null))
        assertEquals(ResourceType.AMBIGUOUS_MASK, ResourceType.guessMask("https://x.example/collect", false, null))
        assertEquals(ResourceType.IMAGE.bit, ResourceType.guessMask("https://x.example/a.gif", false, null))
        assertEquals(ResourceType.MAIN_FRAME.bit, ResourceType.guessMask("https://x.example/", true, null))
    }

    @Test
    fun extensionOfReadsThePathOnly() {
        assertEquals("js", ResourceType.extensionOf("https://x/a/b.min.js?v=1"))
        assertEquals("jpeg", ResourceType.extensionOf("https://x/file.jpeg#frag"))
        assertEquals("gz", ResourceType.extensionOf("https://x/archive.tar.gz"))
        assertEquals("", ResourceType.extensionOf("https://x.example.com"))
        assertEquals("", ResourceType.extensionOf("https://x.example.com/path"))
        assertEquals("", ResourceType.extensionOf("https://x/a.b/c"))
        assertEquals("", ResourceType.extensionOf("https://x/a.abcdefghij"))
        assertEquals("", ResourceType.extensionOf("https://x/a."))
        assertEquals("", ResourceType.extensionOf("https://x/?q=a.js"))
    }
}
