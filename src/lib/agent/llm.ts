/**
 * 可选的 LLM 润色层。
 *
 * 没有配置 `OPENAI_API_KEY` 时整个应用照常工作 —— 回复由 `reply.ts` 里的
 * 确定性模板生成。配置之后，Agent 会在模板基础上做一次口语化润色，
 * 失败时静默回落到模板，绝不阻塞主流程。
 */
export interface LlmStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
}

export function llmStatus(): LlmStatus {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  };
}

const SYSTEM_PROMPT = [
  "你是闲鱼二手卖家的助理。把给定的回复草稿改写得更口语、更像真人卖家，",
  "保持中文、保持所有价格与承诺不变，不要新增任何草稿里没有的承诺或参数，",
  "不要使用 emoji，不超过 3 句话。只输出改写后的正文。",
].join("");

export async function polishReply(
  draft: string,
  context: string,
): Promise<string | null> {
  const status = llmStatus();
  if (!status.configured) return null;

  try {
    const response = await fetch(`${status.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: status.model,
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `背景：${context}\n\n草稿：\n${draft}` },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
