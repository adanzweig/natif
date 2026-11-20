import Testing
@testable import Natif

// Same cases as packages/sdk-core/test/selection.test.ts.
private let catalog = ModelCatalog.bundled.models
private let webllm: @Sendable (ModelSpec, DeviceProfile) -> String? = { s, _ in s.runtimes.webllm?.f16 }
private func sel(_ device: DeviceProfile, _ f: (inout SelectModelInput) -> Void = { _ in }) -> ModelSelection {
    var input = SelectModelInput(device: device, resolveModelId: webllm, minDeviceTokPerSec: 8)
    f(&input)
    return selectModel(input)
}
private func bench(_ id: String, _ tps: Double) -> BenchmarkResult { .init(modelId: id, decodeTokPerSec: tps, ttftMs: 1, at: 0) }

@Suite struct SelectModelTests {
    @Test func picksBestModelForHighEndDevice() { #expect(sel(highEndWeb).spec?.id == "qwen3-4b") }

    @Test func noWebGPU() {
        var d = highEndWeb; d.gpu = .init(available: false)
        #expect(sel(d).reason == .noWebgpu)
    }

    @Test func fourGBStepsDownToLowTier() {
        var d = highEndWeb; d.memoryGB = 4
        #expect(sel(d).spec?.id == "qwen3-1.7b")
    }

    @Test func twoGBInsufficientMemory() {
        var d = highEndWeb; d.memoryGB = 2
        #expect(sel(d).reason == .insufficientMemory)
    }

    @Test func unknownMemoryDoesNotBlock() {
        var d = highEndWeb; d.memoryGB = nil
        #expect(sel(d).spec?.id == "qwen3-4b")
    }

    @Test func lowStorageBlocksUncachedButNotCached() {
        var d = highEndWeb; d.storageFreeBytes = 1e9
        #expect(sel(d).reason == .insufficientStorage)
        #expect(sel(d) { $0.cached = ["Qwen3-4B-q4f16_1-MLC"] }.spec?.id == "qwen3-4b")
    }

    @Test func slowLocalBenchmarkSkipsModel() {
        #expect(sel(highEndWeb) { $0.benchmarks = ["qwen3-4b": bench("qwen3-4b", 3)] }.spec?.id == "gemma-4-e2b")
    }

    @Test func allSlowBenchmarkSlow() {
        let r = sel(highEndWeb) { $0.benchmarks = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, bench($0.id, 1)) }) }
        #expect(r.reason == .benchmarkSlow)
    }

    @Test func recommendationMarksSlowAndLocalBenchmarkOverrides() {
        let rec = DeviceRecommendation(models: ["qwen3-4b": .init(p50DecodeTokPerSec: 4)])
        let r1 = sel(highEndWeb) { $0.recommendation = rec }
        #expect(r1.spec?.id == "gemma-4-e2b")
        #expect(r1.rejected["qwen3-4b"] == .knownSlowDevice)
        let r2 = sel(highEndWeb) { $0.recommendation = rec; $0.benchmarks = ["qwen3-4b": bench("qwen3-4b", 30)] }
        #expect(r2.spec?.id == "qwen3-4b")
    }

    @Test func preferredModelFirst() { #expect(sel(highEndWeb) { $0.preferredModel = "gemma-4-e2b" }.spec?.id == "gemma-4-e2b") }

    @Test func visionOnlyMultimodal() { #expect(sel(highEndWeb) { $0.capability = .vision }.spec?.id == "gemma-4-e2b") }

    // Native (GGUF) resolution: models without a gguf entry are skipped.
    @Test func ggufSkipsModelsWithoutGGUF() {
        var roomy = iPhone; roomy.availableMemoryMB = 8000
        let r = selectModel(SelectModelInput(device: roomy, resolveModelId: { s, _ in ggufModelId(s) },
                                             benchmarks: ["qwen3-4b": bench("qwen3-4b", 2)]))
        #expect(r.spec?.id == "qwen3-1.7b")
        #expect(r.rejected == ["qwen3-4b": .benchmarkSlow, "gemma-4-e2b": .noModelForCapability])
        if case .selected(_, let id, _) = r { #expect(id == "Qwen3-1.7B-Q8_0") } else { Issue.record("not selected") }
    }

    // os_proc_available_memory 5000 MB → budget 3000 MB: the 4B (3432 MB) doesn't fit, the 1.7B does.
    @Test func iPhoneBudgetFromAvailableMemory() {
        let r = selectModel(SelectModelInput(device: iPhone, resolveModelId: { s, _ in ggufModelId(s) }))
        #expect(r.spec?.id == "qwen3-1.7b")
        #expect(r.rejected["qwen3-4b"] == .insufficientMemory)
        var roomy = iPhone; roomy.availableMemoryMB = 6000
        #expect(selectModel(SelectModelInput(device: roomy, resolveModelId: { s, _ in ggufModelId(s) })).spec?.id == "qwen3-4b")
    }
}

@Suite struct MemoryBudgetTests {
    @Test func sixtyFourGBWithTenAvailableRuns4B() {
        var d = highEndWeb; d.memoryGB = 64; d.availableMemoryMB = 10_240
        #expect(sel(d).spec?.id == "qwen3-4b")
    }
    @Test func fourGBAvailableStepsDown() {
        var d = highEndWeb; d.memoryGB = 64; d.availableMemoryMB = 4_096
        #expect(sel(d).spec?.id == "qwen3-1.7b")
    }
    @Test func twoGBAvailableNothing() {
        var d = highEndWeb; d.memoryGB = 64; d.availableMemoryMB = 2_048
        #expect(sel(d).reason == .insufficientMemory)
    }
    @Test func explicitBudgetWins() { #expect(sel(highEndWeb) { $0.memoryBudgetMB = 2_500 }.spec?.id == "qwen3-1.7b") }
    @Test func webCappedAt4GB() {
        var d = highEndWeb; d.memoryGB = 32
        #expect(memoryBudgetMB(d) == 4096)
        d.memoryGB = nil
        #expect(memoryBudgetMB(d) == 4096)
    }
    @Test func constantsComeFromContract() {
        let c = ModelCatalog.bundled.constants
        #expect(c.storageHeadroom == 1.2 && c.availableMemoryShare == 0.6 && c.totalMemoryShare == 0.5 && c.unknownFreeMemoryCapMB == 4096)
    }
}

@Suite struct DecideRuntimeTests {
    let yes = Consent(cloudFallback: true)
    let no = Consent()
    @Test func cases() {
        #expect(decideRuntime(mode: .auto, consent: yes, taskDeviceOnly: false, deviceFailure: nil) == .device)
        #expect(decideRuntime(mode: .auto, consent: yes, taskDeviceOnly: false, deviceFailure: .noWebgpu) == .cloud(.noWebgpu))
        #expect(decideRuntime(mode: .auto, consent: no, taskDeviceOnly: false, deviceFailure: .noWebgpu) == .none(.noWebgpu))
        #expect(decideRuntime(mode: .auto, consent: yes, taskDeviceOnly: true, deviceFailure: .timeout) == .none(.timeout))
        #expect(decideRuntime(mode: .deviceOnly, consent: yes, taskDeviceOnly: false, deviceFailure: .engineError) == .none(.engineError))
        #expect(decideRuntime(mode: .cloudOnly, consent: yes, taskDeviceOnly: false, deviceFailure: nil) == .cloud(.forcedCloud))
        #expect(decideRuntime(mode: .cloudOnly, consent: yes, taskDeviceOnly: true, deviceFailure: nil) == .none(.forcedCloud))
    }
}
