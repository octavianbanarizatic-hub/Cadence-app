package dev.cadence.android

/**
 * The page draws behind the navigation bar, so sheets and the tab bar reach
 * the bottom edge (MainActivity). This holds the bar's height for the page,
 * which pads its bottom-most parts by it (`--nav-bottom` in phone.css).
 */
object SystemBars {
    /** In CSS pixels; 0 while the keyboard is up, when the app sits above it. */
    @Volatile
    var bottom = 0f
        private set

    /** Tells the page when the height changes, once it has loaded. */
    var onChange: ((Float) -> Unit)? = null

    fun update(pixels: Int, density: Float) {
        val css = pixels / density
        if (css == bottom) return
        bottom = css
        onChange?.invoke(css)
    }
}
