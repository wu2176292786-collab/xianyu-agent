import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { llmApiKey, llmStatus } from "@/lib/agent/llm";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 跟现有润色层同一套：OPENAI_API_KEY / BASE_URL / MODEL。 */
export function piConfigured(): boolean {
  return llmStatus().configured;
}

export function piModel(): Model<"openai-completions"> {
  const status = llmStatus();
  return {
    id: status.model,
    name: status.model,
    api: "openai-completions",
    provider: "openai",
    baseUrl: status.baseUrl.replace(/\/$/, ""),
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

export const piStreamFn: StreamFn = (model, context, options) => {
  if (model.api !== "openai-completions") {
    throw new Error(`不支持的模型接口：${model.api}`);
  }
  return streamSimple(model as Model<"openai-completions">, context, {
    ...options,
    apiKey: llmApiKey(),
  });
};
