# Natif

**On-device AI SDK. Describe the task, not the model.**

Natif picks the right local model for each device, downloads it once, runs it on the user's device and validates the output. It falls back to the cloud only when the device can't run the task *and* the user consented. One task API across web, React Native, Expo, Swift and Kotlin.

- Website & live playground: https://benatif.com (every endpoint runs in your browser, no API key)
- Docs: https://benatif.com/docs/
- For AI assistants: https://benatif.com/llms.txt · MCP: `npx -y @be-natif/mcp`

```bash
npm i @be-natif/web zod
```

```ts
import { createClient } from "@be-natif/web";
import { z } from "zod";

const ai = createClient({ consent: { cloudFallback: false } });

const { data } = await ai.extract({
  task: "daily-checkin",
  schema: z.object({ mood: z.number().int().min(1).max(10) }),
  input: { text: "Slept badly and I'm anxious" },
});
```

## What happens on each call

1. **Device check:** WebGPU / Metal / Vulkan, available memory and free storage.
2. **Model choice:** the best curated model that fits (for example Qwen3-4B → Gemma → Qwen3-1.7B), budgeted on *available* memory, not total RAM.
3. **Download once:** weights are cached and resumable; a background preload can fetch them before first use.
4. **Constrained generation:** output forced to your JSON Schema, validated with zod, repaired once if needed.
5. **Knowledge (optional):** ground answers in your own documents with local BM25 retrieval or your own retriever. Your data never leaves the device or your servers.
6. **Fallback:** cloud only with consent and if the project allows it; otherwise a typed `DeviceUnavailableError`.
7. **Telemetry (opt-in):** anonymous model, timings and device class. Never the input or the output.

## Packages

| Package | Platform |
|---|---|
| [`@be-natif/web`](packages/sdk-web) | Browsers (WebLLM on WebGPU, transformers.js) |
| [`@be-natif/react-native`](packages/sdk-react-native) | React Native (llama.rn, GGUF, Metal / Vulkan) |
| [`@be-natif/expo`](packages/sdk-expo) | Expo dev builds (resumable downloads, config plugin) |
| [`@be-natif/core`](packages/sdk-core) | Platform-free logic: model choice, fallback, validation, knowledge, telemetry |
| [`@be-natif/mcp`](packages/mcp) | MCP server so coding assistants can integrate Natif |
| [`Natif`](packages/sdk-swift) (Swift Package) | iOS / macOS (llama.cpp) |
| [`com.benatif`](packages/sdk-kotlin) (Gradle) | Android / JVM (llama.cpp via JNI) |

Also: `examples/web-checkin`, an example app that processes a daily check-in on the device.

> **Status:** early preview. Web, React Native and Expo run end to end; Swift and Kotlin build and pass their tests but have not been verified on physical devices yet. APIs may change before 1.0.

## Development

```bash
pnpm install
pnpm build              # build the JS packages
pnpm test               # unit tests
pnpm dev:checkin        # example app on http://localhost:5190
```

Swift: `cd packages/sdk-swift && swift test` · Kotlin: `cd packages/sdk-kotlin && ./gradlew test`

See [PRIVACY.md](PRIVACY.md) for exactly which data can leave the device and when.

## License

[Apache-2.0](LICENSE)
