/**
 * The Natif guide, written for AI coding assistants. Single source for the MCP server
 * and the site's /llms.txt and /llms-full.txt.
 */
export const SITE = "https://benatif.com";

export const TOPICS = {
  overview: {
    title: "What Natif is",
    body: `Natif is an SDK that runs AI models on the user's own device (browser via WebGPU, phones via llama.cpp).
For every call it checks the device (GPU, memory the app can use, free storage, measured speed), picks the best model that fits from a curated catalog (Apache-2.0 models only), runs it, validates the output against your schema, and only falls back to the cloud if the device can't AND the user consented.

Use it when: user data is sensitive (health, notes, photos), you want zero per-call cost, offline support, or low latency after the first load.
Don't use it for: tasks that need frontier-model reasoning, very long documents, or apps whose users are mostly on low-end phones without fallback consent.

You ask for a task (extract, chat, classify), never for a model: the SDK picks the model per device and can swap it for a better one without code changes. The same code and the same results on every platform.

Packages (Apache-2.0):
- @be-natif/web — browsers (WebGPU)
- @be-natif/react-native — React Native apps (llama.cpp via llama.rn)
- @be-natif/expo — Expo apps (development build; resumable downloads with expo-file-system)
- Natif (Swift Package) — native iOS/macOS, preview
- com.benatif:natif-android (Kotlin) — native Android, preview
- @be-natif/core — shared logic
- @be-natif/mcp — this guide as an MCP server

Try every endpoint in the browser: ${SITE}/playground/`,
  },
  "install-web": {
    title: "Install (web)",
    body: `npm i @be-natif/web

Requirements: WebGPU for text models (Chrome/Edge 113+ desktop, Safari with WebGPU). Without WebGPU the SDK reports DeviceUnavailableError (reason "no_webgpu") or uses the cloud fallback if allowed.
Bundlers: works with Vite, Next.js (client components only: "use client", never import in server code), webpack 5. The model runs in a Web Worker that the SDK creates; no extra config with Vite. With Next.js, create the client inside useEffect or a lazy module so it never runs during SSR.`,
  },
  "install-react-native": {
    title: "Install (React Native / Expo)",
    body: `npm i @be-natif/react-native zod llama.rn @dr.pogodin/react-native-fs @react-native-async-storage/async-storage react-native-device-info
cd ios && pod install

Using Expo? Prefer @be-natif/expo (see "Install (Expo)").

Models (GGUF) download once into the app's Documents folder (1–2.5 GB). Ask before downloading on cellular data.
The model is freed when the app goes to the background (iOS kills background apps that hold memory); it reloads from disk in a few seconds. Disable with unloadOnBackground: false.
For the best model choice, pass availableMemoryMB: () => yourNativeReading() (iOS os_proc_available_memory, Android ActivityManager.MemoryInfo.availMem).`,
  },
  "install-expo": {
    title: "Install (Expo)",
    body: `npx expo install @be-natif/expo llama.rn expo-file-system expo-device @react-native-async-storage/async-storage zod

app.json: { "expo": { "plugins": ["@be-natif/expo", "llama.rn"] } }
The @be-natif/expo config plugin requests the iOS increased-memory-limit entitlement and Android largeHeap (needed for 1–2.5 GB models).
Needs a development build: npx expo prebuild && npx expo run:ios (or EAS Build). It does not run in Expo Go because llama.rn is native code.

import { createClient } from "@be-natif/expo"; // same API as natif and @be-natif/react-native
Model downloads are resumable: if the app goes to the background or is killed mid-download, the next attempt continues where it stopped.`,
  },
  "install-native": {
    title: "Install (Swift / Kotlin, preview)",
    body: `Swift (iOS 17+ / macOS 14+), Swift Package Manager, product "Natif":
let ai = Natif(NatifOptions())
let r = try await ai.chat(ChatRequest(message: "Hi"))

Kotlin (Android, minSdk 26, arm64-v8a):
val ai = Natif.create(context, ClientOptions())
val r = ai.chat(ChatRequest("Hi"))

Same tasks, same model catalog, same selection rules and same knowledge/grounding behavior as the JS SDKs (both use llama.cpp). Preview: not yet published to SPM/Maven; cloud fallback and telemetry are not available yet in the native SDKs.`,
  },
  knowledge: {
    title: "Your own knowledge (RAG, grounding, citations)",
    body: `Natif never stores your data. You give the client your knowledge and it adds the relevant passages to each chat turn:

const ai = createClient({
  knowledge: {
    docs: [{ id: "faq", title: "FAQ", text: faqMarkdown }],       // a few documents: ranked locally (BM25)
    retrieve: async (query, { topK }) => myVectorDb.search(query, topK), // your existing RAG / vector DB / search API
    topK: 4,
    maxContextChars: 6000,
  },
  grounding: "strict", // "off" | "prefer" (default with knowledge) | "strict": answer only from the sources
});
const r = await ai.chat({ message: "Do you ship to Chile?" });
// r.sources: [{ n: 1, id: "faq#2", title: "FAQ", snippet, cited: true }]  → show citations

Passages go into the last user turn only, so the system prompt and earlier turns stay cached; r.history keeps the plain message.
Use retrieve for big corpora (Pinecone, pgvector, Supabase, Algolia, an internal API); docs for FAQs and catalogs. Per call: ai.chat({ message, grounding: "off" }).
Facts belong in knowledge, not in fine-tuning: retraining doesn't stop a model from inventing and must be redone whenever the data changes.`,
  },
  classify: {
    title: "Classification (classify)",
    body: `const { label, meta } = await ai.classify({ text: "I was charged twice", labels: ["billing", "bug", "feature-request"] });
Constrained to one of your labels. Add instructions to explain borderline cases. Runs on the device like extract.`,
  },
  preload: {
    title: "Download ahead of time (download)",
    body: `const r = await ai.download({ onProgress: (p) => setProgress(p.progress) });
// { modelId, engineModelId, downloadBytes } or { unavailable: reason }

Puts the model this device would use on disk WITHOUT loading it into GPU/RAM, so the first real call only compiles (seconds instead of minutes). Resumes an interrupted download (web: per ~30 MB shard; mobile: HTTP resume).
Good places: your landing page after it has loaded and the browser is idle, onboarding, or "on Wi-Fi" on mobile. Skip it when navigator.connection.saveData is set or on cellular, and show a small "Preparing AI · 45% · Pause" notice: ${SITE} does exactly this.`,
  },
  extract: {
    title: "Structured extraction (extract)",
    body: `import { createClient } from "@be-natif/web"; // or "@be-natif/react-native"
import { z } from "zod";

const ai = createClient({
  tasks: {
    "daily-checkin": {
      systemPrompt: "Score the user's wellbeing check-in. mood: 1 = very bad, 10 = great. stress: 1 = calm, 10 = overwhelmed.",
    },
  },
  onDownloadProgress: (p) => setProgress(p.progress), // 0..1, phases: download | compile | ready
});

const CheckIn = z.object({
  mood: z.number().int().min(1).max(10),
  stress: z.number().int().min(1).max(10),
});

const { data, meta } = await ai.extractWithMeta({ task: "daily-checkin", schema: CheckIn, input: { text } });
// meta: { runtime: "device" | "cloud", modelId, latencyMs, tokensIn, tokensOut, estimatedSavingsUsd, fallbackReason?, repaired? }

Output is generated under the JSON Schema (constrained decoding), parsed and validated with zod; on failure the model gets one repair attempt, then SchemaValidationError.
Tips: write an explicit rubric in systemPrompt (what each number means) for consistent scores; keep schemas small and flat; temperature defaults to 0 for repeatable results.`,
  },
  json: {
    title: "JSON output with any schema (chat + schema)",
    body: `// No task needed: pass a JSON Schema (plain object) or a zod schema to chat().
const r = await ai.chat({
  system: "You design tiny arcade games.",
  message: "A game where I catch empanadas and dodge rocks",
  schema: {
    type: "object",
    properties: { title: { type: "string" }, lives: { type: "integer" } },
    required: ["title", "lives"],
  },
  maxTokens: 400,
});
r.data; // { title: "Empanada Escape", lives: 3 }

Generation is constrained to the schema, thinking is turned off, and the result is parsed (and validated, with zod). One repair attempt, then SchemaValidationError.
Use it to build multi-step pipelines in your app: each step is a chat() call with its own system prompt and schema. Natif does not orchestrate the steps: your app does.`,
  },
  context: {
    title: "Long prompts and outputs (contextWindow)",
    body: `const ai = createClient({ contextWindow: 12288 }); // tokens of prompt + output

Default: the engine's (4096 on native). Raise it for long inputs or long outputs such as generated code. It uses more memory (KV cache), so keep it as small as the job allows. Exceeding it throws ContextWindowSizeExceededError.`,
  },
  image: {
    title: "Generate an image (web)",
    body: `const { blob, width, height, meta } = await ai.image({
  prompt: "pixel art knight, white background",
  onProgress: (p) => setProgress(p.progress), // first use downloads ~1.4 GB, then cached
});
img.src = URL.createObjectURL(blob); // 384×384 PNG

Janus-Pro-1B on WebGPU, in its own worker. By default the text model is unloaded first so only one large model is in memory (pass keepTextModel: true to skip). ai.unload() frees both; weights stay cached. Web only for now (needs WebGPU).`,
  },
  chat: {
    title: "Chat (streaming, history)",
    body: `const r = await ai.chat({
  system: "You are a friendly barista.",   // keep identical across turns
  history,                                  // previous turns, owned by your app
  message: userText,                        // the new user message
  onToken: (d) => append(d),                // streaming
  signal: controller.signal,                // stop button
  maxHistoryMessages: 20,                   // optional, default 20
});
history = r.history;                        // history + user message + reply; store it and pass it next turn
// r.meta: { modelId, ttftMs, decodeTokPerSec, cachedTokens?, droppedMessages, ... }

Performance is shared work. The SDK:
- reuses the engine's KV cache when the new prompt starts with the previous one (same system + same earlier turns),
- trims history in blocks (down to half of maxHistoryMessages) instead of one message per turn, so the cached prefix survives several turns,
- frees the model after idleUnloadMs (default 2 min) and keeps the weights on disk.
Your app should:
- keep the system prompt identical across turns (changing it re-processes everything),
- keep history append-only (don't edit or reorder old turns),
- keep maxTokens small for chat (128–512),
- summarize very long conversations yourself and start a new history with the summary,
- call ai.prepare() during onboarding so the first message isn't the slow one.
Chat runs on the device only (no cloud fallback yet); without a usable GPU it throws DeviceUnavailableError.`,
  },
  tasks: {
    title: "Tasks",
    body: `A task is the prompt and settings for one job, referenced by slug.
Fields: systemPrompt (required), temperature (default 0), maxTokens (default 256), minDeviceTokPerSec (default 8, below this the device counts as too slow), recommendedModel (catalog id to try first), deviceOnly (never send input to the cloud).
Define them in code (createClient({ tasks })) or publish them from the dashboard to change prompts without shipping a new app version. Published tasks are cached with ETag and keep working offline.`,
  },
  models: {
    title: "Model catalog and selection",
    body: `| id | tier | memory | capabilities | web | react-native | license |
| qwen3-4b | high | 3.4 GB | text | yes | yes (Q4_K_M GGUF) | Apache-2.0 |
| gemma-4-e2b | high | 3.4 GB | text, vision | yes | no | Apache-2.0 |
| qwen3-1.7b | low | 2.0 GB | text | yes | yes (Q8_0 GGUF) | Apache-2.0 |

Selection order: GPU available (web) → fits the memory budget → enough storage (skipped if already downloaded) → measured speed ≥ minDeviceTokPerSec → anonymous speed data from similar devices. If a model fails to load or is too slow, the next one is tried.
Measured (M2 Max, Chrome, cached): qwen3-4b ~2 s per structured extraction, ~45 tok/s in chat, first word ~0.3 s. First download + compile: 47–130 s.`,
  },
  memory: {
    title: "Memory budget",
    body: `Natif budgets on memory the app can USE, not installed RAM, so it never slows the user's device down.
- memoryBudgetMB option → exactly that.
- Phones: 60% of the available memory (from availableMemoryMB or the GPU working-set limit).
- Browsers can't read free RAM: 50% of the reported total, capped at 4 GB per model.
On the web, set memoryBudgetMB if you know your audience (e.g. 2500 forces the small model).`,
  },
  fallback: {
    title: "Cloud fallback and consent",
    body: `When the device can't (no GPU, out of memory, too slow, invalid output after repair, timeout) the same extract call can run in the cloud with the same schema, only if:
- the user consented: createClient({ consent: { cloudFallback: true } }) or ai.setConsent(...),
- the project/task isn't device-only (enforced server-side),
- the project has budget left (needs apiKey + baseUrl).
Otherwise you get DeviceUnavailableError with .reason. Ask for consent in plain words, e.g. "If your device can't, may we process this text on our server? It isn't stored."`,
  },
  "loading-ux": {
    title: "Loading UX",
    body: `The first run downloads the model (1–2.5 GB). Treat it like a game's loading screen:
- show onDownloadProgress (phase "download" then "compile"),
- call await ai.prepare({ task }) during onboarding or after the user opts in,
- check await ai.capabilities() first to know if the device can run it at all (no download),
- on mobile, ask before downloading on cellular,
- or call ai.download() early (landing page, onboarding) so the weights are already on disk,
- later loads come from cache in 2–6 s.`,
  },
  errors: {
    title: "Errors",
    body: `DeviceUnavailableError (.reason: no_webgpu | insufficient_memory | insufficient_storage | benchmark_slow | known_slow_device | load_failed | timeout | …): the device can't and the cloud isn't allowed.
SchemaValidationError (.issues, .raw): output didn't match after one repair.
CloudFallbackError (.status): the cloud call failed (429 rate limit, 402 budget, 403 device-only).
TaskNotFoundError: unknown task slug.`,
  },
  privacy: {
    title: "Privacy",
    body: `User input and results stay on the device. They only leave in a consented cloud fallback and are not stored by Natif.
Telemetry (only with consent.telemetry) is a closed list: model, latency, tokens, outcome, device class, SDK version. Device class = hash of coarse traits, used only with ≥ 20 devices per class.`,
  },
} as const;

export type Topic = keyof typeof TOPICS;
export const TOPIC_IDS = Object.keys(TOPICS) as [Topic, ...Topic[]];

export function fullGuide(): string {
  return [`# Natif — on-device AI SDK\n\nDocs: ${SITE}/docs/ · Playground: ${SITE}/playground/ · MCP: npx -y @be-natif/mcp`, ...TOPIC_IDS.map((t) => `## ${TOPICS[t].title}\n\n${TOPICS[t].body}`)].join("\n\n");
}

export function llmsTxt(): string {
  return `# Natif

> On-device AI SDK. Runs LLMs (and voice/image models) on the user's device with WebGPU or llama.cpp, picks the right model per device, validates structured output with zod, and falls back to the cloud only with consent. Apache-2.0.

## Docs
${TOPIC_IDS.map((t) => `- [${TOPICS[t].title}](${SITE}/llms-full.txt#${t}): ${TOPICS[t].body.split("\n")[0]!.slice(0, 140)}`).join("\n")}

## Tools
- MCP server: \`npx -y @be-natif/mcp\` (tools: get_started, get_docs, list_models, recommend_model, design_task)
- Full guide in one file: ${SITE}/llms-full.txt
`;
}

/** The prompt users paste into their AI assistant ("Copy prompt" button). */
export function implementPrompt(site = SITE): string {
  return `Add on-device AI to this project using Natif (${site}).

1. Read the guide: ${site}/llms-full.txt (or use the Natif MCP server if it's connected: tools get_started, get_docs, design_task).
2. Detect the platform: web app → @be-natif/web; Expo app → @be-natif/expo; React Native app → @be-natif/react-native; native iOS → Natif (Swift); native Android → com.benatif (Kotlin).
3. Find the best place in this codebase where an AI feature on the user's own device adds value (e.g. classifying, scoring or extracting data from user text, a private chat). Propose it to me in 2–3 lines before writing code.
4. Implement it:
   - one shared client (createClient) with tasks defined in code,
   - if the feature should answer from the project's own data, connect it with knowledge (docs or retrieve) and grounding "strict",
   - a zod schema for structured output (ai.extract) or ai.chat with app-owned history,
   - a loading state with onDownloadProgress (the first download is 1–2.5 GB) and ai.prepare() at a sensible moment,
   - handle DeviceUnavailableError with a friendly message,
   - consent.cloudFallback stays false unless I say otherwise.
5. Follow the project's existing code style, add a test if the project has tests, and tell me how to try it.`;
}
