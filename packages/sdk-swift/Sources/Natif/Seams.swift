import Foundation

// Out of scope for the Swift MVP, but the client already calls these seams so they can be added
// without changing the public API.

/// Cloud fallback (TS `cloudExtract` → POST {baseUrl}/v1/fallback/extract).
/// TODO: ship a default implementation that talks to the benatif backend. Until then, with no
/// provider set, a cloud decision throws `deviceUnavailable` with the device's reason.
public protocol CloudFallbackProvider: Sendable {
    func extract(task: TaskConfig, text: String, jsonSchema: JSONValue) async throws -> CloudExtractResponse
}

public struct CloudExtractResponse: Sendable {
    public var data: JSONValue
    public var model: String
    public var inputTokens: Int
    public var outputTokens: Int
    public init(data: JSONValue, model: String, inputTokens: Int, outputTokens: Int) {
        self.data = data
        self.model = model
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

/// One anonymous performance event (same fields as the TS telemetry queue; never content).
public struct TelemetryEvent: Codable, Sendable, Equatable {
    public var ts: Double
    public var task: String
    public var taskVersion: Int
    public var runtime: String
    public var modelId: String
    public var deviceKey: String
    public var platform: String
    public var latencyMs: Int
    public var loadMs: Int?
    public var decodeTokPerSec: Double?
    public var tokensIn: Int
    public var tokensOut: Int
    public var outcome: String
    public var fallbackReason: String?
    public var repaired: Bool?
    public var sdkVersion: String
}

/// TODO: batching transport to {baseUrl}/v1/telemetry. Only called with telemetry consent.
public protocol TelemetrySink: Sendable {
    func record(_ event: TelemetryEvent) async
}
