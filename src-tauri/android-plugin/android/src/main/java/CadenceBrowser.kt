package dev.cadence.android

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat.MediaItem
import android.support.v4.media.MediaDescriptionCompat
import androidx.media.MediaBrowserServiceCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Android Auto (and other media browsers allowed in [CALLERS]): lists Liked
 * songs and the playlists, read straight from Cadence's database, and plays
 * the song picked through the same media session as the lock screen.
 *
 * The music itself plays in the app's web view, so playing needs Cadence
 * running on the phone; Android Auto can start this service without it, and
 * then picking a song shows "Open Cadence on your phone" ([Playback.playItem]).
 */
class CadenceBrowser : MediaBrowserServiceCompat() {
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        sessionToken = Playback.ensureSession(this).sessionToken
    }

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
        // Only the car and the system see what's in the library.
        if (clientPackageName != packageName && clientPackageName !in CALLERS) return null
        return BrowserRoot(ROOT, null)
    }

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaItem>>) {
        result.detach()
        io.execute {
            val items = try {
                children(parentId)
            } catch (e: Exception) {
                mutableListOf()
            }
            result.sendResult(items)
        }
    }

    /**
     * The root shows two tabs, Liked songs and Playlists. Song ids say where
     * the song is ("liked", "pl:<id>"), its place there and its track id, so
     * the page can play that list from it (main.ts: playItem).
     */
    private fun children(parentId: String): MutableList<MediaItem> {
        val db = database(this) ?: return mutableListOf()
        return db.use {
            when {
                parentId == ROOT -> mutableListOf(
                    folder(LIKED, "Liked songs"),
                    folder(PLAYLISTS, "Playlists"),
                )
                parentId == LIKED -> songs(it, "SELECT data FROM liked ORDER BY added_at DESC", arrayOf(), "liked")
                parentId == PLAYLISTS -> {
                    val out = mutableListOf<MediaItem>()
                    it.rawQuery("SELECT id, name FROM playlists ORDER BY created_at DESC, id DESC", null).use { c ->
                        while (c.moveToNext()) out.add(folder("pl:${c.getLong(0)}", c.getString(1)))
                    }
                    out
                }
                parentId.startsWith("pl:") -> {
                    val id = parentId.removePrefix("pl:")
                    songs(it, "SELECT data FROM playlist_tracks WHERE playlist_id = ? ORDER BY position", arrayOf(id), parentId)
                }
                else -> mutableListOf()
            }
        }
    }

    private fun folder(id: String, title: String) = MediaItem(
        MediaDescriptionCompat.Builder().setMediaId(id).setTitle(title).build(),
        MediaItem.FLAG_BROWSABLE,
    )

    private fun songs(db: SQLiteDatabase, sql: String, args: Array<String>, list: String): MutableList<MediaItem> {
        val out = mutableListOf<MediaItem>()
        db.rawQuery(sql, args).use { c ->
            var i = 0
            while (c.moveToNext() && i < MAX_SONGS) {
                val track = JSONObject(c.getString(0))
                val id = track.optString("id")
                out.add(
                    MediaItem(
                        MediaDescriptionCompat.Builder()
                            .setMediaId("$list/$i/$id")
                            .setTitle(track.optString("title"))
                            .setSubtitle(track.optString("artist"))
                            .build(),
                        MediaItem.FLAG_PLAYABLE,
                    ),
                )
                i++
            }
        }
        return out
    }

    companion object {
        private const val ROOT = "root"
        private const val LIKED = "liked"
        private const val PLAYLISTS = "playlists"
        /** Android Auto lists only so many; long lists stop here. */
        private const val MAX_SONGS = 500
        private val CALLERS = setOf(
            "com.google.android.projection.gearhead",
            "com.google.android.carassistant",
            "com.android.systemui",
        )

        /** Cadence's database (Rust: db.rs), opened only for reading. */
        fun database(context: Context): SQLiteDatabase? {
            val file = listOf(context.dataDir, context.filesDir).map { File(it, "cadence.db") }.firstOrNull { it.exists() } ?: return null
            return try {
                SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY)
            } catch (e: Exception) {
                null
            }
        }
    }
}
