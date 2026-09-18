import { describe, expect, it } from "vitest";
import { judgeResearchAnswer } from "@/lib/agent/pi/research-ask";
import { researchTools, type ResearchAskBag } from "@/lib/agent/pi/research-tools";
import { createSeedState } from "@/lib/domain/seed";

const NOW = Date.parse("2026-03-20T10:00:00.000+08:00");

function emptyBag(): ResearchAskBag {
  return { tools: [], texts: [] };
}

describe("judgeResearchAnswer", () => {
  it("材料里有的数字放行，没有的整段弃用", () => {
    const material = ["现价 ¥1,699.00 想要 93 浏览 1192"];
    expect(judgeResearchAnswer("中位价 1699，想要 93。", material)).toEqual({
      ok: true,
      text: "中位价 1699，想要 93。",
    });
    expect(judgeResearchAnswer("已经降到 1299 了。", material)).toEqual({
      ok: false,
      message: "模型给的数字对不上材料（1299），这一轮不显示。",
    });
  });

  it("小数价格对得上，件数可以数，编出来的价仍弃用", () => {
    const material = ["现价 ¥2.90 上次 ¥2.90 价差 ¥0.00 共 12 件"];
    expect(judgeResearchAnswer("现价 2.9 元，有 2 件在降价。", material)).toEqual({
      ok: true,
      text: "现价 2.9 元，有 2 件在降价。",
    });
    expect(judgeResearchAnswer("已经降到 3 元了。", material)).toEqual({
      ok: false,
      message: "模型给的数字对不上材料（3），这一轮不显示。",
    });
  });

  it("任务 id 里的数字不算材料，思考块里的数字也不算", () => {
    const material = ["任务 RTMU3R4RZQS 现价 ¥2.90"];
    expect(
      judgeResearchAnswer(
        "<think>按 10% 算会变成 3 元</think>任务 RTMU3R4RZQS 还是 2.9 元。",
        material,
      ),
    ).toEqual({
      ok: true,
      text: "任务 RTMU3R4RZQS 还是 2.9 元。",
    });
  });
});

describe("researchTools", () => {
  it("四个工具只读，不改状态", async () => {
    const state = createSeedState(NOW);
    const before = JSON.stringify(state);
    const bag = emptyBag();
    const tools = researchTools(state, NOW, bag);
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_research_tasks",
      "price_band",
      "shop_pulse",
      "rival_heat",
    ]);

    const list = tools[0]!;
    const band = tools[1]!;
    const pulse = tools[2]!;
    const heat = tools[3]!;
    const task = state.research.tasks[0]!;
    const rival = state.research.rivals.find((item) => item.taskId === task.id)!;

    await list.execute("c1", {});
    await band.execute("c2", { taskId: task.id });
    await pulse.execute("c3", { taskId: task.id });
    await heat.execute("c4", { rivalId: rival.id });

    expect(JSON.stringify(state)).toBe(before);
    expect(bag.tools).toEqual([
      "list_research_tasks",
      "price_band",
      "shop_pulse",
      "rival_heat",
    ]);
    expect(bag.texts.some((text) => text.includes("最低"))).toBe(true);
    expect(bag.texts.some((text) => text.includes(task.id))).toBe(true);
    expect(bag.texts.some((text) => /现价|想要/.test(text))).toBe(true);
    expect(bag.texts.some((text) => /共 \d+ 件/.test(text))).toBe(true);
    expect(bag.texts.some((text) => /日均 \d+\.\d/.test(text))).toBe(true);
  });

  it("找不到任务或同行就如实说", async () => {
    const state = createSeedState(NOW);
    const bag = emptyBag();
    const [, band, pulse, heat] = researchTools(state, NOW, bag);
    const missingBand = await band.execute("c1", { taskId: "RT-missing" });
    const missingPulse = await pulse.execute("c2", { taskId: "RT-missing" });
    const missingHeat = await heat.execute("c3", { rivalId: "RV-missing" });
    expect(JSON.stringify(missingBand)).toContain("找不到任务");
    expect(JSON.stringify(missingPulse)).toContain("找不到任务");
    expect(JSON.stringify(missingHeat)).toContain("找不到同行");
  });
});
