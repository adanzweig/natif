import CryptoKit
import Foundation

private func pow2Bucket(_ n: Double) -> Double { pow(2, log2(max(n, 1)).rounded()) }

private func str(_ d: Double) -> String { JSONValue.formatNumber(d) }

/// Traits that describe the *class* of device (port of sdk-core `deviceClassTraits`).
public func deviceClassTraits(_ d: DeviceProfile) -> [String: String] {
    [
        "platform": d.platform.rawValue,
        "browser": d.browser.map { "\($0.name)/\($0.major)" } ?? "",
        "os": d.os ?? "",
        "hw": d.hardwareModel ?? "",
        "gpu": d.gpu.available ? "true" : "false",
        "gpuVendor": d.gpu.vendor ?? "",
        "gpuArch": d.gpu.architecture ?? "",
        "f16": (d.gpu.shaderF16 ?? false) ? "true" : "false",
        "maxBufGB": d.gpu.maxBufferSize.map { $0 > 0 ? str(pow2Bucket($0 / 1_073_741_824)) : "0" } ?? "0",
        "memGB": d.memoryGB.map { $0 > 0 ? str(pow2Bucket($0)) : "0" } ?? "0",
    ]
}

/// Coarse, non-identifying key for a device class: same value as sdk-core `deviceKey`.
public func deviceKey(_ d: DeviceProfile) -> String {
    let traits = deviceClassTraits(d)
    let canonical = traits.keys.sorted().map { "\($0)=\(traits[$0]!)" }.joined(separator: "|")
    let hex = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    return String(hex.prefix(24))
}
