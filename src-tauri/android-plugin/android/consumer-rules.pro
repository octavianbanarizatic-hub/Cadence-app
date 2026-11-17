# Tauri finds plugin classes and commands by reflection.
-keep class dev.cadence.android.** { *; }
-keep class com.yausername.** { *; }
# youtubedl-android unpacks Python with Commons Compress, which looks up its
# zip extra-field classes by reflection.
-keep class org.apache.commons.compress.** { *; }
-dontwarn org.apache.commons.compress.**
