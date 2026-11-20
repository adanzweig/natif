import { describe, expect, it } from "vitest";
import { chunkDocs, createCoreClient, rankChunks } from "../src";
import { MockEngine, platform } from "./helpers";

const catalog = `Aspirina 500 mg: alivia el dolor de cabeza y la fiebre. Adultos: 1 comprimido cada 6 horas.

Bepanthen crema: para la piel irritada y quemaduras leves.

Redoxon: vitamina C efervescente para reforzar defensas.`;

describe("knowledge", () => {
  it("ranks the passage that matches the question first", () => {
    const chunks = chunkDocs([{ id: "cat", text: catalog.replace(/\n\n/g, "\n\n".repeat(1)) }]);
    // force one chunk per paragraph
    const small = chunkDocs(catalog.split("\n\n").map((t, i) => ({ id: `p${i}`, text: t })));
    expect(chunks.length).toBeGreaterThan(0);
    const top = rankChunks(small, "¿Qué tomo para el dolor de cabeza?", 2);
    expect(top[0]!.id).toBe("p0#1");
  });

  it("puts sources in the last user turn, keeps history clean and returns citations", async () => {
    const engine = new MockEngine();
    engine.generate = async (req) => {
      engine.calls.push(req);
      return { text: "Podés tomar Aspirina 500 mg [1].", promptTokens: 10, completionTokens: 5, ttftMs: 1, totalMs: 2, decodeTokPerSec: 40 };
    };
    const ai = createCoreClient({ knowledge: { docs: [{ id: "cat", title: "Catálogo", text: catalog }] }, grounding: "strict" }, platform(engine));
    const r = await ai.chat({ system: "Sos el asistente de la farmacia.", message: "¿Qué tomo para el dolor de cabeza?" });
    const sent = engine.calls.at(-1)!.messages;
    expect(sent[0]).toEqual({ role: "system", content: "Sos el asistente de la farmacia." });
    expect(sent.at(-1)!.content).toMatch(/Sources:\n\[1\] Catálogo:/);
    expect(sent.at(-1)!.content).toMatch(/ONLY the sources/);
    expect(r.history.at(-2)).toEqual({ role: "user", content: "¿Qué tomo para el dolor de cabeza?" });
    expect(r.sources?.[0]).toMatchObject({ n: 1, id: "cat#1", cited: true });
  });

  it("calls the app's own retrieve and skips knowledge when grounding is off", async () => {
    const engine = new MockEngine();
    engine.generate = async (req) => { engine.calls.push(req); return { text: "ok", promptTokens: 1, completionTokens: 1, ttftMs: 1, totalMs: 1, decodeTokPerSec: 40 }; };
    const asked: string[] = [];
    const ai = createCoreClient({ knowledge: { retrieve: async (q) => { asked.push(q); return ["Envíos gratis desde USD 50."]; } } }, platform(engine));
    const r = await ai.chat({ message: "¿El envío es gratis?" });
    expect(asked).toEqual(["¿El envío es gratis?"]);
    expect(engine.calls.at(-1)!.messages.at(-1)!.content).toMatch(/\[1\] Envíos gratis/);
    expect(r.sources).toHaveLength(1);
    await ai.chat({ message: "hola", grounding: "off" });
    expect(asked).toHaveLength(1);
    expect(engine.calls.at(-1)!.messages.at(-1)!.content).toBe("hola");
  });
});
