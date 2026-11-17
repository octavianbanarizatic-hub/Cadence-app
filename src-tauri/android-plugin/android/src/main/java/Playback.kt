package dev.cadence.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.InvokeArg
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** What the page is playing, sent on every track and play/pause change. */
@InvokeArg
class MediaArgs {
    var active: Boolean = false
    var title: String = ""
    var artist: String = ""
    var album: String? = null
    /**
     * An https cover URL, or the path of a music file with a cover inside;
     * the page's own media:// URLs are not reachable from here.
     */
    var art: String? = null
    var duration: Double? = null
    var position: Double = 0.0
    var playing: Boolean = false
}

/**
 * The media session behind the lock screen and notification controls. The
 * audio itself plays in the web view; presses on these controls go back to
 * the page through [onCommand]. Everything here runs on the main thread.
 */
object Playback {
    const val NOTIFICATION_ID = 1
    private const val CHANNEL = "playback"

    /** Set by the plugin: runs a player command ("play", "next", "seek", …) in the page. */
    var onCommand: ((String, Double?) -> Unit)? = null

    /**
     * Set by the plugin while the page runs: plays something picked in Android
     * Auto ("playItem", a [CadenceBrowser] id) or asked for by voice
     * ("playSearch", the words).
     */
    var onRequest: ((String, String) -> Unit)? = null

    var session: MediaSessionCompat? = null
        private set
    var state = MediaArgs()
        private set

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var art: Bitmap? = null
    private var artUrl: String? = null
    private var noisyRegistered = false

    fun send(command: String, arg: Double? = null) {
        onCommand?.invoke(command, arg)
    }

    /**
     * A press on the lock screen controls goes through the foreground service,
     * which wakes the whole app (web view included) if the phone had frozen it.
     */
    private fun press(context: Context, command: String, arg: Double? = null) {
        try {
            ContextCompat.startForegroundService(context, PlaybackService.command(context, command, arg))
        } catch (e: Exception) {
            send(command, arg)
        }
    }

    fun ensureSession(context: Context): MediaSessionCompat =
        session ?: MediaSessionCompat(context.applicationContext, "Cadence").also { s ->
            val app = context.applicationContext
            s.setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = press(app, "play")
                override fun onPause() = press(app, "pause")
                override fun onStop() = press(app, "pause")
                override fun onSkipToNext() = press(app, "next")
                override fun onSkipToPrevious() = press(app, "prev")
                override fun onSeekTo(pos: Long) = press(app, "seek", pos / 1000.0)
                override fun onPlayFromMediaId(mediaId: String, extras: android.os.Bundle?) = request(app, "playItem", mediaId)
                override fun onPlayFromSearch(query: String?, extras: android.os.Bundle?) = request(app, "playSearch", query ?: "")
            })
            session = s
        }

    /**
     * Something to play from the car. Only the page can play, so with Cadence
     * closed the car says to open it (and the app is asked to open, which
     * Android allows only sometimes).
     */
    private fun request(context: Context, command: String, arg: String) {
        val run = onRequest
        if (run != null) return run(command, arg)
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
            try {
                context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                // Not allowed from the background.
            }
        }
        ensureSession(context).setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(PlaybackStateCompat.STATE_ERROR, 0, 0f)
                .setErrorMessage(PlaybackStateCompat.ERROR_CODE_APP_ERROR, "Open Cadence on your phone, then try again")
                .build(),
        )
    }

    fun update(context: Context, args: MediaArgs) {
        val app = context.applicationContext
        state = args
        if (!args.active) return stop(app)
        val s = ensureSession(app)
        s.isActive = true
        if (args.art != artUrl) loadArt(app, args.art)
        val meta = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, args.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, args.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, args.album ?: "")
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, ((args.duration ?: 0.0) * 1000).toLong())
        if (args.art == artUrl) art?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        s.setMetadata(meta.build())
        s.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_SEEK_TO or PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or
                        PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH,
                )
                .setState(
                    if (args.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                    (args.position * 1000).toLong(),
                    if (args.playing) 1f else 0f,
                )
                .build(),
        )
        watchNoisy(app)
        refresh(app)
        CadenceWidget.update(app)
    }

    /** The playing song's cover, once it has loaded. */
    fun cover(): Bitmap? = if (state.art == artUrl) art else null

    /** Playing: run the foreground service, which keeps the app alive. Paused:
     *  the service stays in the foreground and the page keeps running for a
     *  while ([PlaybackService.linger]), then the controls go away ([rest]). */
    private fun refresh(context: Context) {
        val notification = notification(context)
        // Playing, the page is never frozen (it's audible).
        PageHost.current?.keepShown = !state.playing
        if (state.playing) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
                return
            } catch (e: Exception) {
                // Android refuses to start foreground services from the background
                // in some cases; the notification below still shows the controls.
            }
        }
        PlaybackService.instance?.linger()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // Notifications turned off for the app.
        }
    }

    /**
     * Paused for long: the controls go away and the page may be frozen again,
     * as Play there would not work any more. The next song or play brings them back.
     */
    fun rest(context: Context) {
        if (state.playing) return
        stop(context)
    }

    fun stop(context: Context) {
        PageHost.current?.keepShown = false
        session?.isActive = false
        PlaybackService.instance?.end()
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        CadenceWidget.update(context)
    }

    fun notification(context: Context): android.app.Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "What's playing, with play, pause and skip"
                        setShowBadge(false)
                    },
                )
            }
        }
        val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
            PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_cadence)
            .setContentTitle(state.title)
            .setContentText(state.artist)
            .setLargeIcon(if (state.art == artUrl) art else null)
            .setContentIntent(open)
            .setDeleteIntent(PlaybackService.intent(context, "dismiss"))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(state.playing)
            .addAction(android.R.drawable.ic_media_previous, "Previous", PlaybackService.intent(context, "prev"))
            .addAction(
                if (state.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (state.playing) "Pause" else "Play",
                PlaybackService.intent(context, if (state.playing) "pause" else "play"),
            )
            .addAction(android.R.drawable.ic_media_next, "Next", PlaybackService.intent(context, "next"))
        session?.let {
            builder.setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(it.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2),
            )
        }
        return builder.build()
    }

    /** Downloads the cover once per song, then shows it in the controls. */
    private fun loadArt(context: Context, url: String?) {
        art = null
        artUrl = url
        if (url == null) return
        io.execute {
            val bitmap = try {
                if (url.startsWith("/")) {
                    // A path is one of the user's music files, with its cover inside.
                    MusicFiles.cover(url)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                } else {
                    val conn = URL(url).openConnection() as HttpURLConnection
                    conn.connectTimeout = 10_000
                    conn.readTimeout = 10_000
                    conn.inputStream.use { BitmapFactory.decodeStream(it) }
                }
            } catch (e: Exception) {
                null
            }
            main.post {
                // Only if the song hasn't changed in the meantime.
                if (bitmap != null && artUrl == url) {
                    art = Bitmap.createScaledBitmap(bitmap, 512, 512 * bitmap.height / bitmap.width.coerceAtLeast(1), true)
                    update(context, state)
                }
            }
        }
    }

    /** Pauses when wired headphones are unplugged or Bluetooth disconnects. */
    private fun watchNoisy(context: Context) {
        if (noisyRegistered) return
        noisyRegistered = true
        ContextCompat.registerReceiver(
            context,
            object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    if (state.playing) send("pause")
                }
            },
            IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }
}
