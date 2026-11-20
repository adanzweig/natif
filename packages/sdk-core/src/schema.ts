import { sha256Hex } from "./sha256";
import { z } from "zod";

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * Models wrap JSON in thinking tags, code fences or chatter. Take the first top-level
 * JSON object or array out of the text.
 */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through to scanning
  }
  const start = text.search(/[{[]/);
  if (start < 0) throw new SyntaxError("No JSON found in model output");
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new SyntaxError("Unterminated JSON in model output");
}

export type ParseOutcome<T> = { ok: true; data: T } | { ok: false; error: string; issues?: unknown };

export function parseModelOutput<S extends z.ZodType>(schema: S, raw: string): ParseOutcome<z.infer<S>> {
  let value: unknown;
  try {
    value = extractJson(raw);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: z.prettifyError(result.error), issues: result.error.issues };
}

/** Message appended for the single repair attempt. */
export function repairMessage(error: string): string {
  return `Your previous answer was not valid for the required JSON schema:\n${error}\nReply again with only the corrected JSON object.`;
}

/** Stable hash of a JSON Schema, to warn when code and dashboard schemas drift. */
export async function schemaHash(json: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(sortKeys(json));
  return (await sha256Hex(canonical)).slice(0, 16);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}
