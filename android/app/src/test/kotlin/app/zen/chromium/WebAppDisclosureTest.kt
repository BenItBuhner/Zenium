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
 * PWA-13's rule: the "Running in Zenium" card comes up on an install's first launch and is seen
 * once it has LEFT – the clock's end or the swipe – never on show, so a launch killed under the
 * card says it once more; then never again for that install. The memory is one key in the app's
 * own record file – no file type of its own, the write whole or not at all – and a re-install
 * (the record written afresh) starts over.
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
    private fun onDisk(dir: File): JSONObject = JSONObject(file(dir).readText())

    @Test
    fun theInstallsRecordCarriesNoMarkAndAMarkedOneIsShown() {
        assertFalse("no record on disk: not seen yet", WebAppDisclosure.shown(null))
        assertFalse("the install's record: not seen yet", WebAppDisclosure.shown(record.toJson()))
        assertFalse("the install writes no mark", record.toJson().has(WebAppDisclosure.KEY))
        assertTrue(WebAppDisclosure.shown(WebAppDisclosure.marked(record.toJson(), record, 1_700_000_000_000L)))
        assertFalse("a mark of nothing is none", WebAppDisclosure.shown(JSONObject().put(WebAppDisclosure.KEY, 0L)))
    }

    @Test
    fun theFirstLaunchIsDueAndStaysDueUntilTheCardHasLeft() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        val before = file(dir).readText()
        assertTrue("the first launch after the install shows the card", WebAppDisclosure.due(file(dir)))
        // The due read writes nothing: the card showing is not the card seen.
        assertEquals("a due read leaves the record as the install wrote it", before, file(dir).readText())
        assertFalse(onDisk(dir).has(WebAppDisclosure.KEY))
        assertTrue("still due while the card is up", WebAppDisclosure.due(file(dir)))
    }

    @Test
    fun aLaunchKilledUnderTheCardShowsItOnceMore() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        // Launch one: the card comes up on the due read; the process dies before the card leaves – no mark.
        assertTrue(WebAppDisclosure.due(file(dir)))
        // Launch two: due again, the card once more; this time it leaves (the clock's end or the swipe).
        assertTrue("a kill before the card leaves shows it once more", WebAppDisclosure.due(file(dir)))
        assertTrue(WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L))
        // Launch three: seen.
        assertFalse("the launch after a seen card shows nothing", WebAppDisclosure.due(file(dir)))
    }

    @Test
    fun theMarkIsWrittenWhenTheCardLeavesAndKeptOnceThere() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        assertTrue("the card leaving writes the mark", WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L))
        assertEquals(1_700_000_000_000L, onDisk(dir).getLong(WebAppDisclosure.KEY))
        assertFalse("not due after the mark", WebAppDisclosure.due(file(dir)))
        // Idempotent: the clock's end and a swipe cannot both mark, nor a second launch's leave move the time.
        assertFalse("a second mark is no write", WebAppDisclosure.markSeen(file(dir), record, 1_700_000_001_000L))
        assertEquals("the first mark's time stands", 1_700_000_000_000L, onDisk(dir).getLong(WebAppDisclosure.KEY))
    }

    @Test
    fun theMarkKeepsTheRecordWholeForItsOtherReaders() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L)
        val read = WebAppRecord.fromJson(onDisk(dir))!!
        assertEquals(record.id, read.id)
        assertEquals(record.name, read.name)
        assertEquals(record.startUrl, read.startUrl)
        assertEquals(record.scope, read.scope)
        assertEquals(record.display, read.display)
        assertEquals(record.themeColor, read.themeColor)
        assertEquals(record.backgroundColor, read.backgroundColor)
    }

    @Test
    fun theMarksWriteIsWholeOrNotAtAll() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L)
        // A temp beside the record, renamed over it: nothing of the temp is left, the record parses.
        assertEquals(listOf("${record.shortcutId}.json"), dir.list()!!.toList())
        assertTrue(WebAppDisclosure.shown(onDisk(dir)))
        // The store's own write takes the same path: the install leaves no temp either.
        WebAppStore.write(dir, record, null)
        assertEquals(listOf("${record.shortcutId}.json"), dir.list()!!.toList())
        // Over an existing record: replaced, not appended.
        WebAppStore.replace(file(dir), """{"a":1}""")
        assertEquals("""{"a":1}""", file(dir).readText())
    }

    @Test
    fun anOldShortcutWithoutARecordOnDiskGetsOneWithTheMark() {
        val dir = File(temp.root, "never-written")
        assertTrue("no record at all: due", WebAppDisclosure.due(file(dir)))
        assertTrue(WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L))
        val onDisk = onDisk(dir)
        assertTrue(WebAppDisclosure.shown(onDisk))
        assertEquals("the intent's record, written whole", record.startUrl, WebAppRecord.fromJson(onDisk)!!.startUrl)
        assertFalse(WebAppDisclosure.due(file(dir)))
    }

    @Test
    fun aTornRecordCountsAsNoneAndIsMadeWholeAtTheMark() {
        val dir = dir()
        file(dir).writeText("""{"id": "https://app.exa""")
        assertTrue("a record that cannot be read: due (it errs towards telling)", WebAppDisclosure.due(file(dir)))
        assertTrue(WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L))
        assertEquals(record.startUrl, WebAppRecord.fromJson(onDisk(dir))!!.startUrl)
        assertFalse(WebAppDisclosure.due(file(dir)))
    }

    @Test
    fun aReinstallStartsOver() {
        val dir = dir()
        WebAppStore.write(dir, record, null)
        assertTrue(WebAppDisclosure.markSeen(file(dir), record, 1_700_000_000_000L))
        assertFalse(WebAppDisclosure.due(file(dir)))
        WebAppStore.write(dir, record, null)
        assertFalse("the install's write carries no mark", WebAppDisclosure.shown(onDisk(dir)))
        assertTrue("the first launch after the re-install shows it again", WebAppDisclosure.due(file(dir)))
    }

    @Test
    fun theCopyIsTheProductsNameOnThePlainCardsClock() {
        val root = repoRoot()
        val strings = File(root, "android/app/src/main/res/values/strings.xml").readText()
        assertEquals("Running in %1\$s", Regex("""<string name="webapp_disclosure">([^<]+)</string>""").find(strings)!!.groupValues[1])
        assertFalse("the plain card carries no action, so no OK of its own (the lead read on #561)", strings.contains("webapp_disclosure_ok"))
        assertEquals("Zenium", Regex("""<string name="app_name">([^<]+)</string>""").find(strings)!!.groupValues[1])
        val source = File(root, "android/app/src/main/kotlin/app/zen/chromium/WebAppDisclosure.kt").readText()
        assertTrue("the name is the build's app_name, not a literal", source.contains("getString(R.string.webapp_disclosure, context.getString(R.string.app_name))"))
        // §9.33's 2.8 s, the shared card's own clock (`TOAST_SHOW_MS`, pinned by V2TokensPinTest), not the action or Undo clocks.
        assertEquals(2_800L, WebAppDisclosure.SHOW_MS)
        assertEquals(ToastCardSpec.SHOW_MS, WebAppDisclosure.SHOW_MS)
        // The window reads whether the card is due, and marks it seen only where the card reports leaving.
        val activity = File(root, "android/app/src/main/kotlin/app/zen/chromium/WebAppActivity.kt").readText()
        assertTrue(activity.contains("WebAppDisclosure.dueFor(this, record)"))
        assertTrue("the plain card: no action", Regex("""NativeToastCard\([\s\S]*?action = null,""").containsMatchIn(activity))
        val onGone = Regex("""onGone = \{ gone ->([\s\S]*?)\n\s*\}\n""").find(activity)!!.groupValues[1]
        assertTrue("the mark moves to onGone, off the main thread", onGone.contains("Thread(") && onGone.contains("WebAppDisclosure.markSeenFor(this, record, System.currentTimeMillis())"))
        assertTrue("nothing marks on show: the one mark is onGone's", activity.indexOf("markSeenFor") > activity.indexOf("onGone = { gone ->") && !activity.contains("claimFirstLaunch"))
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
