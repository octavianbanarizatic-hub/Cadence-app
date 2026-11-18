package dev.cadence.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Xml
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Runs `Releases.check` in the background, with Cadence closed too. */
class ReleasesWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        Releases.check(applicationContext)
        return Result.success()
    }
}

/**
 * New release notifications. The page hands over who you follow (`watch`);
 * twice a day WorkManager wakes `check`, which looks at each followed artist's
 * releases on YouTube Music (the same browse call the Rust side makes) and at
 * each followed podcast's feed, and notifies about anything it hasn't seen.
 * The first look at an artist or podcast only remembers what's there.
 */
object Releases {
    private const val PREFS = "cadence-releases"
    private const val CHANNEL = "releases"
    private const val WORK = "cadence-releases"
    /** Cadence's share links; one for an album opens it in the app. */
    private const val LINK = "https://octavianbanarizatic-hub.github.io/c/"
    private const val CLIENT_VERSION = "1.20251020.01.00"
    /** Artists looked at per check, as the page does for Home. */
    private const val MAX_ARTISTS = 30

    /** `json` is `{ artists: [{id, name}], shows: [{id, title, feed}] }`. */
    fun watch(context: Context, json: String, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("watch", json)
            .putBoolean("on", on)
            .apply()
        val work = WorkManager.getInstance(context)
        if (!on) return run { work.cancelUniqueWork(WORK) }
        val request = PeriodicWorkRequestBuilder<ReleasesWorker>(12, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        // KEEP: a page update must not push the next check further away.
        work.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun check(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("on", false)) return
        val watch = JSONObject(prefs.getString("watch", null) ?: "{}")
        val known = JSONObject(prefs.getString("known", null) ?: "{}")
        val canNotify = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val artists = watch.optJSONArray("artists") ?: JSONArray()
        for (i in 0 until minOf(artists.length(), MAX_ARTISTS)) {
            val a = artists.getJSONObject(i)
            val id = a.optString("id")
            val name = a.optString("name")
            val releases = try { artistReleases(id) } catch (e: Exception) { continue }
            if (releases.isEmpty()) continue
            val key = "a:$id"
            val before = known.optJSONArray(key)
            if (before != null && canNotify) {
                val seen = (0 until before.length()).map { before.getString(it) }.toSet()
                // A few at most, newest first, should an artist put out many at once.
                releases.filter { it.first !in seen }.take(2).forEach { (albumId, title) ->
                    // quiet=1: the album opens without playing over whatever plays now.
                    val link = "$LINK?al=${enc(albumId)}&t=${enc(title)}&a=${enc(name)}&quiet=1"
                    notify(context, key + albumId, "New from $name", title, Intent(Intent.ACTION_VIEW, Uri.parse(link)))
                }
            }
            known.put(key, JSONArray(releases.map { it.first }))
        }
        val shows = watch.optJSONArray("shows") ?: JSONArray()
        for (i in 0 until shows.length()) {
            val s = shows.getJSONObject(i)
            val latest = try { latestEpisode(s.optString("feed")) } catch (e: Exception) { null }
            val (guid, title) = latest ?: continue
            val key = "p:${s.optString("id")}"
            val before = known.optString(key, "")
            if (before.isNotEmpty() && before != guid && canNotify) {
                // Home lists new episodes, so the notification just opens the app.
                val open = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: continue
                notify(context, key + guid, "New episode · ${s.optString("title")}", title, open)
            }
            known.put(key, guid)
        }
        prefs.edit().putString("known", known.toString()).apply()
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** An artist's albums and singles (id, title), as their page lists them, newest first. */
    private fun artistReleases(id: String): List<Pair<String, String>> {
        if (!id.startsWith("UC")) return emptyList()
        val body = JSONObject()
            .put("browseId", id)
            .put("context", JSONObject().put("client", JSONObject()
                .put("clientName", "WEB_REMIX")
                .put("clientVersion", CLIENT_VERSION)
                .put("hl", "en")
                .put("gl", "US")))
        val conn = URL("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Origin", "https://music.youtube.com")
        conn.setRequestProperty("Referer", "https://music.youtube.com/")
        conn.setRequestProperty("X-YouTube-Client-Name", "67")
        conn.setRequestProperty("X-YouTube-Client-Version", CLIENT_VERSION)
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val page = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val out = LinkedHashMap<String, String>()
            collect(page, out)
            return out.map { it.key to it.value }
        } finally {
            conn.disconnect()
        }
    }

    /** Every album or single card on the page: whatever shelf it sits on, it
     *  leads to an MPRE… album page. */
    private fun collect(node: Any?, out: MutableMap<String, String>) {
        when (node) {
            is JSONObject -> {
                node.optJSONObject("musicTwoRowItemRenderer")?.let { card ->
                    val browseId = card.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")?.optString("browseId").orEmpty()
                    val title = card.optJSONObject("title")?.optJSONArray("runs")?.optJSONObject(0)?.optString("text").orEmpty()
                    if (browseId.startsWith("MPRE") && title.isNotEmpty()) out.putIfAbsent(browseId, title)
                }
                node.keys().forEach { collect(node.opt(it), out) }
            }
            is JSONArray -> for (i in 0 until node.length()) collect(node.opt(i), out)
        }
    }

    /** A feed's newest episode: its guid (or audio link) and title. */
    private fun latestEpisode(feed: String): Pair<String, String>? {
        if (!feed.startsWith("http")) return null
        val conn = URL(feed).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        conn.setRequestProperty("User-Agent", "Cadence")
        try {
            val parser = Xml.newPullParser()
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
            conn.inputStream.use { stream ->
                parser.setInput(stream, null)
                var inItem = false
                var guid = ""
                var title = ""
                var audio = ""
                while (parser.next() != XmlPullParser.END_DOCUMENT) {
                    if (parser.eventType == XmlPullParser.START_TAG) {
                        when (parser.name) {
                            "item" -> inItem = true
                            "guid" -> if (inItem) guid = parser.nextText().trim()
                            "title" -> if (inItem && title.isEmpty()) title = parser.nextText().trim()
                            "enclosure" -> if (inItem) audio = parser.getAttributeValue(null, "url").orEmpty()
                        }
                    } else if (parser.eventType == XmlPullParser.END_TAG && parser.name == "item") {
                        val id = guid.ifEmpty { audio }
                        return if (id.isEmpty()) null else id to title
                    }
                }
            }
            return null
        } finally {
            conn.disconnect()
        }
    }

    private fun notify(context: Context, tag: String, title: String, text: String, intent: Intent) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "New releases", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "New songs and albums from artists you follow, and new podcast episodes"
            })
        }
        intent.setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val tap = PendingIntent.getActivity(context, tag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_cadence)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(tag.hashCode(), notification)
        } catch (e: SecurityException) {
            // Notifications were turned off since the check began.
        }
    }
}
