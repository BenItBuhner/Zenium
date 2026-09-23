package app.zen.chromium

import app.zen.chromium.ext.ZipFixtures
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The relaunch tab-loss race, host side (#344 finding 5): the Activity's `Host` is destroyed
 * while the core in its chrome still runs and a new `Host` boots its own core in the same
 * process. Nothing the old host's storage is asked to write from then on may land – not after
 * `close()` (the storage thread stopped, every path refused), and not, whatever the thread, once
 * a newer host has claimed the profile's lease (the rename refused under the lease's lock).
 */
class StorageTeardownTest {
    private val dir = ZipFixtures.tempDir("zen-storage-teardown")
    private val log = ArrayList<String>()
    private val withTab = """{"version":5,"tabs":[{"id":"tab_demo","url":"http://127.0.0.1/demo"}]}"""
    private val tabless = """{"version":5,"tabs":[]}"""

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private fun await(latch: CountDownLatch) = assertTrue(latch.await(10, TimeUnit.SECONDS))

    @Test
    fun aClosedInstanceRefusesEveryWriteAndTheDocumentStaysAsItWas() {
        val storage = Storage(dir, log = { log.add(it) })
        storage.writeSync("state.json", withTab)
        assertFalse(storage.isClosed)

        storage.close()
        assertTrue(storage.isClosed)
        assertEquals(listOf("closed: writes from this host are refused from here"), log)

        // The debounced write of the state the teardown itself made: refused, the caller told.
        val done = CountDownLatch(1)
        var failure: Throwable? = null
        storage.write("state.json", tabless, backup = true) { failure = it; done.countDown() }
        await(done)
        assertTrue("$failure", failure is Storage.RefusedWrite)
        assertEquals("state.json not written: ${Storage.CLOSED}", failure!!.message)
        assertEquals(withTab, storage.read("state.json"))
        assertNull(storage.read("state.json.bak"))
        assertFalse(File(dir, "state.json.tmp").exists())

        // The last-chance write arriving late; a removal; a write in pieces: all refused alike.
        val sync = runCatching { storage.writeSync("state.json", tabless) }.exceptionOrNull()
        assertTrue("$sync", sync is Storage.RefusedWrite)
        val removed = CountDownLatch(1)
        var removal: Throwable? = null
        storage.remove("state.json") { removal = it; removed.countDown() }
        await(removed)
        assertTrue("$removal", removal is Storage.RefusedWrite)
        assertNull(storage.beginWrite("state.json"))
        assertEquals(withTab, storage.read("state.json"))

        // Nothing runs on the stopped thread; reads still answer; closing again is nothing.
        var ran = false
        storage.execute { ran = true }
        storage.close()
        assertFalse(ran)
        assertTrue(storage.exists("state.json"))
        assertEquals(withTab, storage.readAll().getString("state.json"))
        assertEquals(
            listOf(
                "closed: writes from this host are refused from here",
                "refused state.json: ${Storage.CLOSED}",
                "refused state.json: ${Storage.CLOSED}",
                "refused state.json: ${Storage.CLOSED}",
                "refused state.json: ${Storage.CLOSED}"
            ),
            log
        )
    }

    @Test
    fun aWriteInPiecesStillOpenAtCloseIsDroppedWithItsTempFile() {
        val storage = Storage(dir, log = { log.add(it) })
        storage.writeSync("ext-storage/abc.json", "old")
        val token = storage.beginWrite("ext-storage/abc.json")!!
        assertTrue(storage.writeChunk(token, "new"))
        assertEquals(1, File(dir, "ext-storage").listFiles { f -> f.name.endsWith(".tmp") }!!.size)

        storage.close()
        assertFalse(storage.hasPending(token))
        assertFalse(storage.writeChunk(token, "er"))
        assertFalse(storage.endWrite(token))
        assertEquals("old", storage.read("ext-storage/abc.json"))
        assertEquals(0, File(dir, "ext-storage").listFiles { f -> f.name.endsWith(".tmp") }!!.size)
        assertEquals(listOf("closed: writes from this host are refused from here (1 in pieces dropped)"), log)
    }

    @Test
    fun aWriteQueuedBehindABusyThreadWhenTheHostClosesNeverRuns() {
        val storage = Storage(dir, log = { log.add(it) })
        storage.writeSync("state.json", withTab)
        // The storage thread is busy when the write is queued and when the host is destroyed.
        val busy = CountDownLatch(1)
        val started = CountDownLatch(1)
        storage.execute { started.countDown(); busy.await(10, TimeUnit.SECONDS) }
        val done = CountDownLatch(1)
        var failure: Throwable? = null
        storage.write("state.json", tabless) { failure = it; done.countDown() }
        await(started)
        storage.close()
        busy.countDown()
        // The queued write never runs (the thread was stopped before it began): its callback
        // hears nothing, as a write on a dead host's thread would. The document is untouched.
        assertFalse(done.await(500, TimeUnit.MILLISECONDS))
        assertEquals(withTab, storage.read("state.json"))
        assertNull(failure)
    }

    @Test
    fun aWriteFromASupersededHostIsRefusedAndTheDocumentTheNewHostReadStays() {
        val lease = Storage.Lease()
        val old = Storage(dir, lease, log = { log.add("old: $it") })
        old.writeSync("state.json", withTab, backup = true)

        // The new Activity's host is built: its core reads the profile from here on.
        val new = Storage(dir, lease, log = { log.add("new: $it") })
        assertEquals(withTab, new.read("state.json"))

        // The old core's late writes – the debounced one, the synchronous one, one in pieces –
        // are refused at the rename; nothing about the document, its backup or the folder moves.
        val done = CountDownLatch(1)
        var failure: Throwable? = null
        old.write("state.json", tabless, backup = true) { failure = it; done.countDown() }
        await(done)
        assertTrue("$failure", failure is Storage.RefusedWrite)
        assertEquals("state.json not written: ${Storage.SUPERSEDED}", failure!!.message)
        val sync = runCatching { old.writeSync("state.json", tabless, backup = true) }.exceptionOrNull()
        assertTrue("$sync", sync is Storage.RefusedWrite)
        val token = old.beginWrite("state.json", backup = true)!!
        assertTrue(old.writeChunk(token, tabless))
        assertFalse(old.endWrite(token))
        assertEquals(withTab, new.read("state.json"))
        assertNull(new.read("state.json.bak"))
        assertEquals(setOf("state.json"), dir.list()!!.toSet())

        // The new host writes as ever, and an old instance without a lease of its own is not fenced.
        new.writeSync("state.json", tabless, backup = true)
        assertEquals(tabless, new.read("state.json"))
        assertEquals(withTab, new.read("state.json.bak"))
        assertEquals(
            listOf(
                "old: refused state.json: ${Storage.SUPERSEDED}",
                "old: refused state.json: ${Storage.SUPERSEDED}",
                "old: refused state.json: ${Storage.SUPERSEDED}"
            ),
            log
        )
        old.close()
        new.close()
    }

    @Test
    fun aWriteAlreadyOnTheOldHostsThreadWhenTheNewHostClaimsIsRefused() {
        // The race as the nightly logged it: the old core's `storage.write` is on its way when
        // the new Activity's host comes up; whichever order the threads take, the new host's read
        // is not overwritten – the rename waits for the claim's lock and then finds itself superseded.
        val lease = Storage.Lease()
        val old = Storage(dir, lease, log = { log.add(it) })
        old.writeSync("state.json", withTab)
        val busy = CountDownLatch(1)
        val started = CountDownLatch(1)
        old.execute { started.countDown(); busy.await(10, TimeUnit.SECONDS) }
        val done = CountDownLatch(1)
        var failure: Throwable? = null
        old.write("state.json", tabless) { failure = it; done.countDown() }
        await(started)

        val new = Storage(dir, lease)
        busy.countDown()
        await(done)
        assertTrue("$failure", failure is Storage.RefusedWrite)
        assertEquals(withTab, new.read("state.json"))
        assertFalse(File(dir, "state.json.tmp").exists())
        assertEquals(listOf("refused state.json: ${Storage.SUPERSEDED}"), log)
        old.close()
        new.close()
    }

    @Test
    fun aClaimWaitsForARenameUnderWayAndTheRenameLandsBeforeIt() {
        // The lock is what makes the hand-over clean: a publish that passed the check cannot be
        // overtaken by a claim before its rename, so a write either lands before the new host
        // exists or is refused – never after the new host's core has read.
        val lease = Storage.Lease()
        val holder = lease.claim()
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        var published = false
        val publisher = Thread {
            lease.whileHeld(holder) {
                inside.countDown()
                release.await(10, TimeUnit.SECONDS)
                published = true
            }
        }
        publisher.start()
        await(inside)
        var claimedAfterPublish = false
        val claimer = Thread {
            lease.claim()
            claimedAfterPublish = published
        }
        claimer.start()
        claimer.join(300)
        assertTrue(claimer.isAlive)
        release.countDown()
        claimer.join(10_000)
        publisher.join(10_000)
        assertFalse(claimer.isAlive)
        assertTrue(published)
        assertTrue(claimedAfterPublish)
        assertFalse(lease.holds(holder))
        // A superseded holder's publish never runs.
        var ran = false
        assertFalse(lease.whileHeld(holder) { ran = true })
        assertFalse(ran)
    }
}
