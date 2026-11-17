package dev.cadence.player

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.cadence.android.PageHost
import dev.cadence.android.SystemBars

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // The app is always dark, so the bars' icons stay light in light mode too.
    enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    // Keep the page clear of the status bar and the keyboard. It draws behind
    // the navigation bar, so sheets and the tabs reach the bottom edge, and
    // pads its bottom-most parts by the bar's height (SystemBars).
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      // With the keyboard up the page sits above it, clear of the bar too.
      val above = if (keyboard > bars.bottom) keyboard else 0
      view.setPadding(bars.left, bars.top, bars.right, above)
      SystemBars.update(if (above > 0) 0 else bars.bottom, resources.displayMetrics.density)
      WindowInsetsCompat.CONSUMED
    }
  }

  // wry adds the web view here; PageHost keeps the page running while music
  // is paused in the background.
  override fun setContentView(view: View?) {
    super.setContentView(PageHost(this).apply { addView(view) })
  }
}
