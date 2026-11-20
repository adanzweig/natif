import Foundation

/// A task's settings once complete (same fields as the TS `TaskConfig`).
public struct TaskConfig: Codable, Sendable, Equatable {
    public var slug: String
    public var version: Int
    public var systemPrompt: String
    public var instructions: String?
    public var jsonSchema: JSONValue?
    public var temperature: Double
    public var maxTokens: Int
    /// Below this decode speed the device is considered too slow for the task.
    public var minDeviceTokPerSec: Double
    public var recommendedModel: String?
    /// Set server-side when the project enforces local-only processing.
    public var deviceOnly: Bool
}

/// A task defined in code (TS `LocalTask`): only the system prompt is required.
public struct LocalTask: Sendable, Equatable {
    public var systemPrompt: String
    public var instructions: String?
    public var version: Int
    public var temperature: Double
    public var maxTokens: Int
    public var minDeviceTokPerSec: Double
    public var recommendedModel: String?
    public var deviceOnly: Bool

    /// Defaults match sdk-core `TASK_DEFAULTS`.
    public init(systemPrompt: String, instructions: String? = nil, version: Int = 0, temperature: Double = 0, maxTokens: Int = 256,
                minDeviceTokPerSec: Double = 8, recommendedModel: String? = nil, deviceOnly: Bool = false) {
        self.systemPrompt = systemPrompt
        self.instructions = instructions
        self.version = version
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.minDeviceTokPerSec = minDeviceTokPerSec
        self.recommendedModel = recommendedModel
        self.deviceOnly = deviceOnly
    }

    func complete(slug: String) -> TaskConfig {
        TaskConfig(slug: slug, version: version, systemPrompt: systemPrompt, instructions: instructions, jsonSchema: nil,
                   temperature: temperature, maxTokens: maxTokens, minDeviceTokPerSec: minDeviceTokPerSec,
                   recommendedModel: recommendedModel, deviceOnly: deviceOnly)
    }
}

public let CLASSIFY_TASK = "benatif.classify"
/// Used by `extract` when no task slug is given (Swift-only convenience; TS always names a task).
public let EXTRACT_TASK = "benatif.extract"

/// Tasks the SDK ships with; an app task with the same slug overrides them.
public let BUILTIN_TASKS: [String: LocalTask] = [
    CLASSIFY_TASK: LocalTask(
        systemPrompt: "You are a precise text classifier. Read the text and choose the single label from the given list that fits it best. Follow the instructions if any. Answer with JSON only.",
        temperature: 0, maxTokens: 40),
    EXTRACT_TASK: LocalTask(
        systemPrompt: "You extract structured data from the text. Use only what the text says. Answer with JSON only.",
        temperature: 0, maxTokens: 512),
]
