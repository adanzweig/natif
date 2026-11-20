// swift-tools-version: 6.0
import PackageDescription

// llama.cpp prebuilt XCFramework from the official ggml-org/llama.cpp GitHub releases.
// To upgrade: pick a release tag, download llama-<tag>-xcframework.zip and run
// `swift package compute-checksum llama-<tag>-xcframework.zip`.
let llamaTag = "b10456"
let llamaChecksum = "0223bedd0a01232399d943dcb72bc227882bc90df98e29d7a92343531a88cc02"

let package = Package(
    name: "Natif",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "Natif", targets: ["Natif"]),
    ],
    targets: [
        .binaryTarget(
            name: "llama",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/\(llamaTag)/llama-\(llamaTag)-xcframework.zip",
            checksum: llamaChecksum
        ),
        .target(
            name: "Natif",
            dependencies: ["llama"],
            resources: [.copy("Resources/catalog.json")]
        ),
        .testTarget(
            name: "NatifTests",
            dependencies: ["Natif"]
        ),
    ]
)
