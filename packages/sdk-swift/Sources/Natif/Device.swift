import Foundation
#if canImport(Metal)
import Metal
#endif
#if canImport(Darwin)
import Darwin
#endif

/// Reads what this Apple device can do, mapped to the same `DeviceProfile` fields as TS, so
/// `selectModel` behaves the same as on React Native.
///
/// - total RAM: `ProcessInfo.physicalMemory`
/// - RAM the app may use now: iOS `os_proc_available_memory()`; macOS free+inactive+purgeable
///   pages (Activity Monitor's "available"); both capped by Metal `recommendedMaxWorkingSetSize`
/// - free disk: `volumeAvailableCapacityForImportantUsage`
/// - hardware model: `hw.machine` (iOS, e.g. "iPhone16,2") / `hw.model` (macOS, e.g. "Mac15,3")
public enum AppleDevice {
    public static func detect(storageDirectory: URL? = nil) -> DeviceProfile {
        #if os(iOS)
        let platform = DeviceProfile.Platform.ios
        #else
        let platform = DeviceProfile.Platform.macos
        #endif
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" : "\(v.majorVersion).\(v.minorVersion)"

        var gpuAvailable = false
        var gpuName: String?
        var gpuWorkingSetMB: Double?
        #if canImport(Metal)
        if let device = MTLCreateSystemDefaultDevice() {
            gpuAvailable = true
            gpuName = device.name
            let ws = Double(device.recommendedMaxWorkingSetSize)
            if ws > 0 { gpuWorkingSetMB = ws / 1_048_576 }
        }
        #endif

        let total = Double(ProcessInfo.processInfo.physicalMemory)
        var available = availableMemoryMB()
        if let a = available, let g = gpuWorkingSetMB { available = min(a, g) } else if available == nil { available = gpuWorkingSetMB }

        return DeviceProfile(
            platform: platform,
            os: "\(platform.rawValue) \(osVersion)",
            hardwareModel: hardwareModel(),
            gpu: .init(available: gpuAvailable, vendor: gpuName),
            memoryGB: total > 0 ? (total / 1_073_741_824).rounded() : nil,
            availableMemoryMB: available,
            storageFreeBytes: freeStorageBytes(at: storageDirectory)
        )
    }

    /// RAM this process can still use, in MB (nil when the OS doesn't say).
    public static func availableMemoryMB() -> Double? {
        #if os(iOS) && !targetEnvironment(simulator)
        let bytes = os_proc_available_memory()
        return bytes > 0 ? Double(bytes) / 1_048_576 : nil
        #elseif os(macOS)
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard kr == KERN_SUCCESS else { return nil }
        var pageSize: vm_size_t = 0
        host_page_size(mach_host_self(), &pageSize)
        let pages = UInt64(stats.free_count) + UInt64(stats.inactive_count) + UInt64(stats.purgeable_count) + UInt64(stats.speculative_count)
        return Double(pages * UInt64(pageSize)) / 1_048_576
        #else
        return nil
        #endif
    }

    public static func hardwareModel() -> String? {
        #if targetEnvironment(simulator)
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        #endif
        #if os(macOS)
        return sysctlString("hw.model")
        #else
        return sysctlString("hw.machine")
        #endif
    }

    static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
        let bytes = buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    public static func freeStorageBytes(at directory: URL? = nil) -> Double? {
        var url = directory ?? URL.applicationSupportDirectory
        // The volume query needs an existing path.
        while !FileManager.default.fileExists(atPath: url.path) && url.pathComponents.count > 1 { url.deleteLastPathComponent() }
        guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
              let bytes = values.volumeAvailableCapacityForImportantUsage, bytes > 0
        else { return nil }
        return Double(bytes)
    }
}
