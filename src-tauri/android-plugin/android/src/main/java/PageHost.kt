package dev.cadence.android

import android.content.Context
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * Holds the web view (MainActivity wraps it). The web view freezes a page that
 * is hidden and silent for about a minute and a half, and a frozen page can't
 * start its audio: Play on the lock screen would wait until the app is opened.
 * While [keepShown], the web view is told its window is still visible and
 * isn't paused, so the page keeps running. Everything here runs on the main thread.
 */
class PageHost(context: Context) : FrameLayout(context) {
    /** The app is in the background, and wry has paused the web view. */
    private var away = false

    var keepShown = false
        set(value) {
            if (field == value) return
            field = value
            dispatchWindowVisibilityChanged(windowVisibility)
            if (away) webView?.let { if (value) it.onResume() else it.onPause() }
        }

    private val webView: WebView?
        get() = getChildAt(0) as? WebView

    init {
        current = this
    }

    /** Called right after wry pauses the web view (the activity's onPause). */
    fun onAppPaused() {
        away = true
        if (keepShown) webView?.onResume()
    }

    fun onAppResumed() {
        away = false
    }

    override fun dispatchWindowVisibilityChanged(visibility: Int) {
        super.dispatchWindowVisibilityChanged(if (keepShown) VISIBLE else visibility)
    }

    companion object {
        var current: PageHost? = null
            private set
    }
}
