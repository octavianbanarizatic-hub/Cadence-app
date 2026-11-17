package dev.cadence.android

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat

/**
 * A foreground service while music plays: Android keeps the app (and its web
 * view, which plays the audio) running with the screen off. The notification
 * buttons also arrive here.
 */
class PlaybackService : Service() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started with startForegroundService, so this must come first, every time.
        ServiceCompat.startForeground(
            this,
            Playback.NOTIFICATION_ID,
            Playback.notification(this),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0,
        )
        when (val action = intent?.action) {
            null -> {}
            // The paused notification was swiped away: nothing left to show.
            "dismiss" -> {
                end()
                return START_NOT_STICKY
            }
            else -> Playback.send(action, intent.getDoubleExtra(EXTRA_ARG, Double.NaN).takeUnless { it.isNaN() })
        }
        if (!Playback.state.active) end() else if (!Playback.state.playing) linger() else main.removeCallbacks(release)
        return START_NOT_STICKY
    }

    /** Swiping the app away from recent apps stops the music, as users expect. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Playback.send("pause")
        end()
    }

    private val main = Handler(Looper.getMainLooper())
    private val release = Runnable { Playback.rest(this) }

    /**
     * Paused: stay in the foreground a while longer, so the controls keep
     * working. Without it, some phones (Xiaomi, for example) freeze the app,
     * and Play on the lock screen does nothing until the app is opened.
     */
    fun linger() {
        main.removeCallbacks(release)
        main.postDelayed(release, LINGER_MS)
    }

    fun end() {
        main.removeCallbacks(release)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        private const val LINGER_MS = 30 * 60 * 1000L
        private const val EXTRA_ARG = "arg"

        var instance: PlaybackService? = null
            private set

        /** A player command for this service to pass on to the page. */
        fun command(context: Context, action: String, arg: Double? = null): Intent =
            Intent(context, PlaybackService::class.java).setAction(action).also { i -> arg?.let { i.putExtra(EXTRA_ARG, it) } }

        /** A notification button: starts (or reaches) this service with [action]. */
        fun intent(context: Context, action: String): PendingIntent {
            val intent = command(context, action)
            val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PendingIntent.getForegroundService(context, action.hashCode(), intent, flags)
            } else {
                PendingIntent.getService(context, action.hashCode(), intent, flags)
            }
        }
    }
}
