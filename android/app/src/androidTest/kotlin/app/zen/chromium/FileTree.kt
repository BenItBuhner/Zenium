package app.zen.chromium

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/**
 * A sync folder that is a plain directory: [SyncTree] over `java.io.File`, for the drivers that
 * need the engine's sync on the emulator without a granted document tree (the shell may not
 * issue a SAF grant, and neither may root: the system refuses to hand out URI permissions on
 * its own behalf), set on `Host.syncTreeOverride` (debug builds only). Ids are paths relative
 * to the root ("" for the root itself), so a document's id names it the way the SAF ids name
 * theirs; a driver writes another device's documents with plain files beside the engine's.
 */
class FileTree(private val root: File) : SyncTree {
    init {
        root.mkdirs()
    }

    override fun accessible(): Boolean = root.isDirectory

    override fun rootName(): String = root.name

    override fun rootId(): String = ""

    private fun file(id: String): File = if (id.isEmpty()) root else File(root, id)

    private fun entry(file: File): SyncTree.Entry =
        SyncTree.Entry(file.relativeTo(root).path, file.name, file.isDirectory)

    override fun findChild(parentId: String, name: String): SyncTree.Entry? =
        File(file(parentId), name).takeIf { it.exists() }?.let(::entry)

    override fun listChildren(parentId: String): List<SyncTree.Entry> {
        val dir = file(parentId)
        if (!dir.isDirectory) throw FileNotFoundException("no such directory in the sync folder: $parentId")
        return (dir.listFiles() ?: emptyArray()).sortedBy { it.name }.map(::entry)
    }

    override fun createDirectory(parentId: String, name: String): SyncTree.Entry {
        val dir = File(file(parentId), name)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("could not create $name in the sync folder")
        return entry(dir)
    }

    override fun createFile(parentId: String, name: String): SyncTree.Entry {
        val f = File(file(parentId), name)
        if (!f.exists()) f.writeText("")
        return entry(f)
    }

    override fun read(id: String): String {
        val f = file(id)
        if (!f.isFile) throw FileNotFoundException("could not open a sync document: $id")
        return f.readText()
    }

    override fun write(id: String, text: String) {
        file(id).writeText(text)
    }

    override fun rename(id: String, newName: String): SyncTree.Entry {
        val from = file(id)
        val to = File(from.parentFile ?: root, newName)
        if (!from.renameTo(to)) throw IOException("could not rename $id to $newName")
        return entry(to)
    }

    override fun delete(id: String) {
        if (!file(id).deleteRecursively()) throw IOException("could not delete $id")
    }
}
