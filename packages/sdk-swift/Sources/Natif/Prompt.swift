import Foundation


/// Same prompt as sdk-core `buildExtractMessages`.
func buildExtractMessages(task: TaskConfig, jsonSchema: JSONValue, text: String) -> [ChatMessage] {
    let parts: [String?] = [
        task.systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines),
        task.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
        // Engines with constrained decoding enforce this anyway; the rest rely on the prompt.
        "Answer only with a JSON object that follows this JSON Schema:\n\(jsonSchema.jsonString)",
    ]
    let system = parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    return [.system(system), .user(text)]
}

let BENCHMARK_MESSAGES: [ChatMessage] = [
    .user("Write a short paragraph about why the sky is blue. Keep going until you are told to stop."),
]

/// USD per million tokens of the cloud model used as the "what you would have paid" reference.
public struct PriceReference: Sendable, Equatable {
    public var model: String
    public var inputUsdPerMTok: Double
    public var outputUsdPerMTok: Double
    public init(model: String, inputUsdPerMTok: Double, outputUsdPerMTok: Double) {
        self.model = model
        self.inputUsdPerMTok = inputUsdPerMTok
        self.outputUsdPerMTok = outputUsdPerMTok
    }
    /// Conservative default (same as sdk-core), so savings are never overstated.
    public static let `default` = PriceReference(model: "claude-haiku-5-5", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5)
}

public func estimateSavingsUsd(tokensIn: Int, tokensOut: Int, reference: PriceReference = .default) -> Double {
    (Double(tokensIn) * reference.inputUsdPerMTok + Double(tokensOut) * reference.outputUsdPerMTok) / 1e6
}
