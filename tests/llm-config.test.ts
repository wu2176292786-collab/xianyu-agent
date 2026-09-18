import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  describeLlmConfig,
  maskKey,
  parseLlmConfig,
  resolveLlmOrigin,
} from "@/lib/agent/llm-config";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_VISION_MODEL",
  "OPENAI_THINKING_HINTS",
] as const;

// 测试绝不能读取开发者电脑上的真实模型配置；只有显式写入临时文件的用例才读文件。
const EMPTY_LLM_CONFIG_FILE = path.join(
  os.tmpdir(),
  `xianyu-agent-vitest-no-llm-config-${process.pid}.json`,
);

beforeEach(() => {
  process.env.XIANYU_LLM_CONFIG_FILE = EMPTY_LLM_CONFIG_FILE;
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.XIANYU_LLM_CONFIG_FILE;
  vi.resetModules();
});

describe("模型配置解析", () => {
  it("只粘一条密钥也能用，其余走默认", () => {
    const config = parseLlmConfig("sk-abc123456789")!;
    expect(config.apiKey).toBe("sk-abc123456789");
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.visionModel).toBeUndefined();
    expect(config.sendThinkingHints).toBe(true);
  });

  it("认表单对象", () => {
    const config = parseLlmConfig({
      apiKey: "sk-1",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      visionModel: "qwen-vl-max",
      sendThinkingHints: false,
    })!;
    expect(config.model).toBe("deepseek-chat");
    expect(config.visionModel).toBe("qwen-vl-max");
    expect(config.sendThinkingHints).toBe(false);
  });

  it("认整段 JSON，也认环境变量式的键名", () => {
    const config = parseLlmConfig(
      JSON.stringify({
        OPENAI_API_KEY: "sk-2",
        OPENAI_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
        OPENAI_MODEL: "glm-4-flash",
      }),
    )!;
    expect(config.apiKey).toBe("sk-2");
    expect(config.model).toBe("glm-4-flash");
  });

  it("结尾的斜杠要去掉，否则拼出来是 //chat/completions", () => {
    expect(parseLlmConfig({ apiKey: "sk-1", baseUrl: "https://x.com/v1/" })!.baseUrl).toBe(
      "https://x.com/v1",
    );
    expect(parseLlmConfig({ apiKey: "sk-1", baseUrl: "https://x.com/v1///" })!.baseUrl).toBe(
      "https://x.com/v1",
    );
  });

  it("完全空的输入返回 null，不留半残配置", () => {
    expect(parseLlmConfig("")).toBeNull();
    expect(parseLlmConfig("   ")).toBeNull();
    expect(parseLlmConfig("{ 坏掉的 json")).toBeNull();
    expect(parseLlmConfig({ apiKey: "  " })).toBeNull();
  });

  it("只给地址和模型是合法的 —— 密钥沿用环境变量那份", () => {
    const config = parseLlmConfig({ baseUrl: "https://x.com/v1", model: "m" })!;
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe("https://x.com/v1");
    expect(config.model).toBe("m");
  });
});

describe("密钥脱敏", () => {
  it("留头留尾，中间不给", () => {
    expect(maskKey("sk-proj-abcdefghijklmnop1234")).toBe("sk-pr…1234");
  });

  it("短密钥也不整条露出来", () => {
    expect(maskKey("sk-123")).toBe("sk…");
  });

  it("描述里绝不出现密钥原文", () => {
    const text = describeLlmConfig({
      configured: true,
      origin: "file",
      model: "deepseek-chat",
      visionModel: "qwen-vl-max",
      sendThinkingHints: true,
    });
    expect(text).not.toContain("sk-");
    expect(text).toContain("deepseek-chat");
    expect(text).toContain("qwen-vl-max");
  });

  it("没配看图模型时如实说，不假装能看图", () => {
    const text = describeLlmConfig({
      configured: true,
      origin: "file",
      model: "gpt-4o-mini",
      sendThinkingHints: false,
      visionModel: undefined,
    });
    expect(text).toContain("筛选不看图");
    expect(text).toContain("不带推理关闭字段");
  });

  it("没配置时不说得像配好了", () => {
    expect(
      describeLlmConfig({
        configured: false,
        origin: "none",
        model: DEFAULT_MODEL,
        sendThinkingHints: true,
      }),
    ).toContain("未配置");
  });
});

describe("本机配置和环境变量的合并", () => {
  async function withConfig(config: Record<string, unknown> | null) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "xianyu-llm-"));
    const file = path.join(dir, "llm-config.json");
    if (config) await writeFile(file, JSON.stringify(config), "utf8");
    process.env.XIANYU_LLM_CONFIG_FILE = file;
    vi.resetModules();
    return import("@/lib/agent/llm");
  }

  it("只存了模型时，密钥继续用环境变量那份", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    process.env.OPENAI_BASE_URL = "https://env.example.com/v1";
    const { llmStatus, llmApiKey } = await withConfig({
      model: "glm-4-flash",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    });

    const status = llmStatus();
    expect(status.configured).toBe(true);
    expect(status.origin).toBe("mixed");
    // 模型和地址听本机的
    expect(status.model).toBe("glm-4-flash");
    expect(status.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    // 密钥听环境变量的
    expect(llmApiKey()).toBe("sk-from-env");
  });

  it("本机存了自己的密钥就整份用本机的", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    const { llmStatus, llmApiKey } = await withConfig({
      apiKey: "sk-from-file",
      model: "deepseek-chat",
    });

    expect(llmStatus().origin).toBe("file");
    expect(llmApiKey()).toBe("sk-from-file");
  });

  it("本机没填的字段退回环境变量，不要变成默认值", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    process.env.OPENAI_VISION_MODEL = "env-vision";
    const { llmStatus } = await withConfig({ model: "only-text" });

    expect(llmStatus().visionModel).toBe("env-vision");
  });

  it("清掉本机配置就退回环境变量", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    process.env.OPENAI_MODEL = "env-model";
    const { llmStatus } = await withConfig(null);

    expect(llmStatus().origin).toBe("env");
    expect(llmStatus().model).toBe("env-model");
  });

  it("两边都没有就是未配置，不假装能用", async () => {
    const { llmStatus } = await withConfig(null);
    expect(llmStatus().configured).toBe(false);
    expect(llmStatus().origin).toBe("none");
    expect(llmStatus().hasEnv).toBe(false);
  });
});

describe("来源优先级", () => {
  it("本机配置覆盖环境变量；只有模型没密钥时算混合", () => {
    // 换模型是常规操作，不该逼人改 .env.local 再重启
    expect(resolveLlmOrigin({ envKey: "sk-env", fileKey: "sk-file", hasFile: true })).toBe(
      "file",
    );
    expect(resolveLlmOrigin({ envKey: "sk-env", hasFile: true })).toBe("mixed");
    expect(resolveLlmOrigin({ hasFile: true })).toBe("file");
    expect(resolveLlmOrigin({ envKey: "sk-env", hasFile: false })).toBe("env");
    expect(resolveLlmOrigin({ envKey: "  ", hasFile: false })).toBe("none");
    expect(resolveLlmOrigin({ hasFile: false })).toBe("none");
  });

  it("没有本机配置时用环境变量那份", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.OPENAI_MODEL = "env-model";
    process.env.OPENAI_VISION_MODEL = "env-vision";
    const { llmStatus } = await import("@/lib/agent/llm");
    const status = llmStatus();

    expect(status.origin).toBe("env");
    expect(status.configured).toBe(true);
    expect(status.model).toBe("env-model");
    expect(status.visionModel).toBe("env-vision");
    expect(status.sendThinkingHints).toBe(true);
    expect(status.hasEnv).toBe(true);
  });

  it("只改模型名时不用重贴密钥", () => {
    // 界面上密钥是脱敏的，本来也贴不回来
    const onlyModel = parseLlmConfig({ model: "glm-4-flash" })!;
    expect(onlyModel.apiKey).toBeUndefined();
    expect(onlyModel.model).toBe("glm-4-flash");
  });

  it("一项都没填就不留空配置", () => {
    expect(parseLlmConfig({})).toBeNull();
    expect(parseLlmConfig({ sendThinkingHints: false })).toBeNull();
  });

  it("混合状态在描述里要说清楚密钥是谁的", () => {
    expect(
      describeLlmConfig({
        configured: true,
        origin: "mixed",
        model: "glm-4-flash",
        sendThinkingHints: true,
      }),
    ).toContain("密钥仍用环境变量");
  });

  it("环境变量能关掉非标准字段", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.OPENAI_THINKING_HINTS = "0";
    const { llmStatus, thinkingHints } = await import("@/lib/agent/llm");
    expect(thinkingHints(llmStatus())).toEqual({});
  });

  it("开着的时候带的是那两个字段", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    const { llmStatus, thinkingHints } = await import("@/lib/agent/llm");
    expect(thinkingHints(llmStatus())).toEqual({
      thinking: { type: "disabled" },
      reasoning_split: true,
    });
  });
});
