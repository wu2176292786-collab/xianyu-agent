import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 模型接入配置。
 *
 * 和登录态同一条红线：API Key 等于钱包，只写本机 `.secrets/`，权限 600，
 * 页面上永远只看到脱敏后的描述。
 *
 * 环境变量优先于这个文件 —— 和 `loadLoginState()` 的取舍一致：
 * 显式写在 `.env.local` 里的东西不该被界面上的操作悄悄改掉。
 */
export interface LlmConfig {
  /**
   * 留空表示"继续用环境变量里那份"。
   *
   * 换模型是常规操作，不该每次都逼人把密钥重贴一遍 ——
   * 而且密钥在页面上是脱敏的，本来也贴不回来。
   */
  apiKey?: string;
  /** OpenAI 兼容的接口根地址，结尾不带斜杠 */
  baseUrl: string;
  /** 文本用模型：回复润色、文案润色、对照分析、同行筛选 */
  model: string;
  /**
   * 看图用模型。留空就不看图。
   *
   * 单独一个是因为文本那几件事不需要视觉，
   * 强行换成多模态模型只会更贵更慢。
   */
  visionModel?: string;
  /**
   * 兼容开关。
   *
   * 我们默认会带上 `thinking: {type:"disabled"}` 和 `reasoning_split: true`，
   * 这是 MiniMax、DeepSeek 这类推理模型用来关掉思考过程的非标准字段。
   * 有些严格的网关见到不认识的字段会直接 400，那就把这个关掉。
   */
  sendThinkingHints?: boolean;
  savedAt?: string;
}

export interface LlmConfigView {
  configured: boolean;
  origin: "env" | "file" | "mixed" | "none";
  /** 环境变量里有没有密钥。界面上用来解释"清除之后会退回什么"。 */
  hasEnv: boolean;
  baseUrl: string;
  model: string;
  visionModel?: string;
  sendThinkingHints: boolean;
  /** 脱敏后的密钥，形如 `sk-…a1b2`。绝不回传原文。 */
  maskedKey?: string;
  savedAt?: string;
  detail: string;
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

/** 和 store 的 `XIANYU_STATE_FILE` 同一个路子：可覆盖，测试才好写。 */
export function llmConfigFilePath(): string {
  return (
    process.env.XIANYU_LLM_CONFIG_FILE?.trim() ||
    path.join(process.cwd(), ".secrets", "llm-config.json")
  );
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 结尾的斜杠会让拼出来的地址变成 `//chat/completions`。 */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * 认出各种粘法：表单对象、整段 JSON、或者直接一条 `sk-…`。
 *
 * 认不出来就返回 null，绝不返回一个半残的配置让它在真实请求里报错。
 */
export function parseLlmConfig(
  input: string | Record<string, unknown>,
): LlmConfig | null {
  let source: Record<string, unknown>;

  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return null;
    if (text.startsWith("{")) {
      try {
        source = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else {
      // 不是 JSON，当成裸密钥
      source = { apiKey: text };
    }
  } else {
    source = input;
  }

  const apiKey = trimmed(
    source.apiKey ?? source.api_key ?? source.key ?? source.OPENAI_API_KEY,
  );
  const baseUrl = trimmed(
    source.baseUrl ?? source.base_url ?? source.OPENAI_BASE_URL,
  );
  const model = trimmed(source.model ?? source.OPENAI_MODEL ?? source.modelName);
  const visionModel = trimmed(
    source.visionModel ?? source.vision_model ?? source.OPENAI_VISION_MODEL,
  );

  // 密钥、地址、模型一个都没有，就是一份空配置，不留
  if (!apiKey && !baseUrl && !model && !visionModel) return null;

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrl ?? DEFAULT_BASE_URL),
    model: model ?? DEFAULT_MODEL,
    visionModel,
    sendThinkingHints: source.sendThinkingHints !== false,
    savedAt: trimmed(source.savedAt),
  };
}

/** 脱敏：留头留尾，中间不给。 */
export function maskKey(key: string): string {
  const text = key.trim();
  if (text.length <= 8) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 5)}…${text.slice(-4)}`;
}

export async function saveLlmConfig(config: LlmConfig): Promise<string> {
  await mkdir(path.dirname(llmConfigFilePath()), { recursive: true });
  await writeFile(
    llmConfigFilePath(),
    JSON.stringify({ ...config, savedAt: new Date().toISOString() }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(llmConfigFilePath(), 0o600);
  cache = { at: 0, config: null };
  return llmConfigFilePath();
}

export async function clearLlmConfig(): Promise<void> {
  await rm(llmConfigFilePath(), { force: true });
  cache = { at: 0, config: null };
}

/**
 * 同步读，按 mtime 做缓存。
 *
 * `llmStatus()` 有十几个调用点，一半在 React 服务端组件里同步调用。
 * 为了读一个几百字节的本机文件把它们全改成异步不划算 ——
 * 这是个单人本机工具，`statSync` 的开销可以忽略。
 */
let cache: { at: number; config: LlmConfig | null } = { at: 0, config: null };

export function readLlmConfigFileSync(): LlmConfig | null {
  let mtime = 0;
  try {
    if (!existsSync(llmConfigFilePath())) {
      cache = { at: 0, config: null };
      return null;
    }
    mtime = statSync(llmConfigFilePath()).mtimeMs;
  } catch {
    return null;
  }

  if (cache.at === mtime) return cache.config;

  try {
    const parsed = parseLlmConfig(readFileSync(llmConfigFilePath(), "utf8"));
    cache = { at: mtime, config: parsed };
    // 早先的版本可能落成了 644，顺手收紧
    try {
      chmodSync(llmConfigFilePath(), 0o600);
    } catch {
      // 改不动就算了，不值得为此报错
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 哪一份在生效。
 *
 * `mixed` 是常见状态：密钥留在环境变量里，模型在界面上换。
 */
export function resolveLlmOrigin(input: {
  envKey?: string;
  fileKey?: string;
  hasFile: boolean;
}): "env" | "file" | "mixed" | "none" {
  const env = Boolean(input.envKey?.trim());
  if (input.hasFile) {
    if (input.fileKey?.trim()) return "file";
    return env ? "mixed" : "file";
  }
  return env ? "env" : "none";
}

const ORIGIN_LABEL: Record<"env" | "file" | "mixed" | "none", string> = {
  env: "来自环境变量",
  file: "来自本机配置",
  mixed: "模型来自本机配置，密钥仍用环境变量",
  none: "来源未知",
};

/** 给人看的一句话。任何时候都不能出现密钥原文。 */
export function describeLlmConfig(view: {
  configured: boolean;
  origin: "env" | "file" | "mixed" | "none";
  model: string;
  visionModel?: string;
  sendThinkingHints: boolean;
}): string {
  if (!view.configured) return "未配置。配好之后润色、筛选和问答才会启用。";
  return [
    `文本模型 ${view.model}`,
    view.visionModel ? `看图模型 ${view.visionModel}` : "没配看图模型，筛选不看图",
    view.sendThinkingHints ? "带推理关闭字段" : "不带推理关闭字段",
    ORIGIN_LABEL[view.origin],
  ].join("，");
}
