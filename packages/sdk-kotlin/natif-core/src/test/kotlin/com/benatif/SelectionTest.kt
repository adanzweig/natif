package com.benatif

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

// Same cases as packages/sdk-core/test/selection.test.ts.
class SelectionTest {
    private val catalog = ModelCatalog.default.models
    private val webllm = ModelIdResolver { s, _ -> s.runtimes.webllm?.f16 }
    private fun input(device: DeviceProfile) = SelectModelInput(device, Capability.TEXT, catalog, webllm, 8.0)
    private fun picked(r: ModelSelection) = (r as? ModelSelection.Selected)?.spec?.id
    private fun reason(r: ModelSelection) = assertIs<ModelSelection.Rejected>(r).reason
    private fun bench(id: String, tps: Double) = BenchmarkResult(id, tps, 1, 0)

    @Test fun `catalog is loaded from the generated resource`() {
        assertEquals(listOf("qwen3-4b", "gemma-4-e2b", "qwen3-1.7b"), catalog.map { it.id })
        assertEquals(1.2, ModelCatalog.default.constants.storageHeadroom)
        assertEquals(4096.0, ModelCatalog.default.constants.unknownFreeMemoryCapMB)
        assertEquals(2_300_000_000, catalog[0].downloadBytes)
        assertEquals(true, catalog[0].disableThinking)
        assertEquals(null, catalog[1].runtimes.gguf) // gemma has no GGUF → native SDKs skip it
    }

    @Test fun `picks the best model that fits a high-end device`() = assertEquals("qwen3-4b", picked(selectModel(input(highEndWeb))))

    @Test fun `no WebGPU on web gives no_webgpu`() =
        assertEquals(FallbackReason.NO_WEBGPU, reason(selectModel(input(highEndWeb.copy(gpu = GpuInfo(false))))))

    @Test fun `4 GB of RAM steps down to the low tier`() =
        assertEquals("qwen3-1.7b", picked(selectModel(input(highEndWeb.copy(memoryGB = 4.0)))))

    @Test fun `2 GB of RAM gives insufficient_memory`() =
        assertEquals(FallbackReason.INSUFFICIENT_MEMORY, reason(selectModel(input(highEndWeb.copy(memoryGB = 2.0)))))

    @Test fun `unknown memory does not block`() =
        assertEquals("qwen3-4b", picked(selectModel(input(highEndWeb.copy(memoryGB = null)))))

    @Test fun `low storage blocks models that are not downloaded yet, but not cached ones`() {
        val device = highEndWeb.copy(storageFreeBytes = 1_000_000_000)
        assertEquals(FallbackReason.INSUFFICIENT_STORAGE, reason(selectModel(input(device))))
        assertEquals("qwen3-4b", picked(selectModel(input(device).copy(cached = setOf("Qwen3-4B-q4f16_1-MLC")))))
    }

    @Test fun `a slow local benchmark skips that model`() =
        assertEquals("gemma-4-e2b", picked(selectModel(input(highEndWeb).copy(benchmarks = mapOf("qwen3-4b" to bench("qwen3-4b", 3.0))))))

    @Test fun `all models slow gives benchmark_slow`() {
        val r = selectModel(input(highEndWeb).copy(benchmarks = catalog.associate { it.id to bench(it.id, 1.0) }))
        assertEquals(FallbackReason.BENCHMARK_SLOW, reason(r))
    }

    @Test fun `server recommendation marks a device class as slow and a local benchmark overrides it`() {
        val recommendation = DeviceRecommendation(mapOf("qwen3-4b" to ModelRecommendation(4.0)))
        val r1 = selectModel(input(highEndWeb).copy(recommendation = recommendation))
        assertEquals("gemma-4-e2b", picked(r1))
        assertEquals(FallbackReason.KNOWN_SLOW_DEVICE, r1.rejected["qwen3-4b"])
        val r2 = selectModel(input(highEndWeb).copy(recommendation = recommendation, benchmarks = mapOf("qwen3-4b" to bench("qwen3-4b", 30.0))))
        assertEquals("qwen3-4b", picked(r2))
    }

    @Test fun `preferred model goes first when it fits`() =
        assertEquals("gemma-4-e2b", picked(selectModel(input(highEndWeb).copy(preferredModel = "gemma-4-e2b"))))

    @Test fun `vision only matches multimodal models`() =
        assertEquals("gemma-4-e2b", picked(selectModel(input(highEndWeb).copy(capability = Capability.VISION))))

    @Test fun `native GGUF engine skips models without gguf`() {
        val gguf = ModelIdResolver { s, _ -> s.runtimes.gguf?.url }
        val android = DeviceProfile(Platform.ANDROID, memoryGB = 12.0, availableMemoryMB = 6000.0, storageFreeBytes = 50_000_000_000)
        val r = selectModel(SelectModelInput(android, Capability.VISION, catalog, gguf, 8.0))
        assertEquals(FallbackReason.NO_MODEL_FOR_CAPABILITY, reason(r))
        assertEquals("qwen3-4b", picked(selectModel(SelectModelInput(android, Capability.TEXT, catalog, gguf, 8.0))))
    }

    // decideRuntime
    private val yes = Consent(cloudFallback = true)
    private val no = Consent(cloudFallback = false)

    @Test fun `decideRuntime cases`() {
        assertEquals(RuntimeDecision.Device, decideRuntime(RuntimeMode.AUTO, yes, false, null))
        assertEquals(RuntimeDecision.Cloud(FallbackReason.NO_WEBGPU), decideRuntime(RuntimeMode.AUTO, yes, false, FallbackReason.NO_WEBGPU))
        assertEquals(RuntimeDecision.None(FallbackReason.NO_WEBGPU), decideRuntime(RuntimeMode.AUTO, no, false, FallbackReason.NO_WEBGPU))
        assertEquals(RuntimeDecision.None(FallbackReason.TIMEOUT), decideRuntime(RuntimeMode.AUTO, yes, true, FallbackReason.TIMEOUT))
        assertEquals(RuntimeDecision.None(FallbackReason.ENGINE_ERROR), decideRuntime(RuntimeMode.DEVICE_ONLY, yes, false, FallbackReason.ENGINE_ERROR))
        assertEquals(RuntimeDecision.Cloud(FallbackReason.FORCED_CLOUD), decideRuntime(RuntimeMode.CLOUD_ONLY, yes, false, null))
        assertEquals(RuntimeDecision.None(FallbackReason.FORCED_CLOUD), decideRuntime(RuntimeMode.CLOUD_ONLY, yes, true, null))
    }

    // memory budget (use what's free, not what's installed)
    @Test fun `64 GB machine with only 10 GB available still runs the 4B model`() =
        assertEquals("qwen3-4b", picked(selectModel(input(highEndWeb.copy(memoryGB = 64.0, availableMemoryMB = 10_240.0)))))

    @Test fun `only 4 GB available steps down to the small model`() =
        assertEquals("qwen3-1.7b", picked(selectModel(input(highEndWeb.copy(memoryGB = 64.0, availableMemoryMB = 4_096.0)))))

    @Test fun `only 2 GB available gives nothing local`() =
        assertEquals(FallbackReason.INSUFFICIENT_MEMORY, reason(selectModel(input(highEndWeb.copy(memoryGB = 64.0, availableMemoryMB = 2_048.0)))))

    @Test fun `the app's explicit budget wins`() =
        assertEquals("qwen3-1.7b", picked(selectModel(input(highEndWeb).copy(memoryBudgetMB = 2_500.0))))

    @Test fun `free memory unknown is capped at 4 GB`() {
        assertEquals(4096.0, memoryBudgetMB(highEndWeb.copy(memoryGB = 32.0)))
        assertEquals(4096.0, memoryBudgetMB(highEndWeb.copy(memoryGB = null)))
    }

    @Test fun `device key matches the TypeScript implementation`() {
        // Values computed with sdk-core's deviceKey() (dist/index.js) for the same profiles.
        assertEquals("bb6f863a7cafa596ee10aca5", deviceKey(highEndWeb))
        val android = DeviceProfile(Platform.ANDROID, os = "android 15", hardwareModel = "Pixel 8", gpu = GpuInfo(false), memoryGB = 8.0)
        assertEquals("229c0540e911d117cdf8a7ae", deviceKey(android))
    }
}
