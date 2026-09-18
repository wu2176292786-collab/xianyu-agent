import { describe, expect, it } from "vitest";
import { createSeedState } from "@/lib/domain/seed";
import {
  applyKeepItemIds,
  canApplyScreenResult,
  parseScreenKeepIds,
  pruneHiddenRivals,
  ruleKeepItemIds,
  visibleRivals,
} from "@/lib/research/screen";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

describe("parseScreenKeepIds", () => {
  const allowed = ["1", "2", "3"];

  it("只收下候选里 keep=true 的 id", () => {
    const raw = JSON.stringify([
      { itemId: "1", keep: true },
      { itemId: "2", keep: false },
      { itemId: "9", keep: true },
    ]);
    expect(parseScreenKeepIds(raw, allowed)).toEqual({
      keepIds: ["1"],
      parsed: true,
    });
  });

  it("剥掉思考块再读 JSON", () => {
    const raw =
      '<think>书不要</think>\n[{"itemId":"2","keep":true},{"itemId":"3","keep":false}]';
    expect(parseScreenKeepIds(raw, allowed).keepIds).toEqual(["2"]);
  });

  it("不是数组就当没解析成", () => {
    expect(parseScreenKeepIds("留下 1 和 2", allowed)).toEqual({
      keepIds: [],
      parsed: false,
    });
  });
});

describe("visibleRivals / pruneHiddenRivals", () => {
  it("同行页只留可比", () => {
    const state = createSeedState(NOW);
    const taskId = state.research.tasks[0]!.id;
    expect(visibleRivals(state.research.rivals).map((r) => r.itemId)).toEqual([
      "812345001",
      "812345002",
      "812345003",
    ]);

    const pruned = pruneHiddenRivals(state, taskId);
    expect(pruned).toEqual({ kept: 3, dropped: 2 });
    expect(state.research.rivals.every((r) => r.alignment === "comparable")).toBe(
      true,
    );
  });
});

describe("applyKeepItemIds", () => {
  it("空的模型或规则结果不能触发批量删除", () => {
    expect(canApplyScreenResult([])).toBe(false);
    expect(canApplyScreenResult(["812345001"])).toBe(true);
  });

  it("人手标成可比的即使模型没勾也留下", () => {
    const state = createSeedState(NOW);
    const taskId = state.research.tasks[0]!.id;
    const human = state.research.rivals.find((r) => r.itemId === "812345005")!;
    human.alignment = "comparable";
    human.alignmentBy = "human";

    const result = applyKeepItemIds(state, taskId, ["812345001"]);
    expect(result.kept).toBe(2);
    expect(
      state.research.rivals.map((r) => r.itemId).sort(),
    ).toEqual(["812345001", "812345005"]);
  });

  it("没模型时规则只留可比标题", () => {
    const state = createSeedState(NOW);
    const task = state.research.tasks[0]!;
    expect(ruleKeepItemIds(task, state.research.rivals)).toEqual([
      "812345001",
      "812345002",
      "812345003",
    ]);
  });
});
