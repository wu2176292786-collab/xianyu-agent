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

/** 推理模型（MiniMax-M3、DeepSeek-R1 等）会把思考过程混在正文里。 */
const THINK_BLOCK = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
const OPEN_THINK = /<(think|thinking)>/i;

/** 抓所有像数字的东西：¥3,900.00 / 3900 / 3,900元 / 24 都算。 */
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(NUMBER)) {
    const value = Number(match[0].replace(/,/g, ""));
    if (Number.isFinite(value)) found.add(value);
  }
  return found;
}

export interface PolishGuards {
  /** 必须保留的数值，比如按底价算出来的还价（单位：元） */
  mustKeep?: number[];
}

/**
 * 判断模型的输出能不能用。
 *
 * 三道关卡：
 * 1. 剥掉 `<think>` 思考块；剩下没闭合的说明输出被截断了，直接弃用；
 * 2. 输出里的每一个数字都必须在草稿里出现过。模型不能凭空造出一个
 *    「最低 3500」，也不能把「24 小时内发出」改成 48 小时；
 * 3. 指定必须保留的数值一个都不能少。
 *
 * 比字符串比对宽松的地方在于只看数值：草稿写「¥3,850.00」，模型写成
 * 「3850」或「3,850 元」都算保住了。删掉买家自己报的那个价也是允许的，
 * 不影响承诺。
 *
 * 任何一关没过就整段弃用、回落到模板 —— 回落的代价只是话说得官方一点，
 * 放过一个编出来的低价代价是真金白银。
 */
export function acceptPolished(
  draft: string,
  raw: string,
  guards: PolishGuards = {},
): string | null {
  const stripped = raw.replace(THINK_BLOCK, "").trim();
  if (stripped.length === 0) return null;
  if (OPEN_THINK.test(stripped)) return null;

  const allowed = numbersIn(draft);
  for (const value of numbersIn(stripped)) {
    if (!allowed.has(value)) return null;
  }

  const kept = numbersIn(stripped);
  for (const value of guards.mustKeep ?? []) {
    if (!kept.has(value)) return null;
  }

  return stripped;
}

export interface PolishResult {
  /** 采用的润色结果；为 null 表示这次回落到模板 */
  text: string | null;
  /**
   * 为什么回落，给人看的一句话。
   *
   * 没配 LLM 时不填 —— 那种情况本来就不该润色，不是「出问题了」。
   * 但「配了却一直回落」和「没配」在界面上必须长得不一样，
   * 否则你会以为模型在干活，其实每一条都是模板。
   */
  fallback?: string;
}

/** 从接口返回里抠出那句人话的错误信息。 */
function errorDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const raw =
      typeof parsed.error === "string"
        ? parsed.error
        : (parsed.error?.message ?? parsed.message);
    return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 120) : undefined;
  } catch {
    const trimmed = body.trim();
    return trimmed ? trimmed.slice(0, 120) : undefined;
  }
}

export async function polishReply(
  draft: string,
  context: string,
  guards: PolishGuards = {},
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PolishResult> {
  const status = llmStatus();
  if (!status.configured) return { text: null };

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${status.baseUrl}/chat/completions`, {
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

    const body = await response.text();

    if (!response.ok) {
      const detail = errorDetail(body);
      // 额度用光、key 失效这类问题不该默默咽掉 —— 不然你会以为模型在干活
      console.warn(`[agent] 模型调用失败 HTTP ${response.status}：${detail ?? "无详情"}`);
      return {
        text: null,
        fallback: `模型调用失败（HTTP ${response.status}${detail ? `：${detail}` : ""}），已回落到模板。`,
      };
    }

    let content: string | undefined;
    try {
      const data = JSON.parse(body) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      content = data.choices?.[0]?.message?.content;
    } catch {
      return { text: null, fallback: "模型返回的不是合法 JSON，已回落到模板。" };
    }

    if (!content) {
      return { text: null, fallback: "模型没有返回正文，已回落到模板。" };
    }

    const accepted = acceptPolished(draft, content, guards);
    if (!accepted) {
      // 回落是安全行为，但得让人知道模型被拦下来了。
      console.warn("[agent] 模型润色未通过校验，已回落到模板草稿。");
      return {
        text: null,
        fallback: "模型改动了草稿里的数字或输出被截断，已弃用并回落到模板。",
      };
    }

    return { text: accepted };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误";
    console.warn(`[agent] 模型调用${reason}，已回落到模板草稿。`);
    return { text: null, fallback: `模型调用${reason}，已回落到模板。` };
  }
}
