import { CloudFallbackError } from "./errors";

export interface CloudExtractResponse {
  data: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function cloudExtract(opts: {
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
  task: string;
  taskVersion: number;
  text: string;
  jsonSchema: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<CloudExtractResponse> {
  const res = await opts.fetch(`${opts.baseUrl}/v1/fallback/extract`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": opts.apiKey },
    body: JSON.stringify({ task: opts.task, taskVersion: opts.taskVersion, input: { text: opts.text }, jsonSchema: opts.jsonSchema }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // keep statusText
    }
    throw new CloudFallbackError(res.status, message);
  }
  return (await res.json()) as CloudExtractResponse;
}

/** USD per million tokens of the cloud model used as the "what you would have paid" reference. */
export interface PriceReference {
  model: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** Conservative default: the cheapest current Claude model, so savings are never overstated. */
export const DEFAULT_PRICE_REFERENCE: PriceReference = {
  model: "claude-haiku-5-5",
  inputUsdPerMTok: 0.1,
  outputUsdPerMTok: 0.5,
};

export function estimateSavingsUsd(tokensIn: number, tokensOut: number, ref: PriceReference = DEFAULT_PRICE_REFERENCE): number {
  return (tokensIn * ref.inputUsdPerMTok + tokensOut * ref.outputUsdPerMTok) / 1e6;
}
