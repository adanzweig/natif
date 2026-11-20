import type { ChatMessage, TaskConfig } from "./types";

export function buildExtractMessages(task: TaskConfig, jsonSchema: Record<string, unknown>, text: string): ChatMessage[] {
  const system = [
    task.systemPrompt.trim(),
    task.instructions?.trim(),
    // Engines with constrained decoding enforce this anyway; the rest rely on the prompt.
    `Answer only with a JSON object that follows this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

export const BENCHMARK_MESSAGES: ChatMessage[] = [
  {
    role: "user",
    content: "Write a short paragraph about why the sky is blue. Keep going until you are told to stop.",
  },
];
