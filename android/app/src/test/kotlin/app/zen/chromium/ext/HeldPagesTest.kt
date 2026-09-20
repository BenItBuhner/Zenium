package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bookkeeping behind a restored tab's extension page at boot: the core names the extensions
 * it is about to configure, a page requested on one of their origins is held until the
 * configure serves the extension, and a page of an extension that is not coming (not named,
 * detached, or still unserved when the core's start is over) is handed back to fail.
 */
class HeldPagesTest {
    private val a = "a".repeat(32)
    private val b = "b".repeat(32)
    private val pages = HeldPages<String>()

    private fun urls(held: List<HeldPages.Held<String>>) = held.map { "${it.view}:${it.url}" }

    @Test
    fun `only the named extensions are expected, and the word is replaced by the next`() {
        assertFalse(pages.expects(a))
        pages.expect(listOf(a))
        assertTrue(pages.expects(a))
        assertFalse(pages.expects(b))
        pages.expect(listOf(b))
        assertFalse(pages.expects(a))
        assertTrue(pages.expects(b))
        pages.expect(emptyList())
        assertFalse(pages.expects(b))
    }

    @Test
    fun `a held page comes back once for a reload when the extension is served`() {
        pages.expect(listOf(a))
        pages.hold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        // Asked for again while held (a reload, a second request for the same document): one hold.
        pages.hold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        pages.hold(a, "tab2", "https://$a.ext.zenium.invalid/popup.html")
        assertEquals(setOf(a), pages.holding())
        assertEquals(
            listOf("tab1:https://$a.ext.zenium.invalid/options.html", "tab2:https://$a.ext.zenium.invalid/popup.html"),
            urls(pages.served(a))
        )
        assertEquals(emptyList<String>(), urls(pages.served(a)))
        assertEquals(emptySet<String>(), pages.holding())
    }

    @Test
    fun `a hold taken back leaves nothing to reload`() {
        pages.expect(listOf(a))
        pages.hold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        pages.unhold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        assertEquals(emptySet<String>(), pages.holding())
        assertEquals(emptyList<String>(), urls(pages.served(a)))
    }

    @Test
    fun `the start being over fails the pages of extensions that did not come up`() {
        pages.expect(listOf(a, b))
        pages.hold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        pages.hold(b, "tab2", "https://$b.ext.zenium.invalid/options.html")
        // `a` came up: its page reloads. `b`'s attach failed, and the core says its start is over.
        assertEquals(listOf("tab1:https://$a.ext.zenium.invalid/options.html"), urls(pages.served(a)))
        assertEquals(listOf("tab2:https://$b.ext.zenium.invalid/options.html"), urls(pages.expect(emptyList())))
        assertEquals(emptySet<String>(), pages.holding())
        assertFalse(pages.expects(b))
    }

    @Test
    fun `a detached extension takes its held pages down and is not expected any more`() {
        pages.expect(listOf(a))
        pages.hold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        assertEquals(listOf("tab1:https://$a.ext.zenium.invalid/options.html"), urls(pages.dropped(a)))
        assertFalse(pages.expects(a))
        assertEquals(emptyList<String>(), urls(pages.dropped(a)))
    }

    @Test
    fun `a new word keeps the pages of extensions still named`() {
        pages.expect(listOf(a, b))
        pages.hold(a, "tab1", "https://$a.ext.zenium.invalid/options.html")
        pages.hold(b, "tab2", "https://$b.ext.zenium.invalid/options.html")
        assertEquals(listOf("tab2:https://$b.ext.zenium.invalid/options.html"), urls(pages.expect(listOf(a))))
        assertEquals(setOf(a), pages.holding())
    }
}
