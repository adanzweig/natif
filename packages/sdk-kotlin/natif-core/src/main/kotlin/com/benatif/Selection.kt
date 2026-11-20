package com.benatif

// Exact port of packages/sdk-core/src/selection.ts.

/**
 * How much memory (MB) a model may use on this device, so we never slow the user's device down.
 * Order: what the app says → what the OS says is available → a share of the total → unknown.
 */
fun memoryBudgetMB(device: DeviceProfile, override: Double? = null, constants: SelectionConstants = ModelCatalog.default.constants): Double {
    if (override != null) return override
    device.availableMemoryMB?.let { return it * constants.availableMemoryShare }
    // Without real free memory, never assume more than a safe cap.
    device.memoryGB?.let { return minOf(it * 1024 * constants.totalMemoryShare, constants.unknownFreeMemoryCapMB) }
    return constants.unknownFreeMemoryCapMB
}

data class ModelRecommendation(val p50DecodeTokPerSec: Double, val loadFailRate: Double? = null)

/** Aggregated from anonymous telemetry of devices in the same class (n ≥ 20). */
data class DeviceRecommendation(val models: Map<String, ModelRecommendation>)

/** The part of a [TextEngine] selection needs. */
fun interface ModelIdResolver {
    fun resolveModelId(spec: ModelSpec, device: DeviceProfile): String?
}

data class SelectModelInput(
    val device: DeviceProfile,
    val capability: Capability,
    val catalog: List<ModelSpec>,
    val engine: ModelIdResolver,
    val minDeviceTokPerSec: Double,
    /** Engine model ids already downloaded (storage check is skipped for them). */
    val cached: Set<String> = emptySet(),
    val benchmarks: Map<String, BenchmarkResult> = emptyMap(),
    val recommendation: DeviceRecommendation? = null,
    /** Task or app preference; tried first if it fits. */
    val preferredModel: String? = null,
    /** Max memory (MB) a model may use; overrides what is derived from the device. */
    val memoryBudgetMB: Double? = null,
    val constants: SelectionConstants = ModelCatalog.default.constants,
)

sealed interface ModelSelection {
    val rejected: Map<String, FallbackReason>

    data class Selected(val spec: ModelSpec, val engineModelId: String, override val rejected: Map<String, FallbackReason>) : ModelSelection
    data class Rejected(val reason: FallbackReason, override val rejected: Map<String, FallbackReason>) : ModelSelection
}

/** When every candidate is rejected, report the reason that best explains it. */
private val REASON_PRIORITY = listOf(
    FallbackReason.BENCHMARK_SLOW,
    FallbackReason.KNOWN_SLOW_DEVICE,
    FallbackReason.INSUFFICIENT_MEMORY,
    FallbackReason.INSUFFICIENT_STORAGE,
    FallbackReason.NO_MODEL_FOR_CAPABILITY,
)

/** Pure: picks the best model this device can run for a capability, or explains why none. */
fun selectModel(input: SelectModelInput): ModelSelection {
    val device = input.device
    val rejected = linkedMapOf<String, FallbackReason>()

    if (device.platform == Platform.WEB && !device.gpu.available) {
        return ModelSelection.Rejected(FallbackReason.NO_WEBGPU, rejected)
    }

    val candidates = input.catalog
        .filter { input.capability in it.capabilities }
        .sortedWith { a, b ->
            when {
                a.id == input.preferredModel -> -1
                b.id == input.preferredModel -> 1
                else -> b.quality - a.quality
            }
        }

    val budget = memoryBudgetMB(device, input.memoryBudgetMB, input.constants)
    for (spec in candidates) {
        val engineModelId = input.engine.resolveModelId(spec, device)
        if (engineModelId == null) {
            rejected[spec.id] = FallbackReason.NO_MODEL_FOR_CAPABILITY
            continue
        }
        if (spec.memoryRequiredMB > budget) {
            rejected[spec.id] = FallbackReason.INSUFFICIENT_MEMORY
            continue
        }
        val isCached = engineModelId in input.cached
        val free = device.storageFreeBytes
        if (!isCached && free != null && free < spec.downloadBytes * input.constants.storageHeadroom) {
            rejected[spec.id] = FallbackReason.INSUFFICIENT_STORAGE
            continue
        }
        val bench = input.benchmarks[spec.id]
        if (bench != null && bench.decodeTokPerSec < input.minDeviceTokPerSec) {
            rejected[spec.id] = FallbackReason.BENCHMARK_SLOW
            continue
        }
        val rec = input.recommendation?.models?.get(spec.id)
        if (bench == null && rec != null && rec.p50DecodeTokPerSec < input.minDeviceTokPerSec) {
            rejected[spec.id] = FallbackReason.KNOWN_SLOW_DEVICE
            continue
        }
        return ModelSelection.Selected(spec, engineModelId, rejected)
    }

    val reasons = rejected.values.toSet()
    val reason = REASON_PRIORITY.firstOrNull { it in reasons } ?: FallbackReason.NO_MODEL_FOR_CAPABILITY
    return ModelSelection.Rejected(reason, rejected)
}

sealed interface RuntimeDecision {
    data object Device : RuntimeDecision
    data class Cloud(val reason: FallbackReason) : RuntimeDecision
    data class None(val reason: FallbackReason) : RuntimeDecision
}

/**
 * Pure: given why the device can't (or null if it can), decide where to run.
 * A device-only project never reaches the cloud, whatever the client asks.
 */
fun decideRuntime(mode: RuntimeMode, consent: Consent, taskDeviceOnly: Boolean, deviceFailure: FallbackReason?): RuntimeDecision {
    val cloudAllowed = consent.cloudFallback && !taskDeviceOnly && mode != RuntimeMode.DEVICE_ONLY
    if (mode == RuntimeMode.CLOUD_ONLY) {
        return if (cloudAllowed) RuntimeDecision.Cloud(FallbackReason.FORCED_CLOUD) else RuntimeDecision.None(FallbackReason.FORCED_CLOUD)
    }
    if (deviceFailure == null) return RuntimeDecision.Device
    return if (cloudAllowed) RuntimeDecision.Cloud(deviceFailure) else RuntimeDecision.None(deviceFailure)
}
