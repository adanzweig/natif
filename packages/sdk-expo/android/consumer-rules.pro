# Called from C++ (JNI) by name: keep them through R8/ProGuard in the app's release build.
-keep class com.benatif.expo.NatifSD { *; }
-keep interface com.benatif.expo.NatifSD$StepListener { *; }
-keep class * implements com.benatif.expo.NatifSD$StepListener { *; }
