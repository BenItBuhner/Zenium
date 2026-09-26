package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * PWA-13's rule: the "Running in Zenium" card comes up on an install's first launch and never
 * again for that install, the memory one key in the app's own record file – no file type of its
 * own – and a re-install (the record written afresh) starts over.
 */
class WebAppDisclosureTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val record = WebAppRecord(
        id = "https://app.example/app/",
        name = "Sketch Studio",
        startUrl = "https://app.example/app/",
        scope = "https://app.example/app/",
        display = WebAppRules.Display.STANDALONE,
        themeColor = 0xff2f6f8f.toInt(),
        backgroundColor = 0xffe8f1f5.toInt()
    )

    private fun dir(): File = temp.newFolder("webapps")
    private fun file(dir: File): File = File(dir, "${record.shortcutId}.json")

    @Test
    fun theInstallsRecordCarriesNoMarkAndAMarkedOneIsShown() {
        assertFalse("no record on disk: not shown yet", WebAppDisclosure.shown(null))
        assertFalse("the install's record: not shown yet", WebAppDisclosure.shown(record.toJson()))
        assertFalse("the install writes no mark", record.toJson().has(WebAppDisclosure.KEY))
        assertTrue(WebAppDisclosure.shown(WebAppDisclosure.marked(record.toJson(), record, 1_700_000_000_000L)))
        assertFalse("a mark of nothing is none", WebAppDisclosure.shown(JSONObject().put(WebAppDisclosure.KEY, 0L)))
    }

    @Test
    fun theFirstLaunchClaimsTheDisclosureAndTheSecondDoesNot() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        assertTrue("the first launch after the install shows it", WebAppDisclosure.claim(file(dir), record, 1_700_000_000_000L))
        val onDisk = JSONObject(file(dir).readText())
        assertEquals(1_700_000_000_000L, onDisk.getLong(WebAppDisclosure.KEY))
        assertFalse("the second launch does not", WebAppDisclosure.claim(file(dir), record, 1_700_000_001_000L))
        assertEquals("the second launch left the first's mark", 1_700_000_000_000L, JSONObject(file(dir).readText()).getLong(WebAppDisclosure.KEY))
    }

    @Test
    fun theMarkKeepsTheRecordWholeForItsOtherReaders() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        WebAppDisclosure.claim(file(dir), record, 1_700_000_000_000L)
        val read = WebAppRecord.fromJson(JSONObject(file(dir).readText()))!!
        assertEquals(record.id, read.id)
        assertEquals(record.name, read.name)
        assertEquals(record.startUrl, read.startUrl)
        assertEquals(record.scope, read.scope)
        assertEquals(record.display, read.display)
        assertEquals(record.themeColor, read.themeColor)
        assertEquals(record.backgroundColor, read.backgroundColor)
    }

    @Test
    fun anOldShortcutWithoutARecordOnDiskGetsOneWithTheMark() {
        val dir = File(temp.root, "never-written")
        assertTrue(WebAppDisclosure.claim(file(dir), record, 1_700_000_000_000L))
        val onDisk = JSONObject(file(dir).readText())
        assertTrue(WebAppDisclosure.shown(onDisk))
        assertEquals("the intent's record, written whole", record.startUrl, WebAppRecord.fromJson(onDisk)!!.startUrl)
        assertFalse(WebAppDisclosure.claim(file(dir), record, 1_700_000_001_000L))
    }

    @Test
    fun aReinstallStartsOver() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        assertTrue(WebAppDisclosure.claim(file(dir), record, 1_700_000_000_000L))
        WebAppStore.write(dir, record, null)
        assertFalse("the install's write carries no mark", WebAppDisclosure.shown(JSONObject(file(dir).readText())))
        assertTrue("the first launch after the re-install shows it again", WebAppDisclosure.claim(file(dir), record, 1_700_000_002_000L))
    }

    @Test
    fun theCopyIsTheProductsNameOnTheLongClock() {
        val root = repoRoot()
        val strings = File(root, "android/app/src/main/res/values/strings.xml").readText()
        assertEquals("Running in %1\$s", Regex("""<string name="webapp_disclosure">([^<]+)</string>""").find(strings)!!.groupValues[1])
        assertEquals("OK", Regex("""<string name="webapp_disclosure_ok">([^<]+)</string>""").find(strings)!!.groupValues[1])
        assertEquals("Zenium", Regex("""<string name="app_name">([^<]+)</string>""").find(strings)!!.groupValues[1])
        val source = File(root, "android/app/src/main/kotlin/app/zen/chromium/WebAppDisclosure.kt").readText()
        assertTrue("the name is the build's app_name, not a literal", source.contains("getString(R.string.webapp_disclosure, context.getString(R.string.app_name))"))
        assertEquals(8_000L, WebAppDisclosure.SHOW_MS)
        assertEquals(ToastCardSpec.LONG_SHOW_MS, WebAppDisclosure.SHOW_MS)
    }

    private fun repoRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
            dir = dir.parentFile
        }
        error("not inside the repository")
    }
}
