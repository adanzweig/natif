import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

// One engine per Worker: keeps WebGPU state of the LLM isolated from other engines (see PLAN §5).
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);
