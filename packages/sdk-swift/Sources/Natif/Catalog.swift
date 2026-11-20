import Foundation

/// Selection constants exported from sdk-core (`contract/catalog.json`).
public struct SelectionConstants: Codable, Sendable, Equatable {
    public var storageHeadroom: Double
    /// Share of *available* memory a model may take (native platforms report it).
    public var availableMemoryShare: Double
    /// Share of *total* memory when available memory is unknown.
    public var totalMemoryShare: Double
    /// Max budget when free memory is unknown.
    public var unknownFreeMemoryCapMB: Double

    enum CodingKeys: String, CodingKey {
        case storageHeadroom = "STORAGE_HEADROOM"
        case availableMemoryShare = "AVAILABLE_MEMORY_SHARE"
        case totalMemoryShare = "TOTAL_MEMORY_SHARE"
        case unknownFreeMemoryCapMB = "UNKNOWN_FREE_MEMORY_CAP_MB"
    }
}

/// The model catalog shared by every benatif SDK. Generated from TS (sdk-core
/// `scripts/export-contract.mjs`) and bundled as a resource; see `scripts/sync-contract.sh`.
public struct ModelCatalog: Codable, Sendable, Equatable {
    public var version: Int
    public var constants: SelectionConstants
    public var models: [ModelSpec]

    public init(version: Int = 1, constants: SelectionConstants, models: [ModelSpec]) {
        self.version = version
        self.constants = constants
        self.models = models
    }

    public init(data: Data) throws {
        self = try JSONDecoder().decode(ModelCatalog.self, from: data)
    }

    /// The catalog bundled with this SDK version.
    public static let bundled: ModelCatalog = {
        guard let url = Bundle.module.url(forResource: "catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? ModelCatalog(data: data)
        else { fatalError("Natif: catalog.json missing or invalid in the package resources") }
        return catalog
    }()

    public func model(_ id: String) -> ModelSpec? { models.first { $0.id == id } }
}
