import { Agent } from "@earendil-works/pi-agent-core";
import type { AppState } from "@/lib/domain/types";
import { proposeActions, type Proposal } from "@/lib/agent/engine";
import { llmApiKey } from "@/lib/agent/llm";
import { piConfigured, piModel, piStreamFn } from "./model";
import { createPiRound, shopTools } from "./tools";

const PI_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  "你是闲鱼店铺的运营 Agent，运行在 pi-agent 上。",
  "每轮巡检必须先 survey_shop，再 select_proposals。",
  "只能从 survey_shop 给出的编号里选，不能发明新动作、不能改价格、不能直接给买家发消息。",
  "低置信度回复、售后、降价、发货默认进人工审批，选上即可。",
  "重复、空泛、看不出买家要什么的「其他」回复可以不选。",
  "没有值得做的事就 select_proposals，ids 传空数组。",
].join("");

export async function proposeWithPi(state: AppState, now: number): Promise<Proposal[]> {
  const round = createPiRound();
  let agent: Agent | undefined;
  const timer = setTimeout(() => agent?.abort(), PI_TIMEOUT_MS);

  try {
    agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: piModel(),
        thinkingLevel: "off",
        tools: shopTools(state, now, round),
        messages: [],
      },
      streamFn: piStreamFn,
      toolExecution: "sequential",
      getApiKey: () => llmApiKey(),
    });

    await agent.prompt("开始本轮店铺巡检。先看候选，再选出这一轮要做的。");

    if (agent.state.errorMessage) {
      throw new Error(agent.state.errorMessage);
    }
    if (!round.surveyed) {
      throw new Error("pi-agent 没有调用 survey_shop。");
    }
    if (!round.selected) {
      return round.survey.proposals;
    }
    return round.proposals;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 配了模型就走 pi-agent；没配、超时或模型没按协议走，回落到规则巡检。
 */
export async function collectProposals(state: AppState, now: number): Promise<Proposal[]> {
  if (!piConfigured()) return proposeActions(state, now);
  try {
    return await proposeWithPi(state, now);
  } catch (error) {
    console.error("[agent] pi-agent 本轮失败，回落到规则巡检：", error);
    return proposeActions(state, now);
  }
}
