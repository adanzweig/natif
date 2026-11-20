import Foundation

public struct GenerateRequest: Sendable {
    public var messages: [ChatMessage]
    /// JSON Schema the output must follow (constrained decoding when the engine supports it).
    public var jsonSchema: JSONValue?
    public var maxTokens: Int
    public var temperature: Double
    public var disableThinking: Bool
    /// Called with each new piece of text as it is generated (streaming).
    public var onToken: TokenHandler?

    public init(messages: [ChatMessage], jsonSchema: JSONValue? = nil, maxTokens: Int, temperature: Double,
                disableThinking: Bool = false, onToken: TokenHandler? = nil) {
        self.messages = messages
        self.jsonSchema = jsonSchema
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.disableThinking = disableThinking
        self.onToken = onToken
    }
}

public struct GenerateResult: Sendable, Equatable {
    public var text: String
    public var promptTokens: Int
    public var completionTokens: Int
    public var ttftMs: Double
    public var totalMs: Double
    public var decodeTokPerSec: Double
    /// Prompt tokens reused from the KV cache (prefix match), when the engine reports it.
    public var cachedTokens: Int?

    public init(text: String, promptTokens: Int, completionTokens: Int, ttftMs: Double, totalMs: Double,
                decodeTokPerSec: Double, cachedTokens: Int? = nil) {
        self.text = text
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.ttftMs = ttftMs
        self.totalMs = totalMs
        self.decodeTokPerSec = decodeTokPerSec
        self.cachedTokens = cachedTokens
    }
}

/// Runs a local text model. `LlamaEngine` (llama.cpp) is the default; tests use a mock.
/// Cancellation follows Swift tasks: `generate` must stop soon after its task is cancelled.
public protocol TextEngine: Sendable {
    var name: String { get }
    /// Engine-specific model id for a catalog entry, or nil if this engine can't run it.
    func resolveModelId(_ spec: ModelSpec, device: DeviceProfile) -> String?
    func isCached(_ engineModelId: String) async -> Bool
    /// True when `download` can put the weights on disk without loading them.
    var supportsDownload: Bool { get }
    /// Weights on disk without loading them into GPU/RAM. Must resume an interrupted download.
    func download(_ engineModelId: String, onProgress: ProgressHandler?) async throws
    func load(_ engineModelId: String, onProgress: ProgressHandler?) async throws
    func generate(_ request: GenerateRequest) async throws -> GenerateResult
    func unload() async
}

extension TextEngine {
    public var supportsDownload: Bool { false }
    public func download(_ engineModelId: String, onProgress: ProgressHandler?) async throws {
        throw NatifError.engine("\(name) can't download without loading")
    }
}
