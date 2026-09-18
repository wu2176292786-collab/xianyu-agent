/**
 * 可选的 LLM 润色层。
 *
 * 巡检循环在 pi-agent 上；这里负责回复润色、文案润色、选品对照和同行筛选。
 * 没有配置 `OPENAI_API_KEY` 时巡检按规则跑，回复用 `reply.ts` 模板。
 * 配置之后润色失败会静默回落到模板，绝不阻塞主流程。
 */
import { parseScreenKeepIds } from "@/lib/research/screen";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  readLlmConfigFileSync,
} from "./llm-config";

export interface LlmStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
  /** 配了才在同行筛选里看封面。润色、对照分析仍用 model。 */
  visionModel?: string;
  /** 要不要带上关闭推理过程的非标准字段。严格的网关见到会 400。 */
  sendThinkingHints: boolean;
  /** `mixed` = 密钥来自环境变量，模型这些来自界面上存的配置 */
  origin: "env" | "file" | "mixed" | "none";
  /** 环境变量里有没有配。界面上用来解释"清除之后会退回什么"。 */
  hasEnv: boolean;
}

/**
 * 模型接入现状。
 *
 * 逐字段合并：本机配置覆盖环境变量，本机没填的字段用环境变量兜底。
 *
 * 和登录态那条规矩（环境变量优先、界面改不动）刻意不同 ——
 * 换模型是常规操作，不该逼人改 `.env.local` 再重启整个进程。
 * 密钥仍然是敏感项，所以界面上不填就继续用环境变量那份。
 */
export function llmStatus(): LlmStatus {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  const envBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const envModel = process.env.OPENAI_MODEL?.trim();
  const envVision = process.env.OPENAI_VISION_MODEL?.trim();
  const file = readLlmConfigFileSync();

  const key = file?.apiKey ?? envKey;
  const origin = file
    ? file.apiKey
      ? "file"
      : envKey
        ? "mixed"
        : "file"
    : envKey
      ? "env"
      : "none";

  return {
    configured: Boolean(key),
    model: file?.model ?? envModel ?? DEFAULT_MODEL,
    baseUrl: file?.baseUrl ?? envBaseUrl ?? DEFAULT_BASE_URL,
    visionModel: file?.visionModel ?? envVision ?? undefined,
    sendThinkingHints:
      file?.sendThinkingHints ?? (process.env.OPENAI_THINKING_HINTS !== "0"),
    origin,
    hasEnv: Boolean(envKey),
  };
}

/**
 * 请求体里那两个非标准字段。
 *
 * MiniMax、DeepSeek 这类推理模型靠它们关掉思考过程，
 * 但严格的网关见到不认识的字段会直接 400，所以做成可关。
 */
export function thinkingHints(status: LlmStatus): Record<string, unknown> {
  return status.sendThinkingHints
    ? { thinking: { type: "disabled" }, reasoning_split: true }
    : {};
}

/** 发请求时用的密钥。界面上存过就用它，否则退回环境变量。 */
export function llmApiKey(): string | undefined {
  return readLlmConfigFileSync()?.apiKey || process.env.OPENAI_API_KEY?.trim();
}

const SYSTEM_PROMPT = [
  "你是闲鱼二手卖家的助理。把给定的回复草稿改写得更口语、更像真人卖家，",
  "保持中文、保持所有价格与承诺不变，不要新增任何草稿里没有的承诺或参数，",
  "不要使用 emoji，不超过 3 句话。只输出改写后的正文。",
].join("");

const RESEARCH_SYSTEM_PROMPT = [
  "你是闲鱼卖家的选品参谋。根据给定的本店商品和同行观察，写一段对照分析。",
  "只准用材料里出现过的数字、标题和卖点，不要编价格、想要、浏览、时效或承诺。",
  "不要建议一个材料里没有的具体售价。材料写了中位价，可以说比它高或低，不要另报一个新价。",
  "没有两次商详观察就明说看不出谁在涨，不要猜流量。",
  "只对照材料里规格「可比」的同行。没有可比同行就说搜偏了，不要拿二手书、教材或其他品类的卖点来比服务。",
  "结构：价格位置；流量和热度；同行文案亮点对比本店缺什么；标题/正文可以怎么改（不改价格数字）。",
  "口语中文，最多 4 个短段，不要 emoji，不要话题标签，不要说自己是模型，不要写商品链接。",
].join("");

const COPY_SYSTEM_PROMPT = [
  "你是闲鱼卖家的文案手。根据标题、价格和商详原文，写一份能直接拿去发布的闲鱼文案。",
  "结构：第一行是标题（点明是什么、给谁、有什么），空一行，后面是正文。",
  "正文先写一句钩子，再按「是什么 / 包含什么 / 适合谁 / 怎么用」分段，口语、短句，少用空泛形容词。",
  "可以重排、删水分、换说法。不要编原文没有的售价，不要写新的「只要 xx」。",
  "课时、版本号、年份以原文为准。不要 emoji，不要话题标签，不要商品链接，不要解释自己在做什么。",
  "只有标题、没有正文时，只改标题，不要扩写成一篇。只输出标题和正文。",
].join("");

/** 推理模型（MiniMax-M3、DeepSeek-R1 等）会把思考过程混在正文里。 */
const THINK_BLOCK = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
const OPEN_THINK = /<(think|thinking)>/i;

/** 抓所有像数字的东西：¥3,900.00 / 3900 / 3,900元 / 24 都算。 */
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;

export function numbersIn(text: string): Set<number> {
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
  /**
   * 商品文案：允许 1–49 的结构数字（3 个模块、24 小时），
   * 带小数或 ≥50 的仍视为价格，必须来自原文。
   */
  relaxSmallInts?: boolean;
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
function stripThinking(raw: string): string | null {
  let text = raw.replace(THINK_BLOCK, "").trim();
  if (!text) return null;
  if (OPEN_THINK.test(text)) {
    const afterClose = text.match(/<\/(?:think|thinking)>\s*([\s\S]*)$/i);
    if (afterClose?.[1]?.trim()) {
      text = afterClose[1].trim();
    } else {
      const openAt = text.search(OPEN_THINK);
      text = openAt >= 0 ? text.slice(0, openAt).trim() : "";
    }
  }
  if (!text || OPEN_THINK.test(text)) return null;
  return text;
}

function isStructuralExtra(
  value: number,
  token: string,
  guards: PolishGuards,
): boolean {
  if (!guards.relaxSmallInts) return false;
  if (token.includes(".")) return false;
  return value >= 1 && value <= 49;
}

export function judgePolished(
  draft: string,
  raw: string,
  guards: PolishGuards = {},
): { text: string; reason?: undefined } | { text: null; reason: string } {
  const stripped = stripThinking(raw);
  if (!stripped) {
    return { text: null, reason: "模型输出被截断或只剩思考过程，已弃用。" };
  }

  const allowed = numbersIn(draft);
  const extras: string[] = [];
  for (const match of stripped.matchAll(NUMBER)) {
    const value = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(value) || allowed.has(value)) continue;
    if (isStructuralExtra(value, match[0], guards)) continue;
    extras.push(match[0]);
  }
  if (extras.length > 0) {
    return {
      text: null,
      reason: `模型新写了原文没有的数字（${extras.slice(0, 3).join("、")}），已弃用。`,
    };
  }

  const kept = numbersIn(stripped);
  for (const value of guards.mustKeep ?? []) {
    if (!kept.has(value)) {
      return {
        text: null,
        reason: `模型把必须保留的数字 ${value} 写丢了，已弃用。`,
      };
    }
  }

  return { text: stripped };
}

export function acceptPolished(
  draft: string,
  raw: string,
  guards: PolishGuards = {},
): string | null {
  return judgePolished(draft, raw, guards).text;
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

/** 议价回复短，12 秒够。商品正文长、推理模型更慢，单独放宽。 */
export const REPLY_POLISH_TIMEOUT_MS = 12_000;
export const LISTING_POLISH_TIMEOUT_MS = 60_000;
export const RESEARCH_ANALYZE_TIMEOUT_MS = 60_000;

function unwrapFences(text: string): string {
  const fenced = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return fenced?.[1]?.trim() ?? text;
}

function messageText(body: string): string | undefined {
  const data = JSON.parse(body) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string };
    }>;
  };
  const message = data.choices?.[0]?.message;
  const raw = message?.content || message?.reasoning_content;
  return typeof raw === "string" && raw.trim() ? unwrapFences(raw.trim()) : undefined;
}

async function polishWith(
  system: string,
  draft: string,
  context: string,
  guards: PolishGuards = {},
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    temperature?: number;
    extraBody?: Record<string, unknown>;
    userContent?: string;
  } = {},
): Promise<PolishResult> {
  const status = llmStatus();
  if (!status.configured) return { text: null };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REPLY_POLISH_TIMEOUT_MS;

  try {
    const response = await fetchImpl(`${status.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llmApiKey() ?? ""}`,
      },
      body: JSON.stringify({
        model: status.model,
        temperature: options.temperature ?? 0.4,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              options.userContent ?? `背景：${context}\n\n草稿：\n${draft}`,
          },
        ],
        ...options.extraBody,
      }),
      signal: AbortSignal.timeout(timeoutMs),
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
      content = messageText(body);
    } catch {
      return { text: null, fallback: "模型返回的不是合法 JSON，已回落到模板。" };
    }

    if (!content) {
      return { text: null, fallback: "模型没有返回正文，已回落到模板。" };
    }

    const verdict = judgePolished(draft, content, guards);
    if (!verdict.text) {
      console.warn(`[agent] 模型润色未通过校验：${verdict.reason}`);
      return {
        text: null,
        fallback: verdict.reason ?? "润色没通过校验，原文未改。",
      };
    }

    return { text: verdict.text };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误";
    console.warn(`[agent] 模型调用${reason}，已回落到模板草稿。`);
    return { text: null, fallback: `模型调用${reason}，已回落到模板。` };
  }
}

export async function polishReply(
  draft: string,
  context: string,
  guards: PolishGuards = {},
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PolishResult> {
  return polishWith(SYSTEM_PROMPT, draft, context, guards, {
    ...options,
    timeoutMs: options.timeoutMs ?? REPLY_POLISH_TIMEOUT_MS,
  });
}

/** 根据观察点写对照分析。数字守卫和润色同一套：材料里没有的数不能出现。 */
export async function analyzeCompetition(
  brief: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PolishResult> {
  return polishWith(
    RESEARCH_SYSTEM_PROMPT,
    brief,
    "",
    { relaxSmallInts: true },
    {
      ...options,
      timeoutMs: options.timeoutMs ?? RESEARCH_ANALYZE_TIMEOUT_MS,
      temperature: 0.3,
      userContent: `${brief}\n\n请根据以上观察写对照分析。`,
      extraBody: thinkingHints(llmStatus()),
    },
  );
}

/** 把采集到的商品文案改写成能直接发布的闲鱼稿。价格类数字仍不能编。 */
export async function polishListingCopy(
  draft: string,
  context: string,
  guards: PolishGuards = {},
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PolishResult> {
  return polishWith(
    COPY_SYSTEM_PROMPT,
    draft,
    context,
    { ...guards, relaxSmallInts: guards.relaxSmallInts ?? true },
    {
      ...options,
      timeoutMs: options.timeoutMs ?? LISTING_POLISH_TIMEOUT_MS,
      temperature: 0.7,
      userContent: `${context}\n\n${draft}\n\n请写成可直接发布的闲鱼文案。`,
      extraBody: thinkingHints(llmStatus()),
    },
  );
}

const SCREEN_SYSTEM_PROMPT = [
  "你是闲鱼选品审核。根据本店商品判断每件候选是不是同一类、可以对价格和文案的货。",
  "本店卖服务，只留同类服务；二手书、教材、教辅、ISBN、出版社图书一律 keep=false。",
  "只输出 JSON 数组，不要解释。格式：[{\"itemId\":\"...\",\"keep\":true}]",
  "itemId 必须来自候选列表，不要编新的。拿不准就 keep=false。",
].join("");

export interface ScreenCandidate {
  itemId: string;
  title: string;
  copy?: string;
  imageUrl?: string;
}

export const SCREEN_VISION_BATCH = 8;

type ScreenUserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string; detail: "low" } }
    >;

function screenUserText(
  listing: { title: string; copy?: string },
  candidates: ScreenCandidate[],
): string {
  const listingCopy = listing.copy?.replace(/\s+/g, " ").trim().slice(0, 240) || "（没有正文）";
  const lines = candidates.map(
    (item, index) =>
      `${index + 1}. itemId=${item.itemId} 标题：${item.title} 正文：${(item.copy ?? "（没有正文）").replace(/\s+/g, " ").trim().slice(0, 120)}`,
  );
  return [
    `本店标题：${listing.title}`,
    `本店正文：${listingCopy}`,
    "",
    "候选：",
    ...lines,
    "",
    "只输出 JSON 数组。",
  ].join("\n");
}

function screenUserVision(
  listing: { title: string; copy?: string },
  candidates: ScreenCandidate[],
): ScreenUserContent {
  const parts: Extract<ScreenUserContent, unknown[]> = [
    { type: "text", text: screenUserText(listing, candidates) },
  ];
  for (const item of candidates) {
    if (!item.imageUrl) {
      parts.push({ type: "text", text: `${item.itemId} 没有封面` });
      continue;
    }
    parts.push({ type: "text", text: `${item.itemId} 封面` });
    parts.push({
      type: "image_url",
      image_url: { url: item.imageUrl, detail: "low" },
    });
  }
  return parts;
}

async function callScreenModel(
  model: string,
  userContent: ScreenUserContent,
  allowed: string[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ keepIds: string[]; parsed: boolean; fallback?: string }> {
  const status = llmStatus();
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${status.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llmApiKey() ?? ""}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: SCREEN_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        ...thinkingHints(status),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? RESEARCH_ANALYZE_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = errorDetail(body);
      return {
        keepIds: [],
        parsed: false,
        fallback: `筛选调用失败（HTTP ${response.status}${detail ? `：${detail}` : ""}）`,
      };
    }
    const content = messageText(body);
    if (!content) return { keepIds: [], parsed: false, fallback: "筛选没有返回正文。" };
    return parseScreenKeepIds(content, allowed);
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误";
    return { keepIds: [], parsed: false, fallback: `筛选调用${reason}。` };
  }
}

async function screenWithVision(
  listing: { title: string; copy?: string },
  candidates: ScreenCandidate[],
  visionModel: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ keepIds: string[]; parsed: boolean; fallback?: string }> {
  const keepIds: string[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < candidates.length; start += SCREEN_VISION_BATCH) {
    const batch = candidates.slice(start, start + SCREEN_VISION_BATCH);
    const allowed = batch.map((item) => item.itemId);
    const result = await callScreenModel(
      visionModel,
      screenUserVision(listing, batch),
      allowed,
      options,
    );
    if (!result.parsed) return result;
    for (const id of result.keepIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      keepIds.push(id);
    }
  }
  return { keepIds, parsed: true };
}

export async function screenRivalCandidates(
  listing: { title: string; copy?: string },
  candidates: ScreenCandidate[],
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ keepIds: string[]; parsed: boolean; fallback?: string }> {
  const allowed = candidates.map((item) => item.itemId);
  if (candidates.length === 0) return { keepIds: [], parsed: true };

  const status = llmStatus();
  if (!status.configured) {
    return { keepIds: [], parsed: false };
  }

  if (status.visionModel) {
    const vision = await screenWithVision(
      listing,
      candidates,
      status.visionModel,
      options,
    );
    if (vision.parsed) return vision;
    console.warn(
      `[agent] 带图筛选失败（封面图或视觉模型）：${vision.fallback ?? "未知原因"}，回落到纯文字筛选。`,
    );
  }

  return callScreenModel(
    status.model,
    screenUserText(listing, candidates),
    allowed,
    options,
  );
}

export interface TaskRuleDraft {
  name: string;
  keyword: string;
  mustInclude: string[];
  mustExclude: string[];
}

const TASK_RULE_SYSTEM = [
  "你是闲鱼选品助理。根据用户一句话，写出搜索词和可比规格。",
  "只输出一个 JSON 对象，不要解释。格式：",
  '{"name":"任务名","keyword":"闲鱼搜索词","mustInclude":["必须出现的词"],"mustExclude":["必须排除的词"]}',
  "keyword 是人要去闲鱼搜的词，不超过 30 字。",
  "mustInclude / mustExclude 各最多 6 个词，每词不超过 12 字，不要重复，两个数组不能有相同的词。",
  "两个数组都不能空。name 简短能看懂。",
].join("");

const MAX_TASK_KEYWORD = 30;
const MAX_RULE_WORDS = 6;
const MAX_RULE_WORD = 12;

function cleanRuleWords(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const words: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const word = item.trim();
    if (!word) continue;
    if ([...word].length > MAX_RULE_WORD) return null;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  if (words.length === 0 || words.length > MAX_RULE_WORDS) return null;
  return words;
}

/**
 * 建任务草稿护栏。宁可整份弃用，也不把半残规则写进表单。
 */
export function judgeTaskRuleDraft(raw: unknown): TaskRuleDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.keyword !== "string") {
    return null;
  }
  const name = record.name.trim();
  const keyword = record.keyword.trim();
  if (!name || !keyword) return null;
  if ([...name].length > 40 || [...keyword].length > MAX_TASK_KEYWORD) return null;

  const mustInclude = cleanRuleWords(record.mustInclude);
  const mustExclude = cleanRuleWords(record.mustExclude);
  if (!mustInclude || !mustExclude) return null;

  const includeKeys = new Set(mustInclude.map((word) => word.toLowerCase()));
  if (mustExclude.some((word) => includeKeys.has(word.toLowerCase()))) return null;

  return { name, keyword, mustInclude, mustExclude };
}

function parseTaskRuleJson(text: string): unknown {
  const stripped = stripThinking(text);
  if (!stripped) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    const sliced = stripped.match(/\{[\s\S]*\}/);
    if (!sliced) return null;
    try {
      return JSON.parse(sliced[0]);
    } catch {
      return null;
    }
  }
}

export async function draftTaskRules(
  prompt: string,
  listing: { title: string; copy?: string } | undefined,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ draft: TaskRuleDraft | null; fallback?: string }> {
  const status = llmStatus();
  if (!status.configured) {
    return { draft: null, fallback: "还没配置模型，请手填。" };
  }
  const asked = prompt.trim();
  if (!asked) return { draft: null, fallback: "先用一句话说你想找什么。" };

  const userContent = [
    `用户想找：${asked}`,
    listing
      ? `对标本店：${listing.title}${listing.copy ? `。${listing.copy.replace(/\s+/g, " ").trim().slice(0, 160)}` : ""}`
      : "",
    "只输出 JSON 对象。",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${status.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llmApiKey() ?? ""}`,
      },
      body: JSON.stringify({
        model: status.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: TASK_RULE_SYSTEM },
          { role: "user", content: userContent },
        ],
        ...thinkingHints(status),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? RESEARCH_ANALYZE_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      const detail = errorDetail(body);
      return {
        draft: null,
        fallback: `模型调用失败（HTTP ${response.status}${detail ? `：${detail}` : ""}），请手填。`,
      };
    }
    const content = messageText(body);
    if (!content) return { draft: null, fallback: "模型没给出可用的规则，请手填。" };
    const draft = judgeTaskRuleDraft(parseTaskRuleJson(content));
    if (!draft) return { draft: null, fallback: "模型没给出可用的规则，请手填。" };
    return { draft };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "超时" : "网络错误";
    return { draft: null, fallback: `模型调用${reason}，请手填。` };
  }
}
