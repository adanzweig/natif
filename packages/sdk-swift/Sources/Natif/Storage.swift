import Foundation

/// Small persistent store (benchmarks per device+model+SDK version). Values are JSON-encoded.
public protocol KeyValueStore: Sendable {
    func data(forKey key: String) async -> Data?
    func setData(_ data: Data?, forKey key: String) async
    func clear() async
}

extension KeyValueStore {
    public func get<T: Decodable>(_ type: T.Type, forKey key: String) async -> T? {
        guard let d = await data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }
    public func set<T: Encodable>(_ value: T, forKey key: String) async {
        await setData(try? JSONEncoder().encode(value), forKey: key)
    }
}

/// In-memory store for tests and previews.
public actor MemoryStore: KeyValueStore {
    private var map: [String: Data] = [:]
    public init() {}
    public func data(forKey key: String) -> Data? { map[key] }
    public func setData(_ data: Data?, forKey key: String) { map[key] = data }
    public func clear() { map.removeAll() }
}

/// Default store: UserDefaults, keys prefixed with "benatif.".
public final class UserDefaultsStore: KeyValueStore, @unchecked Sendable {
    // UserDefaults is thread-safe.
    private let defaults: UserDefaults
    private let prefix = "benatif."
    public init(suiteName: String? = nil) {
        defaults = suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }
    public func data(forKey key: String) async -> Data? { defaults.data(forKey: prefix + key) }
    public func setData(_ data: Data?, forKey key: String) async { defaults.set(data, forKey: prefix + key) }
    public func clear() async {
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(prefix) { defaults.removeObject(forKey: k) }
    }
}
