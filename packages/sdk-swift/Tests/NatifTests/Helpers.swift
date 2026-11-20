import Foundation
@testable import Natif

/// Same device as sdk-core test/helpers.ts `highEndWeb`.
let highEndWeb = DeviceProfile(
    platform: .web,
    browser: .init(name: "chrome", major: 157),
    gpu: .init(available: true, vendor: "apple", architecture: "metal-3", shaderF16: true, maxBufferSize: 4 * 1_073_741_824),
    memoryGB: 8,
    storageFreeBytes: 100e9
)

let iPhone = DeviceProfile(
    platform: .ios, os: "ios 18.2", hardwareModel: "iPhone16,2",
    gpu: .init(available: true, vendor: "Apple A17 Pro GPU"),
    memoryGB: 8, availableMemoryMB: 5000, storageFreeBytes: 50e9
)

/// Port of the TS MockEngine: resolves webllm ids so selection cases match sdk-core tests.
actor MockEngine: TextEngine {
    nonisolated let name = "mock"
    var loads: [String] = []
    var calls: [GenerateRequest] = []
    var cached: Set<String> = []
    var failLoad: Set<String> = []
    var current: String?
    var unloads = 0
    let reply: @Sendable (GenerateRequest, Int) -> String
    let tokPerSec: [String: Double]
    var override: (@Sendable (GenerateRequest) async throws -> GenerateResult)?

    init(reply: @escaping @Sendable (GenerateRequest, Int) -> String = { _, _ in "{}" }, tokPerSec: [String: Double] = [:]) {
        self.reply = reply
        self.tokPerSec = tokPerSec
    }

    func setOverride(_ o: @escaping @Sendable (GenerateRequest) async throws -> GenerateResult) { override = o }
    func setFailLoad(_ ids: Set<String>) { failLoad = ids }

    nonisolated func resolveModelId(_ spec: ModelSpec, device: DeviceProfile) -> String? { spec.runtimes.webllm?.f16 }
    func isCached(_ id: String) async -> Bool { cached.contains(id) }
    func load(_ id: String, onProgress: ProgressHandler?) async throws {
        if failLoad.contains(id) { throw NatifError.engine("load failed") }
        loads.append(id)
        current = id
        cached.insert(id)
    }
    func generate(_ req: GenerateRequest) async throws -> GenerateResult {
        calls.append(req)
        if let override { return try await override(req) }
        let isBench = req.jsonSchema == nil
        let text = isBench ? "the sky is blue because" : reply(req, calls.filter { $0.jsonSchema != nil }.count)
        return GenerateResult(text: text, promptTokens: 100, completionTokens: 20, ttftMs: 50, totalMs: 500,
                              decodeTokPerSec: tokPerSec[current ?? ""] ?? 40)
    }
    func unload() async {
        current = nil
        unloads += 1
    }
    var schemaCalls: [GenerateRequest] { calls.filter { $0.jsonSchema != nil } }
}

func makeClient(_ engine: MockEngine, device: DeviceProfile = highEndWeb, _ configure: (inout NatifOptions) -> Void = { _ in }) -> Natif {
    var o = NatifOptions(idleUnloadAfter: nil, unloadOnBackground: false, engine: engine,
                           detectDevice: { device }, storage: MemoryStore())
    configure(&o)
    return Natif(o)
}

/// Thread-safe box for collecting values from @Sendable callbacks.
final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ v: T) { _value = v }
    var value: T { lock.withLock { _value } }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&_value) } }
}

let sdkCoreDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appending(path: "sdk-core")
