# Natif for Android (Kotlin)

On-device AI for Android: ask for tasks (`chat`, `extract`, `classify`), not models. The SDK
checks the phone's free RAM and storage, then picks the catalog model that fits, downloads it once
and runs it locally with llama.cpp. The API and behaviour match `@be-natif/web` and
`@be-natif/react-native`: same selection rules, prompts, grounding and error reasons.

| Module | What it is |
|---|---|
| `natif-core` | Pure Kotlin/JVM: catalog, model selection, knowledge (BM25 + grounding), history trimming, JSON Schema validation/repair, the client. |
| `natif-android` | Android library (`com.benatif`, minSdk 26): device detection, resumable downloads, llama.cpp over JNI, `Natif.create(...)`. |

## Install

```kotlin
// settings.gradle.kts: until it is published, use the folder as an included build
includeBuild("../benatif/packages/sdk-kotlin")

// app/build.gradle.kts
dependencies {
    implementation("com.benatif:natif-android:0.1.0")
}
```

## Use

```kotlin
val ai = Natif.create(context, ClientOptions(
    knowledge = KnowledgeOptions(docs = listOf(KnowledgeDoc(faqText, title = "FAQ"))),
    grounding = Grounding.STRICT,
))
lifecycleScope.launch {
    ai.download { p -> progress.value = p.progress }            // optional, e.g. on Wi-Fi during onboarding
    val r = ai.chat(ChatRequest("Do you ship to Chile?", history = history, onToken = { /* background thread */ }))
    history = r.history                                          // r.sources = citations
    val data = ai.extract(text, """{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}""")
    val label = ai.classify(ticket, listOf("billing", "bug", "feature")).label
}
```

`ai.chatFlow(request)` returns a `Flow<ChatEvent>` (tokens, then `Done(result)`); cancelling the
collector stops generation. `ai.capabilities()` tells you which model this device would use, without
downloading. Call `ai.unload()` when the app goes to the background; the model stays on disk.

## Notes

- **64-bit only.** The AAR ships `arm64-v8a` only. 2–4 GB models can't be mapped in a 32-bit
  process. For an emulator build, add `"x86_64"` to `abiFilters` in `natif-android/build.gradle.kts`.
- **Memory.** Weights are memory-mapped and live outside the Java heap, so `android:largeHeap`
  isn't needed for the model itself. Set `android:largeHeap="true"` if your app also keeps large
  objects on the Java heap during chats. The SDK budgets 60% of `ActivityManager.MemoryInfo.availMem`
  and steps down to a smaller model (or throws `DeviceUnavailableException(INSUFFICIENT_MEMORY)`)
  rather than getting the app killed.
- **Models** are stored in `context.filesDir/natif-models`. Downloads write `<model>.gguf.part`
  with HTTP Range resume and rename the file when it's complete. Only complete files count as cached.
- **CPU only for now.** The library is built for ARMv8.2 with dotprod and fp16 (all arm64 SoCs since
  about 2018). Vulkan/OpenCL GPU offload isn't compiled in yet.
- **Callbacks.** `onToken` and download progress run on background threads. Post to the main thread
  for UI.
- **Catalog.** `catalog.json` is copied at build time from `packages/sdk-core/contract/catalog.json`.
  Outside the monorepo, pass `-Pbenatif.catalog=/path/catalog.json`.
- **Not in this release.** Cloud fallback, dashboard-published tasks and telemetry. The seams are
  `ClientOptions.cloudFallback`, `taskSource` and `telemetry`; see `Seams.kt`.

## Develop

```sh
./gradlew :natif-core:test               # JVM tests with a mock engine
./gradlew :natif-android:assembleRelease # AAR, builds llama.cpp (pinned tag) with the NDK
```

`local.properties` needs `sdk.dir`. The native build downloads llama.cpp (tag pinned in
`natif-android/src/main/cpp/CMakeLists.txt`). To build offline from a local checkout, pass
`-DFETCHCONTENT_SOURCE_DIR_LLAMA=...`.
