import Foundation

/// How much memory (MB) a model may use on this device, so we never slow the user's device down.
/// Order: what the app says → what the OS says is available → a share of the total → unknown.
/// Port of sdk-core `memoryBudgetMB`.
public func memoryBudgetMB(_ device: DeviceProfile, override: Double? = nil,
                           constants: SelectionConstants = ModelCatalog.bundled.constants) -> Double {
    if let override { return override }
    if let available = device.availableMemoryMB { return available * constants.availableMemoryShare }
    if let gb = device.memoryGB { return min(gb * 1024 * constants.totalMemoryShare, constants.unknownFreeMemoryCapMB) }
    return constants.unknownFreeMemoryCapMB
}

public struct DeviceRecommendation: Codable, Sendable, Equatable {
    public struct Model: Codable, Sendable, Equatable {
        public var p50DecodeTokPerSec: Double
        public var loadFailRate: Double?
        public init(p50DecodeTokPerSec: Double, loadFailRate: Double? = nil) {
            self.p50DecodeTokPerSec = p50DecodeTokPerSec
            self.loadFailRate = loadFailRate
        }
    }
    /// Aggregated from anonymous telemetry of devices in the same class (n ≥ 20).
    public var models: [String: Model]
    public init(models: [String: Model]) { self.models = models }
}

public struct SelectModelInput: Sendable {
    public var device: DeviceProfile
    public var capability: Capability
    public var catalog: [ModelSpec]
    public var constants: SelectionConstants
    public var resolveModelId: @Sendable (ModelSpec, DeviceProfile) -> String?
    public var minDeviceTokPerSec: Double
    /// Engine model ids already downloaded (storage check is skipped for them).
    public var cached: Set<String>
    public var benchmarks: [String: BenchmarkResult]
    public var recommendation: DeviceRecommendation?
    /// Task or app preference; tried first if it fits.
    public var preferredModel: String?
    /// Max memory (MB) a model may use; overrides what is derived from the device.
    public var memoryBudgetMB: Double?

    public init(device: DeviceProfile, capability: Capability = .text, catalog: [ModelSpec] = ModelCatalog.bundled.models,
                constants: SelectionConstants = ModelCatalog.bundled.constants,
                resolveModelId: @escaping @Sendable (ModelSpec, DeviceProfile) -> String?,
                minDeviceTokPerSec: Double = 8, cached: Set<String> = [], benchmarks: [String: BenchmarkResult] = [:],
                recommendation: DeviceRecommendation? = nil, preferredModel: String? = nil, memoryBudgetMB: Double? = nil) {
        self.device = device
        self.capability = capability
        self.catalog = catalog
        self.constants = constants
        self.resolveModelId = resolveModelId
        self.minDeviceTokPerSec = minDeviceTokPerSec
        self.cached = cached
        self.benchmarks = benchmarks
        self.recommendation = recommendation
        self.preferredModel = preferredModel
        self.memoryBudgetMB = memoryBudgetMB
    }
}

public enum ModelSelection: Sendable, Equatable {
    case selected(spec: ModelSpec, engineModelId: String, rejected: [String: FallbackReason])
    case unavailable(reason: FallbackReason, rejected: [String: FallbackReason])

    public var spec: ModelSpec? { if case .selected(let s, _, _) = self { return s }; return nil }
    public var reason: FallbackReason? { if case .unavailable(let r, _) = self { return r }; return nil }
    public var rejected: [String: FallbackReason] {
        switch self {
        case .selected(_, _, let r), .unavailable(_, let r): return r
        }
    }
}

/// When every candidate is rejected, report the reason that best explains it.
private let REASON_PRIORITY: [FallbackReason] = [
    .benchmarkSlow, .knownSlowDevice, .insufficientMemory, .insufficientStorage, .noModelForCapability,
]

/// Pure: picks the best model this device can run for a capability, or explains why none.
/// Port of sdk-core `selectModel` (same order of checks and the same rejection reasons).
public func selectModel(_ input: SelectModelInput) -> ModelSelection {
    var rejected: [String: FallbackReason] = [:]
    let device = input.device

    if device.platform == .web && !device.gpu.available {
        return .unavailable(reason: .noWebgpu, rejected: rejected)
    }

    // Stable sort: preferred first, then by quality (ties keep catalog order, like JS).
    let candidates = input.catalog.enumerated()
        .filter { $0.element.capabilities.contains(input.capability) }
        .sorted { a, b in
            if a.element.id == input.preferredModel { return b.element.id != input.preferredModel || a.offset < b.offset }
            if b.element.id == input.preferredModel { return false }
            if a.element.quality != b.element.quality { return a.element.quality > b.element.quality }
            return a.offset < b.offset
        }
        .map(\.element)

    let budget = memoryBudgetMB(device, override: input.memoryBudgetMB, constants: input.constants)
    for spec in candidates {
        guard let engineModelId = input.resolveModelId(spec, device) else {
            rejected[spec.id] = .noModelForCapability
            continue
        }
        if spec.memoryRequiredMB > budget {
            rejected[spec.id] = .insufficientMemory
            continue
        }
        let isCached = input.cached.contains(engineModelId)
        if !isCached, let free = device.storageFreeBytes, free < spec.downloadBytes * input.constants.storageHeadroom {
            rejected[spec.id] = .insufficientStorage
            continue
        }
        let bench = input.benchmarks[spec.id]
        if let bench, bench.decodeTokPerSec < input.minDeviceTokPerSec {
            rejected[spec.id] = .benchmarkSlow
            continue
        }
        if bench == nil, let rec = input.recommendation?.models[spec.id], rec.p50DecodeTokPerSec < input.minDeviceTokPerSec {
            rejected[spec.id] = .knownSlowDevice
            continue
        }
        return .selected(spec: spec, engineModelId: engineModelId, rejected: rejected)
    }

    let reasons = Set(rejected.values)
    let reason = REASON_PRIORITY.first { reasons.contains($0) } ?? .noModelForCapability
    return .unavailable(reason: reason, rejected: rejected)
}

public enum RuntimeDecision: Sendable, Equatable {
    case device
    case cloud(FallbackReason)
    case none(FallbackReason)
}

/// Pure: given why the device can't (or nil if it can), decide where to run.
/// A device-only project never reaches the cloud, whatever the client asks.
public func decideRuntime(mode: RuntimeMode, consent: Consent, taskDeviceOnly: Bool, deviceFailure: FallbackReason?) -> RuntimeDecision {
    let cloudAllowed = consent.cloudFallback && !taskDeviceOnly && mode != .deviceOnly
    if mode == .cloudOnly {
        return cloudAllowed ? .cloud(.forcedCloud) : .none(.forcedCloud)
    }
    guard let deviceFailure else { return .device }
    return cloudAllowed ? .cloud(deviceFailure) : .none(deviceFailure)
}
