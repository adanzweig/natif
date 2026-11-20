import Foundation

/// What an app needs. The SDK picks one model per capability.
public enum Capability: String, Codable, Sendable, Hashable {
    case text, vision
    case audioIn = "audio-in"
    case tts, image, video
}

public enum RuntimeMode: String, Codable, Sendable {
    case auto
    case deviceOnly = "device-only"
    case cloudOnly = "cloud-only"
}

public enum RuntimeUsed: String, Codable, Sendable {
    case device, cloud
}

public struct Consent: Codable, Sendable, Equatable {
    /// User agreed that, if the device can't, the input may be sent to the cloud fallback.
    public var cloudFallback: Bool
    /// User agreed to anonymous performance telemetry (no content, ever).
    public var telemetry: Bool
    public init(cloudFallback: Bool = false, telemetry: Bool = false) {
        self.cloudFallback = cloudFallback
        self.telemetry = telemetry
    }
}

/// Device class traits (same fields as the TS `DeviceProfile`). Nothing here identifies a person.
public struct DeviceProfile: Codable, Sendable, Equatable {
    public enum Platform: String, Codable, Sendable {
        case web, ios, android, node
        /// Not in the TS union (no JS SDK runs on native macOS); selection treats it like any native platform.
        case macos
    }

    public struct GPU: Codable, Sendable, Equatable {
        public var available: Bool
        public var vendor: String?
        public var architecture: String?
        public var shaderF16: Bool?
        public var maxBufferSize: Double?
        public var maxStorageBufferBindingSize: Double?
        public init(available: Bool, vendor: String? = nil, architecture: String? = nil, shaderF16: Bool? = nil,
                    maxBufferSize: Double? = nil, maxStorageBufferBindingSize: Double? = nil) {
            self.available = available
            self.vendor = vendor
            self.architecture = architecture
            self.shaderF16 = shaderF16
            self.maxBufferSize = maxBufferSize
            self.maxStorageBufferBindingSize = maxStorageBufferBindingSize
        }
    }

    public struct Browser: Codable, Sendable, Equatable {
        public var name: String
        public var major: Int
        public init(name: String, major: Int) { self.name = name; self.major = major }
    }

    public var platform: Platform
    public var browser: Browser?
    public var os: String?
    /// Hardware model, e.g. "iPhone16,2" or "Mac15,3".
    public var hardwareModel: String?
    public var gpu: GPU
    /// Total RAM in GB (rounded).
    public var memoryGB: Double?
    /// RAM the app can use right now, in MB (iOS `os_proc_available_memory`).
    public var availableMemoryMB: Double?
    public var storageFreeBytes: Double?

    public init(platform: Platform, browser: Browser? = nil, os: String? = nil, hardwareModel: String? = nil, gpu: GPU,
                memoryGB: Double? = nil, availableMemoryMB: Double? = nil, storageFreeBytes: Double? = nil) {
        self.platform = platform
        self.browser = browser
        self.os = os
        self.hardwareModel = hardwareModel
        self.gpu = gpu
        self.memoryGB = memoryGB
        self.availableMemoryMB = availableMemoryMB
        self.storageFreeBytes = storageFreeBytes
    }
}

public struct ModelSpec: Codable, Sendable, Equatable, Identifiable {
    public struct Runtimes: Codable, Sendable, Equatable {
        public struct WebLLM: Codable, Sendable, Equatable {
            public var f16: String
            public var f32: String?
        }
        public struct GGUF: Codable, Sendable, Equatable {
            public var url: String
        }
        public var webllm: WebLLM?
        public var gguf: GGUF?
    }

    public var id: String
    public var family: String
    public var capabilities: [Capability]
    public var tier: Tier
    public var license: String
    /// Approximate download size of the default variant.
    public var downloadBytes: Double
    /// Approximate GPU/RAM needed while running (weights + KV cache).
    public var memoryRequiredMB: Double
    public var runtimes: Runtimes
    /// Higher = better output. Used to rank candidates that fit.
    public var quality: Double
    /// Qwen3 thinking mode must be turned off.
    public var disableThinking: Bool?

    public enum Tier: String, Codable, Sendable { case high, low }
}

public struct ChatMessage: Codable, Sendable, Equatable {
    public enum Role: String, Codable, Sendable { case system, user, assistant }
    public var role: Role
    public var content: String
    public init(role: Role, content: String) { self.role = role; self.content = content }
    public static func system(_ c: String) -> ChatMessage { .init(role: .system, content: c) }
    public static func user(_ c: String) -> ChatMessage { .init(role: .user, content: c) }
    public static func assistant(_ c: String) -> ChatMessage { .init(role: .assistant, content: c) }
}

/// Why the device can't run something (same names as TS, so dashboards and logs match).
public enum FallbackReason: String, Codable, Sendable, CaseIterable {
    case noWebgpu = "no_webgpu"
    case insufficientMemory = "insufficient_memory"
    case insufficientStorage = "insufficient_storage"
    case noModelForCapability = "no_model_for_capability"
    case knownSlowDevice = "known_slow_device"
    case benchmarkSlow = "benchmark_slow"
    case loadFailed = "load_failed"
    case engineError = "engine_error"
    case schemaFailedAfterRepair = "schema_failed_after_repair"
    case timeout = "timeout"
    case forcedCloud = "forced_cloud"
}

public struct LoadProgress: Sendable, Equatable {
    public enum Phase: String, Sendable { case download, compile, ready }
    public var modelId: String
    /// 0...1
    public var progress: Double
    public var phase: Phase
    public var text: String?
    public init(modelId: String, progress: Double, phase: Phase, text: String? = nil) {
        self.modelId = modelId
        self.progress = progress
        self.phase = phase
        self.text = text
    }
}

public typealias ProgressHandler = @Sendable (LoadProgress) -> Void
public typealias TokenHandler = @Sendable (String) -> Void

public struct BenchmarkResult: Codable, Sendable, Equatable {
    public var modelId: String
    public var decodeTokPerSec: Double
    public var ttftMs: Double
    public var at: Double
    public init(modelId: String, decodeTokPerSec: Double, ttftMs: Double, at: Double) {
        self.modelId = modelId
        self.decodeTokPerSec = decodeTokPerSec
        self.ttftMs = ttftMs
        self.at = at
    }
}

// MARK: - Results

public struct ChatRequest: Sendable {
    /// The new user message.
    public var message: String
    /// Previous turns, owned by your app. Keep it append-only so the engine reuses its cache.
    public var history: [ChatMessage]
    /// System prompt. Keep it identical across turns so it stays cached.
    public var system: String?
    /// Max previous messages sent to the model (default 20), dropped in blocks (see `trimHistory`).
    public var maxHistoryMessages: Int?
    public var temperature: Double?
    public var maxTokens: Int?
    /// Called with each new piece of text (streaming). `<think>` blocks are hidden.
    public var onToken: TokenHandler?
    /// Overrides the client's `grounding` for this call (`.off` skips knowledge).
    public var grounding: Grounding?

    public init(message: String, history: [ChatMessage] = [], system: String? = nil, maxHistoryMessages: Int? = nil,
                temperature: Double? = nil, maxTokens: Int? = nil, grounding: Grounding? = nil, onToken: TokenHandler? = nil) {
        self.message = message
        self.history = history
        self.system = system
        self.maxHistoryMessages = maxHistoryMessages
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.grounding = grounding
        self.onToken = onToken
    }
}

public struct ChatMeta: Sendable, Equatable {
    public var modelId: String
    public var runtime: RuntimeUsed
    public var latencyMs: Int
    public var ttftMs: Double
    public var tokensIn: Int
    public var tokensOut: Int
    public var decodeTokPerSec: Double
    public var estimatedSavingsUsd: Double
    /// Prompt tokens reused from the engine cache.
    public var cachedTokens: Int?
    /// Older messages left out by `maxHistoryMessages`.
    public var droppedMessages: Int
}

public struct ChatResult: Sendable {
    public var text: String
    /// history + the new user message + the reply. Pass it back on the next turn.
    public var history: [ChatMessage]
    public var meta: ChatMeta
    /// Passages from `knowledge` given to the model; `cited` marks the ones it used.
    public var sources: [Source]?
}

public struct ExtractMeta: Sendable, Equatable {
    public var modelId: String
    public var runtime: RuntimeUsed
    public var taskVersion: Int
    public var latencyMs: Int
    public var tokensIn: Int
    public var tokensOut: Int
    /// What the same call would have cost on the reference cloud model. Estimate.
    public var estimatedSavingsUsd: Double
    public var fallbackReason: FallbackReason?
    public var repaired: Bool?
}

public struct ExtractResult<T: Sendable>: Sendable {
    public var data: T
    public var meta: ExtractMeta
}

public struct ClassifyResult: Sendable, Equatable {
    public var label: String
    public var meta: ExtractMeta
}

public struct CapabilityReport: Sendable {
    public enum Text: Sendable, Equatable {
        case available(modelId: String, tier: ModelSpec.Tier, cached: Bool)
        case unavailable(FallbackReason)
    }
    public var device: DeviceProfile
    public var deviceKey: String
    public var text: Text
}

public enum DownloadOutcome: Sendable, Equatable {
    case downloaded(modelId: String, engineModelId: String, downloadBytes: Double)
    case unavailable(FallbackReason)
    /// The engine can't download without loading (TS: "unsupported_engine").
    case unsupportedEngine
}
