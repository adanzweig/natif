export interface FieldSpec {
  name: string;
  type: "integer" | "number" | "string" | "boolean" | "enum" | "string[]";
  description?: string;
  min?: number;
  max?: number;
  values?: string[];
  optional?: boolean;
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^(\d)/, "_$1");
const camel = (s: string) => s.replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase());

function zodFor(f: FieldSpec): string {
  let z: string;
  switch (f.type) {
    case "integer":
    case "number":
      z = `z.number()${f.type === "integer" ? ".int()" : ""}${f.min !== undefined ? `.min(${f.min})` : ""}${f.max !== undefined ? `.max(${f.max})` : ""}`;
      break;
    case "boolean":
      z = "z.boolean()";
      break;
    case "enum":
      z = `z.enum(${JSON.stringify(f.values ?? [])})`;
      break;
    case "string[]":
      z = `z.array(z.string().max(80)).max(${f.max ?? 5})`;
      break;
    default:
      z = `z.string().max(${f.max ?? 200})`;
  }
  if (f.description) z += `.describe(${JSON.stringify(f.description)})`;
  if (f.optional) z += ".optional()";
  return z;
}

/** Deterministic code for a task: schema + task config + call. */
export function designTask(input: { slug: string; description: string; fields: FieldSpec[]; platform?: "web" | "react-native" }): string {
  const name = camel(input.slug);
  const rubric = input.fields
    .map((f) => {
      const range = f.type === "integer" || f.type === "number" ? ` (${f.min ?? "?"}–${f.max ?? "?"})` : f.type === "enum" ? ` (one of: ${(f.values ?? []).join(", ")})` : "";
      return `- ${f.name}${range}: ${f.description ?? "TODO: describe what this field means and how to decide it"}`;
    })
    .join("\\n");
  const pkg = input.platform === "react-native" ? "@be-natif/react-native" : "@be-natif/web";
  return `import { createClient, DeviceUnavailableError } from "${pkg}";
import { z } from "zod";

export const ${name} = z.object({
${input.fields.map((f) => `  ${ident(f.name)}: ${zodFor(f)},`).join("\n")}
});
export type ${name} = z.infer<typeof ${name}>;

export const ai = createClient({
  tasks: {
    ${JSON.stringify(input.slug)}: {
      systemPrompt: ${JSON.stringify(input.description)} + "\\n\\nFields:\\n${rubric}",
      // temperature: 0 (default) gives repeatable results
    },
  },
});

export async function run${name}(text: string): Promise<${name} | null> {
  try {
    return await ai.extract({ task: ${JSON.stringify(input.slug)}, schema: ${name}, input: { text } });
  } catch (e) {
    if (e instanceof DeviceUnavailableError) return null; // show a friendly message; e.reason says why
    throw e;
  }
}
`;
}
