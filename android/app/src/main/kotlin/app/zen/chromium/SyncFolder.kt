package app.zen.chromium

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import java.io.FileNotFoundException
import java.io.IOException
import java.security.SecureRandom

/**
 * The sync folder on Android: the document tree the user picked through the Storage Access
 * Framework (`ACTION_OPEN_DOCUMENT_TREE`, a persisted URI permission), with the `zenium-sync`
 * child directory the devices' files live in – the same layout the desktop keeps under a
 * cloud-drive folder. The chrome's `AndroidSyncTransport` (`src/android/sync.ts`) calls
 * `sync.list` / `read` / `write` / `remove` / `removeAll` here; the engine in the core does the
 * rest, the Kotlin side never sees a record.
 *
 * Writes are atomic for a reader (another device's sync client uploading the folder): the text
 * goes into a temporary document first, then the old file is dropped and the temporary one
 * renamed into place; a provider that will not rename falls back to writing in place and
 * reading back. A tree whose permission is gone (revoked in the system settings, the folder
 * deleted, the SD card removed) makes every operation throw [FolderLostException]; the host
 * answers the chrome with a `folder-lost:` rejection and `SyncStatus.folderLost` follows.
 *
 * The document-tree operations sit behind [SyncTree] so `SyncFolderTest` runs the logic against
 * an in-memory tree; [SafTree] is the DocumentsContract implementation.
 */
class SyncFolder(private val tree: SyncTree) {
    /** A document in the sync directory could not be reached because the tree itself is gone. */
    class FolderLostException(message: String) : IOException(message)

    /** Names of the documents in `zenium-sync`; empty before the first write created it. */
    fun list(): List<String> {
        val dir = syncDir(create = false) ?: return emptyList()
        return tree.listChildren(dir.id).filter { !it.isDirectory && !isTemp(it.name) }.map { it.name }
    }

    /** A document's text, or null when it does not exist. */
    fun read(name: String): String? {
        checkName(name)
        val dir = syncDir(create = false) ?: return null
        val entry = tree.findChild(dir.id, name) ?: return null
        if (entry.isDirectory) return null
        return guard { tree.read(entry.id) }
    }

    /** Create or replace a document so that no reader ever sees a half-written file. */
    fun write(name: String, text: String) {
        checkName(name)
        val dir = syncDir(create = true) ?: throw FolderLostException("the sync folder cannot be created")
        // A temporary document an earlier write left behind (the process died mid-write) goes first.
        for (stale in guard { tree.listChildren(dir.id) }) {
            if (!stale.isDirectory && stale.name.startsWith("$name$TEMP_INFIX")) runCatching { tree.delete(stale.id) }
        }
        val tempName = "$name$TEMP_INFIX${SecureRandom().nextInt(0x7fffffff).toString(36)}"
        val temp = guard { tree.createFile(dir.id, tempName) }
        try {
            guard { tree.write(temp.id, text) }
            val existing = tree.findChild(dir.id, name)
            if (existing != null && !existing.isDirectory) guard { tree.delete(existing.id) }
            val renamed = guard { runCatching { tree.rename(temp.id, name) }.getOrNull() }
            if (renamed != null && renamed.name == name) return
            // The provider would not rename (or renamed to "name (1)"): write in place, read back.
            renamed?.let { guard { tree.delete(it.id) } } ?: guard { tree.delete(temp.id) }
            val target = tree.findChild(dir.id, name)?.takeIf { !it.isDirectory } ?: guard { tree.createFile(dir.id, name) }
            guard { tree.write(target.id, text) }
            val back = guard { tree.read(target.id) }
            if (back != text) throw IOException("the sync folder did not keep what was written to $name")
        } catch (e: Exception) {
            runCatching { tree.findChild(dir.id, tempName)?.let { tree.delete(it.id) } }
            throw e
        }
    }

    /** Delete a document; a missing one is not an error. */
    fun remove(name: String) {
        checkName(name)
        val dir = syncDir(create = false) ?: return
        val entry = tree.findChild(dir.id, name) ?: return
        if (!entry.isDirectory) guard { tree.delete(entry.id) }
    }

    /** Delete the whole `zenium-sync` directory (the user turned sync off and wiped the shared copy). */
    fun removeAll() {
        val dir = syncDir(create = false) ?: return
        guard { tree.delete(dir.id) }
    }

    /** The picked folder's display name, for the status line (a tree URI is not for reading). */
    fun folderName(): String = guard { tree.rootName() } ?: ""

    private fun syncDir(create: Boolean): SyncTree.Entry? {
        val root = guard { tree.rootId() }
        val existing = guard { tree.findChild(root, DIR_NAME) }
        if (existing != null) {
            if (existing.isDirectory) return existing
            throw IOException("$DIR_NAME in the sync folder is a file")
        }
        if (!create) return null
        return guard { tree.createDirectory(root, DIR_NAME) }
    }

    private fun <T> guard(block: () -> T): T {
        if (!tree.accessible()) throw FolderLostException("the sync folder's permission is gone")
        return try {
            block()
        } catch (e: SecurityException) {
            throw FolderLostException(e.message ?: "the sync folder's permission is gone")
        } catch (e: FileNotFoundException) {
            if (!tree.accessible()) throw FolderLostException(e.message ?: "the sync folder is gone")
            throw e
        }
    }

    private fun checkName(name: String) {
        if (name.isEmpty() || name == "." || name == ".." || name.contains('/') || name.contains('\\'))
            throw IllegalArgumentException("invalid sync document name: $name")
    }

    companion object {
        const val DIR_NAME = "zenium-sync"
        /** The chrome sees this prefix on a rejection and reports the folder as lost. */
        const val LOST_PREFIX = "folder-lost:"
        private const val TEMP_INFIX = ".tmp-"

        fun isTemp(name: String): Boolean = name.contains(TEMP_INFIX)
    }
}

/** The operations `SyncFolder` needs of a document tree, on plain ids (the SAF document ids). */
interface SyncTree {
    data class Entry(val id: String, val name: String, val isDirectory: Boolean)

    /** The tree is granted and its root still exists. */
    fun accessible(): Boolean
    /** The picked folder's display name, or null when the provider does not say. */
    fun rootName(): String?
    fun rootId(): String
    fun findChild(parentId: String, name: String): Entry?
    fun listChildren(parentId: String): List<Entry>
    fun createDirectory(parentId: String, name: String): Entry
    fun createFile(parentId: String, name: String): Entry
    fun read(id: String): String
    fun write(id: String, text: String)
    /** Rename; the entry as the provider named it (a provider may pick "name (1)"). */
    fun rename(id: String, newName: String): Entry
    fun delete(id: String)
}

/** A document tree the user granted (`ACTION_OPEN_DOCUMENT_TREE`), over DocumentsContract. */
class SafTree(private val context: Context, private val treeUri: Uri) : SyncTree {
    private val resolver get() = context.contentResolver

    private fun docUri(id: String): Uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)

    override fun accessible(): Boolean {
        val granted = resolver.persistedUriPermissions.any {
            it.uri == treeUri && it.isReadPermission && it.isWritePermission
        }
        if (!granted) return false
        return runCatching {
            resolver.query(docUri(rootId()), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)
                ?.use { it.moveToFirst() } == true
        }.getOrDefault(false)
    }

    override fun rootName(): String? = runCatching {
        resolver.query(docUri(rootId()), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
        }
    }.getOrNull()

    override fun rootId(): String = DocumentsContract.getTreeDocumentId(treeUri)

    override fun findChild(parentId: String, name: String): SyncTree.Entry? =
        listChildren(parentId).firstOrNull { it.name == name }

    override fun listChildren(parentId: String): List<SyncTree.Entry> {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
        val out = ArrayList<SyncTree.Entry>()
        resolver.query(
            children,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            ),
            null, null, null
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                out.add(SyncTree.Entry(id, name, c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR))
            }
        } ?: throw FileNotFoundException("no such directory in the sync folder")
        return out
    }

    override fun createDirectory(parentId: String, name: String): SyncTree.Entry {
        val uri = DocumentsContract.createDocument(resolver, docUri(parentId), DocumentsContract.Document.MIME_TYPE_DIR, name)
            ?: throw IOException("could not create $name in the sync folder")
        return SyncTree.Entry(DocumentsContract.getDocumentId(uri), DownloadSink.queryDisplayName(context, uri) ?: name, true)
    }

    override fun createFile(parentId: String, name: String): SyncTree.Entry {
        val uri = DocumentsContract.createDocument(resolver, docUri(parentId), MIME, name)
            ?: throw IOException("could not create $name in the sync folder")
        return SyncTree.Entry(DocumentsContract.getDocumentId(uri), DownloadSink.queryDisplayName(context, uri) ?: name, false)
    }

    override fun read(id: String): String =
        resolver.openInputStream(docUri(id))?.use { it.readBytes().toString(Charsets.UTF_8) }
            ?: throw FileNotFoundException("could not open a sync document")

    override fun write(id: String, text: String) {
        // "wt": truncate, so a shorter text never leaves the old tail behind.
        resolver.openOutputStream(docUri(id), "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            ?: throw IOException("could not open a sync document for writing")
    }

    override fun rename(id: String, newName: String): SyncTree.Entry {
        val uri = DocumentsContract.renameDocument(resolver, docUri(id), newName)
            ?: throw IOException("the provider would not rename")
        return SyncTree.Entry(DocumentsContract.getDocumentId(uri), DownloadSink.queryDisplayName(context, uri) ?: newName, false)
    }

    override fun delete(id: String) {
        if (!DocumentsContract.deleteDocument(resolver, docUri(id))) throw IOException("could not delete a sync document")
    }

    companion object {
        private const val MIME = "application/json"
        private const val TAG = "ZenSync"

        /** The picked tree, kept across restarts: read and write for as long as the user grants it. */
        fun persist(context: Context, treeUri: Uri) {
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            }.onFailure { Log.w(TAG, "could not persist the sync folder's permission", it) }
        }
    }
}
