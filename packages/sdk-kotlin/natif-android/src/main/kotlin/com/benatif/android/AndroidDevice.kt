package com.benatif.android

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.StatFs
import com.benatif.DeviceProfile
import com.benatif.GpuInfo
import com.benatif.Platform
import kotlin.math.roundToLong

/**
 * Builds the device profile from what Android reports. Nothing here identifies a person:
 * model name, SoC, Android version, RAM and free storage, the same traits the other SDKs use.
 */
object AndroidDevice {
    fun detect(context: Context, modelsDir: java.io.File): DeviceProfile {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val free = runCatching {
            modelsDir.mkdirs()
            StatFs(modelsDir.path).availableBytes
        }.getOrNull()
        val (socVendor, socModel) = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MANUFACTURER to Build.SOC_MODEL else null to null
        return DeviceProfile(
            platform = Platform.ANDROID,
            os = "android ${Build.VERSION.RELEASE}",
            hardwareModel = Build.MODEL,
            // Inference runs on the CPU for now (no GPU backend compiled in). The SoC goes in the
            // gpu fields so device classes (deviceKey) still separate e.g. Tensor G3 from SD 8 Gen 3.
            gpu = GpuInfo(available = false, vendor = socVendor?.takeIf { it != Build.UNKNOWN }, architecture = socModel?.takeIf { it != Build.UNKNOWN }),
            memoryGB = (mem.totalMem / (1L shl 30).toDouble()).roundToLong().toDouble(),
            availableMemoryMB = mem.availMem / (1L shl 20).toDouble(),
            storageFreeBytes = free,
        )
    }
}
