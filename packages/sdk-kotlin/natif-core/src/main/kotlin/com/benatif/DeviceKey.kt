package com.benatif

import java.security.MessageDigest
import kotlin.math.log2
import kotlin.math.pow
import kotlin.math.roundToLong

// Port of packages/sdk-core/src/device.ts. Must produce the same key as TS for the same traits,
// because the backend aggregates performance per device class with it.

private fun pow2Bucket(n: Double): Double = 2.0.pow(Math.round(log2(maxOf(n, 1.0))).toDouble())

/** Formats numbers like JavaScript's String(n) for the values used here. */
private fun jsNumber(d: Double): String = if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 1e15) d.roundToLong().toString() else d.toString()

/**
 * Traits that describe the *class* of device. Buckets keep it coarse so it can't fingerprint an
 * individual; aggregates are only used once n ≥ 20 per key.
 */
fun deviceClassTraits(d: DeviceProfile): Map<String, String> = mapOf(
    "platform" to d.platform.wire,
    "browser" to (d.browser?.let { "${it.name}/${it.major}" } ?: ""),
    "os" to (d.os ?: ""),
    "hw" to (d.hardwareModel ?: ""),
    "gpu" to d.gpu.available.toString(),
    "gpuVendor" to (d.gpu.vendor ?: ""),
    "gpuArch" to (d.gpu.architecture ?: ""),
    "f16" to (d.gpu.shaderF16 ?: false).toString(),
    "maxBufGB" to jsNumber(d.gpu.maxBufferSize?.takeIf { it > 0 }?.let { pow2Bucket(it / 2.0.pow(30)) } ?: 0.0),
    "memGB" to jsNumber(d.memoryGB?.takeIf { it > 0 }?.let { pow2Bucket(it) } ?: 0.0),
)

fun deviceKey(d: DeviceProfile): String {
    val traits = deviceClassTraits(d)
    val canonical = traits.keys.sorted().joinToString("|") { "$it=${traits[it]}" }
    val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }.take(24)
}
