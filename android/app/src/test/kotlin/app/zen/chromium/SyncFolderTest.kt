package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * `SyncFolder` against an in-memory document tree shaped like a SAF provider: entries by id
 * under a parent, display names the provider may dedupe on rename, a permission that can go.
 */
class SyncFolderTest {
    private class FakeTree : SyncTree {
        private class Node(val id: String, var name: String, val parent: String?, val isDirectory: Boolean, var text: String = "")

        private val nodes = LinkedHashMap<String, Node>()
        private var seq = 0
        var granted = true
        var rootPresent = true
        /** The provider refuses to rename (some cloud providers do). */
        var renameFails = false
        /** The provider renames to "name (1)" when the name is taken – or always, when set. */
        var renameDedupes = false
        val log = ArrayList<String>()

        init {
            nodes["root"] = Node("root", "Sync", null, true)
        }

        private fun check() {
            if (!granted) throw SecurityException("Permission Denial: reading the tree")
        }

        override fun accessible(): Boolean = granted && rootPresent
        override fun rootName(): String? = "Sync"
        override fun rootId(): String = "root"

        override fun findChild(parentId: String, name: String): SyncTree.Entry? {
            check()
            return nodes.values.firstOrNull { it.parent == parentId && it.name == name }?.let { SyncTree.Entry(it.id, it.name, it.isDirectory) }
        }

        override fun listChildren(parentId: String): List<SyncTree.Entry> {
            check()
            if (!nodes.containsKey(parentId)) throw java.io.FileNotFoundException(parentId)
            return nodes.values.filter { it.parent == parentId }.map { SyncTree.Entry(it.id, it.name, it.isDirectory) }
        }

        override fun createDirectory(parentId: String, name: String): SyncTree.Entry {
            check()
            val node = Node("d${++seq}", name, parentId, true)
            nodes[node.id] = node
            log.add("mkdir $name")
            return SyncTree.Entry(node.id, node.name, true)
        }

        override fun createFile(parentId: String, name: String): SyncTree.Entry {
            check()
            val node = Node("f${++seq}", name, parentId, false)
            nodes[node.id] = node
            log.add("create $name")
            return SyncTree.Entry(node.id, node.name, false)
        }

        override fun read(id: String): String {
            check()
            return nodes[id]?.text ?: throw java.io.FileNotFoundException(id)
        }

        override fun write(id: String, text: String) {
            check()
            val node = nodes[id] ?: throw java.io.FileNotFoundException(id)
            node.text = text
            log.add("write ${node.name}")
        }

        override fun rename(id: String, newName: String): SyncTree.Entry {
            check()
            if (renameFails) throw IOException("rename unsupported")
            val node = nodes[id] ?: throw java.io.FileNotFoundException(id)
            val taken = nodes.values.any { it.parent == node.parent && it.name == newName && it.id != id }
            node.name = if (renameDedupes || taken) "$newName (1)" else newName
            log.add("rename ${node.name}")
            return SyncTree.Entry(node.id, node.name, node.isDirectory)
        }

        override fun delete(id: String) {
            check()
            val node = nodes.remove(id) ?: throw java.io.FileNotFoundException(id)
            nodes.values.filter { it.parent == id }.forEach { nodes.remove(it.id) }
            log.add("delete ${node.name}")
        }

        fun names(parentId: String): List<String> = nodes.values.filter { it.parent == parentId }.map { it.name }
        fun dirId(): String? = nodes.values.firstOrNull { it.parent == "root" && it.name == SyncFolder.DIR_NAME }?.id
    }

    @Test
    fun anEmptyTreeListsNothingAndReadsNull() {
        val folder = SyncFolder(FakeTree())
        assertEquals(emptyList<String>(), folder.list())
        assertNull(folder.read("device_a.zensync"))
        folder.remove("device_a.zensync")
        folder.removeAll()
    }

    @Test
    fun theFirstWriteCreatesTheSyncDirectoryAndTheDocument() {
        val tree = FakeTree()
        val folder = SyncFolder(tree)
        folder.write("device_a.zensync", "{\"deviceId\":\"a\"}")
        assertEquals(listOf(SyncFolder.DIR_NAME), tree.names("root"))
        assertEquals(listOf("device_a.zensync"), folder.list())
        assertEquals("{\"deviceId\":\"a\"}", folder.read("device_a.zensync"))
        assertEquals("Sync", folder.folderName())
    }

    @Test
    fun aWriteGoesThroughATemporaryDocumentAndReplacesTheOldOne() {
        val tree = FakeTree()
        val folder = SyncFolder(tree)
        folder.write("README.txt", "one")
        folder.write("README.txt", "two")
        assertEquals("two", folder.read("README.txt"))
        assertEquals(listOf("README.txt"), tree.names(tree.dirId()!!))
        // The text landed in a temporary document, the old one went, the temporary one took its name.
        val creates = tree.log.withIndex().filter { it.value.startsWith("create README.txt.tmp-") }.map { it.index }
        assertEquals(tree.log.toString(), 2, creates.size)
        val second = tree.log.drop(creates[1])
        assertTrue(second.toString(), second[1].startsWith("write README.txt.tmp-"))
        assertTrue(second.toString(), second.indexOf("delete README.txt") < second.indexOf("rename README.txt"))
        assertEquals(second.toString(), "rename README.txt", second.last())
        assertEquals("two", folder.read("README.txt"))
    }

    @Test
    fun aProviderThatWillNotRenameStillEndsWithTheRightContentUnderTheRightName() {
        val tree = FakeTree().apply { renameFails = true }
        val folder = SyncFolder(tree)
        folder.write("device_a.zensync", "first")
        folder.write("device_a.zensync", "second")
        assertEquals("second", folder.read("device_a.zensync"))
        assertEquals(listOf("device_a.zensync"), tree.names(tree.dirId()!!))
    }

    @Test
    fun aProviderThatDedupesNamesOnRenameIsCaughtByTheReadBack() {
        val tree = FakeTree().apply { renameDedupes = true }
        val folder = SyncFolder(tree)
        folder.write("device_a.zensync", "payload")
        assertEquals("payload", folder.read("device_a.zensync"))
        assertEquals(listOf("device_a.zensync"), tree.names(tree.dirId()!!))
        assertEquals(listOf("device_a.zensync"), folder.list())
    }

    @Test
    fun temporaryDocumentsNeverShowInTheListingAndStaleOnesAreSwept() {
        val tree = FakeTree()
        val folder = SyncFolder(tree)
        folder.write("device_a.zensync", "a")
        val dir = tree.dirId()!!
        tree.createFile(dir, "device_a.zensync.tmp-stale")
        assertEquals(listOf("device_a.zensync"), folder.list())
        folder.write("device_a.zensync", "a2")
        assertEquals(listOf("device_a.zensync"), tree.names(dir))
    }

    @Test
    fun removeAndRemoveAll() {
        val tree = FakeTree()
        val folder = SyncFolder(tree)
        folder.write("device_a.zensync", "a")
        folder.write("device_b.zensync", "b")
        folder.remove("device_a.zensync")
        assertEquals(listOf("device_b.zensync"), folder.list())
        folder.remove("device_a.zensync")
        folder.removeAll()
        assertEquals(emptyList<String>(), tree.names("root"))
        assertEquals(emptyList<String>(), folder.list())
    }

    @Test
    fun aRevokedPermissionIsReportedAsTheFolderBeingLostNotAsACrash() {
        val tree = FakeTree()
        val folder = SyncFolder(tree)
        folder.write("device_a.zensync", "a")
        tree.granted = false
        assertThrows(SyncFolder.FolderLostException::class.java) { folder.list() }
        assertThrows(SyncFolder.FolderLostException::class.java) { folder.read("device_a.zensync") }
        assertThrows(SyncFolder.FolderLostException::class.java) { folder.write("device_a.zensync", "b") }
        assertThrows(SyncFolder.FolderLostException::class.java) { folder.remove("device_a.zensync") }
        assertThrows(SyncFolder.FolderLostException::class.java) { folder.removeAll() }
        assertThrows(SyncFolder.FolderLostException::class.java) { folder.folderName() }
        // Granted again (the user re-picked the same tree): back to normal, nothing lost.
        tree.granted = true
        assertEquals("a", folder.read("device_a.zensync"))
    }

    @Test
    fun aDeletedRootIsLostToo() {
        val tree = FakeTree().apply { rootPresent = false }
        assertThrows(SyncFolder.FolderLostException::class.java) { SyncFolder(tree).list() }
    }

    @Test
    fun namesWithPathPiecesAreRefused() {
        val folder = SyncFolder(FakeTree())
        assertThrows(IllegalArgumentException::class.java) { folder.read("../state.json") }
        assertThrows(IllegalArgumentException::class.java) { folder.write("a/b", "x") }
        assertFalse(SyncFolder.isTemp("device_a.zensync"))
        assertTrue(SyncFolder.isTemp("device_a.zensync.tmp-x1"))
        assertEquals("folder-lost:", SyncFolder.LOST_PREFIX)
    }
}
