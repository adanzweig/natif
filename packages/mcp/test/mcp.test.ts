import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createNatifMcpServer, llmsTxt, fullGuide } from "../src";

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([createNatifMcpServer().connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: any) => r.content[0].text as string;

describe("benatif MCP", () => {
  it("lists the tools, resources and prompt", async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["design_task", "get_docs", "get_started", "list_models", "recommend_model"]);
    expect((await c.listResources()).resources.length).toBeGreaterThan(5);
    expect((await c.listPrompts()).prompts[0]!.name).toBe("add-on-device-ai");
  });

  it("get_started gives the right package per platform", async () => {
    const c = await connect();
    expect(textOf(await c.callTool({ name: "get_started", arguments: { platform: "react-native", framework: "expo" } }))).toContain("@be-natif/react-native");
    expect(textOf(await c.callTool({ name: "get_started", arguments: { platform: "web", framework: "next" } }))).toContain("use client");
  });

  it("recommend_model uses available memory, not installed RAM", async () => {
    const c = await connect();
    const big = textOf(await c.callTool({ name: "recommend_model", arguments: { platform: "ios", total_ram_gb: 8, available_ram_gb: 6 } }));
    const tight = textOf(await c.callTool({ name: "recommend_model", arguments: { platform: "ios", total_ram_gb: 8, available_ram_gb: 3.5 } }));
    expect(big).toContain("Pick: qwen3-4b");
    expect(tight).toContain("Pick: qwen3-1.7b");
    const noGpu = textOf(await c.callTool({ name: "recommend_model", arguments: { platform: "web", total_ram_gb: 16, has_gpu: false } }));
    expect(noGpu).toContain("no_webgpu");
  });

  it("design_task generates a schema and a typed runner", async () => {
    const c = await connect();
    const code = textOf(
      await c.callTool({
        name: "design_task",
        arguments: { slug: "review-sentiment", description: "Classify a product review.", fields: [{ name: "sentiment", type: "enum", values: ["positive", "neutral", "negative"] }, { name: "stars", type: "integer", min: 1, max: 5 }] },
      }),
    );
    expect(code).toContain('sentiment: z.enum(["positive","neutral","negative"])');
    expect(code).toContain("stars: z.number().int().min(1).max(5)");
    expect(code).toContain("export async function runReviewSentiment");
  });

  it("produces llms.txt and the full guide", () => {
    expect(llmsTxt()).toMatch(/^# Natif/);
    expect(fullGuide()).toContain("## Chat (streaming, history)");
  });
});
