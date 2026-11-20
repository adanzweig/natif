import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, parseModelOutput, schemaHash, toJsonSchema } from "../src";

const S = z.object({ mood: z.number().int().min(1).max(10), emotions: z.array(z.string()).max(5) });

describe("extractJson", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['<think>\n\n</think>\n{"a":1}', { a: 1 }],
    ['Sure! ```json\n{"a":{"b":"}"}}\n```', { a: { b: "}" } }],
    ['text [1,2] more', [1, 2]],
    ['{"s":"quote \\" brace {"}', { s: 'quote " brace {' }],
  ])("%s", (raw, expected) => expect(extractJson(raw)).toEqual(expected));

  it("throws without JSON", () => expect(() => extractJson("no json here")).toThrow());
  it("throws on unterminated JSON", () => expect(() => extractJson('{"a":1')).toThrow());
});

describe("parseModelOutput", () => {
  it("valid", () => expect(parseModelOutput(S, '{"mood":7,"emotions":["calma"]}')).toEqual({ ok: true, data: { mood: 7, emotions: ["calma"] } }));
  it("out of range", () => {
    const r = parseModelOutput(S, '{"mood":11,"emotions":[]}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("mood");
  });
  it("not JSON", () => expect(parseModelOutput(S, "hola").ok).toBe(false));
});

describe("schema helpers", () => {
  it("toJsonSchema drops $schema", () => {
    const j = toJsonSchema(S);
    expect(j.$schema).toBeUndefined();
    expect(j.type).toBe("object");
  });
  it("schemaHash ignores key order", async () => {
    expect(await schemaHash({ a: 1, b: { c: 2, d: 3 } })).toBe(await schemaHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(await schemaHash({ a: 1 })).not.toBe(await schemaHash({ a: 2 }));
  });
});
