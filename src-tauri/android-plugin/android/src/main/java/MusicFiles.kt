package dev.cadence.android

import android.content.ContentResolver
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.io.File
import java.io.FileNotFoundException

/**
 * Music files the user picks in Android's file picker, to import into Cadence.
 * The picker hands out content:// links, which only Android can read, so
 * copying happens here; Rust then reads the copies like any library file.
 */
object MusicFiles {
    private fun entry(uri: Uri, name: String?, size: Long) =
        JSObject().put("uri", uri.toString()).put("name", name ?: "").put("size", size)

    /** Name and size of each picked file. */
    fun describe(resolver: ContentResolver, uris: List<Uri>): JSArray {
        val out = JSArray()
        for (uri in uris) {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) out.put(entry(uri, c.getString(0), if (c.isNull(1)) -1 else c.getLong(1)))
            }
        }
        return out
    }

    /** Every file in a picked folder and the folders inside it. */
    fun walk(resolver: ContentResolver, tree: Uri): JSArray {
        val out = JSArray()
        val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE)
        val pending = ArrayDeque(listOf(DocumentsContract.getTreeDocumentId(tree)))
        while (pending.isNotEmpty()) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, pending.removeFirst())
            resolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0)
                    if (c.getString(2) == Document.MIME_TYPE_DIR) pending.add(id)
                    else out.put(entry(DocumentsContract.buildDocumentUriUsingTree(tree, id), c.getString(1), if (c.isNull(3)) -1 else c.getLong(3)))
                }
            }
        }
        return out
    }

    fun copy(resolver: ContentResolver, uri: String, path: String) {
        val input = resolver.openInputStream(Uri.parse(uri)) ?: throw FileNotFoundException(uri)
        input.use { File(path).outputStream().use { out -> it.copyTo(out) } }
    }

    /** The cover embedded in a music file, for the lock screen and notification. */
    fun cover(path: String): ByteArray? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(path)
            retriever.embeddedPicture
        } catch (e: Exception) {
            null
        } finally {
            retriever.release()
        }
    }
}
