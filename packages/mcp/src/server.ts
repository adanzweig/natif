import { MODEL_CATALOG, memoryBudgetMB, selectModel, type DeviceProfile, type ModelSpec } from "@be-natif/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { designTask } from "./codegen";
import { implementPrompt, SITE, TOPIC_IDS, TOPICS, type Topic } from "./content";

export const VERSION = "0.1.0";
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function startCode(platform: "web" | "react-native", framework?: string): string {
  const pkg = platform === "web" ? "@be-natif/web" : "@be-natif/react-native";
  const install = platform === "web" ? TOPICS["install-web"].body : TOPICS["install-react-native"].body;
  const frameworkNote =
    framework === "next"
      ? "\nNext.js: put this in a client component file (\"use client\") and create the client lazily (inside useEffect or a module imported only on the client)."
      : framework === "expo"
        ? "\nExpo: requires a development build (npx expo prebuild && npx expo run:ios); Expo Go can't load native modules."
        : "";
  return `${install}${frameworkNote}

// ai.ts — one shared client for the app
import { createClient } from "${pkg}";
export const ai = createClient({
  tasks: { /* "my-task": { systemPrompt: "..." } */ },
  consent: { cloudFallback: false, telemetry: false },
  onDownloadProgress: (p) => console.log(p.phase, Math.round(p.progress * 100) + "%"),
});

Next: use get_docs("extract") for structured output or get_docs("chat") for conversations, and design_task to generate a schema + task.`;
}

/** Builds the MCP server. Transport-agnostic (stdio in the CLI, HTTP in the hosted endpoint). */
export function createNatifMcpServer(): McpServer {
  const server = new McpServer(
    { name: "natif", version: VERSION },
    { instructions: `Natif helps add on-device AI (LLMs running on the user's device) to web and React Native apps. Start with get_started, then get_docs and design_task. Full guide: ${SITE}/llms-full.txt` },
  );

  server.registerTool(
    "get_started",
    {
      title: "Get started with Natif",
      description: "Install command and the minimal client setup for a platform. Call this first when adding Natif to a project.",
      inputSchema: {
        platform: z.enum(["web", "react-native"]).describe("web for browser apps (React, Vue, Next.js, vanilla); react-native for iOS/Android apps (bare or Expo)"),
        framework: z.enum(["react", "next", "vue", "svelte", "vanilla", "expo", "bare"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ platform, framework }) => text(startCode(platform, framework)),
  );

  server.registerTool(
    "get_docs",
    {
      title: "Natif docs",
      description: `Documentation for one topic. Topics: ${TOPIC_IDS.map((t) => `${t} (${TOPICS[t].title})`).join(", ")}.`,
      inputSchema: { topic: z.enum(TOPIC_IDS) },
      annotations: { readOnlyHint: true },
    },
    async ({ topic }) => text(`# ${TOPICS[topic as Topic].title}\n\n${TOPICS[topic as Topic].body}`),
  );

  server.registerTool(
    "list_models",
    {
      title: "List on-device models",
      description: "The curated model catalog: memory needed, download size, capabilities, licenses and which platforms run each one.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        MODEL_CATALOG.map(
          (m: ModelSpec) =>
            `- ${m.id} (${m.family}, tier ${m.tier}): ${m.capabilities.join(", ")}; memory ${(m.memoryRequiredMB / 1024).toFixed(1)} GB; download ${(m.downloadBytes / 1e9).toFixed(1)} GB; ${m.license}; web ${m.runtimes.webllm ? "yes" : "no"}, react-native ${m.runtimes.gguf ? "yes" : "no"}`,
        ).join("\n"),
      ),
  );

  server.registerTool(
    "recommend_model",
    {
      title: "Recommend a model for a device",
      description: "Which catalog model Natif would pick for a given device, and why the others don't fit. Useful to set expectations for the app's target users.",
      inputSchema: {
        platform: z.enum(["web", "ios", "android"]),
        total_ram_gb: z.number().positive().describe("Installed RAM"),
        available_ram_gb: z.number().positive().optional().describe("RAM the app can use now (phones). Omit for browsers."),
        has_gpu: z.boolean().default(true).describe("WebGPU in browsers; Metal/Vulkan on phones"),
        free_storage_gb: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const device: DeviceProfile = {
        platform: a.platform,
        gpu: { available: a.has_gpu },
        memoryGB: a.total_ram_gb,
        availableMemoryMB: a.available_ram_gb ? a.available_ram_gb * 1024 : undefined,
        storageFreeBytes: a.free_storage_gb ? a.free_storage_gb * 1e9 : undefined,
      };
      const engine = { resolveModelId: (m: ModelSpec) => (a.platform === "web" ? m.runtimes.webllm?.f16 : m.runtimes.gguf ? m.id : undefined) };
      const sel = selectModel({ device, capability: "text", catalog: MODEL_CATALOG, engine, minDeviceTokPerSec: 8 });
      const budget = Math.round(memoryBudgetMB(device));
      const rejected = Object.entries(sel.rejected).map(([id, r]) => `${id}: ${r}`).join("; ") || "none";
      return text(
        sel.ok
          ? `Pick: ${sel.spec.id} (memory budget ${budget} MB). Rejected: ${rejected}.`
          : `No on-device model fits (${sel.reason}, memory budget ${budget} MB). Rejected: ${rejected}. Options: cloud fallback with consent, or a lower memoryBudgetMB/smaller task.`,
      );
    },
  );

  server.registerTool(
    "design_task",
    {
      title: "Generate a task + schema",
      description: "Generates ready-to-paste TypeScript: a zod schema, a task with a rubric prompt, and a typed function that runs it on the device. Edit the rubric descriptions; they drive output quality.",
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9-]{2,40}$/).describe("kebab-case task id, e.g. 'review-sentiment'"),
        description: z.string().min(10).describe("What the model should do, as a system prompt"),
        fields: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(["integer", "number", "string", "boolean", "enum", "string[]"]),
              description: z.string().optional(),
              min: z.number().optional(),
              max: z.number().optional(),
              values: z.array(z.string()).optional().describe("for enum"),
              optional: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(12),
        platform: z.enum(["web", "react-native"]).default("web"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => text(designTask(a)),
  );

  for (const t of TOPIC_IDS) {
    server.registerResource(t, `benatif://docs/${t}`, { title: TOPICS[t].title, mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: `# ${TOPICS[t].title}\n\n${TOPICS[t].body}` }],
    }));
  }

  server.registerPrompt(
    "add-on-device-ai",
    { title: "Add on-device AI to this project", description: "Step-by-step instructions for the assistant to add Natif to the current codebase." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: implementPrompt() } }] }),
  );

  return server;
}
