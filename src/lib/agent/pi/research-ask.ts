import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AppState } from "@/lib/domain/types";
import { llmApiKey, numbersIn } from "@/lib/agent/llm";
import { piConfigured, piModel, piStreamFn } from "./model";
import { researchTools, type ResearchAskBag } from "./research-tools";

export const RESEARCH_ASK_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  "你是闲鱼选品参谋，只根据工具返回的本地观察回答。",
  "必须先调用工具再下结论。问价格带用 price_band，问一家店或一个任务里谁在降价用 shop_pulse，问单件热度用 rival_heat。",
  "材料里没有的价格、想要、浏览不能出现。数件数用「几件」即可。没有两次观察就说看不出来。",
  "不要建议改本店价格，不要编想要和浏览。",
].join("");

const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const ID_TOKEN = /\b(?:RT|RV|OB)[A-Z0-9]+\b/gi;
const LONG_DIGIT_ID = /\b\d{8,}\b/g;
const THINK_BLOCK = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
const OPEN_THINK = /<(think|thinking)>/i;
const COUNT_UNIT = /^(?:\s*)(?:件|个|家|次|条|种|款|位)/;

function maskResearchIds(text: string): string {
  return text.replace(ID_TOKEN, " ").replace(LONG_DIGIT_ID, " ");
}

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

function extrasInAnswer(answer: string, material: string[]): number[] {
  const allowed = numbersIn(maskResearchIds(material.join("\n")));
  const extras: number[] = [];
  const masked = maskResearchIds(answer);
  for (const match of masked.matchAll(NUMBER)) {
    const token = match[0];
    const value = Number(token.replace(/,/g, ""));
    if (!Number.isFinite(value) || allowed.has(value)) continue;
    const after = masked.slice((match.index ?? 0) + token.length);
    if (!token.includes(".") && COUNT_UNIT.test(after)) continue;
    extras.push(value);
  }
  return extras;
}

export function judgeResearchAnswer(
  answer: string,
  material: string[],
): { ok: true; text: string } | { ok: false; message: string } {
  const stripped = stripThinking(answer);
  if (!stripped) return { ok: false, message: "模型没有返回正文。" };

  const extras = extrasInAnswer(stripped, material);
  if (extras.length > 0) {
    return {
      ok: false,
      message: `模型给的数字对不上材料（${extras.slice(0, 3).join("、")}），这一轮不显示。`,
    };
  }
  return { ok: true, text: stripped };
}

export function lastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

export async function runResearchAsk(
  state: AppState,
  question: string,
  now: number,
  options: {
    streamFn?: StreamFn;
    currentTaskId?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  ok: boolean;
  message: string;
  answer?: string;
  tools: string[];
}> {
  const asked = question.trim();
  if (!asked) return { ok: false, message: "先问一句。", tools: [] };
  if (!piConfigured()) {
    return { ok: false, message: "还没配置模型，没法问答。", tools: [] };
  }

  const bag: ResearchAskBag = { tools: [], texts: [asked] };
  let agent: Agent | undefined;
  const timer = setTimeout(
    () => agent?.abort(),
    options.timeoutMs ?? RESEARCH_ASK_TIMEOUT_MS,
  );

  try {
    agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: piModel(),
        thinkingLevel: "off",
        tools: researchTools(state, now, bag),
        messages: [],
      },
      streamFn: options.streamFn ?? piStreamFn,
      toolExecution: "sequential",
      getApiKey: () => llmApiKey(),
    });

    const hint = options.currentTaskId
      ? `当前研究任务 id 是 ${options.currentTaskId}。优先看这个任务。\n`
      : "";
    await agent.prompt(`${hint}问题：${asked}`);

    if (agent.state.errorMessage) {
      const aborted = /abort|cancel|取消/i.test(agent.state.errorMessage);
      return {
        ok: false,
        message: aborted ? "问答超时，这一轮不显示。" : agent.state.errorMessage,
        tools: bag.tools,
      };
    }

    if (bag.tools.length === 0) {
      return {
        ok: false,
        message: "模型没有先读观察，这一轮不显示。",
        tools: bag.tools,
      };
    }

    const raw = lastAssistantText(agent.state.messages);
    const judged = judgeResearchAnswer(raw, bag.texts);
    if (!judged.ok) {
      console.warn("[research-ask]", judged.message);
      return { ...judged, tools: bag.tools };
    }
    return {
      ok: true,
      message: "以下由模型根据库里的观察生成，数字已校验。",
      answer: judged.text,
      tools: bag.tools,
    };
  } catch (error) {
    const timedOut = error instanceof Error && /abort/i.test(error.message);
    return {
      ok: false,
      message: timedOut ? "问答超时，这一轮不显示。" : "问答出错，这一轮不显示。",
      tools: bag.tools,
    };
  } finally {
    clearTimeout(timer);
  }
}
