# Natif for Swift (iOS / macOS)

On-device AI by task: ask for `chat`, `extract` or `classify`, not for a model. The SDK checks the
device (RAM the app may use, GPU, free disk) and picks the local model that fits, then runs it with
llama.cpp on Metal. Same task API and semantics as the web, React Native and Expo SDKs.

Requirements: iOS 17+ / macOS 14+, Swift 6.

## Install (Swift Package Manager)

In Xcode: File → Add Package Dependencies… and enter the repository URL, or in `Package.swift`:

```swift
.package(url: "https://github.com/<org>/benatif-swift", from: "0.1.0"),
// target:
.product(name: "Natif", package: "benatif-swift"),
```

The package pulls the official llama.cpp XCFramework (ggml-org/llama.cpp release `b10456`) as a
binary target.

## Usage

```swift
import Natif

let ai = Natif(NatifOptions(
    knowledge: KnowledgeOptions(docs: [KnowledgeDoc(title: "FAQ", text: faqText)]),
    grounding: .prefer
))

_ = try await ai.download { print("download", $0.progress) }   // optional, e.g. on Wi-Fi

let reply = try await ai.chat(ChatRequest(message: "Do you ship abroad?", history: history) { token in
    print(token, terminator: "")                                  // streaming
})
history = reply.history                                           // reply.sources = citations

let data = try await ai.extract(text: note, schema: [
    "type": "object",
    "properties": ["mood": ["type": "integer", "minimum": 1, "maximum": 10]],
    "required": ["mood"],
])
let label = try await ai.classify(text: "I was charged twice", labels: ["billing", "bug"]).label
```

- `extract` takes a JSON Schema (`JSONValue` literal, or `[String: Any]` with `extract(text:jsonSchema:)`)
  and returns validated JSON (or your `Decodable` type with `extract(MyType.self, …)`). Invalid output
  gets one repair attempt, then `NatifError.schemaValidation`.
- `capabilities()` reports the chosen model without downloading; `prepare()` downloads, loads and
  benchmarks ahead of time; `unload()` frees RAM/GPU (done automatically when an iOS app goes to the background
  and after 2 minutes idle).
- Errors use the same reason names as the other SDKs (`insufficient_memory`, `benchmark_slow`, …):
  `NatifError.deviceUnavailable(reason:detail:)`.
- Models are stored in `Application Support/natif-models` (excluded from iCloud backup).
  Interrupted downloads resume from URLSession resume data on the next attempt.

## iOS memory: increased-memory-limit entitlement

The 4B model needs about 3.4 GB. iOS caps how much RAM an app may use, often well below the
device's total, and the SDK budgets on `os_proc_available_memory()`. Add the
**Increased Memory Limit** capability (`com.apple.developer.kernel.increased-memory-limit`) to your app's
entitlements so supported devices let the app use more RAM and get the bigger model. Without it, many
iPhones will get the 1.7B model, or no local model.

## Not in this version

- Cloud fallback and telemetry: the client calls the `CloudFallbackProvider` and `TelemetrySink`
  seams, but there is no default implementation yet.
- Backend-published tasks (`/v1/tasks`): define tasks in code with `NatifOptions.tasks`.

## Development

```sh
swift build && swift test
xcodebuild -scheme Natif -destination 'generic/platform=iOS Simulator' build
scripts/sync-contract.sh   # after the sdk-core catalog changes
```
