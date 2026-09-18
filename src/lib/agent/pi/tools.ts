import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Proposal } from "@/lib/agent/engine";
import { pickSurveyProposals, surveyShop, type ShopSurvey } from "./survey";
import type { AppState } from "@/lib/domain/types";

export interface PiRound {
  surveyed: boolean;
  selected: boolean;
  survey: ShopSurvey;
  proposals: Proposal[];
}

export function createPiRound(): PiRound {
  return {
    surveyed: false,
    selected: false,
    survey: { items: [], proposals: [] },
    proposals: [],
  };
}

function textResult(text: string, details: unknown, terminate = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    terminate,
  };
}

export function shopTools(state: AppState, now: number, round: PiRound): AgentTool[] {
  const surveyTool: AgentTool = {
    name: "survey_shop",
    label: "巡检店铺",
    description:
      "按店铺规则列出本轮候选动作：待回复、擦亮、降价、备货、下架。只能看，不能执行。",
    parameters: Type.Object({}),
    execute: async () => {
      round.surveyed = true;
      round.survey = surveyShop(state, now);
      const items = round.survey.items;
      return textResult(
        items.length === 0
          ? "本轮没有候选动作。"
          : `本轮 ${items.length} 条候选：\n${items
              .map(
                (item) =>
                  `${item.id} [${item.ruleKind}/${item.risk}] ${item.title} —— ${item.reason}`,
              )
              .join("\n")}`,
        { count: items.length, ids: items.map((item) => item.id) },
      );
    },
  };

  const selectTool: AgentTool = {
    name: "select_proposals",
    label: "选定本轮动作",
    description:
      "从 survey_shop 的编号里选出本轮要做的。不能发明新编号。没有值得做的就传空数组。选完这一轮结束。",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: "survey_shop 返回的编号，例如 P1、P2",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      if (!round.surveyed) {
        throw new Error("先调用 survey_shop，再从它给出的编号里选。");
      }
      const ids = Array.isArray((params as { ids?: unknown }).ids)
        ? ((params as { ids: string[] }).ids)
        : [];
      const unknown = ids.filter(
        (id) => !round.survey.items.some((item) => item.id === id || item.key === id),
      );
      if (unknown.length > 0) {
        throw new Error(`这些编号不在本轮候选里：${unknown.join("、")}`);
      }
      round.selected = true;
      round.proposals = pickSurveyProposals(round.survey, ids);
      return textResult(
        round.proposals.length === 0
          ? "本轮不提出动作。"
          : `已选定 ${round.proposals.length} 条：${round.proposals.map((item) => item.title).join("；")}`,
        { count: round.proposals.length },
        true,
      );
    },
  };

  return [surveyTool, selectTool];
}
