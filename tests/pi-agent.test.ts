import { describe, expect, it } from "vitest";
import { actionKey, proposeActions } from "@/lib/agent/engine";
import { pickSurveyProposals, surveyShop } from "@/lib/agent/pi/survey";
import { createPiRound, shopTools } from "@/lib/agent/pi/tools";
import { createSeedState } from "@/lib/domain/seed";

const NOW = Date.parse("2026-03-20T10:00:00.000+08:00");

describe("pi-agent 店铺工具", () => {
  it("survey_shop 的候选和规则巡检一致", () => {
    const state = createSeedState(NOW);
    const survey = surveyShop(state, NOW);
    const expected = proposeActions(state, NOW);
    expect(survey.proposals).toEqual(expected);
    expect(survey.items).toHaveLength(expected.length);
    expect(survey.items.map((item) => item.key)).toEqual(
      expected.map((proposal) => actionKey(proposal.payload)),
    );
  });

  it("只能从本轮候选里挑选，不能发明编号", async () => {
    const state = createSeedState(NOW);
    const round = createPiRound();
    const [surveyTool, selectTool] = shopTools(state, NOW, round);
    await surveyTool.execute("call-1", {});
    await expect(selectTool.execute("call-2", { ids: ["P-not-real"] })).rejects.toThrow(
      /不在本轮候选/,
    );
    expect(round.selected).toBe(false);
  });

  it("select_proposals 按编号取出对应提案", async () => {
    const state = createSeedState(NOW);
    const survey = surveyShop(state, NOW);
    expect(survey.items.length).toBeGreaterThan(0);
    const first = survey.items[0]!;
    const picked = pickSurveyProposals(survey, [first.id]);
    expect(picked).toHaveLength(1);
    expect(actionKey(picked[0]!.payload)).toBe(first.key);
  });

  it("没先巡检就选定会失败", async () => {
    const state = createSeedState(NOW);
    const round = createPiRound();
    const selectTool = shopTools(state, NOW, round)[1]!;
    await expect(selectTool.execute("call-1", { ids: [] })).rejects.toThrow(/survey_shop/);
  });
});
