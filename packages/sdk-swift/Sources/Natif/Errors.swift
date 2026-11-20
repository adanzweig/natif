import Foundation

/// Errors thrown by the SDK. Reason names match the TS SDK (`DeviceUnavailableError.reason`, …).
public enum NatifError: Error, Sendable, LocalizedError {
    /// The device can't run the task and the cloud is not allowed or not available.
    case deviceUnavailable(reason: FallbackReason, detail: String?)
    /// The model output didn't match the schema, even after one repair attempt.
    case schemaValidation(issues: [SchemaIssue], raw: String)
    case taskNotFound(String)
    case invalidArgument(String)
    case cloudFallback(status: Int, message: String)
    case downloadFailed(String)
    case engine(String)

    /// The fallback reason, when there is one (`deviceUnavailable`, or `schema_failed_after_repair`).
    public var reason: FallbackReason? {
        switch self {
        case .deviceUnavailable(let r, _): return r
        case .schemaValidation: return .schemaFailedAfterRepair
        default: return nil
        }
    }

    public var errorDescription: String? {
        switch self {
        case .deviceUnavailable(let r, let d): return "On-device inference unavailable (\(r.rawValue))\(d.map { ": \($0)" } ?? "")"
        case .schemaValidation: return "Model output does not match the schema"
        case .taskNotFound(let t): return "Task \"\(t)\" not found or not published"
        case .invalidArgument(let m): return m
        case .cloudFallback(let s, let m): return "Cloud fallback failed (\(s)): \(m)"
        case .downloadFailed(let m): return "Model download failed: \(m)"
        case .engine(let m): return m
        }
    }
}
