import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AppState, RivalListing } from "@/lib/domain/types";
import { yuan } from "@/lib/format";
import { latestHeat, priceBand, viewsTrend, wantsTrend } from "@/lib/research/analysis";
import { latestPriceCents } from "@/lib/research/copy";
import { dailyCompare } from "@/lib/research/heat";

export interface ResearchAskBag {
  tools: string[];
  texts: string[];
}

function textResult(bag: ResearchAskBag, name: string, text: string) {
  bag.tools.push(name);
  bag.texts.push(text);
  return {
    content: [{ type: "text" as const, text }],
    details: { name },
  };
}

function rivalsOf(state: AppState, taskId: string): RivalListing[] {
  return state.research.rivals.filter((rival) => rival.taskId === taskId);
}

function lastTwoPrices(rival: RivalListing): {
  current?: number;
  previous?: number;
} {
  const priced = rival.observations
    .filter((observation) => observation.priceCents !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    current: priced.at(-1)?.priceCents,
    previous: priced.at(-2)?.priceCents,
  };
}

function formatRate(value: number): string {
  return value.toFixed(1);
}

function dailyLine(label: string, daily: ReturnType<typeof dailyCompare>): string {
  if (daily.today === undefined && daily.yesterday === undefined && daily.previous === undefined) {
    return `${label}${daily.note ?? "还没有按天采到"}`;
  }
  const bits = [`${label}`];
  if (daily.today !== undefined) bits.push(`今天 ${daily.today}`);
  if (daily.yesterday !== undefined) bits.push(`昨天 ${daily.yesterday}`);
  else if (daily.previous !== undefined) bits.push(`上次 ${daily.previous}`);
  if (daily.delta !== undefined) {
    const prefix = daily.yesterday !== undefined ? "较昨天" : "较上次";
    bits.push(`${prefix} ${daily.delta > 0 ? `+${daily.delta}` : daily.delta}`);
  }
  if (daily.note) bits.push(daily.note);
  return bits.join(" ");
}

export function researchTools(
  state: AppState,
  now: number,
  bag: ResearchAskBag,
): AgentTool[] {
  return [
    {
      name: "list_research_tasks",
      label: "列出研究任务",
      description: "列出本地研究任务：名称、类型（关键词或店铺）、货件数。只读。",
      parameters: Type.Object({}),
      execute: async () => {
        const lines = state.research.tasks
          .filter((task) => task.status === "active")
          .map((task) => {
            const count = rivalsOf(state, task.id).length;
            const kind = task.kind === "shop" ? "店铺" : "关键词";
            return `${task.id} ${task.name} ${kind} ${count}件`;
          });
        return textResult(
          bag,
          "list_research_tasks",
          lines.length === 0 ? "还没有研究任务。" : lines.join("\n"),
        );
      },
    },
    {
      name: "price_band",
      label: "价格带",
      description: "一个任务里规格可比同行的最低 / 中位 / 最高价。只读，数字来自已入库观察。",
      parameters: Type.Object({
        taskId: Type.String({ description: "研究任务 id，例如 RT…" }),
      }),
      execute: async (_id, params) => {
        const taskId = String((params as { taskId?: unknown }).taskId ?? "");
        const task = state.research.tasks.find((item) => item.id === taskId);
        if (!task) {
          return textResult(bag, "price_band", `找不到任务 ${taskId || "（空）"}。`);
        }
        const band = priceBand(rivalsOf(state, taskId));
        const text =
          band.count === 0
            ? `${task.id}「${task.name}」没有可比且带价格的同行。存疑 ${band.excludedUncertain}，不同款 ${band.excludedDifferent}，缺价 ${band.missingPrice}。`
            : [
                `${task.id}「${task.name}」可比 ${band.count} 件`,
                `最低 ${yuan(band.minCents)}`,
                `中位 ${yuan(band.medianCents)}`,
                `最高 ${yuan(band.maxCents)}`,
                `存疑排除 ${band.excludedUncertain}，不同款排除 ${band.excludedDifferent}，缺价 ${band.missingPrice}`,
              ].join("。");
        return textResult(bag, "price_band", text);
      },
    },
    {
      name: "shop_pulse",
      label: "店铺脉搏",
      description:
        "一个任务里逐件看现价、上次价、价差，以及想要和浏览的今天/昨天对比。只读。",
      parameters: Type.Object({
        taskId: Type.String({ description: "研究任务 id" }),
      }),
      execute: async (_id, params) => {
        const taskId = String((params as { taskId?: unknown }).taskId ?? "");
        const task = state.research.tasks.find((item) => item.id === taskId);
        if (!task) {
          return textResult(bag, "shop_pulse", `找不到任务 ${taskId || "（空）"}。`);
        }
        const rivals = rivalsOf(state, taskId);
        if (rivals.length === 0) {
          return textResult(bag, "shop_pulse", `${task.id}「${task.name}」还没有商品。`);
        }
        const lines = [`任务 ${task.id} ${task.name} 共 ${rivals.length} 件`].concat(rivals.map((rival) => {
          const prices = lastTwoPrices(rival);
          const price =
            prices.current === undefined
              ? "现价没有"
              : prices.previous === undefined
                ? `现价 ${yuan(prices.current)} 上次没有`
                : `现价 ${yuan(prices.current)} 上次 ${yuan(prices.previous)} 价差 ${yuan(prices.current - prices.previous)}`;
          return [
            `${rival.id} ${rival.title.slice(0, 24)}`,
            price,
            dailyLine("想要", dailyCompare(rival, "wants", now)),
            dailyLine("浏览", dailyCompare(rival, "views", now)),
          ].join("；");
        }));
        return textResult(bag, "shop_pulse", lines.join("\n"));
      },
    },
    {
      name: "rival_heat",
      label: "单件热度",
      description: "一件同行的想要 / 浏览时间线和增速。只读，只认商详对商详。",
      parameters: Type.Object({
        rivalId: Type.String({ description: "同行 id，例如 RV…" }),
      }),
      execute: async (_id, params) => {
        const rivalId = String((params as { rivalId?: unknown }).rivalId ?? "");
        const rival = state.research.rivals.find((item) => item.id === rivalId);
        if (!rival) {
          return textResult(bag, "rival_heat", `找不到同行 ${rivalId || "（空）"}。`);
        }
        const heat = latestHeat(rival);
        const wants = wantsTrend(rival);
        const views = viewsTrend(rival);
        const text = [
          `${rival.id} ${rival.title.slice(0, 24)}`,
          `现价 ${latestPriceCents(rival) === undefined ? "没有" : yuan(latestPriceCents(rival)!)}`,
          `想要 ${heat.wants ?? "没有"}${wants.previous !== undefined ? ` 上次 ${wants.previous}` : ""}${wants.delta !== undefined ? ` 增量 ${wants.delta}` : ""}${wants.hours !== undefined ? ` 间隔 ${Math.round(wants.hours)} 小时` : ""}${wants.perDay !== undefined ? ` 日均 ${formatRate(wants.perDay)}` : ""}${wants.note ? ` ${wants.note}` : ""}`,
          `浏览 ${heat.views ?? "没有"}${views.previous !== undefined ? ` 上次 ${views.previous}` : ""}${views.delta !== undefined ? ` 增量 ${views.delta}` : ""}${views.hours !== undefined ? ` 间隔 ${Math.round(views.hours)} 小时` : ""}${views.perDay !== undefined ? ` 日均 ${formatRate(views.perDay)}` : ""}${views.note ? ` ${views.note}` : ""}`,
        ].join("。");
        return textResult(bag, "rival_heat", text);
      },
    },
  ];
}
