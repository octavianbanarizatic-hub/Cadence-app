package dev.cadence.android

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.widget.RemoteViews

/**
 * The home-screen widget: the playing song's cover, title and artist, with
 * previous, play/pause and next. It shows what the media session shows
 * ([Playback.update] redraws it); its buttons work like the notification's.
 */
class CadenceWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        update(context)
    }

    companion object {
        private var cover: Bitmap? = null
        private var coverOf: Bitmap? = null

        /** Redraws every Cadence widget on the home screen. */
        fun update(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, CadenceWidget::class.java))
            if (ids.isEmpty()) return
            manager.updateAppWidget(ids, views(context, Playback.cover()))
        }

        private fun views(context: Context, art: Bitmap?): RemoteViews {
            val state = Playback.state
            val views = RemoteViews(context.packageName, R.layout.cadence_widget)
            val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            views.setOnClickPendingIntent(R.id.widget_root, open)
            if (!state.active) {
                // Nothing playing (or Cadence isn't running): a tap anywhere opens it.
                views.setTextViewText(R.id.widget_title, "Cadence")
                views.setTextViewText(R.id.widget_artist, "Tap to open")
                views.setImageViewResource(R.id.widget_art, R.drawable.cadence_widget_mark)
                views.setImageViewResource(R.id.widget_play, R.drawable.cadence_widget_play)
                for (button in intArrayOf(R.id.widget_prev, R.id.widget_play, R.id.widget_next)) {
                    views.setOnClickPendingIntent(button, open)
                }
                return views
            }
            views.setTextViewText(R.id.widget_title, state.title)
            views.setTextViewText(R.id.widget_artist, state.artist)
            val rounded = art?.let { rounded(it) }
            if (rounded != null) views.setImageViewBitmap(R.id.widget_art, rounded) else views.setImageViewResource(R.id.widget_art, R.drawable.cadence_widget_mark)
            views.setImageViewResource(R.id.widget_play, if (state.playing) R.drawable.cadence_widget_pause else R.drawable.cadence_widget_play)
            views.setContentDescription(R.id.widget_play, if (state.playing) "Pause" else "Play")
            views.setOnClickPendingIntent(R.id.widget_prev, PlaybackService.intent(context, "prev"))
            views.setOnClickPendingIntent(R.id.widget_play, PlaybackService.intent(context, if (state.playing) "pause" else "play"))
            views.setOnClickPendingIntent(R.id.widget_next, PlaybackService.intent(context, "next"))
            return views
        }

        /** The cover with round corners (home screens can't clip a widget's images). */
        private fun rounded(art: Bitmap): Bitmap {
            if (coverOf === art) cover?.let { return it }
            // Small enough to pass to the home screen in one go.
            val size = 192
            val scaled = Bitmap.createScaledBitmap(art, size, size, true)
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
            Canvas(out).drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 24f, 24f, paint)
            cover = out
            coverOf = art
            return out
        }
    }
}
