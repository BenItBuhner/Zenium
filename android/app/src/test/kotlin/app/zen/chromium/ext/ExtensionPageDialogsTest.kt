package app.zen.chromium.ext

import app.zen.chromium.PageDialogKind
import app.zen.chromium.PageDialogWords
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtensionPageDialogsTest {
    private val origin = "https://aefkmifgmaafnojlojpnekbpbmjiiogg.ext.zenium.invalid"
    private val name = "Popup Blocker (strict)"

    /** `strings.xml`'s `page_dialog_*` as the device reads them, so the titles below are the resource formats' own. */
    private val strings: Map<String, String> = Regex("""<string name="page_dialog_(\w+)">(.*?)</string>""")
        .findAll(source("android/app/src/main/res/values/strings.xml"))
        .associate { it.groupValues[1] to it.groupValues[2].replace("\\'", "'") }

    /** A source file by its path from the repository root, wherever Gradle runs the test from. */
    private fun source(path: String): String {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return File(dir, path).readText()
            dir = dir.parentFile
        }
        error("$path: no repository root above ${File(".").absolutePath}")
    }

    private val words = PageDialogWords(
        titleSite = strings.getValue("title_site"),
        titleEmbedded = strings.getValue("title_embedded"),
        titleEmbeddedNoSite = strings.getValue("title_embedded_no_site"),
        titleNoSite = strings.getValue("title_no_site"),
        leaveTitle = strings.getValue("leave_title"),
        reloadTitle = strings.getValue("reload_title"),
        leaveMessage = strings.getValue("leave_message"),
        suppress = strings.getValue("suppress"),
        cancel = strings.getValue("cancel"),
        ok = strings.getValue("ok"),
        leave = strings.getValue("leave"),
        reload = strings.getValue("reload")
    )

    @Test
    fun `the views in the sheet show dialogs - the worker page and an offscreen document have none`() {
        assertTrue(ExtensionPageDialogs.shows("popup"))
        assertTrue(ExtensionPageDialogs.shows("options"))
        assertTrue(ExtensionPageDialogs.shows("sidePanel"))
        assertFalse(ExtensionPageDialogs.shows("background"))
        assertFalse(ExtensionPageDialogs.shows("offscreen"))
    }

    @Test
    fun `a frame on the extension's origin is titled with the extension's name - Chrome's title for an extension page`() {
        val spec = ExtensionPageDialogs.spec(
            PageDialogKind.CONFIRM, "$origin/data/popup/index.html", origin, name,
            "The background script seems to be unresponsive. Do you want to try restarting the extension?", "", suppressible = false
        )
        assertEquals("$name says", spec.title(words))
        assertEquals("The background script seems to be unresponsive. Do you want to try restarting the extension?", spec.message)
        assertTrue(spec.cancellable)
        assertFalse(spec.suppressible)
        assertEquals(words.ok, spec.acceptLabel(words))
        // The origin itself and an about: frame (it inherits the origin) are the extension's own too.
        assertEquals("$name says", ExtensionPageDialogs.spec(PageDialogKind.ALERT, origin, origin, name, "hi", "", false).title(words))
        assertEquals("$name says", ExtensionPageDialogs.spec(PageDialogKind.ALERT, "about:blank", origin, name, "hi", "", false).title(words))
    }

    @Test
    fun `an alert has nothing to cancel and a prompt keeps its default text - a confirm's default is dropped`() {
        val alert = ExtensionPageDialogs.spec(PageDialogKind.ALERT, "$origin/popup.html", origin, name, "Saved", "ignored", suppressible = true)
        assertFalse(alert.cancellable)
        assertEquals("", alert.defaultValue)
        assertTrue(alert.suppressible)
        val prompt = ExtensionPageDialogs.spec(PageDialogKind.PROMPT, "$origin/popup.html", origin, name, "Name the list", "Reading", suppressible = false)
        assertEquals("Reading", prompt.defaultValue)
        assertEquals("$name says", prompt.title(words))
        val confirm = ExtensionPageDialogs.spec(PageDialogKind.CONFIRM, "$origin/popup.html", origin, name, "Sure?", "ignored", suppressible = false)
        assertEquals("", confirm.defaultValue)
    }

    @Test
    fun `an embedded frame of another origin is titled as Chrome titles it - the site line, never the extension's name`() {
        val spec = ExtensionPageDialogs.spec(PageDialogKind.ALERT, "https://example.com/widget", origin, name, "hi", "", suppressible = false)
        assertEquals(words.title("example.com", embedded = true), spec.title(words))
        assertTrue(spec.embedded)
        assertFalse(spec.title(words).contains(name))
        // Another extension's origin is another origin too.
        val other = ExtensionPageDialogs.spec(PageDialogKind.ALERT, "https://other0000000000000000000000000000.ext.zenium.invalid/x.html", origin, name, "hi", "", false)
        assertTrue(other.embedded)
        assertFalse(other.title(words).contains(name))
    }

    @Test
    fun `a hidden view's dialog is silenced with the reason - a shown view's is not - and a silenced visit says so`() {
        val worker = ExtensionPageDialogs.silence("background", PageDialogKind.ALERT, suppressed = false)
        assertTrue(worker!!, worker.startsWith("[Zenium] alert() from the background page"))
        assertTrue(worker, worker.contains("service worker has no dialogs"))
        val offscreen = ExtensionPageDialogs.silence("offscreen", PageDialogKind.PROMPT, suppressed = false)
        assertTrue(offscreen!!, offscreen.startsWith("[Zenium] prompt() from the offscreen document"))
        assertNull(ExtensionPageDialogs.silence("popup", PageDialogKind.CONFIRM, suppressed = false))
        assertNull(ExtensionPageDialogs.silence("sidePanel", PageDialogKind.ALERT, suppressed = false))
        val told = ExtensionPageDialogs.silence("popup", PageDialogKind.CONFIRM, suppressed = true)
        assertTrue(told!!, told.startsWith("[Zenium] confirm() is answered as dismissed: the page was told"))
        val unload = ExtensionPageDialogs.silence("background", PageDialogKind.LEAVE, suppressed = false)
        assertTrue(unload!!, unload.startsWith("[Zenium] a beforeunload objection from the background page"))
    }
}
